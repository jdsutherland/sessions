import { join } from 'node:path';
import { homedir } from 'node:os';

// Every filesystem location the tool reads or writes, in one place. All of them
// default to the real home dirs but honor env overrides so tests can point at
// hermetic temp fixtures. Resolved lazily — never frozen at import — so a test
// that mutates the env on a shared module instance is honored.

/** Home root. `SESSIONS_HOME` exists so install/uninstall can be exercised without touching the real one. */
export function getHome(): string {
  return process.env.SESSIONS_HOME || homedir();
}

/**
 * Durable state: the installed plugin, and memory.db. Distinct from the cache dir
 * on purpose — everything under the cache is a rebuildable projection of the
 * transcripts, and nothing under here is.
 */
export function getDataDir(): string {
  return process.env.SESSIONS_DATA_DIR || join(getHome(), '.local', 'share', 'sessions');
}

/** The lesson store. Its own env override so the primer never reads real lessons under test. */
export function getMemoryDbPath(): string {
  return process.env.SESSIONS_MEMORY_DB || join(getDataDir(), 'memory.db');
}

/**
 * Where the SessionStart hook drops what only it knows — the authoritative session
 * id and transcript path — for the MCP server to pick up. Keyed by the id both
 * processes inherit in their environment (see src/provenance.ts).
 */
export function getHandoffDir(): string {
  return process.env.SESSIONS_HANDOFF_DIR || join(getDataDir(), 'handoff');
}

/** Disposable search index. Dropped on a schema bump, `--clear-cache`, and corruption. */
export function getCacheDir(): string {
  return process.env.SESSIONS_CACHE_DIR || join(getHome(), '.cache', 'sessions');
}

export function getDbPath(): string {
  return join(getCacheDir(), 'index.db');
}

// Source-session roots. Read-only inputs: we index them, we never write them.
export function getClaudeDir(): string {
  return process.env.SESSIONS_CLAUDE_DIR || join(getHome(), '.claude/projects');
}
export function getPiDir(): string {
  return process.env.SESSIONS_PI_DIR || join(getHome(), '.pi/agent/sessions');
}
export function getCodexDir(): string {
  return process.env.SESSIONS_CODEX_DIR || join(getHome(), '.codex/sessions');
}
