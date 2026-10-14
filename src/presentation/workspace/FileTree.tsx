import { useI18n } from "../i18n/I18nProvider";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { ChevronDown, ChevronRight, FileCode2, FileText, Folder, FolderOpen, Image } from "lucide-react";
import type { WorkspaceEntry, WorkspaceFileKind } from "../../contracts/contracts";
import { entryKind, WORKSPACE_IMAGE_DRAG, WORKSPACE_IMAGE_POINTER_DROP } from "../../domain/workspace-files";
import type { WorkbenchCommand } from "../../contracts/workbench";
import type { ThemeId } from "../../domain/workspace-content";
import { CommandMenu } from "./CommandMenu";

export interface TreeNode {
  path: string;
  name: string;
  directory: boolean;
  markdown: boolean;
  kind?: WorkspaceFileKind;
  children?: TreeNode[];
}

/**
 * Build a sorted tree from flat workspace entries, filtering binaries.
 *
 * Directories sort before files with Japanese collation; only entries with a
 * known kind (markdown/text/image) become file nodes so binaries stay hidden.
 */
export function buildTree(entries: WorkspaceEntry[]): TreeNode[] {
  const roots: TreeNode[] = [];
  const dirs = new Map<string, TreeNode>();
  /** Ensure the directory node for a path, creating ancestors as needed. */
  const ensureDir = (path: string): TreeNode => {
    const existing = dirs.get(path);
    if (existing) return existing;
    const node: TreeNode = { path, name: path.split("/").pop() ?? path, directory: true, markdown: false, children: [] };
    dirs.set(path, node);
    const parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : null;
    if (!parent) roots.push(node);
    else ensureDir(parent).children?.push(node);
    return node;
  };
  for (const entry of entries) {
    if (entry.directory) { ensureDir(entry.path); continue; }
    const kind = entryKind(entry);
    if (!kind) continue;
    const node: TreeNode = { ...entry, kind };
    const parent = entry.path.includes("/") ? entry.path.slice(0, entry.path.lastIndexOf("/")) : null;
    if (!parent) roots.push(node);
    else ensureDir(parent).children?.push(node);
  }
  /** Sort folders before files with Japanese collation, recursively. */
  const sort = (nodes: TreeNode[]) => {
    nodes.sort((a, b) => a.directory === b.directory ? a.name.localeCompare(b.name, "ja") : a.directory ? -1 : 1);
    for (const node of nodes) if (node.children) sort(node.children);
  };
  sort(roots);
  return roots;
}

interface Props {
  nodes: TreeNode[];
  activePath: string | null;
  /** Open the file at a workspace-relative path. */
  onOpenFile: (path: string) => void;
  /** True on desktop where native drops own image drags; HTML5 drag stays browser-only. */
  desktop?: boolean;
  rootName?: string;
  rootPath?: string;
  selectedPath?: string | null;
  theme?: ThemeId;
  /** Capture a focused or context-selected tree row without opening its document. */
  onSelect?: (node: TreeNode) => void;
  /** Resolve visible capability state for this exact context-menu target. */
  contextCommands?: (node: TreeNode) => WorkbenchCommand[];
  /** Run a tree command through the workbench dispatcher. */
  onCommand?: (id: string, node: TreeNode) => void;
}
interface NodeProps extends Pick<Props, "activePath" | "onOpenFile" | "desktop" | "rootPath"> {
  node: TreeNode;
  depth: number;
  selectedPath: string | null;
  focusedPath: string;
  expanded: Set<string>;
  /** Toggle this directory without affecting native buffers. */
  onToggle: (path: string) => void;
  /** Select one explicit tree location. */
  onSelect: (node: TreeNode) => void;
  /** Navigate visible rows or invoke a contextual keyboard action. */
  onKey: (event: KeyboardEvent<HTMLButtonElement>, node: TreeNode) => void;
  /** Open a context menu at a captured pointer or keyboard location. */
  onContext: (node: TreeNode, x: number, y: number, origin: HTMLButtonElement) => void;
}

/**
 * Render one tree row with folder toggle, image drag/pointer-drop, and selection.
 *
 * Pointer drags past 5px dispatch an internal drop event; HTML5 drags carry
 * the workspace path on desktop they are suppressed for native handling.
 */
