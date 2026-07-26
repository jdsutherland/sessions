import { closeSync, existsSync, openSync, readdirSync, readSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { homedir } from 'node:os';
import type { Tool } from './types';

// ds4-agent (a local DeepSeek-V4 runtime) writes no transcript log. It checkpoints
// the live KV cache to ~/.ds4/kvcache/<sha1>.kv, and the full rendered conversation
// rides inside that file as a UTF-8 blob between the fixed header and the binary
// KV payload. This module bridges that gap the way src/opencode.ts bridges its
// SQLite DB: synthesize the JSONL-style `lines[]` the shared parser already speaks,
// so the extractors treat ds4 like any other tool.
//
// File layout (ds4_kvstore.c: ds4_kvstore_fill_header / ds4_kvstore_read_header):
//   0   'K' 'V' 'C' + version(1)
//   4   quant_bits | 5 reason | 6 ext_flags | 7 model_id
//   8   tokens u32 | 12 hits u32 | 16 ctx_size u32 | 20 payload ABI
//   24  created_at u64 | 32 last_used u64 | 40 payload_bytes u64   (all LE, epoch s)
//   48  text_bytes u32
//   52  rendered transcript (text_bytes)
//   ..  KV payload (payload_bytes) — never read here
//   ..  title trailer: u32 length + UTF-8 (only when ext_flags & SESSION_TITLE)
//
// Files run 100 MB – 2.5 GB, so every read below is a bounded pread. Never
// readFileSync one of these.

const FIXED_HEADER = 48;
const TEXT_LEN_FIELD = 4;
const KVC_VERSION = 1;
const PAYLOAD_ABI = 2;
const REASON_AGENT_SESSION = 6;
const EXT_SESSION_TITLE = 0x08;
/** Rendered transcripts top out well under a megabyte; this only bounds a corrupt length field. */
const MAX_TEXT_BYTES = 64 * 1024 * 1024;
const MAX_TITLE_BYTES = 64 * 1024;

/** Absolute path to the ds4-agent KV cache, honoring SESSIONS_DS4_DIR. I.e. ~/.ds4/kvcache */
export function getDs4Dir(): string {
  return process.env.SESSIONS_DS4_DIR || join(homedir(), '.ds4/kvcache');
}

/** Whether a stored file_path denotes a ds4 session (a `.kv` directly in the cache dir). */
export function isDs4Path(filePath: string): boolean {
  return filePath.endsWith('.kv') && dirname(filePath) === getDs4Dir();
}

/** The session id embedded in a ds4 file_path: the identity SHA1, without the `.kv`. */
export function ds4SessionId(filePath: string): string {
  return basename(filePath, '.kv');
}

interface Ds4Header {
  reason: number;
  extFlags: number;
  tokens: number;
  createdAt: number;
  lastUsed: number;
  payloadBytes: number;
  textBytes: number;
}

/** Parsed header + rendered transcript, or null when the file is not a readable agent session. */
interface Ds4Session {
  header: Ds4Header;
  text: string;
  title: string;
}

function readAt(fd: number, length: number, position: number): Buffer | null {
  const buf = Buffer.allocUnsafe(length);
  if (readSync(fd, buf, 0, length, position) !== length) return null;
  return buf;
}

function parseHeader(buf: Buffer): Ds4Header | null {
  if (buf[0] !== 0x4b || buf[1] !== 0x56 || buf[2] !== 0x43) return null; // 'KVC'
  if (buf[3] !== KVC_VERSION || buf[20] !== PAYLOAD_ABI) return null;
  const quantBits = buf[4]!;
  if (quantBits !== 2 && quantBits !== 4) return null;
  const tokens = buf.readUInt32LE(8);
  if (tokens === 0) return null;
  const textBytes = buf.readUInt32LE(FIXED_HEADER);
  if (textBytes === 0 || textBytes > MAX_TEXT_BYTES) return null;
  return {
    reason: buf[5]!,
    extFlags: buf[6]!,
    tokens,
    createdAt: Number(buf.readBigUInt64LE(24)),
    lastUsed: Number(buf.readBigUInt64LE(32)),
    payloadBytes: Number(buf.readBigUInt64LE(40)),
    textBytes,
  };
}

/**
 * Header, transcript, and title trailer for one `.kv` file — three bounded preads,
 * never the multi-gigabyte payload between them. Returns null for sysprompt.kv, a
 * cache checkpoint that isn't a user session (reason != AGENT_SESSION), and for
 * anything that fails the magic/version/ABI checks the C reader applies.
 */
export function readDs4File(filePath: string): Ds4Session | null {
  let fd: number;
  try {
    fd = openSync(filePath, 'r');
  } catch {
    return null;
  }
  try {
    const head = readAt(fd, FIXED_HEADER + TEXT_LEN_FIELD, 0);
    if (!head) return null;
    const header = parseHeader(head);
    if (!header || header.reason !== REASON_AGENT_SESSION) return null;

    const textBuf = readAt(fd, header.textBytes, FIXED_HEADER + TEXT_LEN_FIELD);
    if (!textBuf) return null;

    let title = '';
    if (header.extFlags & EXT_SESSION_TITLE) {
      const at = FIXED_HEADER + TEXT_LEN_FIELD + header.textBytes + header.payloadBytes;
      const lenBuf = readAt(fd, 4, at);
      const titleBytes = lenBuf ? lenBuf.readUInt32LE(0) : 0;
      if (titleBytes > 0 && titleBytes <= MAX_TITLE_BYTES) {
        title = readAt(fd, titleBytes, at + 4)?.toString('utf-8') ?? '';
      }
    }
    return { header, text: textBuf.toString('utf-8'), title };
  } catch {
    return null;
  } finally {
    closeSync(fd);
  }
}

/** Saved agent sessions in the cache dir, as discovery entries. Empty when the dir is absent. */
export function discoverDs4Sessions(): { path: string; tool: Tool }[] {
  const dir = getDs4Dir();
  if (!existsSync(dir)) return [];
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const entries: { path: string; tool: Tool }[] = [];
  for (const name of names) {
    // sysprompt.kv is the fixed bootstrap checkpoint, not a conversation. Its
    // reason byte already excludes it; skipping by name avoids opening it at all.
    if (!name.endsWith('.kv') || name === 'sysprompt.kv') continue;
    entries.push({ path: join(dir, name), tool: 'ds4' });
  }
  return entries;
}

// ——— transcript grammar ———
//
// <｜begin▁of▁sentence｜> system prompt
// (<｜User｜> … <｜Assistant｜> … <｜end▁of▁sentence｜>)*
// Assistant turns carry <think>…</think> reasoning and DSML tool calls; tool
// results come back as pseudo-user turns wrapped in <tool_result>…</tool_result>.

const USER_MARK = '<｜User｜>';
const ASSISTANT_MARK = '<｜Assistant｜>';
const EOS_MARK = '<｜end▁of▁sentence｜>';
const THINK_RE = /<think>([\s\S]*?)<\/think>/g;
const TOOL_CALL_BLOCK_RE = /<｜DSML｜tool_calls>[\s\S]*?(?:<\/｜DSML｜tool_calls>|$)/g;
const INVOKE_RE = /<｜DSML｜invoke name="([^"]+)">([\s\S]*?)<\/｜DSML｜invoke>/g;
const PARAM_RE = /<｜DSML｜parameter name="([^"]+)"[^>]*>([\s\S]*?)<\/｜DSML｜parameter>/g;
const TOOL_RESULT_HEAD_RE = /^\s*<tool_result>\s*Tool result \d+ \(([^)]+)\)/;
const EXIT_STATUS_RE = /^exit_status=(\d+)$/m;

