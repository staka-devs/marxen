# Issue #14: フロントエンド Clean Architecture / YAGNI / DRY / SOLID 監査報告

- 基準: `556650d`
- 対象: `src/**` のみ（Rust・root checkout は不変）
- 日付: 2026-10-09

## 要約

Agent チャットとインラインチャットの run lifecycle の実重複を共有 hook に切り出し、Tauri 輸送の直接参照を `lib/` へ寄せ、描画 helper の二重実装を単一化した。UI/UX・revision/Neovim 正本・IME/Undo・early events・取消 fencing・共有 staging 所有は維持した。`WorkspaceShell` の肥大や未使用 renderer などの残存逸脱は直さず記録した。

## 実査証拠（基準時点の重複・結合）

- Agent vs inline run lifecycle の実重複: `src/components/ai-panel.tsx:115-121,134-160,187-195,235-246,256-288,302-308,335-344,361-391,404-406` と `src/components/ai-inline-chat.tsx:53-65,99-113,118-154,165-211,213-229` が token/cancel/settled/stop/busy、staging 待ち取消、late-settle、error 正規化でほぼ同一。差分は意図的（Agent の複数会話・履歴・多 mode 対 inline の単発 `rewrite`・空履歴・配置・Escape）。
- 輸送結合: `src/components/workspace/ImageDropZone.tsx:3,49` が唯一 `@tauri-apps/api/webview` を直接参照。`src/lib/clipboard.ts:117-125` が `load_relative_image` を直接 `invoke` し、`src/lib/workspace.ts:34` の同名 wrapper と二経路化。`src/lib/ai.ts:214-268` の early-event queue と `src/lib/workspace.ts:11-55` の `workspaceApi` 集約自体は健全。
- 表示ラベル重複: `MODE_LABELS` が `src/lib/ai.ts:32-37` と `src/components/ai-panel.tsx:72-77` で同一4件。inline の `slice(0, 20_000)` が `MAX_PROMPT_CHARS` の literal 重複。
- 描画 helper 重複: `escapeHtml` が `src/lib/preview.ts:8-10` と `src/lib/render/pipeline.ts:364-366` で同一。`mdastText`/`alertKind` が `pipeline.ts:384-399` と `blocks.ts:28-42` で同一（座標契約は別）。
- Shell 内重複: `liveResolver`/`readResolver`（`WorkspaceShell.tsx:1418-1425`）同一式、`handleProposal:1622-1674` と `stageStoredProposal:1678-1705` が stage→diff→drift 連鎖を共有、画像 bytes→dataURL が `WorkspaceShell.tsx:1404-1409` と `clipboard.ts:119-123` で重複。

## 実際の修正

- `src/lib/ai-run.ts`（新規）: `useAiRun`（token/cancel/settled/stop/busy 所有＋unmount cleanup）、`normalizeAiError`、`isClaudeBlockedProvider`/`claudeRefusalError`、`keepStartedSession` を共有化。`ai-panel.tsx` と `ai-inline-chat.tsx` が採用し、会話・履歴・mode・配置・Escape 等の差分は各側に残置。
- `src/components/ai-panel.tsx`: `MODE_LABELS` を `lib/ai` に単一化（再 export 維持）、catch 正規化・Claude 拒否・late-settle を共有 helper 化、`busyRef` 参照の送信 guard を整理。
- `src/components/ai-inline-chat.tsx`: magic number を `truncatePrompt` に置換（`trim` 先行の既存語義を維持）、上記共有 lifecycle へ移行。
- `src/lib/native-drop.ts`（新規）: `getCurrentWebview().onDragDropEvent` を包み、`ImageDropZone.tsx` の直接参照を除去（振る舞い不変、hover 無視・drop 転送を維持）。
- `src/lib/clipboard.ts`: `load_relative_image` を `workspaceApi.loadImage` 経由に一本化し、`bytesToDataUrl` を export。`WorkspaceShell.tsx` の resolver が同 helper を使用。
- `src/lib/render/mdast.ts`（新規）: `mdastText`/`alertKind` を共有化し `blocks.ts`/`pipeline.ts` が参照。座標契約（UTF-16 offsets / 1-based lines）の入口は分離のまま。
- `src/lib/render/pipeline.ts`: 私有 `escapeHtml` を `lib/preview` の export に一本化。
- `src/components/shell/WorkspaceShell.tsx`: live/read/split 用 resolver を `previewResolver` に一本化（preview key による文書分離は維持）、非 ask intake を `stageNonAskCopy` に抽出（push 側の diff 再取得と manual 側の非再取得の差分は維持）。
- テスト: `src/lib/ai-run.test.ts`、`src/lib/render/mdast.test.ts`、`src/lib/native-drop.test.ts` を追加、`src/lib/clipboard.test.ts` に bytes/loader 経路を追加。既存の取消・遅延開始・unmount・会話系テストは無改変で維持。

