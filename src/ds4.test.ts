import { test, expect, describe, beforeAll, afterAll } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverDs4Sessions, ds4SessionId, getDs4Dir, isDs4Path, readDs4File, readDs4Session } from './ds4';
import { readSessionLines } from './session-io';
import { extractSessionMetadata, getCwdFromSession, firstPrompt, customTitle, getSessionMessages } from './parser';
import { extractFiles, extractFilesRead } from './extract-files';
import { extractCommands } from './extract-commands';
import { extractErrors } from './extract-errors';
import { extractThinking } from './extract-thinking';
import { buildResumeCommand } from './search-format';

// Fixtures are written in the real on-disk format (ds4_kvstore.c: ds4_kvstore_fill_header)
// rather than copied from ~/.ds4/kvcache: the real files are 100 MB – 2.5 GB of KV payload
// wrapped around a transcript full of personal content. A synthesized header + transcript +
// empty payload exercises exactly the bytes readDs4File parses.

const FIXED_HEADER = 48;
const REASON_AGENT_SESSION = 6;
const REASON_AGENT_SYSTEM = 5;
const EXT_SESSION_TITLE = 0x08;

interface FixtureOptions {
  text: string;
  title?: string;
  createdAt?: number;
  reason?: number;
  version?: number;
  payloadAbi?: number;
  quantBits?: number;
  tokens?: number;
}

function writeKv(path: string, opts: FixtureOptions): void {
  const text = Buffer.from(opts.text, 'utf-8');
  const title = opts.title === undefined ? null : Buffer.from(opts.title, 'utf-8');
  const header = Buffer.alloc(FIXED_HEADER + 4);
  header.write('KVC', 0, 'latin1');
  header[3] = opts.version ?? 1;
  header[4] = opts.quantBits ?? 4;
  header[5] = opts.reason ?? REASON_AGENT_SESSION;
  header[6] = title ? EXT_SESSION_TITLE : 0;
  header[7] = 0; // model_id: Flash
  header.writeUInt32LE(opts.tokens ?? 1234, 8);
  header.writeUInt32LE(0, 12); // hits
  header.writeUInt32LE(8192, 16); // ctx_size
  header[20] = opts.payloadAbi ?? 2;
  header.writeBigUInt64LE(BigInt(opts.createdAt ?? 1_784_321_717), 24);
  header.writeBigUInt64LE(BigInt(1_784_741_164), 32); // last_used
  header.writeBigUInt64LE(0n, 40); // payload_bytes — the KV graph state is never read
  header.writeUInt32LE(text.length, FIXED_HEADER);

  const parts = [header, text];
  if (title) {
    const len = Buffer.alloc(4);
    len.writeUInt32LE(title.length, 0);
    parts.push(len, title);
  }
  writeFileSync(path, Buffer.concat(parts));
}

// One session covering every shape the bridge has to read: reasoning, prose, a bash
// call, an edit, a read, a successful tool result, and a failing one.
const TRANSCRIPT = [
  '<｜begin▁of▁sentence｜>You are a coding agent running in a local workspace.',
  '<｜DSML｜invoke name="$TOOL_NAME">',
  '<｜DSML｜parameter name="$PARAMETER_NAME" string="true">$PARAMETER_VALUE</｜DSML｜parameter>',
  '</｜DSML｜invoke>',
  '<｜User｜>fix the router in /repo/app quuxly',
  '<｜Assistant｜><think>zorptastic reasoning about the router</think>',
  '',
  'Looking at the router now.',
  '<｜DSML｜tool_calls>',
  '<｜DSML｜invoke name="read">',
  '<｜DSML｜parameter name="path" string="true">/repo/app/router.ts</｜DSML｜parameter>',
  '</｜DSML｜invoke>',
  '</｜DSML｜tool_calls><｜end▁of▁sentence｜>',
  '<｜User｜><tool_result>Tool result 1 (read):',
  'exit_status=0',
  '<output>export const router = 1</output>',
  '</tool_result>',
  '<｜Assistant｜>Patching it.',
  '<｜DSML｜tool_calls>',
  '<｜DSML｜invoke name="edit">',
  '<｜DSML｜parameter name="path" string="true">/repo/app/router.ts</｜DSML｜parameter>',
  '<｜DSML｜parameter name="old" string="true">1</｜DSML｜parameter>',
  '<｜DSML｜parameter name="new" string="true">2</｜DSML｜parameter>',
  '</｜DSML｜invoke>',
  '<｜DSML｜invoke name="bash">',
  '<｜DSML｜parameter name="command" string="true">bun test</｜DSML｜parameter>',
  '</｜DSML｜invoke>',
  '</｜DSML｜tool_calls><｜end▁of▁sentence｜>',
  '<｜User｜><tool_result>Tool result 2 (bash):',
  'bash job=1 pid=2 status=done elapsed_sec=0.1 timed_out=0',
  'exit_status=1',
  '<output>boom wibbleflorp</output>',
  '</tool_result>',
  '<｜Assistant｜>That failed.<｜end▁of▁sentence｜>',
].join('\n');