interface Ds4Turn {
  role: 'user' | 'assistant';
  body: string;
}

/** Split a rendered transcript into turns, discarding the leading system prompt. */
function splitTurns(text: string): Ds4Turn[] {
  const turns: Ds4Turn[] = [];
  let pos = text.indexOf(USER_MARK);
  if (pos < 0) return turns;
  while (pos < text.length) {
    const isUser = text.startsWith(USER_MARK, pos);
    const mark = isUser ? USER_MARK : ASSISTANT_MARK;
    const start = pos + mark.length;
    const nextUser = text.indexOf(USER_MARK, start);
    const nextAssistant = text.indexOf(ASSISTANT_MARK, start);
    let end = text.length;
    if (nextUser >= 0) end = Math.min(end, nextUser);
    if (nextAssistant >= 0) end = Math.min(end, nextAssistant);
    let body = text.slice(start, end);
    const eos = body.indexOf(EOS_MARK);
    if (eos >= 0) body = body.slice(0, eos);
    turns.push({ role: isUser ? 'user' : 'assistant', body });
    if (end >= text.length) break;
    pos = end;
  }
  return turns;
}

/** A DSML invoke as `{ name, arguments }` — parameter values are raw text. */
function parseInvokes(body: string): { name: string; args: Record<string, string> }[] {
  const calls: { name: string; args: Record<string, string> }[] = [];
  for (const block of body.match(TOOL_CALL_BLOCK_RE) ?? []) {
    INVOKE_RE.lastIndex = 0;
    let invoke: RegExpExecArray | null;
    while ((invoke = INVOKE_RE.exec(block))) {
      const args: Record<string, string> = {};
      PARAM_RE.lastIndex = 0;
      let param: RegExpExecArray | null;
      while ((param = PARAM_RE.exec(invoke[2]!))) args[param[1]!] = param[2]!;
      calls.push({ name: invoke[1]!, args });
    }
  }
  return calls;
}

