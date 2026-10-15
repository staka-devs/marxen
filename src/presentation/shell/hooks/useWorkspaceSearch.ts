import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SearchMatch, SearchOptions, SearchResults } from "../../../contracts/contracts";
import type { LocalizedText } from "../../../contracts/localization";
import type { WorkspaceGateway } from "../../../application/ports";
import { docFromOpen, matchToHit } from "../../../application/document/document-helpers";
import { replaceSearchResults } from "../../../application/search/replacement-workflow";
import type { SearchHitItem } from "../../../domain/search-hit";
import { DEFAULT_SEARCH_OPTIONS, searchIdentity } from "../../../domain/search";
import { localizedFailure, renderLocalizedText } from "../../../domain/localization";
import { StaleResync, workspaceErrorText } from "../../../domain/document-errors";
import { searchWorkspace as searchLocal } from "../../../domain/workspace-content";
import { isSearchablePath } from "../../../domain/workspace-files";
import { useI18n } from "../../i18n/I18nProvider";
import type { DocumentSession } from "./useDocumentSession";

/** Search ports and document lifecycle supplied by workspace composition. */
interface Args {
  desktop: boolean;
  root: string | null;
  gateway?: WorkspaceGateway;
  session: DocumentSession;
  /** Surface localized search and partial replacement outcomes. */
  notify: (notice: LocalizedText | null) => void;
}