## 維持した不変条件

- 実 Neovim バッファ正本・revision 直列・stale 再同期・IME composition gate・Undo/redo 経路・`:w` 統一に触れていない。
- `lib/ai.ts` の early-event bounded queue（256 件）と runId fencing・terminal での unlisten 解除は不変。
- 取消は staging 待ち・start 待ち・実行中の全相で有効で、遅延 handle は破棄、確定前の start 解決でも spinner を残さない。
- 共有 staging slot の所有は shell の `disabled`＋`ensureStagingFor` の同期確保のまま。両 chat は相互抑止される。
- 日本語文言・配置・フォーカス復帰・Ctrl+I 素通し・Ctrl+Shift+I 起動・差分確認導線は不変。

## 残存逸脱（正直な記録・未対応）

- `WorkspaceShell.tsx` は約2700行のまま。文書 lifecycle・Vim 経路・検索・AI staging・review 等が単一 component に残り SRP/OCP を満たさない。領域別抽出は本件では行わず、分割時の staging 所有・cursor generation・paste 競合の回帰 risk を避けた。
- `src/lib/preview.ts:36-167` の `renderMarkdownPreview` は製品 import がなく並行 renderer として残存（`preview.test.ts` のみ使用）。削除は coverage 削減と表示差分 risk のため見送り。
- `workspace.ts:151-167` の `replaceAll` は製品未使用だが `workspace.test.ts` が検証しており残置。`replaceEdits` のみ shell が使用。
- `src/lib/clipboard.ts:12` が `../components/preview/images`（component 層）から純粋関数を import しており層逆転が残る。移動は import 波及のため見送り。
- `routeCharKey`/`routeCapturedPaste`（`document-client.ts:335-440`）の queue→mode→revision 骨格の類似、`fileLabel`/`contextLabels`/`labelFor` の fallback 類似は、語義差（mapping 分岐・表示文言）のため共有化していない。
- 新規抽象は上記4件（ai-run・mdast・native-drop・bytes helper）のみで、speculative な port・framework・未使用抽象は追加していない。

## 検証

- 実施: `npm run typecheck` 成功。
- 実施: `npx vitest run src/lib/ai-run.test.ts src/lib/render/mdast.test.ts src/lib/native-drop.test.ts src/lib/clipboard.test.ts src/components/ai-panel.test.tsx src/components/ai-inline-chat.test.tsx --maxWorkers=4` 成功（6 files / 36 tests）。
- 実施: `npx vitest run --maxWorkers=4` 成功（39 files / 238 tests）。
- 未実施: 実 WebView（Windows WebView2 / macOS WebKit / Linux WebKitGTK）での IME・描画確認、Tauri 実接続の手動 CI 全体。root 側の統合・手動 CI に委ねる。`node_modules` は root link を使用し `npm ci` は行っていない。
- 上記は完全準拠の主張ではない。残存逸脱の解消には shell 分割と dead renderer の整理が別途必要。
