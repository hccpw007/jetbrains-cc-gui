/**
 * Pending-stream-start marker.
 *
 * Bridges the gap between a dispatched send and the turn's first
 * [STREAM_START]: during that window the backend may still emit late
 * cleanup events for a turn the user just interrupted (showLoading(false) /
 * onStreamEnd echoes arriving after the process tree kill completes).
 * Without the marker those echoes reset `loading` while the freshly
 * dispatched turn is actually booting, which makes the message-queue drain
 * effect dispatch the NEXT queued item and overlap two live turns on one
 * Codex thread (thread-writer lock conflict / ghost user bubble).
 *
 * Marked by the send path (executeMessage), cleared when the dispatched
 * turn's stream actually starts or when a genuine error snapshot lands.
 * Time-boxed so a turn that dies without any event cannot wedge the
 * loading state permanently.
 */

const PENDING_STREAM_IMMUNITY_MS = 8000;

declare global {
  interface Window {
    __pendingStreamStartAt?: number;
  }
}

export function markPendingStreamStart(): void {
  window.__pendingStreamStartAt = Date.now();
}

export function clearPendingStreamStart(): void {
  window.__pendingStreamStartAt = undefined;
}

/**
 * Whether late backend cleanup echoes must not reset the loading state right
 * now: a dispatched turn is still waiting for its stream to start.
 */
export function isPendingStreamStartActive(): boolean {
  const since = window.__pendingStreamStartAt;
  if (since == null) {
    return false;
  }
  if (Date.now() - since >= PENDING_STREAM_IMMUNITY_MS) {
    window.__pendingStreamStartAt = undefined;
    return false;
  }
  return true;
}
