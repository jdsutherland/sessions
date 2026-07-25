import { writeFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { C } from './colors';
import { resolveRepo } from './repo';
import { getClaudeDir, getMemoryDbPath } from './paths';
import { sessionIdFor } from './session-id';
import { writeStdoutFully } from './stdout';
import {
  deferredLessons,
  exportLessons,
  listLessons,
  recoverLesson,
  resolveReview,
  reviewGroups,
  retireLesson,
  type LessonRow,
  type ReviewChoice,
} from './memory';

export type LessonsAction = 'list' | 'review' | 'export' | 'audit' | 'retire';

export interface LessonsArgs {
  action: LessonsAction;
  all: boolean;
  out?: string;
  id?: number;
  /** Non-interactive resolution for `review`, so the walk is scriptable and testable. */
  keep?: ReviewChoice;
}

function die(msg: string): never {
  process.stderr.write(`error: ${msg}\n`);
  process.exit(1);
}

function help(): never {
  process.stderr.write(`sessions lessons — what past sessions concluded, not what they did

Lessons are saved by the remember_lesson MCP tool and served by the context
primer. They live in ${getMemoryDbPath()}, outside the search index, and
survive --clear-cache, cleanup, and uninstall.

Usage:
  sessions lessons                 Lessons in scope for the current repo
  sessions lessons --all           Every lesson, every repo
  sessions lessons review          Resolve conflicting lessons
  sessions lessons export          Print every lesson as JSON
  sessions lessons audit           Trace deferred provenance back to a session
  sessions lessons retire <id>     Take one lesson out of service (never deleted)

Options:
  --all            Ignore repo scope
  --out <path>     Write export output to a file instead of stdout
  --keep <which>   review: resolve every group non-interactively (new|old|both)
  -h, --help       Show this help
`);
  process.exit(0);
}

export function parseLessonsArgs(argv: string[]): LessonsArgs {
  const args: LessonsArgs = { action: 'list', all: false };

  let i = 0;
  while (i < argv.length) {
    const a = argv[i]!;
    switch (a) {
      case '-h':
      case '--help':
        help();
      case 'list':
      case 'review':
      case 'export':
      case 'audit':
        args.action = a;
        break;
      case 'retire': {
        args.action = 'retire';
        const v = Number(argv[++i]);
        if (!Number.isInteger(v) || v <= 0) die('retire needs a lesson id');
        args.id = v;
        break;
      }
      case '--all':
        args.all = true;
        break;
      case '--out':
        args.out = argv[++i];
        if (!args.out) die('--out requires a path');
        break;
      case '--keep': {
        const v = argv[++i] ?? '';
        if (v !== 'new' && v !== 'old' && v !== 'both') die('--keep must be new|old|both');
        args.keep = v;
        break;
      }
      default:
        die(`unknown option: ${a}`);
    }
    i++;
  }

  return args;
}

/** `hook`/`env`/`meta` are traceable; `deferred` and `none` are not, and say so. */
function provenanceLabel(row: LessonRow): string {
  if (row.source_verified === 1 && row.source_session) return `${row.provenance} · ${row.source_session.slice(0, 8)}`;
  if (row.provenance === 'deferred') return 'deferred · run `sessions lessons audit`';
  return `${row.provenance} · unverifiable`;
}

function formatRow(row: LessonRow): string {
  const scope = row.scope === 'global' ? 'global' : basename(row.repo_container) || 'repo';
  const out = [`${C.bold}#${row.id}${C.reset} ${row.lesson}`];
  if (row.detail) out.push(`     ${C.dim}${row.detail}${C.reset}`);
  out.push(`     ${C.dim}${scope} · ${row.created_at.slice(0, 10)} · ${provenanceLabel(row)}${C.reset}`);
  return out.join('\n');
}

async function runList(args: LessonsArgs): Promise<void> {
  const repo = resolveRepo(process.cwd());
  const rows = listLessons({
    all: args.all,
    container: repo?.container ?? '',
    remote: repo?.remote ?? '',
  });

  const active = rows.filter((r) => r.status === 'active');
  const flagged = rows.filter((r) => r.status === 'needs_review');

  if (rows.length === 0) {
    const where = args.all ? '' : ' for this repo';
    process.stderr.write(`${C.dim}No lessons${where}. They are saved by the remember_lesson MCP tool.${C.reset}\n`);
    return;
  }

  const out: string[] = [];
  for (const row of active) out.push(formatRow(row));
  if (flagged.length > 0) {
    out.push(
      `\n${C.yellow}${flagged.length} lesson${flagged.length === 1 ? '' : 's'} flagged as conflicting${C.reset} ` +
        `${C.dim}— withheld from the primer until resolved. Run \`sessions lessons review\`.${C.reset}`,
    );
  }
  await writeStdoutFully(out.join('\n') + '\n');
}

async function runReview(args: LessonsArgs): Promise<void> {
  const groups = reviewGroups();
  if (groups.length === 0) {
    process.stderr.write(`${C.dim}No conflicting lessons to review.${C.reset}\n`);
    return;
  }

  for (const group of groups) {
    process.stderr.write(`\n${C.bold}Conflict${C.reset} ${C.dim}(group ${group.group})${C.reset}\n`);
    for (const row of group.rows) process.stderr.write(`${formatRow(row)}\n`);

    // Nothing is ever merged. Whichever way this goes, both texts stay readable —
    // the loser is marked superseded or retired, not rewritten.
    const choice = args.keep ?? askChoice();
    if (!choice) {
      process.stderr.write(`  ${C.dim}skipped${C.reset}\n`);
      continue;
    }
    resolveReview(group.group, choice);
    process.stderr.write(`  ${C.green}✓${C.reset} kept ${choice}\n`);
  }
}

/** Ask once per group. A non-TTY (or anything unrecognized) skips rather than guessing. */
function askChoice(): ReviewChoice | null {
  if (!process.stdin.isTTY) return null;
  process.stderr.write(`  ${C.dim}Keep [n]ew / [o]ld / [b]oth / [s]kip? ${C.reset}`);
  const answer = (prompt('') ?? '').trim().toLowerCase();
  if (answer === 'n' || answer === 'new') return 'new';
  if (answer === 'o' || answer === 'old') return 'old';
  if (answer === 'b' || answer === 'both') return 'both';
  return null;
}

async function runExport(args: LessonsArgs): Promise<void> {
  const json = JSON.stringify(exportLessons(), null, 2) + '\n';
  if (args.out) {
    await writeFile(args.out, json, 'utf-8');
    process.stderr.write(`wrote ${args.out}\n`);
    return;
  }
  await writeStdoutFully(json);
}

export interface AuditResult {
  scanned: number;
  recovered: number;
  unresolved: number;
  grepFailed: boolean;
}

/**
 * Promote deferred rows to `recovered`.
 *
 * A deferred lesson has no session id but does have the tool_use id its client sent,
 * which appears verbatim in the transcript on disk. It is client-generated, the model
 * never sees it, and it is unique across the corpus — so an exact-literal search for
 * it is an unforgeable way to find the conversation after the fact.
 */
export function auditDeferred(): AuditResult {
  const pending = deferredLessons();
  const result: AuditResult = { scanned: pending.length, recovered: 0, unresolved: 0, grepFailed: false };

  for (const row of pending) {
    const needle = row.source_tool_use_id!;
    let out: string;
    try {
      const proc = Bun.spawnSync(['grep', '-rlF', '--include=*.jsonl', needle, getClaudeDir()]);
      // grep exits 1 for "no match" and 2 for a real error; only 2 is our problem.
      if (proc.exitCode === 2) {
        result.grepFailed = true;
        break;
      }
      out = new TextDecoder().decode(proc.stdout).trim();
    } catch {
      result.grepFailed = true;
      break;
    }

    const hit = out.split('\n').find(Boolean);
    if (!hit) {
      result.unresolved++;
      continue;
    }
    recoverLesson(row.id, sessionIdFor(hit, 'claude'), hit);
    result.recovered++;
  }

  return result;
}

function runAudit(): void {
  const res = auditDeferred();
  if (res.scanned === 0) {
    process.stderr.write(`${C.dim}No lessons are waiting on provenance.${C.reset}\n`);
    return;
  }
  if (res.grepFailed) {
    process.stderr.write(`${C.red}✗${C.reset} could not search the transcripts (grep unavailable).\n`);
    return;
  }
  process.stderr.write(
    `${C.green}✓${C.reset} traced ${res.recovered} of ${res.scanned} lesson${res.scanned === 1 ? '' : 's'} back to a session` +
      (res.unresolved > 0 ? `; ${res.unresolved} had no matching transcript and stay deferred` : '') +
      '\n',
  );
}

function runRetire(id: number): void {
  if (retireLesson(id)) {
    process.stderr.write(`${C.green}✓${C.reset} lesson #${id} retired. It is out of the primer, not deleted.\n`);
  } else {
    process.stderr.write(`${C.dim}No active lesson #${id}.${C.reset}\n`);
  }
}

export async function runLessons(args: LessonsArgs): Promise<void> {
  switch (args.action) {
    case 'list':
      return runList(args);
    case 'review':
      return runReview(args);
    case 'export':
      return runExport(args);
    case 'audit':
      return runAudit();
    case 'retire':
      return runRetire(args.id!);
  }
}
