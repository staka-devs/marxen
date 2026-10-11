import { useState } from "react";
import type { WorkspaceEntry } from "../../shared/contracts";

export interface TreeNode {
  path: string;
  name: string;
  directory: boolean;
  markdown: boolean;
  children?: TreeNode[];
}

/** Build a nested tree from flat workspace-relative entry paths. */
export function buildTree(entries: WorkspaceEntry[]): TreeNode[] {
  const roots: TreeNode[] = [];
  const dirs = new Map<string, TreeNode>();
  const ensureDir = (path: string): TreeNode => {
    const existing = dirs.get(path);
    if (existing) return existing;
    const name = path.split("/").pop() ?? path;
    const node: TreeNode = { path, name, directory: true, markdown: false, children: [] };
    dirs.set(path, node);
    const parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : null;
    if (parent === null || parent === "") roots.push(node);
    else ensureDir(parent).children?.push(node);
    return node;
  };
  for (const entry of entries) {
    if (entry.directory) {
      ensureDir(entry.path);
      continue;
    }
    const node: TreeNode = { path: entry.path, name: entry.name, directory: false, markdown: entry.markdown };
    const parent = entry.path.includes("/") ? entry.path.slice(0, entry.path.lastIndexOf("/")) : null;
    if (parent === null || parent === "") roots.push(node);
    else ensureDir(parent).children?.push(node);
  }
  const sort = (nodes: TreeNode[]) => {
    nodes.sort((a, b) => (a.directory === b.directory ? a.name.localeCompare(b.name, "ja") : a.directory ? -1 : 1));
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

interface NodeProps {
  node: TreeNode;
  activePath: string | null;
  onOpenFile: (path: string) => void;
  depth: number;
}

function Node({ node, activePath, onOpenFile, depth }: NodeProps) {
  const [open, setOpen] = useState(depth < 1);
  if (node.directory) {
    return (
      <li>
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          className="w-full truncate rounded-md px-3 py-1.5 text-left text-sm text-muted-foreground hover:bg-muted"
          style={{ paddingLeft: `${12 + depth * 12}px` }}
        >
          {open ? "▼" : "▶"} {node.name}
        </button>
        {open && (
          <ul className="space-y-1">
            {(node.children ?? []).map((child) => (
              <Node key={child.path} node={child} activePath={activePath} onOpenFile={onOpenFile} depth={depth + 1} />
            ))}
          </ul>
        )}
      </li>
    );
  }
  if (!node.markdown) {
    return (
      <li aria-disabled="true" title="Markdown ファイルのみ開けます" className="truncate rounded-md px-3 py-1.5 text-sm text-muted-foreground/60" style={{ paddingLeft: `${12 + depth * 12}px` }}>
        {node.name}
      </li>
    );
  }
  return (
    <li>
      <button
        type="button"
        onClick={() => onOpenFile(node.path)}
        aria-current={activePath === node.path ? "true" : undefined}
        className={`w-full truncate rounded-md px-3 py-1.5 text-left text-sm hover:bg-muted ${activePath === node.path ? "bg-muted font-medium" : ""}`}
        style={{ paddingLeft: `${12 + depth * 12}px` }}
      >
        {node.path}
      </button>
    </li>
  );
}

export function FileTree({ nodes, activePath, onOpenFile }: Props) {
  return (
    <nav data-testid="file-tree" aria-label="フォルダーツリー" className="overflow-auto">
      <p className="px-3 pb-2 text-xs font-semibold tracking-wider text-muted-foreground">エクスプローラー</p>
      <ul className="space-y-1 px-2">
        {nodes.map((node) => (
          <Node key={node.path} node={node} activePath={activePath} onOpenFile={onOpenFile} depth={0} />
        ))}
      </ul>
    </nav>
  );
}
