// Model id → display name, plus canonicalization for merging and counting.
// Raw ids reach wrapped in several dresses for the same underlying model:
//   provider prefix    openai/gpt-oss-120b
//   context-window tag  claude-opus-4-8[1m]
//   tier suffix         claude-opus-4-8:thinking
//   dated snapshot      claude-opus-4-5-20251101
// A human counts all opus-4-5 rows as one model, so "N models tried" and the
// cast list dedup on the canonical (pretty) name, not the raw id.

/** Strip provider prefix + context-window/tier suffixes so matching sees the bare id. */
function normalizeModelId(id: string): string {
  return id
    .replace(/^[a-z0-9.-]+\//i, '') // provider/ prefix: openai/, anthropic/, moonshotai/
    .replace(/\[[^\]]*\]$/, '') // [1m] context-window marker
    .replace(/:[^:]*$/, '') // :thinking / :tier suffix
    .trim();
}

/** "claude-opus-4-8" → "Opus 4.8"; "claude-haiku-4-5-20251001" → "Haiku 4.5";
 *  "claude-opus-4-8[1m]" → "Opus 4.8"; "openai/gpt-oss-120b" → "gpt-oss-120b";
 *  anything unrecognized keeps its normalized id (never invent a name). */
export function prettyModel(id: string): string {
  const norm = normalizeModelId(id);
  // The minor version is 1-2 digits at a segment boundary — an 8-digit date
  // suffix (claude-opus-4-20250514) is NOT a minor version.
  const claude = norm.match(/^claude-(opus|sonnet|haiku|fable|mythos)-(\d+)(?:-(\d{1,2})(?=-|$))?/);
  if (claude) {
    const family = claude[1]!.charAt(0).toUpperCase() + claude[1]!.slice(1);
    return claude[3] ? `${family} ${claude[2]}.${claude[3]}` : `${family} ${claude[2]}`;
  }
  const gpt = norm.match(/^gpt-([\d.]+)(-\w+)?/);
  if (gpt) return `GPT-${gpt[1]}${gpt[2] ?? ''}`;
  return norm;
}

/** Canonical key for merging/counting model variants — the pretty name collapses
 *  provider prefixes and dated snapshots that are the same model. */
export const canonicalModel = prettyModel;

/** Whether a raw model id names a real model. Parsers emit sentinels like
 *  '<synthetic>' for turns with no model; those are never a model you "tried". */
export function isRealModel(id: string): boolean {
  return !!id && !id.startsWith('<');
}
