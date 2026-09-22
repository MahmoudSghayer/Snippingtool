import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/** Merges class lists, letting a later Tailwind utility win over an earlier
 * conflicting one (e.g. a consumer's `className="p-2"` overriding a
 * component's default `p-4`). Every component in this package builds its
 * class list through this helper instead of template-literal concatenation. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
