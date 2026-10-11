import { useMemo } from "react";
import { WorkspaceShell } from "./presentation/shell/WorkspaceShell";
import { createComposition } from "./composition";

/**
 * Root component wiring concrete adapters into the shell via props.
 *
 * Single explicit composition: infrastructure transports are created once
 * here and injected, so presentation never imports them directly.
 */
export default function App() {
  /** Memoized composition so gateways stay stable across renders. */
  const composition = useMemo(() => createComposition(), []);
  return (
    <div className="min-h-screen bg-background text-foreground">
      <h1 className="sr-only">Marxen</h1>
      <WorkspaceShell
        desktop={composition.desktop}
        documentGateway={composition.documentGateway}
        workspaceGateway={composition.workspaceGateway}
        eventSource={composition.eventSource}
        aiGateway={composition.aiGateway}
        isolationGateway={composition.isolationGateway}
        runtimeGateway={composition.runtimeGateway}
        dialogGateway={composition.dialogGateway}
        dropGateway={composition.dropGateway}
        clipboardGateway={composition.clipboardGateway}
        aiProfileStore={composition.aiProfileStore}
        editorPreferencesStore={composition.editorPreferencesStore}
        imageLoader={composition.imageLoader}
        vimSettingsGateway={composition.vimSettingsGateway}
      />
    </div>
  );
}