// A session whose only absolute paths sit under a real git repo — cwd must resolve to the
// repo root, not the leaf directory the file lives in.
function gitSessionTranscript(repoDir: string): string {
  return [
    '<｜begin▁of▁sentence｜>system',
    '<｜User｜>read the config',
    '<｜Assistant｜><｜DSML｜tool_calls>',
    '<｜DSML｜invoke name="read">',
    `<｜DSML｜parameter name="path" string="true">${repoDir}/deep/nested/config.ts</｜DSML｜parameter>`,
    '</｜DSML｜invoke>',
    '</｜DSML｜tool_calls><｜end▁of▁sentence｜>',
  ].join('\n');
}

let tmp: string;
let cacheDir: string;
let repoDir: string;
let mainPath: string;

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'sessions-ds4-'));
  cacheDir = join(tmp, 'kvcache');
  mkdirSync(cacheDir);
  repoDir = join(tmp, 'repo');
  mkdirSync(join(repoDir, '.git'), { recursive: true });
  mkdirSync(join(repoDir, 'deep', 'nested'), { recursive: true });

  mainPath = join(cacheDir, 'a'.repeat(40) + '.kv');
  writeKv(mainPath, { text: TRANSCRIPT, title: 'fix the router in /repo/app quuxly' });
  writeKv(join(cacheDir, 'b'.repeat(40) + '.kv'), { text: gitSessionTranscript(repoDir), title: 'read the config' });
  // The fixed bootstrap checkpoint — an implementation cache, never a user session.
  writeKv(join(cacheDir, 'sysprompt.kv'), { text: 'system prompt only', reason: REASON_AGENT_SYSTEM });
  writeFileSync(join(cacheDir, 'notes.txt'), 'not a session');

  process.env.SESSIONS_DS4_DIR = cacheDir;
});

afterAll(() => {
  delete process.env.SESSIONS_DS4_DIR;
  rmSync(tmp, { recursive: true, force: true });
});

describe('ds4 file format', () => {
  test('reads header, transcript, and title trailer without touching the payload', () => {
    const session = readDs4File(mainPath);
    expect(session).not.toBeNull();
    expect(session!.header.tokens).toBe(1234);
    expect(session!.header.createdAt).toBe(1_784_321_717);
    expect(session!.title).toBe('fix the router in /repo/app quuxly');
    expect(session!.text).toBe(TRANSCRIPT);
  });

  test('rejects files that the C reader would reject', () => {
    const bad = join(tmp, 'bad.kv');
    writeKv(bad, { text: TRANSCRIPT, version: 2 });
    expect(readDs4File(bad)).toBeNull();
    writeKv(bad, { text: TRANSCRIPT, payloadAbi: 3 });
    expect(readDs4File(bad)).toBeNull();
    writeKv(bad, { text: TRANSCRIPT, quantBits: 3 });
    expect(readDs4File(bad)).toBeNull();
    writeKv(bad, { text: TRANSCRIPT, tokens: 0 });
    expect(readDs4File(bad)).toBeNull();
    writeFileSync(bad, 'not a kv file at all');
    expect(readDs4File(bad)).toBeNull();
    expect(readDs4File(join(tmp, 'missing.kv'))).toBeNull();
  });

  test('rejects the sysprompt checkpoint by reason byte, not just by name', () => {
    const sysAsSession = join(tmp, 'sys.kv');
    writeKv(sysAsSession, { text: TRANSCRIPT, reason: REASON_AGENT_SYSTEM });
    expect(readDs4File(sysAsSession)).toBeNull();
  });
});

