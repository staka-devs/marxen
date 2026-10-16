import { useEffect, useRef, useState } from "react";
import type { ProviderAccountGateway } from "../../application/ai/provider-account-ports";
import type { AccountHost, AccountProvider, AccountSnapshot, ProviderAccount, ProviderAccountUsage } from "../../contracts/provider-accounts";
import type { LabelKey } from "../../contracts/localization";
import { ACCOUNT_PROVIDERS, accountErrorKey, accountReasonKey, sameAccountHost } from "../../domain/provider-accounts";
import { useI18n } from "../i18n/I18nProvider";
import { Button } from "../ui/button";

interface Props {
  gateway?: ProviderAccountGateway;
  /** Broadcast committed selections for model and history scoping. */
  onSnapshot?: (snapshot: AccountSnapshot) => void;
}

/** Complete provider account settings, backed only by injected native ports. */
export function ProviderAccountsSettings({ gateway, onSnapshot }: Props) {
  const { t } = useI18n();
  const [snapshot, setSnapshot] = useState<AccountSnapshot>({ accounts: [], selections: [] });
  const [provider, setProvider] = useState<AccountProvider>("codex");
  const [hostKind, setHostKind] = useState<"local" | "wsl">("local");
  const [distribution, setDistribution] = useState("");
  const [draft, setDraft] = useState<ProviderAccount | null>(null);
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<LabelKey | null>(null);
  const [presence, setPresence] = useState<boolean | null>(null);
  const [usage, setUsage] = useState<ProviderAccountUsage | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const attempt = useRef(0);
  const spec = ACCOUNT_PROVIDERS.find(p => p.id === provider)!;
  const host: AccountHost = hostKind === "local" ? { kind: "local" } : { kind: "wsl", distribution };
  const selection = snapshot.selections.find(s => s.provider === provider && sameAccountHost(s.host, host));
  const selectedId = selection?.accountId ?? "";
  const accounts = snapshot.accounts.filter(s => s.account.provider === provider && sameAccountHost(s.account.host, host));
  const selected = accounts.find(s => s.account.id === selectedId);
  const editing = draft ?? selected?.account ?? null;
  const hostValid = hostKind === "local" || distribution.trim().length > 0;

  useEffect(() => {
    let active = true;
    if (gateway) gateway.snapshot().then(result => { if (active) { setSnapshot(result); onSnapshot?.(result); } }).catch(error => { if (active) setNotice(accountErrorKey(error)); });
    return () => { active = false; attempt.current += 1; };
  }, [gateway, onSnapshot]);

  /** Invalidate outstanding results before changing provider, host or account. */
  function resetView() {
    attempt.current += 1;
    setDraft(null); setSecret(""); setNotice(null); setPresence(null); setUsage(null); setConfirmDelete(false); setBusy(false);
  }

  /** Serialize UI actions and discard results when the viewed scope changes. */
  async function perform(action: () => Promise<void>) {
    if (!gateway || busy) return;
    const id = ++attempt.current;
    setBusy(true); setNotice(null);
    try { await action(); } catch (error) { if (id === attempt.current) setNotice(accountErrorKey(error)); }
    finally { if (id === attempt.current) setBusy(false); }
  }

  /** Persist only through Rust and clear the secret input before awaiting any external action. */
  async function saveAccount() {
    if (!editing || !gateway) return;
    const account = { ...editing, name: editing.name.trim() };
    const credential = secret || undefined;
    const id = attempt.current;
    setSecret("");
    await gateway.save(account, credential);
    const updated = await gateway.snapshot();
    if (id !== attempt.current) return;
    setSnapshot(updated); onSnapshot?.(updated); setDraft(null); setNotice("アカウントを保存しました。選択すると次の起動に反映します。");
  }

  /** Change selection only after native persistence succeeds, preserving the previous account on failure. */
  async function chooseAccount(id: string) {
    if (!gateway) return;
    const attemptId = attempt.current;
    await gateway.select({ provider, host, accountId: id || null });
    const updated = await gateway.snapshot();
    if (attemptId !== attempt.current) return;
    setSnapshot(updated); onSnapshot?.(updated); setDraft(null); setSecret(""); setUsage(null); setPresence(null); setConfirmDelete(false);
    setNotice("選択を保存しました。既存の会話には反映しません。");
  }

  /** Delete only a confirmed managed account and refresh the persisted selection. */
  async function deleteAccount() {
    if (!gateway || !selected) return;
    const attemptId = attempt.current;
    await gateway.delete(selected.account.id);
    const updated = await gateway.snapshot();
    if (attemptId !== attempt.current) return;
    setSnapshot(updated); onSnapshot?.(updated); setDraft(null); setSecret(""); setUsage(null); setPresence(null); setConfirmDelete(false);
    setNotice("管理アカウントを削除しました。システム既定のログインは変更しません。");
  }

  return <section className="space-y-3 border-t border-border pt-4" aria-label={t("プロバイダーアカウント")}>
    <h3 className="text-sm font-semibold">{t("プロバイダーアカウント")}</h3>
    <Button size="sm" variant="outline" disabled={!gateway || busy} onClick={() => { void perform(async () => { const id = attempt.current; const updated = await gateway!.snapshot(); if (id === attempt.current) { setSnapshot(updated); onSnapshot?.(updated); setUsage(null); setPresence(null); } }); }}>{t("設定を再読み込み")}</Button>
    <p className="text-xs text-muted-foreground">{t("選択は次の ACP 起動に適用します。既存の会話は元のアカウントを維持します。")}</p>
    {!gateway && <p role="status">{t("AI 機能はデスクトップアプリで利用します。")}</p>}
    <label className="block text-xs">{t("プロバイダーアカウント")}<select className="ml-2 rounded border bg-background p-1" value={provider} onChange={event => { resetView(); setProvider(event.target.value as AccountProvider); }}>
      {ACCOUNT_PROVIDERS.map(p => <option key={p.id} value={p.id}>{p.label}</option>)}
    </select></label>
    <label className="block text-xs">{t("認証スコープ")}<select className="ml-2 rounded border bg-background p-1" value={hostKind} onChange={event => { resetView(); setHostKind(event.target.value as "local" | "wsl"); }}>
      <option value="local">{t("ローカル OS")}</option><option value="wsl">Windows WSL</option>
    </select></label>
    {hostKind === "wsl" && <><label className="block text-xs">{t("WSL ディストリビューション")}<input className="ml-2 rounded border bg-background p-1" value={distribution} maxLength={128} onChange={event => { resetView(); setDistribution(event.target.value); }} /></label><p className="text-xs">{t(accountReasonKey("wsl_unsupported"))}</p></>}
    <label className="block text-xs">{t("使用するアカウント")}<select className="ml-2 rounded border bg-background p-1" value={selectedId} disabled={!gateway || busy || !hostValid} onChange={event => { void perform(() => chooseAccount(event.target.value)); }}>
      <option value="">{t("システム既定")}</option>{accounts.map(state => <option key={state.account.id} value={state.account.id}>{state.account.name}</option>)}
    </select></label>
    <p className="text-xs text-muted-foreground">{selected ? t(selected.hasCredential ? "認証情報あり（未検証）" : "認証情報なし") : t("システム既定のログインを使用します。認証状態は未確認です。")}</p>
    <p className="text-xs"><a className="underline" href={spec.docs} target="_blank" rel="noreferrer" onClick={gateway ? event => { event.preventDefault(); void perform(() => gateway.openSetup(provider)); } : undefined}>{t("公式の設定・使用量ページ")}</a></p>
    {spec.usage && provider !== "codex" && provider !== "minimax" && <p className="text-xs">{t("この使用量取得は公開保証のない API を使用します。形式が変わると取得できません。")}</p>}
    {!spec.usage && <p className="text-xs">{t(accountReasonKey("adapter_unsupported"))}</p>}
    {provider === "gemini" && <p className="text-xs">{t("Google ログインのレガシー設定のみ対応します。API キーの使用量とは別です。")}</p>}
    {provider === "minimax" && <p className="text-xs">{t("Subscription Key 専用です。従量課金キーやブラウザー Cookie には対応しません。")}</p>}
    {provider === "cursor" && <p className="text-xs">{t("Cookie は手動入力のみです。ブラウザーから自動で読み取りません。")}</p>}
    <div className="flex flex-wrap gap-2">
      <Button size="sm" variant="outline" disabled={!gateway || busy || !hostValid} onClick={() => { setSecret(""); setConfirmDelete(false); setDraft({ id: "", revision: 0, provider, host, name: "", endpoint: spec.endpoints[0], project: "" }); }}>{t("アカウントを追加")}</Button>
      <Button size="sm" variant="outline" disabled={!gateway || busy || !hostValid || hostKind === "wsl" || !!draft} onClick={() => { void perform(async () => { const id = attempt.current; const result = await gateway!.credentialPresent(provider, host); if (id === attempt.current) setPresence(result); }); }}>{t("認証状態を確認")}</Button>
      <Button size="sm" variant="outline" disabled={!gateway || busy || !hostValid || hostKind === "wsl" || !spec.usage || !!draft} onClick={() => { setUsage(null); void perform(async () => { const id = attempt.current; const result = await gateway!.usage(provider, host); if (id === attempt.current) setUsage(result); }); }}>{t("使用量を更新")}</Button>
    </div>
    {presence !== null && <p role="status" className="text-xs">{t(presence ? "認証情報あり（未検証）" : "対応する保存先に認証情報が見つかりません。他の認証方式は未確認です。")}</p>}
    {editing && <fieldset className="space-y-2 rounded border border-border p-3" disabled={busy || !gateway}>
      <legend className="text-xs">{draft?.id === "" ? t("アカウントを追加") : t("管理アカウントを編集")}</legend>
      {!spec.launch && <p className="text-xs">{t("保存した認証は使用量取得用です。この CLI の管理アカウントによる起動は未対応です。")}</p>}
      <label className="block text-xs">{t("アカウント名")}<input className="ml-2 rounded border bg-background p-1" maxLength={100} value={editing.name} onChange={event => setDraft({ ...editing, name: event.target.value })} /></label>
      <label className="block text-xs">{t("使用量の接続先")}<select className="ml-2 max-w-full rounded border bg-background p-1" value={editing.endpoint} onChange={event => setDraft({ ...editing, endpoint: event.target.value })}>{spec.endpoints.map(endpoint => <option key={endpoint} value={endpoint}>{endpoint}</option>)}</select></label>
      {provider === "gemini" && <label className="block text-xs">{t("Google Cloud プロジェクト ID（任意）")}<input className="ml-2 rounded border bg-background p-1" value={editing.project} maxLength={200} onChange={event => setDraft({ ...editing, project: event.target.value })} /></label>}
      <label className="block text-xs">{t(spec.credential)}<input className="ml-2 rounded border bg-background p-1" type="password" autoComplete="new-password" spellCheck={false} value={secret} onChange={event => setSecret(event.target.value)} /></label>
      <p className="text-xs text-muted-foreground">{t("空欄なら保存済みの認証情報を維持します。値は再表示しません。")}</p>
      <Button size="sm" disabled={!editing.name.trim()} onClick={() => { void perform(saveAccount); }}>{t("アカウントを保存")}</Button>
      {draft && <Button size="sm" variant="outline" onClick={() => { setDraft(null); setSecret(""); }}>{t("キャンセル")}</Button>}
      {selected && !draft && <Button size="sm" variant="outline" onClick={() => setConfirmDelete(true)}>{t("アカウントを削除")}</Button>}
      {confirmDelete && <div className="space-y-2" role="group" aria-label={t("管理アカウントの削除確認")}><p className="text-xs">{t("この管理アカウントの認証情報と設定を削除します。")}</p><Button size="sm" onClick={() => { void perform(deleteAccount); }}>{t("削除を確定")}</Button><Button size="sm" variant="outline" onClick={() => setConfirmDelete(false)}>{t("キャンセル")}</Button></div>}
    </fieldset>}
    {usage && <div className="space-y-2 text-xs" aria-label={t("アカウントの使用量")}>
      {usage.unavailableReason && <p role="status">{t(accountReasonKey(usage.unavailableReason))}</p>}
      {usage.quotas.map((quota, index) => <div key={`${quota.label}:${index}`}><span>{quota.label}: {quota.usedPercent.toLocaleString(undefined, { maximumFractionDigits: 2 })}%</span><progress aria-label={quota.label} value={quota.usedPercent} max={100} className="ml-2" />{quota.resetsAt && <span className="ml-2">{t("リセット値")}: {quota.resetsAt}</span>}</div>)}
      <p>{t("取得日時")}: {new Date(usage.receivedMs).toLocaleString()}</p>
    </div>}
    {busy && <p role="status" className="text-xs">{t("処理中…")}</p>}
    {notice && <p role="status" className="text-xs">{t(notice)}</p>}
  </section>;
}