function Node({ node, activePath, onOpenFile, depth, desktop = false, selectedPath, focusedPath, expanded, onToggle, onSelect, onKey, onContext, rootPath }: NodeProps) {
  const open = expanded.has(node.path);
  const pointer = useRef<{ x: number; y: number; dragging: boolean } | null>(null);
  const suppressClick = useRef(false);
  const selected = selectedPath === node.path;
  const Icon = node.directory ? (open ? FolderOpen : Folder)
    : node.kind === "image" ? Image : node.markdown ? FileText
    : /\.(jsonc?|ya?ml|toml|[cm]?jsx?|tsx?|rs|py|css|html?|lua|vim)$/i.test(node.path) ? FileCode2 : FileText;
  return (
    <li role="treeitem" aria-level={depth + 1} aria-selected={selected} aria-expanded={node.directory ? open : undefined}>
      <button
        type="button"
        tabIndex={focusedPath === node.path ? 0 : -1}
        data-tree-path={node.path}
        aria-expanded={node.directory ? open : undefined}
        aria-selected={selected} aria-current={activePath === node.path ? "true" : undefined}
        aria-label={node.path || node.name} title={node.path || rootPath || node.name}
        onClick={() => {
          if (suppressClick.current) { suppressClick.current = false; return; }
          onSelect(node);
          if (node.directory) onToggle(node.path);
          else onOpenFile(node.path);
        }}
        onFocus={() => onSelect(node)}
        onKeyDown={(event) => onKey(event, node)}
        onContextMenu={(event) => { event.preventDefault(); onContext(node, event.clientX, event.clientY, event.currentTarget); }}
        onPointerDown={event => {
          if (node.kind !== "image" || event.button !== 0) return;
          pointer.current = { x: event.clientX, y: event.clientY, dragging: false };
          event.currentTarget.setPointerCapture?.(event.pointerId);
        }}
        onPointerMove={event => {
          const start = pointer.current;
          if (start && Math.hypot(event.clientX - start.x, event.clientY - start.y) > 5) start.dragging = true;
        }}
        onPointerUp={event => {
          const start = pointer.current;
          pointer.current = null;
          if (!start?.dragging) return;
          suppressClick.current = true;
          event.preventDefault();
          window.dispatchEvent(new CustomEvent(WORKSPACE_IMAGE_POINTER_DROP, {
            detail: { path: node.path, x: event.clientX, y: event.clientY },
          }));
        }}
        onPointerCancel={() => { pointer.current = null; }}
        draggable={node.kind === "image"}
        onDragStart={event => {
          if (node.kind !== "image") return;
          if (desktop) { event.preventDefault(); return; }
          pointer.current = null;
          event.dataTransfer.effectAllowed = "copy";
          event.dataTransfer.setData(WORKSPACE_IMAGE_DRAG, node.path);
        }}
        className={`marxen-tree-row flex h-7 w-full items-center gap-1.5 truncate border-l-2 pr-3 text-left text-xs hover:bg-muted/50 ${selected ? "border-primary bg-primary/10 text-foreground" : "border-transparent text-foreground/85"}`}
        style={{ paddingLeft: 6 + depth * 16 }}
      >
        {node.directory ? (open ? <ChevronDown size={12} aria-hidden /> : <ChevronRight size={12} aria-hidden />) : <span className="w-3 shrink-0" />}
        <Icon size={15} aria-hidden data-file-icon={node.directory ? (open ? "folder-open" : "folder") : node.kind} className={`shrink-0 ${node.directory ? "text-[#bdad87]" : node.markdown ? "text-primary/70" : "text-muted-foreground"}`} />
        <span className="truncate">{node.name}</span>
      </button>
      {node.directory && open && <ul role="group" className="marxen-tree-children" style={{ "--tree-indent": `${20 + depth * 16}px` } as React.CSSProperties}>{(node.children ?? []).map(child =>
        <Node key={child.path} node={child} activePath={activePath} onOpenFile={onOpenFile} depth={depth + 1} desktop={desktop} selectedPath={selectedPath} focusedPath={focusedPath} expanded={expanded} onToggle={onToggle} onSelect={onSelect} onKey={onKey} onContext={onContext} />
      )}</ul>}
    </li>
  );
}

/**
 * Render the workspace file tree with selection and image drag support.
 *
 * `desktop` switches image drags to native handling; the composition root
 * injects it so this view never imports the Tauri transport directly.
 */
