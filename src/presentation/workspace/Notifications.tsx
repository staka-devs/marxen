import { useI18n } from "../i18n/I18nProvider";
import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { CheckCircle2, Info, X } from "lucide-react";
import { trapDialogTab } from "./dialogFocus";
import type { ThemeId } from "../../domain/workspace-content";
import type { LocalizedText } from "../../contracts/localization";
import { renderLocalizedText } from "../../domain/localization";

/** Display behavior for a transient success or a persistent notification. */
export type NoticeKind = "info" | "success" | "error";

/** One notification occurrence, including repeated messages. */
export interface Notice {
  id: number;
  message: LocalizedText;
  kind: NoticeKind;
}

interface ToastProps {
  notice: Notice;
  /** Dismiss a specific occurrence, retaining newer notifications. */
  onDismiss: (id: number) => void;
  actions?: ReactNode;
  raised?: boolean;
  testId?: string;
  theme?: ThemeId;
}

interface DialogProps {
  label: string;
  testId?: string;
  /** Cancel the decision without executing its destructive action. */
  onDismiss: () => void;
  children: ReactNode;
  theme?: ThemeId;
}

/** Show notifications outside the editor layout without taking keyboard focus. */
export function NotificationToast({ notice, onDismiss, actions, raised = false, testId = "notification-toast", theme }: ToastProps) {
  const { t } = useI18n();
  const dismiss = useRef(onDismiss);
  dismiss.current = onDismiss;
  useEffect(() => {
    if (notice.kind !== "success") return;
    const timer = window.setTimeout(() => dismiss.current(notice.id), 4_000);
    return () => window.clearTimeout(timer);
  }, [notice.id, notice.kind]);
  const Icon = notice.kind === "success" ? CheckCircle2 : Info;
  return createPortal(
    <div data-theme={theme} data-testid={testId} role={notice.kind === "error" ? "alert" : "status"} className={`fixed ${raised ? "bottom-32" : "bottom-8"} right-4 z-50 flex w-[min(360px,calc(100vw-32px))] items-start gap-3 rounded-md border border-border bg-card p-3 text-[13px] text-foreground shadow-xl`}>
      <Icon size={17} className="mt-0.5 shrink-0 text-muted-foreground" aria-hidden="true" />
      <div className="min-w-0 flex-1 break-words leading-5"><p>{renderLocalizedText(notice.message, t)}</p>{actions && <div className="mt-2 flex gap-2">{actions}</div>}</div>
      <button type="button" aria-label={t("通知を閉じる")} onClick={() => onDismiss(notice.id)} className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-muted"><X size={15} aria-hidden="true" /></button>
    </div>, document.body,
  );
}

/** Present a decision in a modal, trap keyboard focus, and restore it on dismissal. */
export function WorkspaceDialog({ label, testId, onDismiss, children, theme }: DialogProps) {
  const { t } = useI18n();
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const element = panel.current;
    // Destructive decisions require explicit activation; initially focus the panel.
    element?.focus();
    return () => {
      if (previous?.isConnected && (element?.contains(document.activeElement) || document.activeElement === document.body)) previous.focus();
    };
  }, []);
  return createPortal(
    <div data-theme={theme} className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4 text-foreground" onPointerDown={(event) => { if (event.target === event.currentTarget) onDismiss(); }}>
      <div ref={panel} role="dialog" aria-modal="true" aria-label={label} data-testid={testId} tabIndex={-1} className="flex max-h-[80dvh] w-full max-w-md flex-col overflow-hidden rounded-md border border-border bg-card shadow-2xl outline-none"
        onKeyDown={(event) => {
          if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onDismiss(); }
          else trapDialogTab(event, panel.current);
        }}>
        <div className="flex h-11 shrink-0 items-center justify-between border-b border-border px-4">
          <h2 className="text-sm font-medium">{label}</h2>
          <button type="button" aria-label={t("{{value0}}を閉じる", { value0: (label) })} onClick={onDismiss} className="rounded p-1 text-muted-foreground hover:bg-muted"><X size={16} aria-hidden="true" /></button>
        </div>
        <div className="min-h-0 overflow-y-auto p-4 text-[13px] leading-6">{children}</div>
      </div>
    </div>, document.body,
  );
}
