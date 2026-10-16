import type { AccountHost, AccountProvider, AccountReason, ProviderAccountError } from "../contracts/provider-accounts";
import type { LabelKey } from "../contracts/localization";

/** Setup metadata mirrors the native exact endpoint allowlists; it contains no credentials. */
export const ACCOUNT_PROVIDERS: { id: AccountProvider; label: string; endpoints: string[]; docs: string; credential: LabelKey; usage: boolean; launch: boolean }[] = [
  { id: "codex", label: "Codex", endpoints: ["https://chatgpt.com"], docs: "https://developers.openai.com/codex/auth/", credential: "Codex の auth.json", usage: true, launch: true },
  { id: "claude", label: "Claude Code", endpoints: ["https://api.anthropic.com"], docs: "https://code.claude.com/docs/en/authentication", credential: "Claude の .credentials.json", usage: true, launch: true },
  { id: "opencode", label: "OpenCode", endpoints: ["https://opencode.ai"], docs: "https://opencode.ai/docs/providers/", credential: "OpenCode の auth.json", usage: false, launch: true },
  { id: "devin", label: "Devin", endpoints: ["https://api.devin.ai"], docs: "https://docs.devin.ai/work-with-devin/devin-cli", credential: "認証設定 JSON", usage: false, launch: false },
  { id: "gemini", label: "Gemini CLI (legacy)", endpoints: ["https://cloudcode-pa.googleapis.com"], docs: "https://geminicli.com/docs/get-started/authentication/", credential: "Gemini の oauth_creds.json", usage: true, launch: false },
  { id: "antigravity", label: "Antigravity", endpoints: ["https://antigravity.google"], docs: "https://antigravity.google/docs/home", credential: "認証設定 JSON", usage: false, launch: false },
  { id: "opencode_go", label: "OpenCode Go", endpoints: ["https://opencode.ai"], docs: "https://opencode.ai/docs/go/", credential: "OpenCode Go の API キー", usage: true, launch: false },
  { id: "minimax", label: "MiniMax", endpoints: ["https://www.minimax.io", "https://www.minimaxi.com"], docs: "https://platform.minimax.io/docs/token-plan/faq", credential: "MiniMax の Subscription Key", usage: true, launch: false },
  { id: "grok", label: "Grok", endpoints: ["https://cli-chat-proxy.grok.com"], docs: "https://grok.com/", credential: "Grok の認証 JSON（accessToken / userId）", usage: true, launch: false },
  { id: "cursor", label: "Cursor", endpoints: ["https://cursor.com"], docs: "https://cursor.com/dashboard", credential: "Cursor の Cookie ヘッダー（WorkosCursorSessionToken）", usage: true, launch: false },
  { id: "glm", label: "GLM Coding Plan", endpoints: ["https://api.z.ai", "https://open.bigmodel.cn", "https://dev.bigmodel.cn"], docs: "https://docs.z.ai/devpack/overview", credential: "GLM Coding Plan の API キー", usage: true, launch: false },
];

/** Compare host scopes without allowing a WSL distribution to match the local OS. */
export function sameAccountHost(left: AccountHost, right: AccountHost): boolean {
  return left.kind === right.kind && (left.kind !== "wsl" || (right.kind === "wsl" && left.distribution === right.distribution));
}

/** Translate only fixed native error codes; never render arbitrary backend strings or objects. */
export function accountErrorKey(error: unknown): LabelKey {
  if (!error || typeof error !== "object" || !("code" in error)) return "アカウント操作に失敗しました。保存先と接続を確認してください。";
  const value = error as ProviderAccountError;
  switch (value.code) {
    case "invalid_settings": return "アカウント名、接続先、認証情報の形式を確認してください。";
    case "not_found": return "アカウントが見つかりません。再読み込みしてください。";
    case "credential_store_failed": return "OS 資格情報ストアを利用できません。ロック状態を確認してください。";
    case "unauthorized": return "認証情報が失効しているか、使用量の権限がありません。ログインし直してください。";
    case "rate_limited": return "使用量の取得が制限されています。時間を置いて再試行してください。";
    case "invalid_response": return "使用量の応答形式に対応していません。値は表示しません。";
    case "unsupported": return accountReasonKey(value.reason);
    default: return "アカウント操作に失敗しました。保存先と接続を確認してください。";
  }
}

/** Explain unsupported adapters and missing measurements without displaying inferred zero usage. */
export function accountReasonKey(reason: AccountReason): LabelKey {
  switch (reason) {
    case "wsl_unsupported": return "WSL アダプターは未対応です。保存した設定はローカル OS の認証に使われません。";
    case "private_files_unsupported": return "この OS では管理アカウントの私有ファイル分離を未検証のため起動できません。";
    case "adapter_unsupported": return "このプロバイダーの使用量・認証アダプターは未対応です。公式画面で確認してください。";
    case "missing_credential": return "管理アカウントの認証情報が未保存です。システム既定へは切り替えません。";
    case "login_required": return "認証情報がありません。公式の手順でログインするか、管理アカウントを追加してください。";
    case "missing_project": return "Gemini のプロジェクトを取得できません。プロジェクト ID を設定してください。";
    case "refresh_required": return "再ログインが必要です。Google の自動更新には client_id と client_secret も必要です。";
    case "invalid_response": return "使用量の応答形式に対応していません。値は表示しません。";
    default: return "アカウント操作に失敗しました。保存先と接続を確認してください。";
  }
}
