import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parseSession } from './record';
import { toTrajectory, parseExportArgs } from './trajectory';
import type { Tool } from './types';

const CAPTURED = join(import.meta.dir, '__fixtures__');

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
const fixtures: [string, Tool][] = [
  ...transcripts(join(CAPTURED, 'claude')).map((p): [string, Tool] => [p, 'claude']),
  ...transcripts(join(CAPTURED, 'codex')).map((p): [string, Tool] => [p, 'codex']),
  ...transcripts(join(CAPTURED, 'pi')).map((p): [string, Tool] => [p, 'pi']),
];

const TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})$/;

/**
 * schema/trajectory-v1.schema.json, hand-rolled — the schema is small, closed
 * (additionalProperties:false everywhere), and this keeps the assertion running with
 * no validator dependency. The keys per role ARE the contract, so they are spelled out.
 */
function violations(records: unknown): string[] {
  const bad: string[] = [];
  if (!Array.isArray(records) || records.length === 0) return ['not a non-empty array'];
  const KEYS: Record<string, { required: string[]; optional: string[] }> = {
    meta: { required: ['role', 'source'], optional: ['cwd', 'git_branch', 'model'] },
    user: { required: ['role', 'content', 'timestamp'], optional: [] },
    reasoning: { required: ['role', 'content', 'timestamp'], optional: [] },
    assistant: { required: ['role', 'content', 'timestamp'], optional: ['tool_calls'] },
    tool: { required: ['role', 'tool_call_id', 'content', 'timestamp'], optional: [] },
  };
  records.forEach((raw, i) => {
    const at = (msg: string) => bad.push(`[${i}] ${msg}`);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return at('not an object');
    const r = raw as Record<string, unknown>;
    const spec = KEYS[String(r['role'])];
    if (!spec) return at(`unknown role ${String(r['role'])}`);
    for (const k of spec.required) if (!(k in r)) at(`missing ${k}`);
    for (const k of Object.keys(r)) {
      if (!spec.required.includes(k) && !spec.optional.includes(k)) at(`additional property ${k}`);
    }
    if (r['role'] === 'meta') {
      if (i !== 0) at('meta is not the first record');
      if (typeof r['source'] !== 'string' || r['source'] === '') at('source is not a non-empty string');
      for (const k of ['cwd', 'git_branch', 'model']) {
        if (k in r && typeof r[k] !== 'string') at(`${k} is not a string`);
      }
      return;
    }
    if (typeof r['timestamp'] !== 'string' || !TS.test(r['timestamp'])) at('timestamp is not ISO-8601');
    if (r['role'] === 'assistant') {
      if ('tool_calls' in r) {
        if (r['content'] !== null) at('assistant with tool_calls must have content:null');
        const calls = r['tool_calls'];
        if (!Array.isArray(calls) || calls.length === 0) return at('tool_calls is not a non-empty array');
        for (const c of calls as Record<string, unknown>[]) {
          const keys = Object.keys(c).sort().join(',');
          if (keys !== 'args,id,name') at(`tool_call keys are ${keys}`);
          if (typeof c['id'] !== 'string' || c['id'] === '') at('tool_call id is not a non-empty string');
          if (typeof c['name'] !== 'string' || c['name'] === '') at('tool_call name is not a non-empty string');
          if (typeof c['args'] !== 'string') at('tool_call args is not a string');
        }
      } else if (typeof r['content'] !== 'string' || r['content'] === '') {
        at('assistant without tool_calls must have non-empty string content');
      }
      return;
    }
    if (typeof r['content'] !== 'string') at('content is not a string');
    if (r['role'] === 'tool' && (typeof r['tool_call_id'] !== 'string' || r['tool_call_id'] === '')) {
      at('tool_call_id is not a non-empty string');
    }
  });
  return bad;
}

const j = (o: unknown): string => JSON.stringify(o);

describe('the projection satisfies trajectory-v1', () => {
  for (const [path, tool] of fixtures) {
    test(`${tool}/${path.split('/').pop()}`, () => {
      const { records } = toTrajectory(read(path), tool);
      expect(violations(records)).toEqual([]);
      // A trajectory with no conversation is a meta record and nothing else — the
      // fixtures are real sessions, so each must carry turns.
      expect(records.length).toBeGreaterThan(1);
    });
  }
});

