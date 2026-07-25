import { basename } from 'node:path';
import { type Tool } from './types';

/** Trailing UUID of a Codex rollout filename: `rollout-<ISO>-<uuid>.jsonl`. */
const UUID_TAIL = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The one identity for a session, shared by the index and the report pipeline.
 *
 * They used to disagree: the indexer took `basename(filePath)` while
 * report/parsers/codex.ts took `session_meta.payload.id`, so the same Codex rollout
 * was `rollout-2026-04-16T10-36-08-019d96ef-…` on one side and `019d96ef-…` on the
 * other. Pi had the same split (`<ISO>_<uuid>` vs `session.id`). Nothing crashed —
 * the two ids simply never met, which is why it survived.
 *
 * `idFromLog` is the id the transcript states about itself, when the caller already
 * has it: the report parsers stream parsed objects rather than `lines: string[]` and
 * must not be made to materialize a transcript just to name it. The filename
 * fallbacks below are what a caller without it gets, and they are derivations of the
 * same value — the uuid is in the filename too, just with a prefix.
 */
export function sessionIdFor(filePath: string, tool: Tool, idFromLog?: string): string {
  const base = basename(filePath).replace(/\.jsonl$/, '');
  if (idFromLog) return idFromLog;
  if (tool === 'codex') return UUID_TAIL.exec(base)?.[0] ?? base;
  // Pi files are `<ISO-with-dashes>_<uuid>`; the eval corpus uses plain names with no
  // separator, so an absent `_` means the whole basename is already the id.
  if (tool === 'pi') {
    const cut = base.lastIndexOf('_');
    return cut >= 0 ? base.slice(cut + 1) : base;
  }
  // claude: the basename IS the in-file sessionId (equal in 400/400 files checked).
  // opencode: the synthetic path's basename is the `ses_…` id (see src/opencode.ts).
  return base;
}
