/**
 * Deduplication guard for clipboard-image pastes.
 *
 * One Cmd+V / Ctrl+V can hand the same clipboard image to the input box more
 * than once, because two independent producers exist:
 *
 * - the DOM `paste` event handled by usePasteAndDrop (webview), and
 * - the Java side, which dispatches the `java-paste-image` event from
 *   CefPasteHook (macOS 27+ Cmd+V fallback), ClipboardHandler and
 *   ChatPasteAction.
 *
 * The producers cannot see each other, so the input box — the single consumer
 * of both channels — keeps the knowledge instead: an image that arrives while
 * the previous paste gesture is still open is treated as a replay of that
 * gesture rather than as a second attachment. That is what turned a single
 * paste into two thumbnails when the CEF hook and the webview paste both fired.
 */

/**
 * How long a paste gesture stays open for a replay coming from the other
 * producer. The producers fire within a few milliseconds of each other, so one
 * second is generous while staying far below the time a user needs to trigger a
 * second, deliberate paste.
 */
export const IMAGE_PASTE_REPLAY_WINDOW_MS = 1000;

/** Producer that handed the image over. */
export type ImagePasteSource = 'dom-paste' | 'java-bridge';

/** The part of an Attachment that identifies the pasted image. */
export interface PastedImage {
  mediaType: string;
  data: string;
}

export interface ImagePasteDedupe {
  /**
   * @returns true when the image starts a new paste gesture, false when it is a
   * replay of the gesture that is still open.
   */
  isNewPaste(image: PastedImage, source: ImagePasteSource): boolean;
}

export function createImagePasteDedupe(
  windowMs: number = IMAGE_PASTE_REPLAY_WINDOW_MS
): ImagePasteDedupe {
  let lastImage: PastedImage | null = null;
  let lastSource: ImagePasteSource | null = null;
  let lastAcceptedAt = 0;

  const isSameImage = (a: PastedImage, b: PastedImage): boolean =>
    a.mediaType === b.mediaType && a.data === b.data;

  return {
    isNewPaste(image: PastedImage, source: ImagePasteSource): boolean {
      const now = Date.now();
      const previous = lastImage;
      const gestureOpen = previous !== null && now - lastAcceptedAt < windowMs;

      if (gestureOpen && previous !== null) {
        // Replay when the other producer delivers the same gesture (the DOM
        // paste and the Java producers race for a single keystroke), or when
        // one producer pushes the very same bytes twice. Java producers
        // re-encode the clipboard image identically, so the CEF hook echoing
        // ClipboardHandler is caught by the byte comparison.
        const fromOtherProducer = lastSource !== source;
        if (fromOtherProducer || isSameImage(previous, image)) {
          // Keep the gesture open while echoes keep arriving, so a late third
          // copy cannot slip in as a new attachment.
          lastAcceptedAt = now;
          return false;
        }
      }

      lastImage = image;
      lastSource = source;
      lastAcceptedAt = now;
      return true;
    },
  };
}
