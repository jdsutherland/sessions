// Sessions-owned (forked from tokenmaxing's parser). Dedupes usage by (message.id, requestId)
// so the same API response — copied across resumed/forked session files — is counted once, matching ccusage.
import type { UsageEvent } from './types.ts';
import { readJsonlLines } from './util.ts';

interface ClaudeAssistantLine {
  type: 'assistant';
  sessionId?: string;
  cwd?: string;
  timestamp?: string;
  requestId?: string;
  message?: {
    id?: string;
    model?: string;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number };
    };
  };
}

function isAssistantLine(v: unknown): v is ClaudeAssistantLine {
  return !!v && typeof v === 'object' && (v as { type?: unknown }).type === 'assistant';
}

/** One transcript's events, undeduped — the dedupe spans files, so gatherEvents owns it. */
export async function parseClaudeCodeFile(path: string): Promise<UsageEvent[]> {
  const events: UsageEvent[] = [];
  for await (const line of readJsonlLines(path)) {
    if (!isAssistantLine(line)) continue;
    const u = line.message?.usage;
    const model = line.message?.model;
    const ts = line.timestamp;
    const sid = line.sessionId;
    if (!u || !model || !ts || !sid) continue;
    const event: UsageEvent = {
      tool: 'claude-code',
      provider: 'anthropic',
      model,
      timestamp: ts,
      sessionId: sid,
      projectPath: line.cwd,
      tokens: {
        input: u.input_tokens ?? 0,
        output: u.output_tokens ?? 0,
        cacheRead: u.cache_read_input_tokens ?? 0,
        cacheWrite: u.cache_creation_input_tokens ?? 0,
        cacheWrite1h: u.cache_creation?.ephemeral_1h_input_tokens ?? 0,
      },
    };
    const id = line.message?.id;
    // No id means no identity to dedupe by: the line is counted as its own response.
    if (id) event.dedupeKey = `${id}|${line.requestId ?? ''}`;
    events.push(event);
  }
  return events;
}

/**
 * Drop repeats of an API response the harness rewrote into another session file.
 * Global across files by necessity — resuming or forking a session copies every prior
 * assistant line into the new transcript — which is why it cannot live in a per-file
 * parse, and why the per-file event cache stores events with their dedupeKey intact.
 */
export function dedupeClaude(events: UsageEvent[]): UsageEvent[] {
  const seen = new Set<string>();
  return events.filter((e) => {
    if (!e.dedupeKey) return true;
    if (seen.has(e.dedupeKey)) return false;
    seen.add(e.dedupeKey);
    return true;
  });
}
