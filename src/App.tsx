import { useEffect, useState } from "react";
import { ArrowDown, FileText, Layers, Unplug } from "lucide-react";
import { Button } from "./components/ui/button";
import { Card } from "./components/ui/card";
import { SourceSample } from "./components/source-sample";
import { readRuntimeStatus } from "./lib/runtime";
import type { RuntimeStatus } from "./shared/contracts";

const labels = { disconnected: "Neovim 未接続", connecting: "Neovim 接続中", connected: "Neovim 接続済み", error: "Neovim 接続エラー" };

export default function App() {
  const [runtime, setRuntime] = useState<RuntimeStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showSample, setShowSample] = useState(false);
  useEffect(() => {
    let active = true;
    readRuntimeStatus().then((status) => { if (active) setRuntime(status); }).catch((cause: unknown) => {
      if (active) setError(cause instanceof Error ? cause.message : String(cause));
    });
    return () => { active = false; };
  }, []);

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="flex items-center justify-between border-b border-border px-6 py-5 sm:px-10">
        <a href="#main" className="flex items-center gap-3 font-serif text-xl tracking-tight"><span className="grid size-8 place-items-center rounded-lg bg-primary text-base text-primary-foreground">M</span>Marxen</a>
        <span className="rounded-full border border-border px-3 py-1 text-xs text-muted-foreground">開発版 · 0.1</span>
      </header>
      <main id="main" className="mx-auto max-w-5xl px-6 pb-16 pt-14 sm:px-10 sm:pt-20">
        <p className="mb-4 text-xs font-semibold tracking-[.2em] text-primary">MARKDOWN WORKSPACE</p>
        <h1 className="font-serif text-3xl leading-snug sm:text-4xl">書くことに、集中できる場所。</h1>
        <p className="mt-5 max-w-2xl text-sm leading-7 text-muted-foreground">Markdown の原文と Vim 操作を大切にする、デスクトップエディタ。<br className="hidden sm:block" />現在はアプリの基盤を準備しています。</p>

        <Card className="mt-10" aria-labelledby="engine-title">
          <div className="flex items-start gap-4">
            <span className="rounded-lg bg-muted p-3 text-primary"><Unplug size={20} aria-hidden="true" /></span>
            <div className="min-w-0 flex-1">
              <h2 id="engine-title" className="text-base font-semibold">編集エンジン</h2>
              <p role="status" className="mt-2 text-sm font-medium">{error ? "接続状態を取得できません" : runtime ? labels[runtime.connection] : "接続状態を確認中…"}</p>
              <p className="mt-2 text-sm leading-6 text-muted-foreground">{error ?? runtime?.detail}</p>
              <p className="mt-3 text-xs text-muted-foreground">この開発版では、編集・保存・Vim モードはまだ利用できません。</p>
            </div>
          </div>
        </Card>

        <div className="mt-8 grid gap-4 sm:grid-cols-2">
          <Card>
            <FileText size={20} className="mb-4 text-primary" aria-hidden="true" />
            <h2 className="font-semibold">原文の表示サンプル</h2>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">日本語と絵文字を含む Markdown を読み取り専用で表示します。</p>
            <Button variant="outline" className="mt-5" aria-expanded={showSample} aria-controls="source-sample" onClick={() => setShowSample(!showSample)}><ArrowDown size={14} aria-hidden="true" />{showSample ? "サンプルを閉じる" : "サンプルを表示"}</Button>
          </Card>
          <Card>
            <Layers size={20} className="mb-4 text-primary" aria-hidden="true" />
            <h2 className="font-semibold">これからできること</h2>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">実 Neovim による編集、ワークスペース管理、ライブプレビュー、AI 支援を順に追加します。</p>
            <p className="mt-5 text-xs text-muted-foreground">文書データと保存は Rust が管理します。</p>
          </Card>
        </div>
        {showSample && <section id="source-sample" aria-label="原文サンプル" className="mt-6"><SourceSample /></section>}
        <footer className="mt-10 flex flex-wrap gap-x-5 gap-y-2 border-t border-border pt-5 text-xs text-muted-foreground"><span>Rust / Tauri v2</span><span>React / CodeMirror 6</span><span>日本語 UI</span></footer>
      </main>
    </div>
  );
}
