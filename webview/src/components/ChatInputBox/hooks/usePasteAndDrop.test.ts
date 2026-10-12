import { act, renderHook } from '@testing-library/react';
import type { Attachment } from '../types.js';
import { usePasteAndDrop } from './usePasteAndDrop.js';

function createEditable(): HTMLDivElement {
  const editable = document.createElement('div');
  editable.setAttribute('contenteditable', 'true');
  document.body.appendChild(editable);
  return editable;
}

function placeCaretAtEnd(editable: HTMLDivElement): void {
  const range = document.createRange();
  range.selectNodeContents(editable);
  range.collapse(false);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

function createPasteEvent(text: string): React.ClipboardEvent {
  return {
    clipboardData: {
      items: [{ kind: 'string', type: 'text/plain' }],
      getData: (type: string) => type === 'text/plain' ? text : '',
    },
    preventDefault: vi.fn(),
  } as unknown as React.ClipboardEvent;
}

function setupPasteHook(
  editable: HTMLDivElement,
  setInternalAttachments: React.Dispatch<React.SetStateAction<Attachment[]>> =
    vi.fn() as unknown as React.Dispatch<React.SetStateAction<Attachment[]>>
) {
  const pathMappingRef = { current: new Map<string, string>() };
  const renderFileTags = vi.fn();
  const hook = renderHook(() => usePasteAndDrop({
    editableRef: { current: editable },
    pathMappingRef,
    getTextContent: () => editable.textContent ?? '',
    adjustHeight: vi.fn(),
    renderFileTags,
    setHasContent: vi.fn(),
    setInternalAttachments,
    onInput: vi.fn(),
    closeAllCompletions: vi.fn(),
    handleInput: vi.fn(),
    flushInput: vi.fn(),
  }));

  return { ...hook, pathMappingRef, renderFileTags, setInternalAttachments };
}

describe('usePasteAndDrop file references', () => {
  beforeEach(() => {
    // happy-dom does not implement the deprecated command used by the
    // production helper; returning false exercises its Range fallback.
    Object.defineProperty(document, 'execCommand', {
      configurable: true,
      value: vi.fn(() => false),
    });
  });

  afterEach(() => {
    document.body.innerHTML = '';
    Reflect.deleteProperty(document, 'execCommand');
    delete window.getClipboardFilePath;
  });

  it('registers and normalizes multiple explicit paths with spaces', () => {
    const editable = createEditable();
    placeCaretAtEnd(editable);
    const { result, pathMappingRef } = setupPasteHook(editable);

    result.current.handlePaste(createPasteEvent(
      '@C:\\Program Files\\demo\\view file.xml @/workspace/src/index.vue'
    ));

    expect(editable.textContent).toBe(
      '@C:\\Program Files\\demo\\view file.xml @/workspace/src/index.vue '
    );
    expect(pathMappingRef.current.get('view file.xml'))
      .toBe('C:\\Program Files\\demo\\view file.xml');
    expect(pathMappingRef.current.get('/workspace/src/index.vue'))
      .toBe('/workspace/src/index.vue');
  });

  it('keeps mixed ordinary text unchanged and does not register its @ text', () => {
    const editable = createEditable();
    placeCaretAtEnd(editable);
    const { result, pathMappingRef } = setupPasteHook(editable);
    const mixedText = 'const email = "user@example.com"; @/workspace/src/index.vue';

    result.current.handlePaste(createPasteEvent(mixedText));

    expect(editable.textContent).toBe(mixedText);
    expect(pathMappingRef.current.size).toBe(0);
  });

  it('keeps trailing prose after an absolute-looking reference unchanged', () => {
    const editable = createEditable();
    placeCaretAtEnd(editable);
    const { result, pathMappingRef } = setupPasteHook(editable);
    const mixedText = '@C:\\workspace\\view.xml please review';

    result.current.handlePaste(createPasteEvent(mixedText));

    expect(editable.textContent).toBe(mixedText);
    expect(pathMappingRef.current.size).toBe(0);
  });

  it('registers a pasted line reference with a spaced path', () => {
    const editable = createEditable();
    placeCaretAtEnd(editable);
    const { result, pathMappingRef } = setupPasteHook(editable);

    result.current.handlePaste(createPasteEvent(
      '@C:\\Program Files\\src\\Main.java#L10-12'
    ));

    expect(editable.textContent).toBe('@C:\\Program Files\\src\\Main.java#L10-12 ');
    expect(pathMappingRef.current.get('C:\\Program Files\\src\\Main.java#L10-12'))
      .toBe('C:\\Program Files\\src\\Main.java');
  });

  it('registers a real clipboard file returned by the Java bridge', async () => {
    const editable = createEditable();
    placeCaretAtEnd(editable);
    const { result, pathMappingRef } = setupPasteHook(editable);
    window.getClipboardFilePath = vi.fn().mockResolvedValue(
      'C:\\Program Files\\demo\\view file.xml'
    );
    const event = {
      clipboardData: {
        items: [{ kind: 'file', type: 'application/xml' }],
        getData: () => '',
      },
      preventDefault: vi.fn(),
    } as unknown as React.ClipboardEvent;

    await act(async () => {
      result.current.handlePaste(event);
      await Promise.resolve();
    });

    expect(editable.textContent).toBe('@C:\\Program Files\\demo\\view file.xml ');
    expect(pathMappingRef.current.get('view file.xml'))
      .toBe('C:\\Program Files\\demo\\view file.xml');
  });
});

/** Collects the attachment state the hook writes, mirroring the real setter. */
function createAttachmentStore() {
  let attachments: Attachment[] = [];
  const setInternalAttachments = vi.fn((updater: unknown) => {
    attachments = typeof updater === 'function'
      ? (updater as (prev: Attachment[]) => Attachment[])(attachments)
      : (updater as Attachment[]);
  });

  return {
    getAttachments: () => attachments,
    setInternalAttachments:
      setInternalAttachments as unknown as React.Dispatch<React.SetStateAction<Attachment[]>>,
  };
}

/** Replaces happy-dom's asynchronous FileReader with a synchronous one. */
function stubSynchronousFileReader(): () => void {
  const originalFileReader = globalThis.FileReader;

  class MockFileReader {
    public result: string | null = 'data:image/png;base64,c2hvdA==';
    public onload: ((this: FileReader, ev: ProgressEvent<FileReader>) => unknown) | null = null;

    readAsDataURL(this: FileReader): void {
      this.onload?.(new ProgressEvent('load') as ProgressEvent<FileReader>);
    }
  }

  // @ts-expect-error test override
  globalThis.FileReader = MockFileReader;

  return () => {
    globalThis.FileReader = originalFileReader;
  };
}

function createImagePasteEvent(file: File): React.ClipboardEvent {
  return {
    clipboardData: {
      items: [{ kind: 'file', type: file.type, getAsFile: () => file }],
      getData: () => '',
    },
    preventDefault: vi.fn(),
  } as unknown as React.ClipboardEvent;
}

describe('usePasteAndDrop clipboard images', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('attaches a single image when the Java bridge echoes the webview paste', () => {
    const restoreFileReader = stubSynchronousFileReader();
    try {
      const editable = createEditable();
      const store = createAttachmentStore();
      const { result } = setupPasteHook(editable, store.setInternalAttachments);

      result.current.handlePaste(
        createImagePasteEvent(new File(['shot'], 'shot.png', { type: 'image/png' }))
      );
      expect(store.getAttachments()).toHaveLength(1);

      // CefPasteHook / ClipboardHandler hand the same clipboard image over for
      // the very same Cmd+V.
      act(() => {
        window.dispatchEvent(new CustomEvent('java-paste-image', {
          detail: { base64: store.getAttachments()[0].data, mediaType: 'image/png' },
        }));
      });

      expect(store.getAttachments()).toHaveLength(1);
    } finally {
      restoreFileReader();
    }
  });

  it('collapses two identical Java deliveries into one attachment', () => {
    const editable = createEditable();
    const store = createAttachmentStore();
    setupPasteHook(editable, store.setInternalAttachments);

    const dispatchJavaPasteImage = () => {
      act(() => {
        window.dispatchEvent(new CustomEvent('java-paste-image', {
          detail: { base64: 'c2hvdA==', mediaType: 'image/png' },
        }));
      });
    };

    dispatchJavaPasteImage();
    dispatchJavaPasteImage();

    expect(store.getAttachments()).toHaveLength(1);
  });
});
