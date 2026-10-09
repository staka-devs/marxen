import { useEffect, useRef, type ReactNode, type DragEvent } from "react";
import { EditorView } from "@codemirror/view";
import { isImagePath, WORKSPACE_IMAGE_DRAG, WORKSPACE_IMAGE_POINTER_DROP } from "../../domain/workspace-files";
import type { Utf16Range } from "../../contracts/contracts";

export type ImageDrop = { kind: "workspace"; path: string } | { kind: "native"; paths: string[] } | { kind: "files"; files: File[] };

/** Native drop subscription injected by the composition root (Tauri webview). */
export type NativeDropSubscribe = (
  onDrop: (drop: { position: { x: number; y: number }; paths: string[] }) => void,
) => Promise<() => void>;

interface Props {
  children: ReactNode;
  enabled: boolean;
  hidden?: boolean;
  selection: Utf16Range;
  /** Route a resolved drop with its editor range. */
  onDrop: (drop: ImageDrop, range: Utf16Range) => void;
  /** Report drop validation failures for notices. */
  onError: (message: string) => void;
  /** True on desktop where native drops are available; browser stays HTML5-only. */
  desktop?: boolean;
  /** Native subscription from infrastructure; omitted disables native drops. */
  subscribeNativeDrop?: NativeDropSubscribe;
}

/**
 * Own image drops before CodeMirror, using its UTF-16 position at the pointer.
 *
 * Internal pointer drags, HTML5 file drops, and injected native drops all
 * resolve through `rangeAt` so pastes land at the pointer. Native handling is
 * fully injected (`desktop` + `subscribeNativeDrop`) so this view never
 * imports the Tauri transport directly.
 */
export function ImageDropZone({ children, enabled, hidden = false, selection, onDrop, onError, desktop = false, subscribeNativeDrop }: Props) {
  const element = useRef<HTMLDivElement>(null);
  const composing = useRef(false);
  const latest = useRef({ enabled, selection, onDrop, onError });
  latest.current = { enabled, selection, onDrop, onError };
  /** Resolve a pointer position to a UTF-16 range, falling back to selection. */
  const rangeAt = (x: number, y: number): Utf16Range => {
    const editor = element.current?.querySelector<HTMLElement>(".cm-editor");
    const bounds = editor?.getBoundingClientRect();
    const position = editor && bounds?.width && bounds?.height ? EditorView.findFromDOM(editor)?.posAtCoords({ x, y }) : null;
    return position === null || position === undefined ? latest.current.selection : { start: position, end: position };
  };
  // Native file-drop handling suppresses HTML5 drag/drop on Windows.
  // Pointer-driven internal drags stay in the DOM while native imports remain enabled.
  useEffect(() => {
    /** Route internal pointer drops landing inside the editor bounds. */
    const handlePointerDrop = (event: Event) => {
      if (!latest.current.enabled || composing.current) return;
      const { path, x, y } = (event as CustomEvent<{ path: string; x: number; y: number }>).detail;
      const bounds = element.current?.getBoundingClientRect();
      if (!bounds || !bounds.width || x < bounds.left || x > bounds.right || y < bounds.top || y > bounds.bottom || !isImagePath(path)) return;
      latest.current.onDrop({ kind: "workspace", path }, rangeAt(x, y));
    };
    window.addEventListener(WORKSPACE_IMAGE_POINTER_DROP, handlePointerDrop);
    return () => window.removeEventListener(WORKSPACE_IMAGE_POINTER_DROP, handlePointerDrop);
  }, []);
  useEffect(() => {
    if (!enabled || !desktop || !subscribeNativeDrop) return;
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    try {
      void subscribeNativeDrop(({ position, paths }) => {
        if (!latest.current.enabled || composing.current) return;
        const x = position.x / window.devicePixelRatio;
        const y = position.y / window.devicePixelRatio;
        const bounds = element.current?.getBoundingClientRect();
        if (!bounds || bounds.width === 0 || x < bounds.left || x > bounds.right || y < bounds.top || y > bounds.bottom) return;
        if (paths.length === 0 || paths.length > 16 || paths.some(path => !isImagePath(path))) {
          latest.current.onError("対応画像（PNG/JPEG/GIF/WebP、最大16枚）のみドロップできます。");
          return;
        }
        latest.current.onDrop({ kind: "native", paths }, rangeAt(x, y));
      }).then(stop => { if (cancelled) stop(); else unlisten = stop; }).catch(() => {
        if (!cancelled) latest.current.onError("ネイティブの画像ドロップを利用できません。");
      });
    } catch {
      // A browser harness cannot provide a real native webview.
    }
    return () => { cancelled = true; unlisten?.(); };
  }, [enabled, desktop, subscribeNativeDrop]);
  /** Check whether a drag carries workspace images or files. */
  const owns = (event: DragEvent) => Array.from(event.dataTransfer.types).some(type => type === WORKSPACE_IMAGE_DRAG || type === "Files");
  return <div ref={element} hidden={hidden} className={hidden ? "hidden" : "min-h-0 min-w-0 h-full"} data-testid="image-drop-zone"
    onCompositionStartCapture={() => { composing.current = true; }}
    onCompositionEndCapture={() => { composing.current = false; }}
    onDragOverCapture={event => {
      if (!owns(event)) return;
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = enabled && !composing.current ? "copy" : "none";
    }}
    onDropCapture={event => {
      if (!owns(event)) return;
      event.preventDefault();
      event.stopPropagation();
      if (!enabled || composing.current) return;
      const path = event.dataTransfer.getData(WORKSPACE_IMAGE_DRAG);
      const range = rangeAt(event.clientX, event.clientY);
      if (path) { if (isImagePath(path)) onDrop({ kind: "workspace", path }, range); return; }
      const files = Array.from(event.dataTransfer.files);
      if (files.length === 0 || files.length > 16 || files.some(file => !isImagePath(file.name))) {
        onError("対応画像（PNG/JPEG/GIF/WebP、最大16枚）のみドロップできます。");
        return;
      }
      onDrop({ kind: "files", files }, range);
    }}
  >{children}</div>;
}
