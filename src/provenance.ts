import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getClaudeDir, getCodexDir, getHandoffDir } from './paths';
import type { Tool } from './types';

/**
 * How a lesson's session id was established, most trustworthy first:
 *  meta      — the client stated it on the tool call itself (Codex)
 *  hook      — the SessionStart hook handed it over, transcript confirmed
 *  env       — inherited from the environment AND confirmed on disk
 *  deferred  — no session id, but a tool-use id that `sessions lessons audit` can trace
 *  recovered — a deferred row the audit resolved after the fact
 *  none      — nothing identifying reached us
 */
export type Provenance = 'meta' | 'hook' | 'env' | 'deferred' | 'recovered' | 'none';

export interface SessionProvenance {
  sessionId: string | null;
  transcript: string | null;
  /** Client-generated, appears verbatim in the transcript, never seen by the model. An audit anchor. */
  toolUseId: string | null;
  provenance: Provenance;
  verified: boolean;
  tool: Tool | '';
}

/** Codex puts session/thread/turn identity on every tools/call under this _meta key. */
const CODEX_TURN_META = 'x-codex-turn-metadata';
/** Claude Code sends no session id — but it does send the tool_use id, which the transcript also holds. */
const CLAUDE_TOOL_USE_ID = 'claudecode/toolUseId';

/** Handoff files older than this are session starts nobody is going to write a lesson from. */
const HANDOFF_TTL_MS = 30 * 24 * 60 * 60 * 1000;

// Ids arrive from a client's _meta or from the environment and end up in globs and
// filenames, so anything that is not a plain id is treated as absent rather than escaped.
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function safeId(v: unknown): string | null {
  return typeof v === 'string' && SAFE_ID.test(v) ? v : null;
}

/** What the SessionStart hook knows and the MCP server does not: the real session id and its transcript. */
export interface HookHandoff {
  sessionId: string;
  transcriptPath: string;
  cwd: string;
  source: string;
  writtenAt: string;
}

/**
 * Drop a handoff for the MCP server to find.
 *
 * `key` is `$CLAUDE_CODE_SESSION_ID` as the *hook* saw it, not the session id: hook
 * and MCP server are children of the same client and inherit the same value, so it
 * joins the two processes even on `claude -c`, where that value is stale and the real
 * id (in the payload) is something else. Keying by cwd instead would collide across
 * concurrent sessions in one repo.
 */
export function writeHandoff(key: string, handoff: HookHandoff): void {
  const safe = safeId(key);
  if (!safe) return;
  const dir = getHandoffDir();
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${safe}.json`), JSON.stringify(handoff) + '\n');
  pruneHandoffs(dir);
}

function pruneHandoffs(dir: string): void {
  const cutoff = Date.now() - HANDOFF_TTL_MS;
  try {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      try {
        if (statSync(p).mtimeMs < cutoff) unlinkSync(p);
      } catch {}
    }
  } catch {}
}

export function readHandoff(key: string): HookHandoff | null {
  const safe = safeId(key);
  if (!safe) return null;
  const path = join(getHandoffDir(), `${safe}.json`);
  if (!existsSync(path)) return null;
  try {
    const h = JSON.parse(readFileSync(path, 'utf-8')) as HookHandoff;
    return safeId(h?.sessionId) && typeof h.transcriptPath === 'string' ? h : null;
  } catch {
    return null;
  }
}

/** Claude writes `<projects>/<cwd-slug>/<session-id>.jsonl`; the slug is unknown here, so probe each project dir. */
export function findClaudeTranscript(sessionId: string): string | null {
  const root = getClaudeDir();
  let dirs: string[];
  try {
    dirs = readdirSync(root);
  } catch {
    return null;
  }
  for (const d of dirs) {
    const candidate = join(root, d, `${sessionId}.jsonl`);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** Codex rollouts are `<sessions>/YYYY/MM/DD/rollout-<ISO>-<session-id>.jsonl`. */
export function findCodexRollout(sessionId: string): string | null {
  const root = getCodexDir();
  if (!existsSync(root)) return null;
  try {
    for (const p of new Bun.Glob(`**/rollout-*${sessionId}.jsonl`).scanSync(root)) {
      return join(root, p);
    }
  } catch {}
  return null;
}

function codexSessionId(meta: Record<string, unknown> | undefined): string | null {
  const turn = meta?.[CODEX_TURN_META];
  if (turn && typeof turn === 'object') {
    const id = safeId((turn as Record<string, unknown>).session_id);
    if (id) return id;
  }
  return safeId(meta?.threadId);
}

/**
 * Establish which session a lesson came from, using only what the client supplied.
 *
 * The agent is never asked. A tool schema with a session_id field creates pressure to
 * fill it, and a well-formed-but-wrong uuid is undetectable by inspection and may
 * collide with a real session — omission is the benign failure, fabrication is the
 * likely one, so the field does not exist.
 */
export function resolveProvenance(
  meta?: Record<string, unknown>,
  env: Record<string, string | undefined> = process.env,
): SessionProvenance {
  const toolUseId = safeId(meta?.[CLAUDE_TOOL_USE_ID]);

  // 1. Codex states its session id on the call itself. Unlike the environment there is
  // no known staleness in it, so a rollout we cannot find (relocated CODEX_HOME, say)
  // downgrades verified rather than discarding what the client told us.
  const codex = codexSessionId(meta);
  if (codex) {
    const rollout = findCodexRollout(codex);
    return {
      sessionId: codex,
      transcript: rollout,
      toolUseId,
      provenance: 'meta',
      verified: rollout !== null,
      tool: 'codex',
    };
  }

  const envId = safeId(env.CLAUDE_CODE_SESSION_ID);

  // 2. The hook is authoritative exactly where the env var is not: it is handed the
  // session id and transcript path directly, and it fires again with the right ones
  // after a resume.
  if (envId) {
    const handoff = readHandoff(envId);
    if (handoff && existsSync(handoff.transcriptPath)) {
      return {
        sessionId: handoff.sessionId,
        transcript: handoff.transcriptPath,
        toolUseId,
        provenance: 'hook',
        verified: true,
        tool: 'claude',
      };
    }
  }

  // 3. The environment id, but only if a transcript by that name exists. `claude -c`
  // spawns MCP servers with the pre-resume id and then adopts the resumed session's,
  // so the inherited value can name a session that never existed — and a later `-c`
  // could mint that uuid for real and silently attach this lesson to a stranger.
  // The existence check is what keeps that id out of the store.
  if (envId) {
    const transcript = findClaudeTranscript(envId);
    if (transcript) {
      return { sessionId: envId, transcript, toolUseId, provenance: 'env', verified: true, tool: 'claude' };
    }
  }

  // 4. No usable session id, but the tool_use id is in the transcript verbatim —
  // `sessions lessons audit` can find it later and promote the row to 'recovered'.
  if (toolUseId) {
    return { sessionId: null, transcript: null, toolUseId, provenance: 'deferred', verified: false, tool: 'claude' };
  }

  return { sessionId: null, transcript: null, toolUseId: null, provenance: 'none', verified: false, tool: '' };
}
