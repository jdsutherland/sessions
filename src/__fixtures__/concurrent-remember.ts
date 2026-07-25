/**
 * One process that saves one lesson, for the concurrency test in memory.test.ts.
 *
 * A simulated race cannot reach this bug: the crash needs two real SQLite connections,
 * each of which missed the other's row on the content_hash SELECT and then met the
 * UNIQUE index inside its own transaction. So the test spawns copies of this.
 *
 * Reads SESSIONS_MEMORY_DB (set by the test) and prints the outcome as JSON. The gate
 * path is a start barrier: bun's startup varies by tens of milliseconds, which is long
 * enough for the writes to queue up politely and never overlap at all.
 */
import { existsSync } from 'node:fs';
import { rememberLesson } from '../memory';

const lesson = process.argv[2] ?? '';
const gate = process.argv[3];
while (gate && !existsSync(gate)) Bun.sleepSync(1);

const result = rememberLesson({
  lesson,
  detail: 'Two agent windows can close on the same finding at the same moment.',
  container: '/repo/alpha',
  remote: 'github.com/nicknisi/alpha',
  source: { sessionId: null, transcript: null, toolUseId: null, provenance: 'none', verified: false, tool: '' },
});

process.stdout.write(JSON.stringify({ outcome: result.outcome, id: result.id }));
