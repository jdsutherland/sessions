import { readFileSync, statSync } from 'node:fs';
import { type Tool } from './types';
import { tryParseJson } from './parser';
import { isOpencodePath, readOpencodeSession, opencodeStat } from './opencode';

// Generic session IO: every consumer (indexer, scanner, digest, MCP) reads a
// session as JSONL-style `lines[]` through here. JSONL tools read their file
// directly; OpenCode sessions — synthetic dbPath/sessionId paths with no real
// file — are reconstructed from the SQLite DB by src/opencode.ts.

/**
 * Read any session into `lines[]`. `tool` is optional: when omitted (call sites
 * that only carry a file_path, e.g. the MCP tools) OpenCode is detected from the
 * path shape.
 */
export function readSessionLines(filePath: string, tool?: Tool): string[] {
  if (tool === 'opencode' || (tool === undefined && isOpencodePath(filePath))) {
    return readOpencodeSession(filePath);
  }
  try {
    return readFileSync(filePath, 'utf-8').trimEnd().split('\n');
  } catch {
    return [];
  }
}

/**
 * Which harness wrote a transcript, read off the lines themselves.
 *
 * Read-path callers (get_session_messages, `sessions digest <file>`) hold a file path
 * and nothing else, and parseSession needs a tool — so this is the one place that
 * answers the question, rather than each caller re-deriving it from directory layout
 * (which a copied or fixture transcript would defeat). Codex and Pi both declare
 * themselves on line 0 in all 466 real transcripts on the author's machine; Claude
 * opens on whichever sidecar row the CLI happened to write first, so it is the default.
 */
export function toolForSession(filePath: string, lines: string[]): Tool {
  if (isOpencodePath(filePath)) return 'opencode';
  for (const line of lines.slice(0, 5)) {
    const type = tryParseJson(line)?.type;
    if (type === 'session_meta' || type === 'response_item') return 'codex';
    if (type === 'session') return 'pi';
  }
  return 'claude';
}

/** Cache-invalidation signal for a session: filesystem stat for JSONL tools, DB metadata for OpenCode. */
export function statSession(filePath: string, tool: Tool): { mtimeMs: number; size: number } | null {
  if (tool === 'opencode') return opencodeStat(filePath);
  try {
    const s = statSync(filePath);
    return { mtimeMs: s.mtimeMs, size: s.size };
  } catch {
    return null;
  }
}
