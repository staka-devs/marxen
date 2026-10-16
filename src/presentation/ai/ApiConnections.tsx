import type { LabelKey } from "../../contracts/localization";
import type { LocalizedText } from "../../contracts/localization";
import { localizedFailure, renderLocalizedText } from "../../domain/localization";
import type { Translator } from "../../contracts/localization";
import { japaneseTranslator } from "../../domain/localization";
import { useI18n } from "../i18n/I18nProvider";
import { createPortal } from "react-dom";
import { trapDialogTab } from "../workspace/dialogFocus";
import { useEffect, useRef, useState } from "react";
import { Button } from "../ui/button";
import { ChoiceMenu } from "../ui/choice-menu";
import { ProviderIcon } from "./provider-icon";
import { DEFAULT_ENDPOINTS, describeInvokeError } from "../../domain/ai-config";
import { validateConnectionFields, type ApiConnectionList } from "../../domain/ai-connections";
import type { ApiConnection, ApiConnectionId, ApiProtocol, ConnectionCredentialRef } from "../../contracts/ai-contracts";
import type { ApiConnectionGateway } from "../../application/ports";

/** Protocol choices for the settings dropdown with user-facing labels. */
function protocolChoices(t: Translator) {
  return [
    { value: "openai_compatible", label: t("OpenAI 互換"), icon: <ProviderIcon provider="openai_compatible" size={14} /> },
    { value: "anthropic", label: "Anthropic Messages", icon: <ProviderIcon provider="anthropic" size={14} /> },
  ];
}

export interface ApiConnectionDialogProps {
  /** Draft being added or edited; the ID is already minted by the owner. */
  initial: ApiConnection;
  /** True when registering a new connection rather than editing a saved one. */
  isNew: boolean;
  /** Per-connection credential gateway; absence means desktop-only credential UI stays quiet. */
  connectionGateway?: ApiConnectionGateway;
  /** Persist the draft; the secret is stored only when non-null. */
  onSave: (connection: ApiConnection, secret: string | null) => void;
  /** Close without persisting the draft. */
  onClose: () => void;
}

/**
 * Add or edit one named API connection with a protocol dropdown.
 *
 * New connections collect an optional secret that the owner stores only on
 * save, so cancelling never orphans a credential. Saved connections manage
 * their OS-store credential immediately by connection ID.
 */
