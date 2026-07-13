// Shared slide validator for the two extra-slide sources — --extras (a file)
// and --roast (model output). Whatever the origin, the page owns shape, field
// length, and count. Kept in its own module so index.ts and roast.ts can both
// import it without a cycle.

import type { WrappedExtra } from './types.ts';

export function coerceExtras(parsed: unknown): WrappedExtra[] {
  if (!Array.isArray(parsed)) return [];
  // Cap by code points, not UTF-16 units — String.slice can split a surrogate
  // pair and leave a lone half that renders as U+FFFD on the slide.
  const cap = (s: unknown, n: number): string | undefined => {
    if (typeof s !== 'string' || s.trim().length === 0) return undefined;
    return [...s.trim()].slice(0, n).join('');
  };
  const out: WrappedExtra[] = [];
  for (const item of parsed.slice(0, 6)) {
    if (typeof item !== 'object' || item === null) continue;
    const o = item as Record<string, unknown>;
    const headline = cap(o['headline'], 120);
    if (!headline) continue;
    out.push({
      headline,
      title: cap(o['title'], 60),
      subline: cap(o['subline'], 200),
      footnote: cap(o['footnote'], 160),
    });
  }
  return out;
}
