// Generated from src-tauri/src/contracts/isolation.rs. Run npm run isolation-contracts:generate.
// Do not edit by hand. Isolation IPC schema version 2.
import type { DocumentId, Revision, Utf16Range } from "./contracts";
import type { IsolatedCopyId } from "./ai-contracts";
export type IsolatedCopyDoc = { documentId: DocumentId, revision: Revision, path: string | null, ranges: Array<Utf16Range>, fullDocument: boolean, };
export type IsolatedCopyInfo = { copyId: IsolatedCopyId, documents: Array<IsolatedCopyDoc>, };
export type IsolationDiff = { documentId: DocumentId, path: string | null, range: Utf16Range, baseRevision: Revision, liveRevision: Revision,
/**
 * Live buffer moved since the copy; approve will refuse until resync.
 */
drifted: boolean, changed: boolean, unified: string, stagingChars: number, liveChars: number, };
export type ApproveDocOutcome = { documentId: DocumentId, applied: boolean, revision: Revision, error: string | null, rolledBack: boolean, rollbackError: string | null, };
export type ApproveResult = { copyId: IsolatedCopyId, outcomes: Array<ApproveDocOutcome>, };
export type StagedProposal = { copyId: IsolatedCopyId, updated: Array<DocumentId>, chars: number, };
