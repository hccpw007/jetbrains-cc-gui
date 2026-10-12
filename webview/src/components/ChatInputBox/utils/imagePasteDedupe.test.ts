import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  IMAGE_PASTE_REPLAY_WINDOW_MS,
  createImagePasteDedupe,
} from './imagePasteDedupe.js';

const image = { mediaType: 'image/png', data: 'AAAA' };
const otherImage = { mediaType: 'image/png', data: 'BBBB' };

describe('createImagePasteDedupe', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-28T10:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('accepts the first image of a gesture', () => {
    const dedupe = createImagePasteDedupe();

    expect(dedupe.isNewPaste(image, 'dom-paste')).toBe(true);
  });

  it('drops the same image delivered again by the same producer', () => {
    const dedupe = createImagePasteDedupe();

    expect(dedupe.isNewPaste(image, 'dom-paste')).toBe(true);
    expect(dedupe.isNewPaste(image, 'dom-paste')).toBe(false);
  });

  it('drops the other producer echoing the same image', () => {
    const dedupe = createImagePasteDedupe();

    expect(dedupe.isNewPaste(image, 'dom-paste')).toBe(true);
    expect(dedupe.isNewPaste(image, 'java-bridge')).toBe(false);
  });

  it('drops the other producer echoing a re-encoded copy of the same image', () => {
    const dedupe = createImagePasteDedupe();

    // The webview hands over the raw clipboard bytes while the Java producer
    // re-encodes the image, so the payloads differ but the gesture is the same.
    expect(dedupe.isNewPaste({ mediaType: 'image/tiff', data: 'RAW' }, 'dom-paste')).toBe(true);
    expect(dedupe.isNewPaste(image, 'java-bridge')).toBe(false);
  });

  it('keeps the gesture open while echoes keep arriving', () => {
    const dedupe = createImagePasteDedupe();

    expect(dedupe.isNewPaste(image, 'dom-paste')).toBe(true);

    // Echoes at t+900 and t+1700: the second one is outside the original
    // window but the gesture was extended by the first echo.
    vi.advanceTimersByTime(900);
    expect(dedupe.isNewPaste(image, 'java-bridge')).toBe(false);
    vi.advanceTimersByTime(800);
    expect(dedupe.isNewPaste(image, 'java-bridge')).toBe(false);

    // …and it stops extending once the echoes stop.
    vi.advanceTimersByTime(IMAGE_PASTE_REPLAY_WINDOW_MS);
    expect(dedupe.isNewPaste(image, 'java-bridge')).toBe(true);
  });

  it('treats any other-producer delivery inside the window as the same gesture', () => {
    const dedupe = createImagePasteDedupe();

    expect(dedupe.isNewPaste(image, 'dom-paste')).toBe(true);
    // The DOM and the Java producers cannot share a gesture token, so a
    // different payload from the other producer is still assumed to be the
    // re-encoded copy of the paste that is already attached.
    expect(dedupe.isNewPaste(otherImage, 'java-bridge')).toBe(false);
  });

  it('accepts a different image pasted by the same producer right after', () => {
    const dedupe = createImagePasteDedupe();

    expect(dedupe.isNewPaste(image, 'dom-paste')).toBe(true);
    vi.advanceTimersByTime(200);
    expect(dedupe.isNewPaste(otherImage, 'dom-paste')).toBe(true);
  });

  it('accepts the same image pasted again after the window closed', () => {
    const dedupe = createImagePasteDedupe();

    expect(dedupe.isNewPaste(image, 'java-bridge')).toBe(true);
    vi.advanceTimersByTime(IMAGE_PASTE_REPLAY_WINDOW_MS);
    expect(dedupe.isNewPaste(image, 'java-bridge')).toBe(true);
  });
});
