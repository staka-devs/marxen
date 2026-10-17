import type { ReactNode } from "react";
import { ChevronDown } from "lucide-react";

interface StyledSelectProps {
  label: string;
  value: string | number;
  disabled?: boolean;
  id?: string;
  className?: string;
  title?: string;
  children: ReactNode;
  /** Commit the raw option value without interpreting its meaning. */
  onChange: (value: string) => void;
}

/**
 * Themed native select with a consistent trigger affordance.
 *
 * Keeps the OS option popup while unifying height, border, chevron,
 * and focus treatment across settings, provider, toolbar, and view-mode
 * selects. The wrapper carries layout width; the inner select fills it.
 */
export function StyledSelect({ label, value, disabled, id, className, title, children, onChange }: StyledSelectProps) {
  return (
    <span className={`marxen-select ${className ?? ""}`}>
      <select
        id={id}
        aria-label={label}
        title={title}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      >
        {children}
      </select>
      <ChevronDown size={13} className="marxen-select-chevron" aria-hidden="true" />
    </span>
  );
}
