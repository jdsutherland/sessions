import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sessionIdFor } from './session-id';
import { extractSessionMetadata } from './parser';

const FIXTURES = join(import.meta.dir, '__fixtures__');

describe('sessionIdFor', () => {
  test('claude: the basename is the id', () => {
    expect(sessionIdFor('/p/-repo/abc-123.jsonl', 'claude')).toBe('abc-123');
  });

  test('codex: the in-file id wins over the rollout filename', () => {
    const path = '/c/2026/04/16/rollout-2026-04-16T10-36-08-019d96ef-74e4-7c80-824a-f3b19b826334.jsonl';
    expect(sessionIdFor(path, 'codex', '019d96ef-74e4-7c80-824a-f3b19b826334')).toBe(
      '019d96ef-74e4-7c80-824a-f3b19b826334',
    );
    // …and without it, the filename's uuid tail is the same value.
    expect(sessionIdFor(path, 'codex')).toBe('019d96ef-74e4-7c80-824a-f3b19b826334');
  });

  test('pi: the uuid after the timestamp, not the whole basename', () => {
    const path = '/pi/-slug-/2026-06-23T14-31-26-172Z_019ef4e4-a6dc-744f-9b84-157e784f69c2.jsonl';
    expect(sessionIdFor(path, 'pi')).toBe('019ef4e4-a6dc-744f-9b84-157e784f69c2');
    expect(sessionIdFor(path, 'pi', '019ef4e4-a6dc-744f-9b84-157e784f69c2')).toBe(
      '019ef4e4-a6dc-744f-9b84-157e784f69c2',
    );
  });

  test('pi: a basename with no separator is already the id (the eval corpus shape)', () => {
    expect(sessionIdFor('/pi/proj/s17-worker-postgres-split.jsonl', 'pi')).toBe('s17-worker-postgres-split');
  });

  test('opencode: the synthetic path basename is the ses_ id', () => {
    expect(sessionIdFor('/x/opencode.db/ses_8fc21', 'opencode')).toBe('ses_8fc21');
  });

  test('a filename that carries no uuid falls back to the basename', () => {
    expect(sessionIdFor('/c/rollout-weird.jsonl', 'codex')).toBe('rollout-weird');
  });
});

// The assertion that would have caught the split: over real captured transcripts, the
// id derived from the path alone must equal the id the transcript states about itself
// — which is the id report/parsers/{codex,pi} emit for the same file.
describe('sessionIdFor agrees with the id in the log', () => {
  for (const tool of ['codex', 'pi'] as const) {
    for (const name of readdirSync(join(FIXTURES, tool))) {
      test(`${tool}/${name}`, () => {
        const path = join(FIXTURES, tool, name);
        const lines = readFileSync(path, 'utf-8').trimEnd().split('\n');
        const idFromLog = extractSessionMetadata(lines, tool).sessionId;
        expect(idFromLog).not.toBe('');
        expect(sessionIdFor(path, tool)).toBe(idFromLog);
        expect(sessionIdFor(path, tool, idFromLog)).toBe(idFromLog);
      });
    }
  }
});