/** Debounced native search with context fences and serialized, revision-bound replacement. */
export function useWorkspaceSearch({ desktop, root, gateway, session, notify }: Args) {
  const { t, message } = useI18n();
  const [query, setQuery] = useState("");
  const [options, setOptions] = useState<SearchOptions>(DEFAULT_SEARCH_OPTIONS);
  const [replacement, setReplacement] = useState("");
  const [results, setResults] = useState<{ identity: string; epoch: number; value: SearchResults } | null>(null);
  const [error, setError] = useState<LocalizedText | null>(null);
  const [searching, setSearching] = useState(false);
  const [mutating, setMutating] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const lifecycle = useRef({ identity: "", epoch: 0, request: 0, mounted: true, locked: false, suspended: 0, root });
  const identity = searchIdentity(root, query, options);
  if (lifecycle.current.identity !== identity) {
    lifecycle.current.identity = identity;
    lifecycle.current.epoch += 1;
    lifecycle.current.request += 1;
  }
  lifecycle.current.root = root;
  const revisions = Object.values(session.docs).map((doc) => `${doc.documentId}:${doc.revision}`).sort().join("|");

  /** Immediately revoke result actions and pending work before a query or root changes. */
  const invalidate = useCallback(() => {
    lifecycle.current.epoch += 1;
    lifecycle.current.request += 1;
    if (lifecycle.current.mounted) {
      setResults(null);
      setRefresh((value) => value + 1);
    }
  }, []);

  /** Revoke pending actions throughout a native workspace-open operation. */
  const suspend = useCallback(() => { lifecycle.current.suspended += 1; invalidate(); }, [invalidate]);
  /** Resume search only after the workspace open operation has settled. */
  const resume = useCallback(() => { lifecycle.current.suspended = Math.max(0, lifecycle.current.suspended - 1); invalidate(); }, [invalidate]);

  /** Update the query while fencing pending async work at event time. */
  const setSearchQuery = useCallback((value: React.SetStateAction<string>) => {
    invalidate();
    setQuery(value);
  }, [invalidate]);

  /** Update native matching flags while fencing pending async work at event time. */
  const setSearchOptions = useCallback((value: SearchOptions) => {
    invalidate();
    setOptions(value);
  }, [invalidate]);

  useEffect(() => {
    lifecycle.current.mounted = true;
    return () => {
      lifecycle.current.mounted = false;
      lifecycle.current.epoch += 1;
      lifecycle.current.request += 1;
    };
  }, []);

  useEffect(() => {
    const state = lifecycle.current;
    const request = ++state.request;
    const epoch = state.epoch;
    setResults(null);
    setError(null);
    if (!desktop || !root || !gateway || query === "" || state.locked || state.suspended) {
      setSearching(false);
      return;
    }
    setSearching(true);
    /** Accept only the active lifecycle and request, including catch/finally callbacks. */
    const current = () => state.mounted && state.epoch === epoch && state.request === request;
    const timer = window.setTimeout(() => {
      gateway.searchWorkspace(query, options, root)
        .then((value) => { if (current()) setResults({ identity, epoch, value }); })
        .catch((cause: unknown) => { if (current()) setError(localizedFailure(cause, workspaceErrorText)); })
        .finally(() => { if (current()) setSearching(false); });
    }, 300);
    return () => { window.clearTimeout(timer); if (state.request === request) state.request += 1; };
  }, [desktop, root, gateway, query, options, identity, refresh, revisions]);

  const activeResults = results?.identity === identity && results.epoch === lifecycle.current.epoch ? results.value : null;
  const ready = activeResults !== null && !searching && !mutating && activeResults.matches.every((hit) => {
    const doc = hit.documentId ? session.docs[hit.documentId] : undefined;
    return !doc || hit.revision === doc.revision;
  });
  const registryHits = useMemo(() => activeResults?.matches.map(matchToHit) ?? [], [activeResults]);
  const localHits = useMemo((): SearchHitItem[] => {
    if (desktop || !query) return [];
    // Browser samples are explicitly labelled literal and case-sensitive; no JS regex executes.
    return searchLocal(Object.values(session.docs).map((doc) => ({ path: doc.path ?? doc.documentId, text: doc.text })).filter((file) => isSearchablePath(file.path)), query, 51)
      .map((hit) => ({ ...hit, line: hit.line + 1 }));
  }, [desktop, query, session.docs]);

  /** Replace captured native results once; reject busy, stale and incomplete result actions. */
  const replace = useCallback(async (selected?: SearchHitItem) => {
    const state = lifecycle.current;
    if (!desktop || !gateway || !session.registry) { notify(message("ブラウザ表示では編集できません。デスクトップで開いてください。")); return; }
    if (state.locked || state.suspended || !ready || !activeResults || !root) return;
    if (!selected && activeResults.limit) return;
    const hits: SearchMatch[] = selected ? activeResults.matches.filter((hit) =>
      hit.path === selected.path && hit.range.start === selected.offset && hit.range.end === selected.end
      && hit.contentToken === selected.contentToken && hit.revision === selected.revision) : activeResults.matches;
    if (hits.length === 0) return;
    const epoch = state.epoch;
    state.locked = true;
    state.request += 1;
    setMutating(true);
    setResults(null);
    /** Fence plan completions and the queued edit send against changed workspace/query/unmount. */
    const current = () => state.mounted && !state.suspended && state.epoch === epoch && state.identity === identity;
    const outcome = await replaceSearchResults(gateway, session.registry, {
      root, query, options, replacement, hits, all: !selected, current,
      /** Register the native document at its acknowledged plan revision. */
      opened: (plan) => {
        const doc = docFromOpen(plan.document);
        session.registry!.noteSnapshot(plan.document.snapshot);
        session.setDocs((previous) => ({ ...previous, [doc.documentId]: doc }));
        session.setTabs((previous) => previous.includes(doc.documentId) ? previous : [...previous, doc.documentId]);
      },
      /** Preserve acknowledgements only in the owning workspace's active session. */
      changed: (snapshot) => { if (state.mounted && state.root === root) session.mergeSnapshot(snapshot); },
    });
    state.locked = false;
    if (!state.mounted) return;
    setMutating(false);
    if (outcome.failure instanceof StaleResync && state.root === root) session.mergeSnapshot(outcome.failure.snapshot);
    if (outcome.failure || outcome.cancelled) {
      notify(message("{{count}} 件・{{files}} ファイルを置換しました。残りは未処理です。{{reason}}", {
        count: outcome.count, files: outcome.files,
        reason: outcome.cancelled ? message("検索条件が変わったため置換を中止しました。") : localizedFailure(outcome.failure, workspaceErrorText),
      }));
    } else {
      notify(message("{{count}} 件を置換しました。", { count: outcome.count }));
    }
    setRefresh((value) => value + 1);
  }, [desktop, gateway, session, ready, activeResults, root, identity, query, options, replacement, notify, t, message]);

  /** Replace exactly one captured match, never a nearby recomputed match. */
  const replaceOne = useCallback((hit: SearchHitItem) => replace(hit), [replace]);
  /** Replace all complete captured results, stopping and reporting after the first failure. */
  const replaceAllMatches = useCallback(() => replace(), [replace]);

  /** Validate an exact visible result before opening and navigating its authoritative range. */
  const jumpToHit = useCallback(async (hit: SearchHitItem) => {
    if (!desktop) {
      session.setTabs((previous) => previous.includes(hit.path) ? previous : [...previous, hit.path]);
      session.setActiveId(hit.path);
      return;
    }
    if (!ready || !root || !gateway || !activeResults) return;
    const captured = activeResults.matches.find((match) => match.path === hit.path
      && match.range.start === hit.offset && match.range.end === hit.end
      && match.contentToken === hit.contentToken && match.revision === hit.revision);
    if (!captured) return;
    const state = lifecycle.current;
    const epoch = state.epoch;
    try {
      const plan = await gateway.planSearchReplacement({ root, path: hit.path, query, options,
        replacement: "", contentToken: captured.contentToken, revision: captured.revision, range: captured.range });
      if (!state.mounted || state.epoch !== epoch || state.locked || state.suspended) return;
      const doc = docFromOpen(plan.document);
      session.registry?.noteSnapshot(plan.document.snapshot);
      session.setDocs((previous) => ({ ...previous, [doc.documentId]: doc }));
      session.setTabs((previous) => previous.includes(doc.documentId) ? previous : [...previous, doc.documentId]);
      session.setActiveId(doc.documentId);
      await session.jumpToOffset(doc.documentId, captured.range.start, captured.range.end);
    } catch (cause) {
      if (state.mounted && state.epoch === epoch) {
        notify(localizedFailure(cause, workspaceErrorText));
        setRefresh((value) => value + 1);
      }
    }
  }, [desktop, session, ready, root, gateway, activeResults, query, options, notify]);

  return {
    searchQuery: query, setSearchQuery, searchOptions: options, setSearchOptions,
    searchError: error === null ? null : renderLocalizedText(error, t),
    registryHits, localHits: localHits.slice(0, 50), searching, replacing: mutating, resultsReady: ready,
    searchLimit: desktop ? activeResults?.limit ?? null : localHits.length > 50 ? "matches" as const : null, replaceText: replacement, setReplaceText: setReplacement,
    replaceOne, replaceAllMatches, jumpToHit, invalidate, suspend, resume,
  };
}
