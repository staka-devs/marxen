import type { ComponentProps } from "react";
import { cn } from "../utils/cn";

/** Padded card section for settings and panels. */ export function Card({ className, ...props }: ComponentProps<"section">) {
  return <section className={cn("rounded-xl border border-border bg-card p-6", className)} {...props} />;
}

