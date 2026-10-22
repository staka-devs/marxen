import { useEffect, useState } from "react";
import type { WorkspaceGateway } from "../../../application/ports";
import type { OpenDoc } from "../../../application/document/document-helpers";

/**
 * HEAD text of the active file for the change gutter (Issue #124); refreshed on open and save.
 *
 * Returns null while loading, outside Git, or when the file is not committed.
 */
export function useGitHead(active: OpenDoc | null, gateway: WorkspaceGateway | undefined): string | null {
  const [head, setHead] = useState<{ documentId: string; text: string | null } | null>(null);
  const scope = active?.location?.scope;
  useEffect(() => {
    if (!active?.path || !scope || !gateway?.gitHeadText) { setHead(null); return; }
    let current = true;
    const documentId = active.documentId;
    gateway.gitHeadText(scope, active.path)
      .then((text) => { if (current) setHead({ documentId, text }); })
      .catch(() => { if (current) setHead(null); });
    return () => { current = false; };
  }, [active?.documentId, active?.path, active?.dirty, scope?.rootId, scope?.generation, gateway]);
  return head && head.documentId === active?.documentId ? head.text : null;
}
