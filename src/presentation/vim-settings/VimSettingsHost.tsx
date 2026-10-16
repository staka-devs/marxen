import { useEffect } from "react";
import { useI18n } from "../i18n/I18nProvider";
import type { VimSettingsGateway } from "../../application/vim-settings/ports";
import type { DialogGateway } from "../../application/ports";
import { useVimSettings } from "./useVimSettings";
import { VimSettingsPanel } from "./VimSettingsPanel";

interface Props {
  gateway: VimSettingsGateway;
  initialPath: string;
  /** Share the selected path with the apply action. */
  onPathChange?: (path: string) => void;
  /** Select the saved config for the shell's explicit apply action. */
  onSaved: (path: string) => void;
  dialogGateway?: DialogGateway;
}

/** Bind the settings editor to injected native ports without restarting Neovim on save. */
export function VimSettingsHost({ gateway, initialPath, onSaved, onPathChange, dialogGateway }: Props) {
  const { t } = useI18n();
  const model = useVimSettings({ gateway, initialPath, onSaved });
  useEffect(() => { onPathChange?.(model.selectedPath); }, [model.selectedPath, onPathChange]);
  /** Browse for one config file and load it through the same guarded editor. */
  async function browse() {
    const picked = await dialogGateway?.pickConfigFile(t("Neovim 設定ファイル"));
    if (picked) model.setSelectedPath(picked);
  }
  return <VimSettingsPanel model={model} onBrowseConfig={dialogGateway ? () => void browse() : undefined} />;
}
