import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { parseSession, toMessages, type SessionRecord } from './record';
import { extractMessages, summarizeMessages } from './parser';
import type { Tool } from './types';

const CAPTURED = join(import.meta.dir, '__fixtures__');
const CORPUS = join(import.meta.dir, 'eval/__fixtures__');

function transcripts(root: string): string[] {
  if (!existsSync(root)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(root)) {
    const p = join(root, entry);
    if (statSync(p).isDirectory()) out.push(...transcripts(p));
    else if (entry.endsWith('.jsonl')) out.push(p);
  }
  return out;
}

const read = (p: string): string[] => readFileSync(p, 'utf-8').trimEnd().split('\n');
const records = (p: string, tool: Tool): SessionRecord[] => parseSession(read(p), tool);

/** The numbering-bearing fields — what must not move for any already-indexed tool. */
const numbering = (m: { role: string; text: string; index: number; genuine: boolean }[]) =>
  m.map(({ role, text, index, genuine }) => ({ role, text, index, genuine }));

describe('differential: toMessages(parseSession()) against extractMessages', () => {
  // Claude is the tool with 62,673 indexed message rows today. Byte-identical, or the
  // migration silently renumbers every search hit in the index.
  for (const path of [...transcripts(join(CORPUS, 'claude')), ...transcripts(join(CAPTURED, 'claude'))]) {
    test(`claude/${path.split('/').pop()}`, () => {
      const lines = read(path);
      expect(toMessages(parseSession(lines, 'claude'))).toEqual(extractMessages(lines));
    });
  }

  // Pi keeps its numbering and strictly gains tool calls: extractToolUses matches
  // `tool_use`, pi emits `toolCall`, so all 4,075 of them were invisible.
  for (const path of [...transcripts(join(CORPUS, 'pi')), ...transcripts(join(CAPTURED, 'pi'))]) {
    test(`pi/${path.split('/').pop()}`, () => {
      const lines = read(path);
      const before = extractMessages(lines);
      const after = toMessages(parseSession(lines, 'pi'));
      expect(numbering(after)).toEqual(numbering(before));
      expect(before.every((m) => m.tools.length === 0)).toBe(true);
    });
  }

  // Codex is the asymmetry this whole change exists for.
  for (const path of transcripts(join(CAPTURED, 'codex'))) {
    test(`codex/${path.split('/').pop()}`, () => {
      const lines = read(path);
      expect(extractMessages(lines)).toEqual([]);
      expect(toMessages(parseSession(lines, 'codex')).length).toBeGreaterThan(0);
    });
  }
});

test('pi tool calls reach the message list', () => {
  const path = transcripts(join(CAPTURED, 'pi'))[0]!;
  const tools = toMessages(parseSession(read(path), 'pi')).flatMap((m) => m.tools);
  expect(tools.length).toBeGreaterThan(0);
  expect(tools.some((t) => t.name === 'bash' && t.summary !== '')).toBe(true);
});

describe('numbering', () => {
  const everything = [
    ...transcripts(join(CORPUS, 'claude')).map((p) => [p, 'claude'] as const),
    ...transcripts(join(CAPTURED, 'claude')).map((p) => [p, 'claude'] as const),
    ...transcripts(join(CORPUS, 'pi')).map((p) => [p, 'pi'] as const),
    ...transcripts(join(CAPTURED, 'pi')).map((p) => [p, 'pi'] as const),
    ...transcripts(join(CAPTURED, 'codex')).map((p) => [p, 'codex'] as const),
  ];

  test('indexed records are dense and agree with toMessages positions', () => {
    for (const [path, tool] of everything) {
      const rs = records(path, tool);
      const indexed = rs.filter((r) => r.index >= 0);
      expect(indexed.map((r) => r.index)).toEqual(indexed.map((_, i) => i));
      const messages = toMessages(rs);
      expect(messages.map((m) => m.index)).toEqual(messages.map((_, i) => i));
    }
  });

  // The -1 sentinel already means "subagent text" in message_fts; a reasoning or tool
  // record leaking into the indexed set would pollute it.
  test('reasoning and tool records never take a number', () => {
    for (const [path, tool] of everything) {
      for (const r of records(path, tool)) {
        if (r.role === 'reasoning' || r.role === 'tool') expect(r.index).toBe(-1);
      }
    }
  });

  test('every record carries an ISO timestamp', () => {
    for (const [path, tool] of everything) {
      for (const r of records(path, tool)) expect(r.timestamp).toMatch(/^2\d{3}-\d{2}-\d{2}T/);
    }
  });
});

