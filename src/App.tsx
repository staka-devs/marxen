import { WorkspaceShell } from "./components/shell/WorkspaceShell";

export default function App() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <h1 className="sr-only">Marxen</h1>
      <WorkspaceShell />
    </div>
  );
}