/** Assistant turn → content blocks: thinking, prose text, and one tool block per DSML invoke. */
function assistantContent(body: string): Record<string, unknown>[] {
  const blocks: Record<string, unknown>[] = [];
  THINK_RE.lastIndex = 0;
  let think: RegExpExecArray | null;
  while ((think = THINK_RE.exec(body))) {
    const thinking = think[1]!.trim();
    if (thinking) blocks.push({ type: 'thinking', thinking });
  }
  const prose = body.replace(THINK_RE, '').replace(TOOL_CALL_BLOCK_RE, '').trim();
  if (prose) blocks.push({ type: 'text', text: prose });
  for (const call of parseInvokes(body)) {
    // `state.input` mirrors the OpenCode tool-block shape so the shared
    // extractor helpers read one structure across both synthesized sources.
    blocks.push({ type: 'tool', tool: call.name, state: { input: call.args } });
  }
  return blocks;
}

// ——— cwd inference ———
//
// ds4-agent records no working directory anywhere (there is no getcwd call in
// ds4_agent.c and no cwd field in the KV header), so the project has to be
// inferred from the paths the session actually touched. Ranked, most reliable
// first: the git root shared by absolute tool-arg paths, then the most-used
// absolute directory, then a `cd` target from a bash command. A session that
// touched nothing absolute (pure conversation, or relative paths only) is
// genuinely unattributable and falls back to the cache dir — still searchable,
// never a false match for a repo scope.

/** Tools whose `path` argument names a real filesystem target worth attributing a session to. */
const PATH_TOOLS: Record<string, true> = { read: true, write: true, edit: true, list: true };
const CD_RE = /\bcd\s+("?)(\/[^\s"&;|]+)\1/g;

/** Nearest ancestor containing `.git`, or '' — memoized per call to bound the stat traffic. */
function gitRoot(dir: string, memo: Map<string, string>): string {
  const cached = memo.get(dir);
  if (cached !== undefined) return cached;
  let current = dir;
  let root = '';
  while (current !== '/' && current !== '.') {
    if (existsSync(join(current, '.git'))) {
      root = current;
      break;
    }
    current = dirname(current);
  }
  memo.set(dir, root);
  return root;
}

