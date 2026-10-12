/**
 * streamLifecycleGuard.test.ts
 *
 * Regression coverage for the pending-stream-start immunity window
 * (streamLifecycle.ts) wired through the registered window callbacks:
 *
 * After the user interrupts a turn, the backend emits late cleanup echoes
 * (showLoading(false)) once the killed process tree is reaped. If a queued
 * message was dispatched in the meantime, those echoes must NOT reset the
 * loading state — otherwise the queue drain dispatches the next item while
 * the previous send is still booting, overlapping two live turns on one
 * Codex thread.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { registerMessageCallbacks } from './messageCallbacks';
import { registerStreamingCallbacks } from './streamingCallbacks';
import type { UseWindowCallbacksOptions } from '../../useWindowCallbacks';
import {
  markPendingStreamStart,
  isPendingStreamStartActive,
  clearPendingStreamStart,
} from '../../../utils/streamLifecycle';

const ref = <T,>(value: T) => ({ current: value });

function createHarness(loadingValues: boolean[]) {
  let loadingState = false;
  const options = {
    addToast: () => {},
    setMessages: () => {},
    setStatus: () => {},
    // Mirrors React's functional-update contract: the showLoading handler
    // always passes an updater function.
    setLoading: (value: boolean | ((prev: boolean) => boolean)) => {
      const next = typeof value === 'function' ? (value as (prev: boolean) => boolean)(loadingState) : value;
      loadingState = next;
      loadingValues.push(next);
    },
    setLoadingStartTime: () => {},
    setIsThinking: () => {},
    setHistoryData: () => {},
    userPausedRef: ref(false),
    isUserAtBottomRef: ref(true),
    messagesContainerRef: ref(null),
    suppressNextStatusToastRef: ref(false),
    streamingContentRef: ref(''),
    isStreamingRef: ref(false),
    useBackendStreamingRenderRef: ref(false),
    streamingMessageIndexRef: ref(-1),
    streamingTurnIdRef: ref(-1),
    findLastAssistantIndex: () => -1,
    extractRawBlocks: () => [],
    patchAssistantForStreaming: (message: unknown) => message,
    updateContextUsageData: () => {},
    closeContextUsageDialog: () => {},
    currentSessionIdRef: ref(null),
  } as unknown as UseWindowCallbacksOptions;

  registerMessageCallbacks(options, () => {}, () => {});
}

describe('pending-stream-start immunity window', () => {
  beforeEach(() => {
    clearPendingStreamStart();
  });

  it('marks, reports, and clears the pending stream start', () => {
    expect(isPendingStreamStartActive()).toBe(false);
    markPendingStreamStart();
    expect(isPendingStreamStartActive()).toBe(true);
    clearPendingStreamStart();
    expect(isPendingStreamStartActive()).toBe(false);
  });

  it('expires the marker after the immunity window', () => {
    markPendingStreamStart();
    // Simulate the window elapsing without waiting 8 real seconds.
    window.__pendingStreamStartAt = Date.now() - 8001;
    expect(isPendingStreamStartActive()).toBe(false);
    // The expired marker is retired so it cannot resurrect.
    expect(window.__pendingStreamStartAt).toBeUndefined();
  });

  it('suppresses the interrupted turn\'s late showLoading(false) echo', () => {
    const loadingValues: boolean[] = [];
    createHarness(loadingValues);

    markPendingStreamStart(); // executeMessage dispatched a queued message

    window.showLoading!('false'); // late echo from the interrupted turn
    expect(loadingValues).not.toContain(false);

    // loading=true from the dispatch path is unaffected.
    window.showLoading!('true');
    expect(loadingValues).toContain(true);
  });

  it('lets a genuine error snapshot release the suppression', () => {
    const loadingValues: boolean[] = [];
    createHarness(loadingValues);

    markPendingStreamStart();
    window.showLoading!('false'); // echo — suppressed
    expect(loadingValues).not.toContain(false);

    // Java pushes the error snapshot BEFORE the state-change notification.
    const errorSnapshot = JSON.stringify([
      { type: 'ERROR', content: 'Codex thread is busy: already has an active writer' },
    ]);
    window.updateMessages!(errorSnapshot);

    window.showLoading!('false'); // the genuine failure's loading reset
    expect(loadingValues).toContain(false);
  });

  it('stops suppressing once the immunity window elapses', () => {
    const loadingValues: boolean[] = [];
    createHarness(loadingValues);

    markPendingStreamStart();
    window.__pendingStreamStartAt = Date.now() - 8001; // window elapsed

    window.showLoading!('false');
    expect(loadingValues).toContain(false);
  });

  it('keeps the loading state when an older turn\'s onStreamEnd arrives mid-boot', () => {
    // Simulates the repeat-send chain: a queued message was dispatched (marker
    // armed), then the interrupted turn's late onStreamEnd lands. Its loading
    // reset must not claim the freshly dispatched turn's loading state —
    // otherwise the queue drain fires again and the queued messages resend.
    let loadingResets = 0;
    const options = {
      setMessages: () => {},
      setStreamingActive: () => {},
      setLoading: (value: boolean | ((prev: boolean) => boolean)) => {
        if (value === false || (typeof value === 'function' && value(true) === false)) {
          loadingResets += 1;
        }
      },
      setLoadingStartTime: () => {},
      setIsThinking: () => {},
      setExpandedThinking: () => {},
      streamingContentRef: ref(''),
      streamingThinkingRef: ref(''),
      isStreamingRef: ref(false),
      useBackendStreamingRenderRef: ref(false),
      autoExpandedThinkingKeysRef: ref(new Set<string>()),
      streamingMessageIndexRef: ref(-1),
      streamingTurnIdRef: ref(7),
      turnIdCounterRef: ref(7),
      recordStreamingBlockReset: () => {},
      clearStreamingBlockResets: () => {},
      lastContentUpdateRef: ref(0),
      contentUpdateTimeoutRef: ref<number | null>(null),
      lastThinkingUpdateRef: ref(0),
      thinkingUpdateTimeoutRef: ref<number | null>(null),
      currentProviderRef: ref('codex'),
      getOrCreateStreamingAssistantIndex: () => -1,
      patchAssistantForStreaming: (message: unknown) => message,
      findLastAssistantIndex: () => -1,
    } as unknown as UseWindowCallbacksOptions;

    registerStreamingCallbacks(options);

    markPendingStreamStart();
    // isStreamingRef=false but streamingTurnIdRef=7 → handlingMode 'full':
    // the exact ref state left behind by interruptSession for the old turn.
    window.onStreamEnd!();

    // The dispatched turn's marker and loading state survive the echo.
    expect(isPendingStreamStartActive()).toBe(true);
    expect(loadingResets).toBe(0);

    if (window.__stallWatchdogInterval != null) {
      clearInterval(window.__stallWatchdogInterval);
      window.__stallWatchdogInterval = null;
    }
  });
});
