// Capture a real transcript as a committable fixture.
//
// Fixtures written from the parser's mental model cannot falsify that model — the
// Codex test at parser.test.ts asserted a line shape that occurs zero times in 54k
// real rollout lines, and the suite stayed green over a completely dead code path.
// So fixtures are captured, never authored: this script preserves every key and
// every structural value (types, roles, tool names, call ids, exit codes, token
// counts, timestamps) and replaces only values that carry content.
//
// Usage:
//   bun scripts/capture-fixture.ts <transcript> <out.jsonl> --project <slug> [--alias from=to …]
//
// `--alias` is the manual half, and it is not optional in practice: org, repo, and
// remote names ride in on keys that stay verbatim (git urls, shell commands, env var
// names), so the operator names them and re-runs until the leak scan is clean.
//
// What survives verbatim (after path rewriting):
//   - every key, at every depth, in the original order
//   - every value whose key is not in PROSE_KEYS — enum tokens, ids, models,
//     timestamps, numbers, booleans, and shell commands (the extract-commands signal)
//   - structural lines inside prose: patch headers, harness injection tags
// What is replaced:
//   - prose values → deterministic synthetic prose with the same line shape, so a
//     text-equality join (Codex's user_message ↔ response_item twin) still matches
//   - opaque blobs (encrypted reasoning, thinking signatures) → clipped
//   - $HOME, the session cwd, and the OS username → fixed placeholders
//   - anything matching a credential pattern → REDACTED
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { dirname } from 'node:path';

/** Values under these keys can carry conversation text, tool output, or file bodies. */
const PROSE_KEYS = new Set([
  'text',
  'message',
  'content',
  'output',
  'input',
  'stdout',
  'stderr',
  'aggregated_output',
  'formatted_output',
  'summary',
  'title',
  'customTitle',
  'oldText',
  'newText',
  'old_string',
  'new_string',
  'oldString',
  'newString',
  'originalFile',
  'description',
  'prompt',
  'instructions',
  'user_instructions',
  'developer_instructions',
  'base_instructions',
  'error',
  'errorMessage',
  'unified_diff',
  'thinking',
  'reasoning',
  'query',
]);

/** Opaque provider blobs: never conversation, never shape — just bulk. */
const BLOB_KEYS = new Set(['encrypted_content', 'signature', 'thinkingSignature', 'patch', 'diff']);

/** Lines kept verbatim inside prose because an extractor keys off them. */
const STRUCTURAL_LINE =
  /^(\*\*\* (?:Begin|End) Patch|\*\*\* (?:Add|Update|Delete) File:|@@|<\/?(?:environment_context|user_action|turn_aborted|recommended_plugins|image|skill|user_shell_command|permissions instructions|system-reminder)\b|# AGENTS\.md instructions for )/;

/** Credential shapes. Verbatim values are scanned for these; a hit blanks the whole value. */
const SECRET =
  /(sk-[A-Za-z0-9]{16,}|ghp_[A-Za-z0-9]{16,}|xox[abpsr]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]{20,}|-----BEGIN )/;

/** Word bank for synthetic prose. Domain-neutral on purpose: a fixture must not read
 *  like it is about anything, or the next reader will trust its content. */
const WORDS =
  'the parser reads a line and returns a record when the shape matches otherwise it skips ahead so that every consumer sees one normalized form instead of four different envelopes each with its own rules for where the text lives'.split(
    ' ',
  );

/** Cap synthesized prose: a fixture needs the shape of a 3,500-token tool output, not its bulk. */
const MAX_LINES = 30;
const MAX_WORDS_PER_LINE = 18;
const BLOB_CHARS = 48;

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

interface Rewrite {
  cwd: string;
  project: string;
  aliases: [string, string][];
}

/** $HOME, the captured session's cwd, the OS username, and the operator's aliases → placeholders. */
function rewritePaths(s: string, rw: Rewrite): string {
  let out = s;
  if (rw.cwd) out = out.split(rw.cwd).join(`/eval/corpus/${rw.project}`);
  out = out.split(homedir()).join('/eval/home');
  const user = userInfo().username;
  if (user) out = out.split(user).join('dev');
  for (const [from, to] of rw.aliases) out = out.split(from).join(to);
  return out;
}