describe('codex', () => {
  const review = join(CAPTURED, 'codex/rollout-2026-03-13T09-27-57-019ce798-d032-7a51-afc3-b1f31385799e.jsonl');
  const noEvents = join(CAPTURED, 'codex/rollout-2026-05-08T12-49-51-019e0923-a5ed-7ae3-bb08-75d11d711353.jsonl');
  const reasoned = join(CAPTURED, 'codex/rollout-2026-02-26T12-22-58-019c9b30-954b-7031-85a1-ae7d7d72526b.jsonl');

  test('genuineness is the event_msg join, and every injection shape loses it', () => {
    const users = records(review, 'codex').filter((r) => r.role === 'user');
    // Four user records: one typed turn, plus the AGENTS.md, <user_action> and
    // <turn_aborted> injections. Codex has no promptSource — this count IS the oracle.
    expect(users.length).toBe(4);
    expect(users.filter((r) => r.genuine).length).toBe(1);
    for (const r of users.filter((r) => !r.genuine)) {
      expect(r.text.trim()).toMatch(/^(# AGENTS\.md instructions for |<user_action|<turn_aborted)/);
    }
  });

  test('a session with no user_message events falls back to the injection prefixes', () => {
    const users = records(noEvents, 'codex').filter((r) => r.role === 'user');
    expect(users.length).toBeGreaterThan(0);
    // Every user turn in this rollout is an injection, so nothing survives as genuine —
    // but the fallback ran, rather than the join marking everything false by default.
    expect(users.every((r) => /^(<user_action|<turn_aborted)/.test(r.text.trim()))).toBe(true);
    expect(users.filter((r) => r.genuine).length).toBe(0);
  });

  test('first_prompt is non-blank — 292 of 292 indexed Codex sessions were empty', () => {
    const summary = summarizeMessages(toMessages(records(review, 'codex')));
    expect(summary.firstPrompt).not.toBe('');
    expect(summary.closingAssistant).not.toBe('');
  });

  test('assistant turns are not double-counted by the event_msg stream', () => {
    for (const path of [review, noEvents, reasoned]) {
      const assistants = records(path, 'codex').filter((r) => r.role === 'assistant' && r.text.trim());
      const seen = new Set(assistants.map((r) => `${r.timestamp}|${r.text}`));
      expect(seen.size).toBe(assistants.length);
    }
  });

  test('reasoning comes through as plaintext, deduplicated across the two streams', () => {
    const reasoning = records(reasoned, 'codex').filter((r) => r.role === 'reasoning');
    expect(reasoning.length).toBeGreaterThan(0);
    expect(new Set(reasoning.map((r) => r.text.trim())).size).toBe(reasoning.length);
  });

  // token_count is a standalone event with no message id, and `info` is null on the
  // first event of every session. Attaching the nearest one would produce plausible
  // per-message usage that cannot reconcile with the report pipeline's totals.
  test('usage is never synthesized', () => {
    for (const path of transcripts(join(CAPTURED, 'codex'))) {
      expect(records(path, 'codex').filter((r) => r.usage).length).toBe(0);
    }
  });

  test('tool calls survive all three of Codex argument shapes', () => {
    const calls = records(review, 'codex').flatMap((r) => r.toolCalls);
    expect(calls.length).toBeGreaterThan(0);
    // arguments as a JSON string → parsed, and `cmd` summarized (not `workdir`).
    const exec = calls.find((c) => c.name === 'exec_command')!;
    expect(exec.summary).toBe((exec.args as { cmd: string }).cmd.replace(/\s+/g, ' ').trim().slice(0, 120));
    // input as a raw string → wrapped, never dropped.
    expect(calls.find((c) => c.name === 'apply_patch')!.summary).toContain('*** Begin Patch');
    expect(calls.filter((c) => c.summary === '').length / calls.length).toBeLessThan(0.1);
  });

  test('tool results are joinable to the calls that produced them', () => {
    const rs = records(review, 'codex');
    const ids = new Set(rs.flatMap((r) => r.toolCalls).map((c) => c.id));
    const results = rs.filter((r) => r.role === 'tool');
    expect(results.length).toBeGreaterThan(0);
    for (const r of results) expect(ids.has(r.toolCallId!)).toBe(true);
  });

  test('the injected developer system prompt is not a turn', () => {
    const texts = records(review, 'codex').map((r) => r.text);
    expect(texts.some((t) => t.startsWith('<permissions instructions>'))).toBe(false);
  });
});

// Characterization, not a win: 12,768 of 12,778 real Claude thinking blocks carry
// `thinking: ""` (the signature is kept, the text is not). "The record supports
// reasoning" therefore changes nothing for Claude. The day Anthropic writes thinking
// text again this fails, and someone updates the claim instead of discovering it later.
test('claude reasoning records are absent because the logs carry no thinking text', () => {
  for (const path of transcripts(join(CAPTURED, 'claude'))) {
    const rs = records(path, 'claude');
    // The blocks are there — six of them in this rollout — they just hold ''.
    expect(read(path).join('').includes('"type":"thinking"')).toBe(true);
    expect(rs.filter((r) => r.role === 'reasoning').length).toBe(0);
    // Tool results, by contrast, arrive with real text and a call to join back to.
    const results = rs.filter((r) => r.role === 'tool');
    expect(results.length).toBeGreaterThan(0);
    const ids = new Set(rs.flatMap((r) => r.toolCalls).map((c) => c.id));
    for (const r of results) expect(ids.has(r.toolCallId!)).toBe(true);
  }
});

// Opt-in, because its corpus is whatever is on this machine: SESSIONS_DIFFERENTIAL=1
// runs the same equivalence over every real transcript in ~/.claude and ~/.pi.
describe.skipIf(!process.env['SESSIONS_DIFFERENTIAL'])('differential over the live corpus', () => {
  test('claude and pi numbering is unchanged for every transcript on this machine', () => {
    let checked = 0;
    for (const [root, tool] of [
      [join(homedir(), '.claude/projects'), 'claude'],
      [join(homedir(), '.pi/agent/sessions'), 'pi'],
    ] as const) {
      for (const path of transcripts(root)) {
        const lines = read(path);
        const before = extractMessages(lines);
        const after = toMessages(parseSession(lines, tool));
        if (tool === 'claude') expect(after).toEqual(before);
        else expect(numbering(after)).toEqual(numbering(before));
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(0);
  }, 600_000); // Thousands of multi-megabyte transcripts; the default 5s is for hermetic tests.
});