describe('ds4 discovery', () => {
  test('lists saved sessions only — no sysprompt, no non-kv files', () => {
    const ids = discoverDs4Sessions()
      .map((s) => ds4SessionId(s.path))
      .sort();
    expect(ids).toEqual(['a'.repeat(40), 'b'.repeat(40)]);
    expect(discoverDs4Sessions().every((s) => s.tool === 'ds4')).toBe(true);
  });

  test('path helpers identify ds4 sessions', () => {
    expect(isDs4Path(mainPath)).toBe(true);
    expect(isDs4Path(join(cacheDir, 'notes.txt'))).toBe(false);
    expect(isDs4Path('/elsewhere/deadbeef.kv')).toBe(false);
    expect(ds4SessionId(mainPath)).toBe('a'.repeat(40));
  });

  test('an absent cache dir discovers nothing', () => {
    process.env.SESSIONS_DS4_DIR = join(tmp, 'gone');
    expect(discoverDs4Sessions()).toEqual([]);
    process.env.SESSIONS_DS4_DIR = cacheDir;
  });
});

describe('ds4 transcript reconstruction', () => {
  test('session-io routes ds4 paths to the bridge, by tool and by path shape', () => {
    expect(readSessionLines(mainPath, 'ds4')).toEqual(readDs4Session(mainPath));
    expect(readSessionLines(mainPath)).toEqual(readDs4Session(mainPath));
  });

  test('turns become messages with the tool-result turns marked non-genuine', () => {
    const lines = readDs4Session(mainPath);
    const messages = getSessionMessages(lines);
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant', 'user', 'assistant']);
    expect(messages[0]!.text).toContain('fix the router');
    // The system prompt (and its $TOOL_NAME template) precedes the first user mark
    // and must not leak into any turn.
    expect(lines.join('\n')).not.toContain('$TOOL_NAME');
    expect(firstPrompt(lines, 'ds4')).toContain('fix the router');
  });

  test('metadata: title, cwd, and the session-start timestamp', () => {
    const lines = readDs4Session(mainPath);
    expect(customTitle(lines)).toBe('fix the router in /repo/app quuxly');
    expect(getCwdFromSession(lines, 'ds4')).toBe('/repo/app');
    const metadata = extractSessionMetadata(lines, 'ds4');
    expect(metadata.cwd).toBe('/repo/app');
    expect(metadata.createdAt).toBe('2026-07-17');
    expect(metadata.branch).toBe('');
  });

  test('cwd inference prefers the git root over the leaf directory', () => {
    const lines = readDs4Session(join(cacheDir, 'b'.repeat(40) + '.kv'));
    expect(getCwdFromSession(lines, 'ds4')).toBe(repoDir);
  });

  test('a session with no absolute paths falls back to the cache dir, never a false repo', () => {
    const chat = join(cacheDir, 'c'.repeat(40) + '.kv');
    writeKv(chat, { text: '<｜begin▁of▁sentence｜>sys<｜User｜>just talking<｜Assistant｜>ok<｜end▁of▁sentence｜>' });
    expect(getCwdFromSession(readDs4Session(chat), 'ds4')).toBe(getDs4Dir());
    rmSync(chat);
  });

  test('a file with no user turn yields no lines', () => {
    const empty = join(tmp, 'empty.kv');
    writeKv(empty, { text: '<｜begin▁of▁sentence｜>system prompt with no conversation' });
    expect(readDs4Session(empty)).toEqual([]);
  });
});

describe('ds4 extractors', () => {
  test('edited files come from edit/write path arguments', () => {
    expect(extractFiles(readDs4Session(mainPath), 'ds4')).toEqual(['/repo/app/router.ts']);
  });

  test('read targets come from read/list path arguments', () => {
    expect(extractFilesRead(readDs4Session(mainPath), 'ds4')).toEqual(['/repo/app/router.ts']);
  });

  test('commands come from bash invokes', () => {
    expect(extractCommands(readDs4Session(mainPath), 'ds4')).toEqual(['bun test']);
  });

  test('reasoning is indexed', () => {
    expect(extractThinking(readDs4Session(mainPath), 'ds4')).toContain('zorptastic');
  });

  test('a non-zero exit_status in a tool result is an error; a zero one is not', () => {
    const errors = extractErrors(readDs4Session(mainPath), 'ds4');
    expect(errors.errored).toBe(true);
    expect(errors.count).toBe(1);
    expect(errors.messages[0]).toContain('wibbleflorp');
    expect(errors.messages[0]).not.toContain('export const router');
  });
});

describe('ds4 resume', () => {
  test('resume names the REPL /switch command, since ds4-agent has no resume flag', () => {
    expect(buildResumeCommand('ds4', '/repo/app', 'a'.repeat(40))).toBe(
      'cd "/repo/app" && ds4-agent  # then: /switch aaaaaaaa',
    );
  });
});
