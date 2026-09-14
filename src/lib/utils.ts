import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

/** Merge conditional classes without allowing utility conflicts to leak through. */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
