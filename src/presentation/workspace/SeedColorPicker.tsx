import { useState } from "react";
import type { LabelKey } from "../../contracts/localization";
import { useI18n } from "../i18n/I18nProvider";
import { MATERIAL_HUES, MATERIAL_SHADES, findMaterialColor } from "../../domain/material-palette";
import { textOn } from "../../domain/color-scheme";

interface Props {
  value: string;
  /** Persist a new `#rrggbb` seed color. */
  onChange: (color: string) => void;
}

/** Choose the Material 3 seed: one of 19 hues, then one of its shades, or any custom color. */
export function SeedColorPicker({ value, onChange }: Props) {
  const { t } = useI18n();
  const [hueId, setHueId] = useState(() => findMaterialColor(value)?.hue.id ?? "blue");
  const hue = MATERIAL_HUES.find((item) => item.id === hueId) ?? MATERIAL_HUES[0];
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div role="group" aria-label={t("色相")} className="flex flex-wrap gap-1">
        {MATERIAL_HUES.map((item) => (
          <button key={item.id} type="button" aria-pressed={item.id === hueId} aria-label={t(item.label as LabelKey)} title={t(item.label as LabelKey)}
            onClick={() => { setHueId(item.id); onChange(item.colors[5]); }}
            style={{ background: item.colors[5] }}
            className="h-6 w-6 rounded-full border border-border aria-pressed:ring-2 aria-pressed:ring-foreground aria-pressed:ring-offset-1 aria-pressed:ring-offset-background" />
        ))}
      </div>
      <div role="group" aria-label={t("{{value0}}の濃さ", { value0: t(hue.label as LabelKey) })} className="flex flex-wrap gap-1">
        {hue.colors.map((color, index) => (
          <button key={color} type="button" aria-pressed={color === value} aria-label={`${t(hue.label as LabelKey)} ${MATERIAL_SHADES[index]}`} title={`${MATERIAL_SHADES[index]} ${color}`}
            onClick={() => onChange(color)}
            style={{ background: color, color: textOn(color) }}
            className="h-7 w-10 rounded-sm text-[10px] font-medium aria-pressed:ring-2 aria-pressed:ring-foreground aria-pressed:ring-offset-1 aria-pressed:ring-offset-background">
            {MATERIAL_SHADES[index]}
          </button>
        ))}
      </div>
      <label className="flex items-center gap-2 text-xs text-muted-foreground">
        <input type="color" aria-label={t("任意の色")} value={value} onChange={(event) => onChange(event.target.value)} className="h-6 w-8 cursor-pointer rounded-sm border border-border bg-transparent" />
        {t("任意の色")}
        <code className="text-foreground">{value}</code>
      </label>
    </div>
  );
}
