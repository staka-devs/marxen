import { useRef, useState } from "react";
import { ChevronDown, ChevronRight, FileCode2, FileText, Folder, FolderOpen, Image, FileType2 } from "lucide-react";
import type { WorkspaceEntry, WorkspaceFileKind } from "../../shared/contracts";
import { entryKind, WORKSPACE_IMAGE_DRAG, WORKSPACE_IMAGE_POINTER_DROP } from "../../lib/workspace-files";
import { isDesktop } from "../../lib/workspace";

export interface TreeNode {
  path: string;
  name: string;
  directory: boolean;
  markdown: boolean;
  kind?: WorkspaceFileKind;
  children?: TreeNode[];
}

export function buildTree(entries: WorkspaceEntry[]): TreeNode[] {
  const roots: TreeNode[] = [];
  const dirs = new Map<string, TreeNode>();
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
  onOpenFile: (path: string) => void;
}
type NodeProps = Omit<Props, "nodes"> & { node: TreeNode; depth: number };

function Node({ node, activePath, onOpenFile, depth }: NodeProps) {
  const [open, setOpen] = useState(depth < 1);
  const pointer = useRef<{ x: number; y: number; dragging: boolean } | null>(null);
  const suppressClick = useRef(false);
  const selected = activePath === node.path;
  const Icon = node.directory ? (open ? FolderOpen : Folder)
    : node.kind === "image" ? Image : node.markdown ? FileType2
    : /\.(jsonc?|ya?ml|toml|[cm]?jsx?|tsx?|rs|py|css|html?|lua|vim)$/i.test(node.path) ? FileCode2 : FileText;
  return (
    <li role="treeitem" aria-level={depth + 1} aria-selected={selected} aria-expanded={node.directory ? open : undefined}>
      <button
        type="button"
        aria-expanded={node.directory ? open : undefined}
        aria-selected={selected} aria-current={selected ? "true" : undefined}
        aria-label={node.path} title={node.path}
        onClick={() => {
          if (suppressClick.current) { suppressClick.current = false; return; }
          if (node.directory) setOpen(value => !value);
          else onOpenFile(node.path);
        }}
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
          if (isDesktop()) { event.preventDefault(); return; }
          pointer.current = null;
          event.dataTransfer.effectAllowed = "copy";
          event.dataTransfer.setData(WORKSPACE_IMAGE_DRAG, node.path);
        }}
        className={`flex w-full items-center gap-1.5 truncate border-l-2 py-1 pr-2 text-left text-xs hover:bg-muted ${selected ? "border-primary bg-muted font-medium text-foreground" : "border-transparent text-muted-foreground"}`}
        style={{ paddingLeft: 6 + depth * 14 }}
      >
        {node.directory ? (open ? <ChevronDown size={12} aria-hidden /> : <ChevronRight size={12} aria-hidden />) : <span className="w-3 shrink-0" />}
        <Icon size={15} aria-hidden data-file-icon={node.directory ? (open ? "folder-open" : "folder") : node.kind} className="shrink-0" />
        <span className="truncate">{node.name}</span>
      </button>
      {node.directory && open && <ul role="group">{(node.children ?? []).map(child =>
        <Node key={child.path} node={child} activePath={activePath} onOpenFile={onOpenFile} depth={depth + 1} />
      )}</ul>}
    </li>
  );
}

export function FileTree({ nodes, activePath, onOpenFile }: Props) {
  return <nav data-testid="file-tree" aria-label="フォルダーツリー" className="overflow-auto">
    <ul role="tree" aria-label="ワークスペース" className="py-1">{nodes.map(node =>
      <Node key={node.path} node={node} activePath={activePath} onOpenFile={onOpenFile} depth={0} />
    )}</ul>
  </nav>;
}
