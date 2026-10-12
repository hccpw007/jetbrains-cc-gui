package com.github.claudecodegui.startup;

import com.github.claudecodegui.ui.toolwindow.ClaudeChatWindow;
import com.google.gson.Gson;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.ui.jcef.JBCefBrowser;
import com.intellij.util.concurrency.AppExecutorUtil;

import java.awt.Graphics2D;
import java.awt.Image;
import java.awt.Toolkit;
import java.awt.datatransfer.Clipboard;
import java.awt.datatransfer.DataFlavor;
import java.awt.image.BufferedImage;
import java.io.ByteArrayOutputStream;
import java.lang.reflect.Field;
import java.util.Base64;
import java.util.Collections;
import java.util.Set;
import java.util.WeakHashMap;
import java.util.concurrent.TimeUnit;
import javax.imageio.ImageIO;

import org.cef.CefClient;
import org.cef.browser.CefBrowser;
import org.cef.handler.CefKeyboardHandler.CefKeyEvent;
import org.cef.handler.CefKeyboardHandler.CefKeyEvent.EventType;
import org.cef.handler.CefKeyboardHandlerAdapter;
import org.cef.misc.BoolRef;
import org.cef.misc.EventFlags;

/**
 * macOS 27 CEF remote quirk: Cmd+V keydown never reaches onPreKeyEvent as
 * KEYEVENT_RAWKEYDOWN; only an orphan KEYEVENT_KEYUP (wkc=86) arrives.
 * Strategy: on KEYUP for V with Command still held, if no matching RAWKEYDOWN
 * for V was seen within 800ms, treat it as an intercepted Cmd+V and paste the
 * clipboard image.
 *
 * One hook per browser: every ClaudeChatWindow tab gets its own JBCefBrowser
 * (and CefClient), and browsers are replaced on reload, so installation is
 * driven by ClaudeChatWindow.replaceBrowser and deduped per CefClient. A
 * single global install would leave second projects, extra tabs and recreated
 * browsers without the fix.
 */
public class CefPasteHook extends CefKeyboardHandlerAdapter {

    private static final Logger LOG = Logger.getInstance(CefPasteHook.class);
    private static final Gson GSON = new Gson();
    private static final int VK_V = 0x56;
    private static final long ORPHAN_WINDOW_MS = 800;
    private static final long PASTE_DEBOUNCE_MS = 500;
    /** Same payload ceiling as ClipboardHandler; clipboard screenshots can be huge. */
    private static final long MAX_PNG_BYTES = 20L * 1024 * 1024;
    private static final int MAX_INSTALL_ATTEMPTS = 8;
    private static final long INSTALL_RETRY_DELAY_MS = 3000;

    /**
     * Clients that already carry the hook. Weak keys so a disposed browser's
     * client drops out instead of pinning it (and its window) forever.
     */
    private static final Set<CefClient> INSTALLED_CLIENTS = Collections.synchronizedSet(
            Collections.newSetFromMap(new WeakHashMap<>()));

    private volatile long lastVRawKeyDown = 0;
    private volatile long lastPasteTrigger = 0;
    private volatile boolean sawVRawKeyDown = false;

    private final ClaudeChatWindow myWindow;

    CefPasteHook(ClaudeChatWindow window) {
        this.myWindow = window;
    }

    /**
     * Attach the hook to the window's current browser client, retrying briefly
     * while the CEF browser is still initializing. Safe to call on every browser
     * (re)bind: each CefClient gets at most one hook.
     */
    public static void installForWindow(ClaudeChatWindow window) {
        installForWindow(window, 0);
    }

    private static void installForWindow(ClaudeChatWindow window, int attempt) {
        try {
            if (window == null || window.isDisposed()) {
                return;
            }
            CefClient client = readClient(window);
            if (client == null) {
                if (attempt < MAX_INSTALL_ATTEMPTS) {
                    AppExecutorUtil.getAppScheduledExecutorService().schedule(
                            () -> installForWindow(window, attempt + 1),
                            INSTALL_RETRY_DELAY_MS, TimeUnit.MILLISECONDS);
                } else {
                    LOG.info("[paste-fix][CEF] browser client not ready after "
                            + MAX_INSTALL_ATTEMPTS + " attempts, hook not installed");
                }
                return;
            }
            install(client, window);
        } catch (Throwable t) {
            LOG.warn("[paste-fix][CEF] install error", t);
        }
    }

    public static void install(CefClient client, ClaudeChatWindow window) {
        try {
            if (client == null || window == null) {
                return;
            }
            if (!INSTALLED_CLIENTS.add(client)) {
                return;
            }
            client.addKeyboardHandler(new CefPasteHook(window));
            LOG.info("[paste-fix][CEF] CefPasteHook installed on client " + System.identityHashCode(client));
        } catch (Throwable t) {
            LOG.warn("[paste-fix][CEF] install failed", t);
        }
    }

