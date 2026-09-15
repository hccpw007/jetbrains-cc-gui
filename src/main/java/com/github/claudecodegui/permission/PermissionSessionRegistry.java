package com.github.claudecodegui.permission;

import com.intellij.openapi.diagnostic.Logger;

import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.function.Function;
import java.util.function.Supplier;

/**
 * Tracks PermissionService instances by session id.
 *
 * <p>实例生命周期完全跟随窗口/标签页：窗口初始化时创建并启动，窗口销毁时由调用方
 * 显式 {@link #removeInstance(String)} 移除。此处刻意不做基于时间的"空闲回收"：
 * 会话长时间静默（用户离开数小时乃至过夜）是常态，而 Node 侧常驻 daemon 始终持有
 * 创建时的 sessionId 写权限 IPC 文件。一旦实例被判空闲回收，其 watcher 停止、且
 * 没有任何路径能把它重新创建回来（重建只发生在窗口初始化时），该会话的
 * AskUserQuestion 请求文件将无人消费 —— 对话框永久不再弹出。
 */
class PermissionSessionRegistry {

    private static final Logger LOG = Logger.getInstance(PermissionSessionRegistry.class);

    private static PermissionService legacyInstance;
    private static final Map<String, PermissionService> INSTANCES_BY_SESSION_ID = new ConcurrentHashMap<>();

    private PermissionSessionRegistry() {
    }

    static synchronized PermissionService getInstance(
            String sessionId,
            Supplier<PermissionService> legacyFactory,
            Function<String, PermissionService> sessionFactory
    ) {
        if (sessionId == null || sessionId.isEmpty()) {
            if (legacyInstance == null) {
                legacyInstance = legacyFactory.get();
            }
            return legacyInstance;
        }

        return INSTANCES_BY_SESSION_ID.computeIfAbsent(sessionId, sessionFactory);
    }

    static synchronized PermissionService getLegacyInstance(Supplier<PermissionService> legacyFactory) {
        LOG.warn("Deprecated getInstance(Project) called - please migrate to getInstance(Project, String sessionId). "
                + "This method will be removed in a future version.");
        if (legacyInstance == null) {
            legacyInstance = legacyFactory.get();
        }
        return legacyInstance;
    }

    /**
     * Removes the session instance and stops its watcher.
     *
     * <p>窗口/标签页关闭是本注册表唯一的移除入口，返回实例让调用方能顺带清理该
     * session 遗留的 IPC 文件（见 {@link PermissionService#stopAndCleanupFiles()}）。
     *
     * @return the removed {@link PermissionService}, or null if the session was not
     *         registered.
     */
    static synchronized PermissionService removeInstance(String sessionId) {
        if (sessionId == null || sessionId.isEmpty()) {
            return null;
        }
        PermissionService removed = INSTANCES_BY_SESSION_ID.remove(sessionId);
        if (removed != null) {
            removed.stop();
            LOG.info(String.format("PermissionService instance removed for sessionId=%s, remaining instances=%d",
                    sessionId, INSTANCES_BY_SESSION_ID.size()));
        }
        return removed;
    }

    static String newLegacySessionId() {
        return UUID.randomUUID().toString();
    }
}
