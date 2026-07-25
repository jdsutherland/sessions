import type { SessionRecord } from './record';

export const MAX_THINKING_LEN = 20_000;

/**
 * Plaintext reasoning for the (low-weighted) `thinking` FTS column, read straight off
 * the record. The per-tool dispatch this used to carry is gone, and with it the
 * `if (tool === 'codex') return ''` that made every Codex session's reasoning
 * permanently unsearchable — Codex ships 97.6% of its reasoning encrypted, but the
 * `agent_reasoning` events and `summary_text` records it does write in the clear were
 * being thrown away too (7 of 300 rollouts here, 107KB of text).
 *
 * What each harness supplies is the adapters' business now (src/record.ts). Worth
 * knowing: for Claude this is empty in almost every session, because 12,768 of 12,778
 * real thinking blocks carry `thinking: ""`.
 */
export function extractThinking(records: SessionRecord[]): string {
  const parts: string[] = [];
  for (const r of records) {
    if (r.role === 'reasoning') parts.push(r.text);
  }
  return parts.join('\n').slice(0, MAX_THINKING_LEN);
}