export function ApiConnectionDialog({ initial, isNew, connectionGateway, onSave, onClose }: ApiConnectionDialogProps) {
  const { t, message } = useI18n();
  const [name, setName] = useState(initial.name);
  const [protocol, setProtocol] = useState<ApiProtocol>(initial.protocol);
  const [endpoint, setEndpoint] = useState(initial.endpoint);
  const [model, setModel] = useState(initial.model);
  const [secretInput, setSecretInput] = useState("");
  const [credential, setCredentialState] = useState<ConnectionCredentialRef | null>(null);
  const [credentialMessage, setCredentialMessage] = useState<LocalizedText | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const dialogRef = useRef<HTMLDivElement>(null);
  const openerRef = useRef<Element | null>(null);

  useEffect(() => {
    openerRef.current = document.activeElement;
    dialogRef.current?.focus();
    /**
     * Close the dialog on Escape without persisting the draft.
     *
     * Registered in the capture phase so the shell's global shortcuts never
     * fire first; ChoiceMenu popups consume their own Escape first. Closing
     * restores focus to the opener so keyboard users never lose their place.
     */
    const onKey = (event: KeyboardEvent) => {
      trapDialogTab(event, dialogRef.current);
      if (event.key === "Escape") {
        if (document.querySelector('[role="listbox"]')) return;
        event.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      const opener = openerRef.current as HTMLElement | null;
      if (opener && typeof opener.focus === "function") opener.focus();
    };
  }, [onClose]);

  /**
   * Refresh credential presence for the edited connection through the gateway.
   *
   * Without a gateway (tests, browser demo) reports that desktop is required.
   */
  async function refreshCredential() {
    if (!connectionGateway) {
      setCredentialMessage(message("AI 機能はデスクトップアプリで利用します。"));
      return;
    }
    try {
      setCredentialState(await connectionGateway.getConnectionCredentialState(initial.id));
      setCredentialMessage(null);
    } catch (cause) {
      setCredentialMessage(localizedFailure(cause, describeInvokeError));
    }
  }

  /**
   * Save the typed secret to this connection's OS-store slot immediately.
   *
   * Clears the input on success; failures surface as helper text.
   */
  async function handleSaveCredential() {
    if (!connectionGateway) {
      setCredentialMessage(message("AI 機能はデスクトップアプリで利用します。"));
      return;
    }
    try {
      await connectionGateway.setConnectionCredential(initial.id, secretInput);
      setSecretInput("");
      await refreshCredential();
      setCredentialMessage(message("資格情報を OS ストアに保存しました。値は表示しません。"));
    } catch (cause) {
      setCredentialMessage(localizedFailure(cause, describeInvokeError));
    }
  }

  /**
   * Delete only this connection's stored secret.
   *
   * Refreshes presence afterwards so the UI never shows a stale value.
   */
  async function handleDeleteCredential() {
    if (!connectionGateway) {
      setCredentialMessage(message("AI 機能はデスクトップアプリで利用します。"));
      return;
    }
    try {
      await connectionGateway.deleteConnectionCredential(initial.id);
      await refreshCredential();
      setCredentialMessage(message("資格情報を削除しました。"));
    } catch (cause) {
      setCredentialMessage(localizedFailure(cause, describeInvokeError));
    }
  }

  /**
   * Validate the draft and hand it to the owner without touching storage.
   *
   * New-connection secrets travel with the save so cancelling the dialog
   * never orphans a credential under the minted ID.
   */
  function handleSave() {
    const failures = validateConnectionFields({ name, protocol, endpoint, model });
    setErrors(failures);
    if (failures.length > 0) return;
    onSave(
      { id: initial.id, name: name.trim(), protocol, endpoint: endpoint.trim(), model: model.trim() },
      isNew && secretInput !== "" ? secretInput : null,
    );
  }

  /**
   * Resolve the live theme scope for the dialog portal.
   *
   * Mounts inside the opener's `[data-theme]` container (falling back to the
   * first themed scope) so CSS variables apply; matches AiProviderSettings
   * instead of themeless `document.body`.
   */
  function themeScope(): Element {
    return openerRef.current?.closest?.("[data-theme]") ?? document.querySelector("[data-theme]") ?? document.body;
  }

  return createPortal(
    <div
      className="ai-provider-overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={isNew ? t("API 接続先を追加") : t("API 接続先を編集")}
        tabIndex={-1}
        className="ai-provider-dialog"
      >
        <div className="ai-provider-dialog-header flex shrink-0 items-center gap-1.5">
          <h2 className="min-w-0 flex-1 truncate text-[13px] font-semibold">{isNew ? t("API 接続先を追加") : t("API 接続先を編集")}</h2>
          <Button variant="outline" size="sm" aria-label={t("閉じる")} title={t("閉じる")} onClick={onClose} className="shrink-0">
            {t("閉じる")}</Button>
        </div>
        <div className="ai-provider-dialog-body min-h-0 space-y-2.5 overflow-y-auto px-2.5 py-2">
          <label className="block text-xs">
            {t("接続先名")}<input
              aria-label={t("接続先名")}
              className="mt-1 block w-full rounded-md border border-border bg-card px-2 py-1.5 text-xs"
              value={name}
              onChange={(event) => { setName(event.target.value); setErrors([]); }}
              placeholder={t("接続先名")}
              maxLength={64}
            />
          </label>
          <div className="text-xs">
            <span id="api-protocol-label">{t("通信形式")}</span>
            <ChoiceMenu
              label={t("通信形式")}
              value={protocol}
              onChange={(value) => {
                const next = value as ApiProtocol;
                setProtocol(next);
                setErrors([]);
                if (endpoint.trim() === "" || endpoint.trim() === DEFAULT_ENDPOINTS[protocol]) {
                  setEndpoint(DEFAULT_ENDPOINTS[next]);
                }
              }}
              choices={protocolChoices(t)}
            />
          </div>
          <label className="block text-xs">
            {t("API エンドポイント")}<input
              aria-label={t("API エンドポイント")}
              className="mt-1 block w-full rounded-md border border-border bg-card px-2 py-1.5 text-xs"
              value={endpoint}
              onChange={(event) => { setEndpoint(event.target.value); setErrors([]); }}
              placeholder={DEFAULT_ENDPOINTS[protocol === "openai_compatible" ? "openai_compatible" : "anthropic"]}
            />
          </label>
          <label className="block text-xs">
            {t("モデル")}<input
              aria-label={t("モデル")}
              className="mt-1 block w-full rounded-md border border-border bg-card px-2 py-1.5 text-xs"
              value={model}
              onChange={(event) => { setModel(event.target.value); setErrors([]); }}
              placeholder="model-id"
            />
          </label>
          {isNew ? (
            <div>
              <p className="text-xs font-medium">{t("API キー")}</p>
              <div className="mt-1 flex gap-1">
                <input
                  aria-label={t("資格情報の入力")}
                  type="password"
                  autoComplete="off"
                  className="min-w-0 flex-1 rounded-md border border-border bg-card px-2 py-1.5 text-xs"
                  value={secretInput}
                  onChange={(event) => setSecretInput(event.target.value)}
                  placeholder={t("API キーなど")}
                />
              </div>
              <p className="mt-1 text-[11px] text-muted-foreground">{t("OS の資格情報ストアに保存します。")}</p>
            </div>
          ) : (
            <div className="border-t border-border pt-2">
              <p className="text-xs font-medium">{t("API キー")}</p>
              <p className="mt-1 text-[11px] text-muted-foreground">
                {credential === null ? t("未確認") : credential.hasSecret ? t("保存済み") : t("未保存")}
              </p>
              <div className="mt-1 flex flex-wrap gap-1">
                <Button variant="outline" size="sm" onClick={() => void refreshCredential()}>{t("状態を確認")}</Button>
                <Button variant="outline" size="sm" onClick={() => void handleDeleteCredential()}>{t("削除")}</Button>
              </div>
              <div className="mt-1 flex gap-1">
                <input
                  aria-label={t("資格情報の入力")}
                  type="password"
                  autoComplete="off"
                  className="min-w-0 flex-1 rounded-md border border-border bg-card px-2 py-1.5 text-xs"
                  value={secretInput}
                  onChange={(event) => setSecretInput(event.target.value)}
                  placeholder={t("API キーなど")}
                />
                <Button size="sm" aria-label={t("API キーを保存")} title={t("API キーを保存")} onClick={() => void handleSaveCredential()} disabled={secretInput.length === 0}>{t("保存")}</Button>
              </div>
              {credentialMessage && <p className="mt-1 text-[11px] text-muted-foreground">{renderLocalizedText(credentialMessage, t)}</p>}
              <p className="mt-2 text-xs text-muted-foreground">{t("OS の資格情報ストアに保存します。")}</p>
            </div>
          )}
          {errors.length > 0 && (
            <div role="alert" className="text-xs font-medium text-red-600">
              {errors.map((key) => <p key={key}>{t(key as LabelKey)}</p>)}
            </div>
          )}
          <div className="flex justify-end gap-1">
            <Button variant="outline" size="sm" onClick={onClose}>{t("キャンセル")}</Button>
            <Button size="sm" onClick={handleSave}>{t("保存")}</Button>
          </div>
        </div>
      </div>
    </div>, themeScope(),
  );
}

/** Connection selection shared by the chat switcher and the settings list. */
export interface ApiConnectionSelection {
  /** Sanitized named-connection list owned by the composition root. */
  list: ApiConnectionList;
  /** Currently active connection ID, or null when none is selected. */
  activeId: string | null;
  /**
   * Switch the chat to the chosen connection wholesale.
   *
   * Returns false when the target is missing or persistence fails, keeping
   * the previous connection and provider.
   */
  onSelect: (id: ApiConnectionId) => boolean;
}

/** Full named-connection controls owned by the composition root. */
export interface ApiConnectionControls extends ApiConnectionSelection {
  /**
   * Persist a newly registered connection with its optional secret.
   *
   * Returns false on metadata failure, keeping the previous provider, record,
   * and credential with no secret written; credential failures after metadata
   * success surface as notices with the record staying selected.
   */
  onAdd: (connection: ApiConnection, secret: string | null) => boolean;
  /**
   * Persist edits to one saved connection.
   *
   * Returns false on persistence failure, keeping the previous record and
   * provider so the dialog can stay open.
   */
  onUpdate: (connection: ApiConnection) => boolean;
  /**
   * Delete one saved connection and its OS-store credential.
   *
   * Metadata persists first; returns false on metadata failure with no secret
   * deleted. Credential failures after metadata success keep the removed
   * record and surface a retryable notice for the orphaned slot.
   */
  onDelete: (id: ApiConnectionId) => boolean;
  /** Mint a fresh connection ID outside render. */
  onMintId: () => ApiConnectionId;
  /** Per-connection credential gateway forwarded to the edit dialog. */
  connectionGateway?: ApiConnectionGateway;
  /** One-shot notice (for example migration) rendered above the list. */
  notice?: LocalizedText | null;
  /** Retry a failed migration key copy without reselecting anything. */
  onRetryMigration?: () => void;
  /** Retry a failed post-delete credential removal for the retained deleted ID. */
  onRetryDeleteCredential?: () => void;
}

export interface ApiConnectionSettingsProps extends ApiConnectionControls {
  /** Fence connection switching while a run owns the shared staging slot. */
  disabled?: boolean;
}
/**
 * Named API connection list with add, edit, and explicit delete confirmation.
 *
 * Selecting a connection replaces endpoint and model wholesale so stale
 * results from another connection never display; deleting states clearly
 * that the OS-store credential goes with the connection.
 */
export function ApiConnectionSettings({ list, activeId, onSelect, onAdd, onUpdate, onDelete, onMintId, connectionGateway, notice, onRetryMigration, onRetryDeleteCredential, disabled = false }: ApiConnectionSettingsProps) {
  const { t } = useI18n();
  const [draft, setDraft] = useState<{ connection: ApiConnection; isNew: boolean } | null>(null);
  const [confirming, setConfirming] = useState<ApiConnectionId | null>(null);

  /**
   * Open a blank draft with a freshly minted stable ID.
   *
   * The ID is fixed before editing so the pending secret, when saved,
   * lands in exactly this connection's credential slot.
   */
  function openAdd() {
    setDraft({
      connection: { id: onMintId(), name: "", protocol: "openai_compatible", endpoint: DEFAULT_ENDPOINTS.openai_compatible, model: "" },
      isNew: true,
    });
  }

  /**
   * Persist the dialog draft and close the dialog on success.
   *
   * Add and edit share one path; only adds carry a pending secret. Metadata
   * failures keep the dialog open with no state changed, so no orphan secret
   * or misleading closed success occurs.
   */
  function saveDraft(connection: ApiConnection, secret: string | null) {
    const ok = draft?.isNew ? onAdd(connection, secret) : onUpdate(connection);
    if (ok === false) return;
    setDraft(null);
  }

  return (
    <div className="space-y-2" data-testid="api-connection-settings">
      <div className="flex items-center gap-1.5">
        <h3 className="min-w-0 flex-1 truncate text-xs font-medium">{t("名前付き API 接続先")}</h3>
        <Button variant="outline" size="sm" onClick={openAdd} disabled={disabled}>{t("API を追加")}</Button>
      </div>
      {notice && <p role="status" className="text-[11px] text-muted-foreground">{renderLocalizedText(notice, t)}</p>}
      {onRetryMigration && <div><Button variant="outline" size="sm" onClick={onRetryMigration}>{t("再試行")}</Button></div>}
      {onRetryDeleteCredential && <div><Button variant="outline" size="sm" onClick={onRetryDeleteCredential}>{t("資格情報の削除を再試行")}</Button></div>}
      {list.connections.length === 0 ? (
        <p className="text-[11px] text-muted-foreground">{t("API 接続先がありません。")}</p>
      ) : (
        <ul className="space-y-1">
          {list.connections.map((connection) => {
            const active = connection.id === activeId;
            const confirmingDelete = confirming === connection.id;
            return (
              <li key={connection.id} className="rounded-md border border-border px-2 py-1.5">
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    aria-pressed={active}
                    disabled={disabled}
                    onClick={() => onSelect(connection.id)}
                    title={`${connection.endpoint} • ${connection.model}`}
                    className="flex min-w-0 flex-1 items-center gap-1.5 rounded-sm px-1 py-0.5 text-left text-xs hover:bg-muted disabled:opacity-50"
                  >
                    <ProviderIcon provider={connection.protocol} size={14} />
                    <span className="min-w-0 flex-1 truncate font-medium">{connection.name}</span>
                    {active && <span className="shrink-0 text-[11px] text-muted-foreground">{t("使用中")}</span>}
                  </button>
                  <Button variant="outline" size="sm" aria-label={t("API 接続先を編集")} title={t("編集")} onClick={() => { setDraft({ connection, isNew: false }); setConfirming(null); }} disabled={disabled}>
                    {t("編集")}</Button>
                  <Button variant="outline" size="sm" aria-label={t("削除")} title={t("削除")} onClick={() => setConfirming(confirmingDelete ? null : connection.id)} disabled={disabled}>
                    {t("削除")}</Button>
                </div>
                {confirmingDelete && (
                  <div className="mt-1.5 border-t border-border pt-1.5">
                    <p className="text-[11px] text-muted-foreground">{t("接続先と API キーを削除します。")}</p>
                    <div className="mt-1 flex gap-1">
                      <Button variant="outline" size="sm" onClick={() => setConfirming(null)}>{t("キャンセル")}</Button>
                      <Button size="sm" onClick={() => { const ok = onDelete(connection.id); if (ok !== false) setConfirming(null); }}>{t("削除")}</Button>
                    </div>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {draft && (
        <ApiConnectionDialog
          initial={draft.connection}
          isNew={draft.isNew}
          connectionGateway={connectionGateway}
          onSave={saveDraft}
          onClose={() => setDraft(null)}
        />
      )}
    </div>
  );
}

/**
 * Describe one named connection for translators and tests.
 *
 * Shows the name with its protocol label; liveness comes only from an
 * explicit connection test and is never invented here.
 */
export function describeApiConnection(connection: ApiConnection, t: Translator = japaneseTranslator): string {
  const protocol = connection.protocol === "openai_compatible" ? t("OpenAI 互換") : "Anthropic Messages";
  return `${connection.name} • ${protocol}`;
}
