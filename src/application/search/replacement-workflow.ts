import type { DocumentSnapshot, SearchMatch, SearchOptions, SearchReplacePlan, TextEdit, SaveRequest } from "../../contracts/contracts";
import type { WorkspaceGateway } from "../ports";

/** Revision-bound edit capability consumed by the search replacement workflow. */
export interface SearchEditPort {
  /** Serialize an edit and recheck its lifecycle guard immediately before sending it. */
  applyEdits(request: SaveRequest, edits: TextEdit[], current: () => boolean): Promise<DocumentSnapshot>;
}

/** One replacement run over a captured, complete native result set. */
export interface ReplacementRun {
  root: string;
  query: string;
  options: SearchOptions;
  replacement: string;
  hits: SearchMatch[];
  all: boolean;
  /** Fence asynchronous preparation and queued mutations against changed context. */
  current: () => boolean;
  /** Install a native plan's document without guessing a revision. */
  opened: (plan: SearchReplacePlan) => void;
  /** Install an acknowledged native edit even when cancellation follows its commit. */
  changed: (snapshot: DocumentSnapshot) => void;
  /** Resolve the owning workspace root for one hit; defaults to the single run root. */
  rootFor?: (hit: SearchMatch) => string;
}

/** Successful edits before a failure or context cancellation; buffers remain unsaved. */
export interface ReplacementOutcome {
  count: number;
  files: number;
  cancelled: boolean;
  failure?: unknown;
}

/** Execute file plans serially, preserving partial acknowledgements without automatic save. */
export async function replaceSearchResults(gateway: WorkspaceGateway, editor: SearchEditPort, run: ReplacementRun): Promise<ReplacementOutcome> {
  const outcome: ReplacementOutcome = { count: 0, files: 0, cancelled: false };
  /** Key files by owning root incarnation and relative path so same names never collapse. */
  const fileKey = (hit: SearchMatch): string =>
    `${hit.scope?.rootId ?? run.root}::${hit.scope?.generation ?? ""}::${hit.path}`;
  const hits = run.all ? [...new Map(run.hits.map((hit) => [fileKey(hit), hit])).values()] : run.hits.slice(0, 1);
  for (const hit of hits) {
    if (!run.current()) { outcome.cancelled = true; break; }
    try {
      const root = run.rootFor ? run.rootFor(hit) : run.root;
      const plan = await gateway.planSearchReplacement({
        ...(hit.location ? { location: hit.location } : {}),
        ...(hit.documentId ? { documentId: hit.documentId } : {}),
        ...(hit.scope ? { scope: hit.scope } : {}),
        root, path: hit.path, query: run.query, options: run.options,
        replacement: run.replacement, contentToken: hit.contentToken,
        revision: hit.revision, range: run.all ? null : hit.range,
      });
      if (!run.current()) { outcome.cancelled = true; break; }
      run.opened(plan);
      const snapshot = await editor.applyEdits({ ...(plan.document.snapshot.location ? { location: plan.document.snapshot.location } : {}), documentId: plan.document.snapshot.documentId, baseRevision: plan.document.snapshot.revision }, plan.edits, run.current);
      outcome.count += plan.edits.length;
      outcome.files += 1;
      run.changed(snapshot);
    } catch (failure) {
      outcome.cancelled = !run.current();
      outcome.failure = failure;
      break;
    }
  }
  return outcome;
}
