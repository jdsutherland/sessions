import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { CODEX_INJECTED } from './record';
import { toTrajectory, type TrajectoryRecord } from './trajectory';
import type { Tool } from './types';

// @letta-ai/trajectory as an ORACLE, not a parser: a devDependency the compiled binary
// never sees (the import below is dynamic and only ever runs under SESSIONS_ORACLE, so
// `bun build --compile index.ts` cannot reach it and the runtime dependency count stays
// at two). Opt-in for the same reason record.test.ts gates SESSIONS_DIFFERENTIAL — a
// normal run and CI must not depend on a third party's parse of our fixtures:
//
//   SESSIONS_ORACLE=1 bun test src/trajectory.differential.test.ts
//
// What it checks: that our record sequence agrees with normalizeTranscript() over the
// committed real transcripts, once a shim normalizes the three places the two
// deliberately disagree.

const CAPTURED = join(import.meta.dir, '__fixtures__');

/** tool → the reference's source id. It files Pi transcripts under the format's other name. */
const SOURCE: Record<string, 'claude-code' | 'codex' | 'openclaw'> = {
  claude: 'claude-code',
  codex: 'codex',
  pi: 'openclaw',
};

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

const fixtures: [string, Tool][] = (['claude', 'codex', 'pi'] as const).flatMap((tool) =>
  transcripts(join(CAPTURED, tool)).map((p): [string, Tool] => [p, tool]),
);

/** Real transcripts that project to a document trajectory-v1 rejects. Not in `fixtures`:
 *  the shared loops there are about sessions that DO normalize. */
const unrepresentable: [string, Tool][] = [
  [join(CAPTURED, 'unrepresentable/claude-harness-only.jsonl'), 'claude'],
  [join(CAPTURED, 'unrepresentable/codex-no-assistant.jsonl'), 'codex'],
];

// CODEX_INJECTED is imported, not restated: the reference keeps the AGENTS.md preamble
// as a user turn where sessions calls it an injection, so the shim applies OUR rule to
// their output — and a second copy of the list would drift out of sync with it.

type Role = 'meta' | 'user' | 'reasoning' | 'assistant' | 'assistant-tool-call' | 'tool';
interface Record_ {
  role: string;
  content?: string | null;
  tool_calls?: { id: string; name: string; args: string }[];
}

/**
 * The shim, applied to the reference's output only:
 *   - drop the user turns sessions classifies as harness injections;
 *   - deduplicate reasoning by text, because Codex writes it twice (encrypted in
 *     `response_item`, plaintext in `event_msg`) and the reference emits both.
 * The tool-call fold — one record per call there, one per turn here — is absorbed by
 * collapsing runs of the same role instead, since both spellings satisfy the schema.
 */
function shim(records: Record_[]): Record_[] {
  const seen = new Set<string>();
  return records.filter((r) => {
    if (r.role === 'user') return !CODEX_INJECTED.test((r.content ?? '').trim());
    if (r.role !== 'reasoning') return true;
    const text = (r.content ?? '').trim();
    if (seen.has(text)) return false;
    seen.add(text);
    return true;
  });
}

const roles = (records: Record_[]): Role[] =>
  records.map((r) => (r.role === 'assistant' && r.tool_calls ? 'assistant-tool-call' : (r.role as Role)));

const collapse = (r: Role[]): Role[] => r.filter((x, i) => x !== r[i - 1]);

const callIds = (records: Record_[]): string[] => records.flatMap((r) => (r.tool_calls ?? []).map((c) => c.id));

const contents = (records: Record_[], role: string): string[] =>
  records.filter((r) => r.role === role && typeof r.content === 'string').map((r) => (r.content as string).trim());

describe.skipIf(!process.env['SESSIONS_ORACLE'])('differential against @letta-ai/trajectory', () => {
  for (const [path, tool] of fixtures) {
    test(`${tool}/${path.split('/').pop()}`, async () => {
      const { normalizeTranscript } = await import('@letta-ai/trajectory');
      const raw = readFileSync(path, 'utf-8');
      const ours: Record_[] = toTrajectory(raw.trimEnd().split('\n'), tool).records as TrajectoryRecord[] as Record_[];
      const theirs = shim(normalizeTranscript({ source: SOURCE[tool]!, transcript: raw }).records as Record_[]);

      expect(collapse(roles(ours))).toEqual(collapse(roles(theirs)));
      expect(callIds(ours)).toEqual(callIds(theirs));
      for (const role of ['user', 'assistant', 'reasoning']) {
        expect(contents(ours, role)).toEqual(contents(theirs, role));
      }
      // Tool results are compared modulo the third divergence: the record keeps
      // `isError` as a field and trajectory-v1 has nowhere to put it, so we drop the
      // flag and leave the output verbatim. The reference's Pi adapter folds it into
      // the text as an `Error: ` prefix — its Claude adapter does not, so that is an
      // adapter's idiom to tolerate rather than a format convention to adopt.
      const ourResults = contents(ours, 'tool');
      const theirResults = contents(theirs, 'tool').map((t) => t.replace(/^Error: /, ''));
      expect(ourResults).toEqual(theirResults);
    });
  }
});

/**
 * The other half of the oracle. validateTranscript is the interop target the export exists
 * to satisfy, and its semantic layer — a document needs at least one user record and at
 * least one assistant record — is nowhere in the JSON schema, so a document can pass every
 * per-record rule and still be refused. `missing` has to predict its verdict exactly, over
 * every captured transcript, including the ones it refuses.
 */
describe.skipIf(!process.env['SESSIONS_ORACLE'])('validateTranscript agrees with `missing`', () => {
  for (const [path, tool] of [...fixtures, ...unrepresentable]) {
    test(`${tool}/${path.split('/').pop()}`, async () => {
      const { validateTranscript } = await import('@letta-ai/trajectory');
      // Called through a plain signature: it is declared `asserts`, and TypeScript will not
      // narrow through a binding that came out of a dynamic import.
      const validate: (value: unknown) => void = validateTranscript;
      const { records, missing } = toTrajectory(readFileSync(path, 'utf-8').trimEnd().split('\n'), tool);
      let rejection: string | null = null;
      try {
        validate(records);
      } catch (err) {
        rejection = (err as Error).message;
      }
      if (missing.length === 0) {
        expect(rejection).toBeNull();
      } else {
        expect(rejection).toContain(`at least one ${missing[0]} record`);
      }
    });
  }
});
