// Frontend composition root (composition).
//
// Single explicit wiring of concrete infrastructure adapters into
// application ports and presentation. `App` calls this once and injects the
// result into `WorkspaceShell`, so presentation never imports infrastructure
// and domain/application never pull singletons.

import { workspaceApi, listenWorkspaceEvents, isDesktop } from "./infrastructure/tauri/workspace-api";
import { RegistryClient, ReadonlyRegistry, type DocumentClient } from "./infrastructure/tauri/registry-client";
import {
  startPrompt,
  cancelPromptSafe,
  getCredentialState,
  setCredential,
  deleteCredential,
  testConnection,
} from "./infrastructure/tauri/ai-client";
import {
  createIsolatedCopy,
  fetchIsolationDiff,
  stageProposal,
  approveIsolatedCopy,
  rejectIsolatedCopy,
  cancelIsolatedCopy,
} from "./infrastructure/tauri/isolation-client";
import { readRuntimeStatus } from "./infrastructure/tauri/runtime-client";
import { pickFolder, pickConfigFile } from "./infrastructure/native/dialog";
import { listenNativeDrop } from "./infrastructure/native/drop";
import { copyYankToClipboard } from "./infrastructure/clipboard/clipboard-writer";
import { bytesToDataUrl } from "./domain/clipboard-text";
import { loadAiProfile, saveAiProfile } from "./infrastructure/storage/ai-profile-store";
import {
  loadEditorPreferences,
  saveEditorPreferences,
} from "./infrastructure/storage/editor-preferences-store";
import { makeImageResolver as makeInfraImageResolver, resolveImageForDocument } from "./infrastructure/images/image-loader";
import { workspaceErrorText, READONLY_MESSAGE } from "./domain/document-errors";
import type {
  AiGateway,
  AiProfileStore,
  ClipboardGateway,
  DialogGateway,
  DocumentGateway,
  DropGateway,
  EditorPreferencesStore,
  ImageLoader,
  IsolationGateway,
  RuntimeGateway,
  WorkspaceEventSource,
  WorkspaceGateway,
} from "./application/ports";

/** Concrete workspace gateway delegating to the Tauri transport. */
function createWorkspaceGateway(): WorkspaceGateway {
  return {
    openWorkspace: (path) => workspaceApi.openWorkspace(path),
    listWorkspace: (path) => workspaceApi.listWorkspace(path),
    listDocuments: () => workspaceApi.listDocuments(),
    openMarkdown: (path) => workspaceApi.openMarkdown(path),
    openTextFile: (path) => workspaceApi.openTextFile(path),
    createMarkdown: (path, text) => workspaceApi.createMarkdown(path, text),
    renameMarkdown: (request, path) => workspaceApi.renameMarkdown(request, path),
    closeDocument: (request, action) => workspaceApi.closeDocument(request, action),
    searchWorkspace: (query) => workspaceApi.searchWorkspace(query),
    pollEvents: () => workspaceApi.pollEvents(),
    listRecovery: () => workspaceApi.listRecovery(),
    restoreRecovery: (documentId) => workspaceApi.restoreRecovery(documentId),
    discardRecovery: (documentId) => workspaceApi.discardRecovery(documentId),
    loadImage: (documentId, path) => workspaceApi.loadImage(documentId, path),
    loadWorkspaceImage: (path) => workspaceApi.loadWorkspaceImage(path),
    fetchSnapshot: (documentId) => workspaceApi.fetchSnapshot(documentId),
    fetchGrid: (documentId, width, height) => workspaceApi.fetchGrid(documentId, width, height),
  };
}

/**
 * Create the document gateway for the current transport.
 *
 * Desktop returns a serial registry; the browser demo returns a rejecting
 * read-only registry. Called once by the composition root.
 */
function createDocumentGateway(): DocumentGateway {
  const client: DocumentClient = isDesktop() ? new RegistryClient() : new ReadonlyRegistry();
  return client as DocumentGateway;
}

/**
 * Build all injected adapters for the shell in one place.
 *
 * Returns gateways, stores, flags, and shared helpers so `App` stays a thin
 * composer and `WorkspaceShell` receives everything via props.
 */
export function createComposition() {
  const desktop = isDesktop();
  const documentGateway = createDocumentGateway();
  const workspaceGateway = createWorkspaceGateway();
  /** Subscribe to pushed workspace events with polling fallback. */
  const eventSource: WorkspaceEventSource = {
    listen: (callback) => listenWorkspaceEvents(callback),
  };
  /** AI streaming, credentials, and connection tests over Tauri. */
  const aiGateway: AiGateway = {
    startPrompt,
    cancelPromptSafe,
    getCredentialState,
    setCredential,
    deleteCredential,
    testConnection,
  };
  /** Isolation staging lifecycle pinned by Rust. */
  const isolationGateway: IsolationGateway = {
    createCopy: (contexts) => createIsolatedCopy(contexts),
    fetchDiff: (copyId) => fetchIsolationDiff(copyId),
    stageProposal: (copyId, proposal, mode) => stageProposal(copyId, proposal, mode),
    approveCopy: (copyId) => approveIsolatedCopy(copyId),
    rejectCopy: (copyId) => rejectIsolatedCopy(copyId),
    cancelCopy: (copyId) => cancelIsolatedCopy(copyId),
  };
  /** Runtime connectivity status. */
  const runtimeGateway: RuntimeGateway = {
    readStatus: () => readRuntimeStatus(),
  };
  /** Native folder and config pickers. */
  const dialogGateway: DialogGateway = {
    pickFolder: () => pickFolder(),
    pickConfigFile: () => pickConfigFile(),
  };
  /** Native file-drop subscription. */
  const dropGateway: DropGateway = {
    listen: (onDrop) => listenNativeDrop(onDrop),
  };
  /** Native clipboard writes through Rust. */
  const clipboardGateway: ClipboardGateway = {
    copyYank: (copy, documentId) => copyYankToClipboard(copy, documentId),
  };
  /** Non-secret AI profile persistence. */
  const aiProfileStore: AiProfileStore = {
    load: () => loadAiProfile(),
    save: (profile) => saveAiProfile(profile),
  };
  /** View-only editor preferences persistence. */
  const editorPreferencesStore: EditorPreferencesStore = {
    load: () => loadEditorPreferences(),
    save: (preferences) => saveEditorPreferences(preferences),
  };
  /** Document-scoped image byte loader with in-memory cache. */
  const imageLoader: ImageLoader = {
    resolve: (documentId, src, signal) => resolveImageForDocument(documentId, src, signal),
    forDocument: (documentId) => makeInfraImageResolver(documentId),
  };
  return {
    desktop,
    documentGateway,
    workspaceGateway,
    eventSource,
    aiGateway,
    isolationGateway,
    runtimeGateway,
    dialogGateway,
    dropGateway,
    clipboardGateway,
    aiProfileStore,
    editorPreferencesStore,
    imageLoader,
    bytesToDataUrl,
    workspaceErrorText,
    readonlyMessage: READONLY_MESSAGE,
  };
}

/** Composition result type for shell props and tests. */
export type Composition = ReturnType<typeof createComposition>;