function topKey(counts: Map<string, number>): string {
  let best = '';
  let bestCount = 0;
  for (const [key, count] of counts) {
    if (count > bestCount) {
      best = key;
      bestCount = count;
    }
  }
  return best;
}

function inferCwd(turns: Ds4Turn[]): string {
  const roots = new Map<string, number>();
  const dirs = new Map<string, number>();
  const cds = new Map<string, number>();
  const memo = new Map<string, string>();
  const bump = (m: Map<string, number>, k: string): void => void m.set(k, (m.get(k) ?? 0) + 1);

  for (const turn of turns) {
    if (turn.role !== 'assistant') continue;
    for (const call of parseInvokes(turn.body)) {
      if (PATH_TOOLS[call.name]) {
        const path = call.args.path?.trim();
        if (!path?.startsWith('/')) continue;
        const dir = dirname(path) || '/';
        bump(dirs, dir);
        const root = gitRoot(dir, memo);
        if (root) bump(roots, root);
      } else if (call.name === 'bash') {
        const command = call.args.command ?? '';
        CD_RE.lastIndex = 0;
        let cd: RegExpExecArray | null;
        while ((cd = CD_RE.exec(command))) bump(cds, cd[2]!);
      }
    }
  }
  return topKey(roots) || topKey(dirs) || topKey(cds) || getDs4Dir();
}

/**
 * Reconstruct a ds4 session as JSONL-style `lines[]` in shapes the shared parser
 * already understands: a Pi-style `session` line carrying the inferred cwd, a
 * `custom-title` line from the KV title trailer, then one `message` line per turn.
 *
 * ds4 stores no per-message timestamps — only the session's `created_at` and
 * `last_used` — so every turn carries the session start. A session resumed across
 * days therefore buckets entirely to the day it began; the per-turn time simply
 * does not exist in the source.
 */
export function readDs4Session(filePath: string): string[] {
  const session = readDs4File(filePath);
  if (!session) return [];
  const turns = splitTurns(session.text);
  if (turns.length === 0) return [];

  // ds4 stores epoch seconds; a zero/insane created_at yields '', which the parser skips.
  const createdAt = session.header.createdAt;
  const timestamp = createdAt > 0 && Number.isFinite(createdAt) ? new Date(createdAt * 1000).toISOString() : '';
  const lines: string[] = [];
  lines.push(JSON.stringify({ type: 'session', cwd: inferCwd(turns), timestamp }));
  const title = session.title.trim();
  if (title) lines.push(JSON.stringify({ type: 'custom-title', customTitle: title }));

  for (const turn of turns) {
    if (turn.role === 'assistant') {
      const content = assistantContent(turn.body);
      if (content.length === 0) continue;
      lines.push(JSON.stringify({ type: 'message', timestamp, message: { role: 'assistant', content } }));
      continue;
    }
    const body = turn.body.trim();
    if (!body) continue;
    const resultTool = TOOL_RESULT_HEAD_RE.exec(body)?.[1];
    const content: Record<string, unknown>[] = [{ type: 'text', text: body }];
    if (resultTool !== undefined) {
      // Tool results ride back as pseudo-user turns. They keep their index and stay
      // searchable, but `promptSource: null` marks them non-genuine (the same signal
      // Claude's tool results carry), and the toolResult block gives extract-errors
      // the exit status the text would otherwise hide.
      const exit = EXIT_STATUS_RE.exec(body)?.[1];
      content.push({
        type: 'toolResult',
        tool: resultTool,
        exitStatus: exit === undefined ? 0 : Number(exit),
      });
    }
    lines.push(
      JSON.stringify({
        type: 'message',
        timestamp,
        promptSource: resultTool === undefined ? 'typed' : null,
        message: { role: 'user', content },
      }),
    );
  }
  return lines;
}
