import type { ReactNode } from "react";
import { Files, GitBranch, ListTree, Search, Settings as SettingsIcon } from "lucide-react";
import { useI18n } from "../i18n/I18nProvider";
import type { SideView } from "./shellView";

interface Props {
  sideView: SideView | null;
  /** Toggle a side view; the open view closes when chosen again. */
  onSideView: (update: (current: SideView | null) => SideView | null) => void;
  /** Offer Source Control (desktop with a Git-capable gateway). */
  showScm: boolean;
  /** Open settings. */
  onSettings: () => void;
}

/** VS Code-style activity bar choosing the side view, with settings at the bottom. */
export function ActivityBar({ sideView, onSideView, showScm, onSettings }: Props) {
  const { t } = useI18n();
  const items: Array<{ id: SideView; label: string; icon: ReactNode }> = [
    { id: "explorer", label: t("エクスプローラー"), icon: <Files size={19} aria-hidden="true" /> },
    { id: "search", label: t("検索"), icon: <Search size={19} aria-hidden="true" /> },
    ...(showScm ? [{ id: "scm" as const, label: t("ソース管理"), icon: <GitBranch size={19} aria-hidden="true" /> }] : []),
    { id: "outline", label: t("アウトライン"), icon: <ListTree size={19} aria-hidden="true" /> },
  ];
  return (
    <nav aria-label={t("アクティビティ")} className="marxen-activity flex w-12 shrink-0 flex-col items-center border-r border-border bg-card py-1">
      {items.map((item) => (
        <button
          key={item.id}
          type="button"
          onClick={() => onSideView((current) => (current === item.id ? null : item.id))}
          aria-pressed={sideView === item.id}
          aria-label={item.label}
          title={item.label}
          className={`relative flex h-11 w-full items-center justify-center border-l-2 hover:text-foreground ${sideView === item.id ? "border-primary text-foreground" : "border-transparent text-muted-foreground"}`}
        >
          {item.icon}
        </button>
      ))}
      <button
        type="button"
        onClick={onSettings}
        aria-label={t("設定表示切替")}
        title={t("設定")}
        className="mt-auto flex h-11 w-full items-center justify-center text-muted-foreground hover:text-foreground"
      >
        <SettingsIcon size={19} aria-hidden="true" />
      </button>
    </nav>
  );
}