/**
 * Deterministic synthetic prose with the source's line shape. Deterministic because
 * Codex's genuineness join is a text equality between two streams that hold the same
 * string — synthesize them independently and the join has to still match.
 */
function synthesize(s: string, rw: Rewrite): string {
  const lines = s.split('\n');
  const kept = lines.slice(0, MAX_LINES);
  let seed = hash(s);
  const next = (): number => {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    return seed;
  };
  const out = kept.map((line) => {
    const trimmed = line.trimStart();
    if (!trimmed) return '';
    if (STRUCTURAL_LINE.test(trimmed)) return rewritePaths(line, rw);
    // Diff and list markers are shape; the payload after them is not.
    const marker = /^([+\-*>#|\s]{0,4})/.exec(line)?.[1] ?? '';
    const count = Math.min(Math.max(1, trimmed.split(/\s+/).length), MAX_WORDS_PER_LINE);
    const words: string[] = [];
    for (let i = 0; i < count; i++) words.push(WORDS[next() % WORDS.length]!);
    return marker + words.join(' ');
  });
  if (lines.length > MAX_LINES) out.push('…');
  return out.join('\n');
}

function scrub(s: string, rw: Rewrite): string {
  const rewritten = rewritePaths(s, rw);
  return SECRET.test(rewritten) ? 'REDACTED' : rewritten;
}

function redactString(key: string, value: string, rw: Rewrite): string {
  if (BLOB_KEYS.has(key)) return value.slice(0, BLOB_CHARS) + (value.length > BLOB_CHARS ? '…' : '');
  // Codex ships function_call.arguments as a JSON *string*; that one is schema, not
  // prose, so recurse to keep its parameter names. Only this key — a prose field that
  // merely happens to start with `{` (a package.json in tool output) must stay prose,
  // since object keys are never rewritten and would carry real names through.
  if (key === 'arguments') {
    try {
      return JSON.stringify(redact(key, JSON.parse(value), rw));
    } catch {}
  }
  if (PROSE_KEYS.has(key)) return synthesize(value, rw);
  return scrub(value, rw);
}

function redact(key: string, value: unknown, rw: Rewrite): unknown {
  if (typeof value === 'string') return redactString(key, value, rw);
  if (Array.isArray(value)) return value.map((v) => redact(key, v, rw));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = redact(k, v, rw);
    return out;
  }
  return value;
}

/** The captured session's own working directory — the string that has to disappear everywhere. */
function findCwd(lines: string[]): string {
  for (const line of lines) {
    try {
      const d = JSON.parse(line) as Record<string, unknown>;
      if (typeof d['cwd'] === 'string' && d['cwd']) return d['cwd'];
      const p = d['payload'] as Record<string, unknown> | undefined;
      if (p && typeof p['cwd'] === 'string' && p['cwd']) return p['cwd'];
    } catch {}
  }
  return '';
}

const [src, dest, ...rest] = process.argv.slice(2);
if (!src || !dest) {
  process.stderr.write('usage: bun scripts/capture-fixture.ts <transcript> <out.jsonl> --project <slug>\n');
  process.exit(1);
}
const projectFlag = rest.indexOf('--project');
const project = projectFlag >= 0 ? (rest[projectFlag + 1] ?? 'sample') : 'sample';
// Longest first, so `authkit-session=…` wins over a bare `authkit=…`.
const aliases = rest
  .filter((a, i) => rest[i - 1] === '--alias')
  .map((a): [string, string] => {
    const eq = a.indexOf('=');
    return [a.slice(0, eq), a.slice(eq + 1)];
  })
  .sort((a, b) => b[0].length - a[0].length);

const lines = readFileSync(src, 'utf-8').trimEnd().split('\n');
const rw: Rewrite = { cwd: findCwd(lines), project, aliases };
const captured = lines
  .map((line) => {
    try {
      return JSON.stringify(redact('', JSON.parse(line), rw));
    } catch {
      return null;
    }
  })
  .filter((l): l is string => l !== null);

mkdirSync(dirname(dest), { recursive: true });
writeFileSync(dest, captured.join('\n') + '\n');
process.stderr.write(`captured ${captured.length} lines → ${dest}\n`);