export function FileTree({ nodes, activePath, onOpenFile, desktop = false, rootName, rootPath, selectedPath = activePath, onSelect, contextCommands, onCommand, theme }: Props) {
  const { t } = useI18n();
  const roots: TreeNode[] = rootName ? [{ path: "", name: rootName, directory: true, markdown: false, children: nodes }] : nodes;
  const host = useRef<HTMLElement>(null);
  const [expanded, setExpanded] = useState(() => new Set([...roots, ...(rootName ? nodes : [])].filter((node) => node.directory).map((node) => node.path)));
  const [focused, setFocused] = useState(roots[0]?.path ?? "");
  const [context, setContext] = useState<{ node: TreeNode; point: { x: number; y: number }; origin: HTMLButtonElement } | null>(null);
  useEffect(() => {
    if (selectedPath === null) return;
    setExpanded((previous) => { const next = new Set(previous); if (rootName) next.add(""); const parts = selectedPath.split("/"); for (let i = 1; i < parts.length; i++) next.add(parts.slice(0, i).join("/")); return next; });
    setFocused(selectedPath);
  }, [selectedPath, rootName]);
  const visible: TreeNode[] = [];
  /** Flatten only expanded directories for standard roving tree navigation. */
  function collect(items: TreeNode[]) { for (const item of items) { visible.push(item); if (item.directory && expanded.has(item.path)) collect(item.children ?? []); } }
  collect(roots);
  const roving = visible.some((node) => node.path === focused) ? focused : visible[0]?.path ?? "";
  /** Select a row independently of its open-document state. */
  function select(node: TreeNode) { setFocused(node.path); onSelect?.(node); }
  /** Move focus to an existing visible row without opening a buffer. */
  function focus(path: string) {
    setFocused(path);
    const button = [...(host.current?.querySelectorAll<HTMLButtonElement>("[data-tree-path]") ?? [])].find((item) => item.dataset.treePath === path);
    button?.focus(); button?.scrollIntoView?.({ block: "nearest" });
  }
  /** Toggle one folder, preserving every other expansion through refresh. */
  function toggle(path: string) { setExpanded((previous) => { const next = new Set(previous); if (next.has(path)) next.delete(path); else next.add(path); return next; }); }
  /** Select the captured row and open its menu without opening its document. */
  function openContext(node: TreeNode, x: number, y: number, origin: HTMLButtonElement) { select(node); origin.focus(); if (contextCommands) setContext({ node, point: { x, y }, origin }); }
  /** Restore the originating row only after explicit menu dismissal or execution. */
  function dismiss(restore = true) { setContext(null); if (restore) context?.origin.focus(); }
  /** Handle visible-row traversal, folder hierarchy and explicit contextual commands. */
  function key(event: KeyboardEvent<HTMLButtonElement>, node: TreeNode) {
    if (event.nativeEvent.isComposing) return;
    const at = visible.findIndex((item) => item.path === node.path);
    if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault(); event.stopPropagation();
      const next = event.key === "Home" ? 0 : event.key === "End" ? visible.length - 1 : Math.max(0, Math.min(visible.length - 1, at + (event.key === "ArrowDown" ? 1 : -1)));
      if (visible[next]) focus(visible[next].path);
    } else if (event.key === "Enter") { event.preventDefault(); select(node); if (node.directory) toggle(node.path); else onOpenFile(node.path); }
    else if (event.key === " ") { event.preventDefault(); select(node); }
    else if (event.key === "ArrowRight" && node.directory) { event.preventDefault(); if (!expanded.has(node.path)) toggle(node.path); else if (node.children?.[0]) focus(node.children[0].path); }
    else if (event.key === "ArrowLeft") { event.preventDefault(); if (node.directory && expanded.has(node.path)) toggle(node.path); else focus(node.path.includes("/") ? node.path.slice(0, node.path.lastIndexOf("/")) : ""); }
    else if (event.key === "F2") { event.preventDefault(); event.stopPropagation(); onCommand?.("file-rename", node); }
    else if (event.key === "ContextMenu" || event.key === "Menu" || (event.key === "F10" && event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey)) { event.preventDefault(); event.stopPropagation(); const bounds = event.currentTarget.getBoundingClientRect(); openContext(node, bounds.left + 12, bounds.bottom, event.currentTarget); }
  }
  return <nav ref={host} data-testid="file-tree" aria-label={t("フォルダーツリー")} className="overflow-auto">
    <ul role="tree" aria-label={t("ワークスペース")} className="py-1">{roots.map(node =>
      <Node rootPath={rootPath} key={node.path} node={node} activePath={activePath} onOpenFile={onOpenFile} depth={0} desktop={desktop} selectedPath={selectedPath ?? roving} focusedPath={roving} expanded={expanded} onToggle={toggle} onSelect={select} onKey={key} onContext={openContext} />
    )}</ul>
    {context && <CommandMenu label={t("エクスプローラーの操作")} point={context.point} commands={contextCommands?.(context.node) ?? []} onRun={(id) => onCommand?.(id, context.node)} onDismiss={dismiss} theme={theme} />}
  </nav>;
}