    private static CefClient readClient(ClaudeChatWindow window) {
        try {
            Field f = ClaudeChatWindow.class.getDeclaredField("browser");
            f.setAccessible(true);
            Object v = f.get(window);
            if (!(v instanceof JBCefBrowser)) {
                return null;
            }
            CefBrowser cefBrowser = ((JBCefBrowser) v).getCefBrowser();
            return cefBrowser == null ? null : cefBrowser.getClient();
        } catch (Throwable t) {
            return null;
        }
    }

    @Override
    public boolean onPreKeyEvent(CefBrowser browser, CefKeyEvent event, BoolRef isKeyboardShortcut) {
        try {
            if (!isVKey(event)) {
                return false;
            }
            long now = System.currentTimeMillis();
            if (event.type == EventType.KEYEVENT_RAWKEYDOWN) {
                sawVRawKeyDown = true;
                lastVRawKeyDown = now;
                return false;
            }
            if (event.type != EventType.KEYEVENT_KEYUP) {
                return false;
            }

            // Orphan KEYUP: no RAWKEYDOWN recently => a Cmd+V whose keydown the OS
            // swallowed before CEF. Command must still be held: macOS press-and-hold
            // on a bare 'v' emits no autorepeat RAWKEYDOWN either, so without the
            // modifier check simply holding v past the window would paste whatever
            // image happens to be in the clipboard.
            boolean commandDown = (event.modifiers & EventFlags.EVENTFLAG_COMMAND_DOWN) != 0;
            boolean orphan = !(sawVRawKeyDown && (now - lastVRawKeyDown) < ORPHAN_WINDOW_MS);
            sawVRawKeyDown = false; // consume
            if (!orphan || !commandDown) {
                return false;
            }

            if (now - lastPasteTrigger < PASTE_DEBOUNCE_MS) {
                return false;
            }
            lastPasteTrigger = now;
            LOG.info("[paste-fix][CEF] orphan Cmd+V detected, pasting image");

            ClaudeChatWindow window = myWindow;
            // Clipboard read on the EDT (fast; off-EDT AppKit clipboard access can
            // deadlock), the PNG encode off it (multi-megapixel screenshots would
            // otherwise freeze the UI for seconds).
            ApplicationManager.getApplication().invokeLater(() -> {
                BufferedImage image = readClipboardImage();
                if (image == null) {
                    return;
                }
                AppExecutorUtil.getAppExecutorService().execute(() -> encodeAndDispatch(window, image));
            });
        } catch (Throwable t) {
            LOG.warn("[paste-fix][CEF] hook error", t);
        }
        return false;
    }

    /**
     * windows_key_code is the PHYSICAL key: on Dvorak and similar layouts Cmd+V
     * is not 0x56, so also accept the layout-translated characters.
     */
    private static boolean isVKey(CefKeyEvent event) {
        return event.windows_key_code == VK_V
                || event.character == 'v' || event.character == 'V'
                || event.unmodified_character == 'v' || event.unmodified_character == 'V';
    }

    private static BufferedImage readClipboardImage() {
        try {
            Clipboard clipboard = Toolkit.getDefaultToolkit().getSystemClipboard();
            if (!clipboard.isDataFlavorAvailable(DataFlavor.imageFlavor)) {
                return null;
            }
            Object imageData = clipboard.getData(DataFlavor.imageFlavor);
            if (imageData == null) {
                return null;
            }
            if (imageData instanceof BufferedImage) {
                return (BufferedImage) imageData;
            }
            if (imageData instanceof Image) {
                Image img = (Image) imageData;
                int w = img.getWidth(null);
                int h = img.getHeight(null);
                if (w <= 0 || h <= 0) {
                    return null;
                }
                BufferedImage buffered = new BufferedImage(w, h, BufferedImage.TYPE_INT_ARGB);
                Graphics2D g = buffered.createGraphics();
                g.drawImage(img, 0, 0, null);
                g.dispose();
                return buffered;
            }
        } catch (Throwable t) {
            LOG.warn("[paste-fix][CEF] clipboard read error", t);
        }
        return null;
    }

    private void encodeAndDispatch(ClaudeChatWindow window, BufferedImage image) {
        try {
            ByteArrayOutputStream baos = new ByteArrayOutputStream();
            ImageIO.write(image, "png", baos);
            byte[] bytes = baos.toByteArray();
            baos.close();
            if (bytes.length == 0) {
                return;
            }
            if (bytes.length > MAX_PNG_BYTES) {
                LOG.warn("[paste-fix][CEF] image too large (" + bytes.length + " bytes), skipped");
                return;
            }
            String base64 = Base64.getEncoder().encodeToString(bytes);
            String js = "(function(){  window.dispatchEvent(new CustomEvent('java-paste-image',{detail:{base64:" + GSON.toJson(base64) + ",mediaType:'image/png'}}));})()";
            window.executeJavaScriptCode(js);
            LOG.info("[paste-fix][CEF] dispatched java-paste-image, len=" + base64.length());
        } catch (Throwable t) {
            LOG.warn("[paste-fix][CEF] encode/dispatch error", t);
        }
    }
}