test('meta carries what the log recorded and nothing else', () => {
  const claude = join(CAPTURED, 'claude/0ff7b94c-6411-4b4d-925e-49e5cadd85a9.jsonl');
  expect(toTrajectory(read(claude), 'claude').records[0]).toEqual({
    role: 'meta',
    source: 'claude-code',
    cwd: '/eval/corpus/workstation',
    git_branch: 'main',
    model: 'claude-opus-4-8',
  });
  // Pi logs no branch, so the field is absent rather than ''.
  const pi = transcripts(join(CAPTURED, 'pi'))[0]!;
  expect(toTrajectory(read(pi), 'pi').records[0]).not.toHaveProperty('git_branch');
});

test('injected user turns are omitted, not relabeled', () => {
  const codex = join(CAPTURED, 'codex/rollout-2026-03-13T09-27-57-019ce798-d032-7a51-afc3-b1f31385799e.jsonl');
  const lines = read(codex);
  const { records, omissions } = toTrajectory(lines, 'codex');
  const users = parseSession(lines, 'codex').filter((r) => r.role === 'user');
  expect(omissions.injectedUser).toBe(users.filter((r) => !r.genuine).length);
  expect(records.filter((r) => r.role === 'user').length).toBe(users.filter((r) => r.genuine).length);
  for (const r of records) {
    if (r.role === 'user') expect(r.content).not.toContain('# AGENTS.md instructions for ');
  }
});

// Claude keeps the thinking signature and discards the text on 12,768 of 12,778
// records. An empty `reasoning` record would validate and say nothing.
test('claude emits no reasoning records', () => {
  for (const path of transcripts(join(CAPTURED, 'claude'))) {
    const { records } = toTrajectory(read(path), 'claude');
    expect(records.filter((r) => r.role === 'reasoning').length).toBe(0);
  }
  const codex = join(CAPTURED, 'codex/rollout-2026-02-26T12-22-58-019c9b30-954b-7031-85a1-ae7d7d72526b.jsonl');
  const reasoning = toTrajectory(read(codex), 'codex').records.filter((r) => r.role === 'reasoning');
  expect(reasoning.length).toBeGreaterThan(0);
  for (const r of reasoning) expect((r as { content: string }).content.trim()).not.toBe('');
});

test('tool_calls carry the structured args as a string, losslessly', () => {
  const codex = join(CAPTURED, 'codex/rollout-2026-03-13T09-27-57-019ce798-d032-7a51-afc3-b1f31385799e.jsonl');
  const lines = read(codex);
  const structured = parseSession(lines, 'codex').flatMap((r) => r.toolCalls);
  const projected = toTrajectory(lines, 'codex')
    .records.flatMap((r) => (r.role === 'assistant' && 'tool_calls' in r ? r.tool_calls : []))
    .filter((c) => c !== undefined);
  expect(projected.length).toBe(structured.length);
  projected.forEach((c, i) => {
    expect(typeof c.args).toBe('string');
    expect(JSON.parse(c.args)).toEqual(structured[i]!.args as object);
  });
});

test('every tool result names a call that was emitted', () => {
  for (const [path, tool] of fixtures) {
    const { records } = toTrajectory(read(path), tool);
    const ids = new Set(
      records.flatMap((r) => (r.role === 'assistant' && 'tool_calls' in r ? r.tool_calls.map((c) => c.id) : [])),
    );
    for (const r of records) if (r.role === 'tool') expect(ids.has(r.tool_call_id)).toBe(true);
  }
});

