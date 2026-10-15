// Simulated native transport for browser layout/navigation only; no Neovim or OS IME claim.
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { WorkspaceShell } from "../../../src/presentation/shell/WorkspaceShell";
import { I18nProvider } from "../../../src/presentation/i18n/I18nProvider";
import { createTranslator } from "../../../src/infrastructure/localization/i18next-translator";
import { workspaceMetadataStore } from "../../../src/infrastructure/storage/workspace-metadata-store";
import { workspaceApi } from "../../../src/infrastructure/tauri/workspace-api";
import { RegistryClient } from "../../../src/application/document/registry-client";
import type { CursorUpdate, OpenDocument, RootScope, WorkspaceInfo } from "../../../src/contracts/contracts";
import type { Language } from "../../../src/contracts/language";
import type { WorkspaceGateway } from "../../../src/application/ports";
import pixel from "../../fixtures/pixel.png?url";
import "../../../src/styles.css";

const alpha: WorkspaceInfo = { root: "/fixture/alpha", scope: { rootId: "root-alpha", generation: "1" } };
const beta: WorkspaceInfo = { root: "/fixture/beta", scope: { rootId: "root-beta", generation: "1" } };
let roots: WorkspaceInfo[] = [];
const documents = new Map<string, OpenDocument>();
const calls: string[] = [];

/** Open an independently owned simulated text actor. */
async function openFile(path: string, scope?: RootScope): Promise<OpenDocument> {
  if (!scope || !roots.some((root) => root.scope.rootId === scope.rootId)) throw new Error("unknown fixture root");
  const id = `${scope.rootId}:${path}`;
  const open = documents.get(id) ?? { path, snapshot: { documentId: id, location: { scope, path, position: 0 }, revision: 0, text: `${scope.rootId} 日本😀`, dirty: false } };
  documents.set(id, open); calls.push(`open:${id}`); return open;
}

const gateway: WorkspaceGateway = {
  ...workspaceApi,
  /** Replace only this fixture's simulated root list. */
  openWorkspace: async () => { roots = [alpha]; return alpha; },
  /** Add the second independent simulated root. */
  addWorkspace: async () => { if (roots.some((root) => root.scope.rootId === beta.scope.rootId)) throw new Error("duplicate"); roots.push(beta); return beta; },
  /** Expose currently registered fixture roots for WebView-reload behavior. */
  listWorkspaces: async () => roots,
  /** Remove only the chosen root after an explicit fixture decision. */
  removeWorkspace: async (scope, action) => { const owner = roots.find((root) => root.scope.rootId === scope.rootId)!; if (action === "cancel") return null; roots = roots.filter((root) => root !== owner); calls.push(`remove:${scope.rootId}`); return owner; },
  /** Give both owners identical filenames with distinguishable ownership. */
  listWorkspace: async () => [
    { path: "same.md", name: "same.md", directory: false, markdown: true, kind: "markdown" },
    { path: "same.png", name: "same.png", directory: false, markdown: false, kind: "image" },
    { path: "same.txt", name: "same.txt", directory: false, markdown: false, kind: "text" },
  ],
  /** Return only the captured owner's fixture actors. */
  listDocuments: async (scope) => [...documents.values()].filter((doc) => doc.snapshot.location?.scope.rootId === scope?.rootId),
  openMarkdown: openFile,
  openTextFile: openFile,
  /** Supply valid local PNG bytes while recording the requested owner. */
  loadWorkspaceImage: async (path, scope) => { calls.push(`image:${scope?.rootId}:${path}`); return { mime: "image/png", bytes: [...new Uint8Array(await (await fetch(pixel)).arrayBuffer())] }; },
  /** This navigation fixture contains no crash-recovery records. */
  listRecovery: async () => [],
  /** No simulated external filesystem events. */
  pollEvents: async () => [],
};
const registry = new RegistryClient({
  ...workspaceApi,
  /** Supply a stable simulated native mode. */
  fetchMode: async () => ({ documentId: "", revision: 0, mode: "normal" }),
  /** Supply a bounded cursor for the requested simulated actor. */
  fetchCursor: async (documentId) => ({ documentId, revision: 0, anchor: 0, head: 0 }),
  /** Acknowledge restored fixture selection. */
  reportCursor: async (cursor: CursorUpdate) => cursor,
  /** Supply configuration without invoking a native process. */
  fetchConfig: async () => ({ path: null, errors: [], copyKeys: {} }),
});
const runtimeGateway = {
  /** Explicitly identify the simulated status. */
  readStatus: async () => ({ contractVersion: 1, connection: "disconnected" as const, detail: "simulated browser fixture" }),
};
const eventSource = {
  /** Install no native event subscription in the browser. */
  listen: async () => () => {},
};
const dialogGateway = {
  /** Return deterministic fixture paths without opening an OS picker. */
  pickFolder: async () => roots.length ? beta.root : alpha.root,
  /** No config selection in this navigation fixture. */
  pickConfigFile: async () => null,
};

declare global {
  interface Window {
    __multiRootFixture: {
      /** Switch presentation locale without remounting workspace state. */
      setLanguage(language: Language): void;
      /** Inspect explicit fixture calls, never native process evidence. */
      getCalls(): string[];
    };
  }
}

/** Render the production shell over the explicitly simulated transport. */
function Fixture() {
  const [language, setLanguage] = useState<Language>("ja-JP");
  window.__multiRootFixture = { setLanguage,
    /** Inspect simulated calls without invoking native services. */
    getCalls: () => [...calls],
  };
  return <I18nProvider language={language} createTranslator={createTranslator}><div lang={language}>
    <WorkspaceShell desktop documentGateway={registry} workspaceGateway={gateway} workspaceMetadataStore={workspaceMetadataStore} runtimeGateway={runtimeGateway} eventSource={eventSource} dialogGateway={dialogGateway} />
  </div></I18nProvider>;
}

createRoot(document.getElementById("root")!).render(<Fixture />);
