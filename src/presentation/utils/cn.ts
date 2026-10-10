import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * Merge Tailwind class lists, resolving conflicts with tailwind-merge.
 *
 * Thin wrapper over `clsx` + `twMerge` shared by presentation components.
 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