// Pi's bashExecution channel is a result with no call — the only shape in the
// fixtures that trajectory-v1 cannot express, so it is dropped and counted.
test('a tool result with no call to join is omitted and counted', () => {
  const lines = [
    j({ type: 'session', id: 's1', cwd: '/repo', timestamp: '2026-06-01T10:00:00Z' }),
    j({
      type: 'message',
      timestamp: '2026-06-01T10:00:01Z',
      message: { role: 'user', content: [{ type: 'text', text: 'run it' }] },
    }),
    j({
      type: 'message',
      timestamp: '2026-06-01T10:00:02Z',
      message: { role: 'bashExecution', output: 'ok', exitCode: 0 },
    }),
    j({
      type: 'message',
      timestamp: '2026-06-01T10:00:03Z',
      message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
    }),
  ];
  const { records, omissions } = toTrajectory(lines, 'pi');
  expect(omissions.orphanToolResult).toBe(1);
  expect(records.filter((r) => r.role === 'tool').length).toBe(0);
  expect(violations(records)).toEqual([]);
});

test('a call the harness gave no id gets a synthetic one', () => {
  const lines = [
    j({ type: 'session_meta', timestamp: '2026-06-01T10:00:00Z', payload: { id: 's1', cwd: '/repo' } }),
    j({
      type: 'response_item',
      timestamp: '2026-06-01T10:00:01Z',
      payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'search' }] },
    }),
    j({
      type: 'event_msg',
      timestamp: '2026-06-01T10:00:01Z',
      payload: { type: 'user_message', message: 'search' },
    }),
    j({
      type: 'response_item',
      timestamp: '2026-06-01T10:00:02Z',
      payload: { type: 'web_search_call', action: { query: 'trajectory v1' } },
    }),
  ];
  const { records } = toTrajectory(lines, 'codex');
  const calls = records.flatMap((r) => (r.role === 'assistant' && 'tool_calls' in r ? r.tool_calls : []));
  expect(calls).toEqual([{ id: 'sessions-call-1', name: 'web_search_call', args: j({ query: 'trajectory v1' }) }]);
  expect(violations(records)).toEqual([]);
});

test('a record the log gave no timestamp is omitted and counted', () => {
  const lines = [
    j({
      type: 'user',
      cwd: '/repo',
      timestamp: '2026-06-01T10:00:00Z',
      message: { role: 'user', content: [{ type: 'text', text: 'hello' }] },
      promptSource: 'typed',
    }),
    j({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'no timestamp here' }] } }),
  ];
  const { records, omissions } = toTrajectory(lines, 'claude');
  expect(omissions.noTimestamp).toBe(1);
  expect(records.filter((r) => r.role === 'assistant').length).toBe(0);
  expect(violations(records)).toEqual([]);
});

// The schema forbids an assistant record holding prose and calls at once.
test('an assistant turn with both prose and calls splits into two records', () => {
  const lines = [
    j({
      type: 'user',
      cwd: '/repo',
      timestamp: '2026-06-01T10:00:00Z',
      message: { role: 'user', content: [{ type: 'text', text: 'fix it' }] },
      promptSource: 'typed',
    }),
    j({
      type: 'assistant',
      timestamp: '2026-06-01T10:00:01Z',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'reading the file' },
          { type: 'tool_use', id: 'call_1', name: 'Read', input: { file_path: '/repo/a.ts' } },
        ],
      },
    }),
  ];
  const { records } = toTrajectory(lines, 'claude');
  expect(records.slice(2)).toEqual([
    { role: 'assistant', content: 'reading the file', timestamp: '2026-06-01T10:00:01Z' },
    {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'call_1', name: 'Read', args: j({ file_path: '/repo/a.ts' }) }],
      timestamp: '2026-06-01T10:00:01Z',
    },
  ]);
  expect(violations(records)).toEqual([]);
});

describe('parseExportArgs', () => {
  test('a bare argument is the session target', () => {
    expect(parseExportArgs(['abc123'])).toEqual({
      target: 'abc123',
      query: '',
      tool: '',
      here: false,
      limit: 10,
      strict: false,
    });
  });

  test('--query takes the ranked-selection options', () => {
    const args = parseExportArgs(['--query', 'flaky retry', '--tool', 'codex', '--here', '--limit', '3', '--strict']);
    expect(args).toEqual({ target: '', query: 'flaky retry', tool: 'codex', here: true, limit: 3, strict: true });
  });

  test('--format only accepts trajectory', () => {
    expect(parseExportArgs(['x', '--format', 'trajectory']).target).toBe('x');
  });
});
