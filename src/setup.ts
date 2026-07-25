import { existsSync, mkdirSync, writeFileSync, cpSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { C } from './colors';
import { PLUGIN_FILES } from './plugin-files';
import { enableSessionHook, disableSessionHook } from './hooks';
import { getDataDir, getHome, getMemoryDbPath } from './paths';
import { countLessons, purgeLessons } from './memory';
import {
  detectClients,
  wireJsonClient,
  unwireJsonClient,
  wireCodex,
  unwireCodex,
  codexManualBlock,
  cleanDeadConfigs,
  type McpClient,
  type WireResult,
} from './mcp-config';

// Resolved per call rather than frozen at import so SESSIONS_HOME / SESSIONS_DATA_DIR
// let install and uninstall be exercised without touching the real home.
const sessionsDir = (): string => getDataDir();
const pluginDest = (): string => join(sessionsDir(), 'plugin');
const PLUGIN_VERSION = '1.15.3'; // x-release-please-version
const MARKETPLACE_NAME = 'sessions';
const PLUGIN_NAME = 'sessions';

function findPluginSource(): string {
  const candidates = [
    join(dirname(Bun.main), 'plugin'),
    join(dirname(Bun.main), '..', 'plugin'),
    join(dirname(Bun.main), '..', 'share', 'sessions', 'plugin'),
  ];
  for (const c of candidates) {
    if (existsSync(join(c, '.mcp.json'))) return c;
  }
  return '';
}

function installPluginFromDisk(source: string): boolean {
  try {
    mkdirSync(dirname(pluginDest()), { recursive: true });
    cpSync(source, pluginDest(), { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

function installPluginFromEmbed(): boolean {
  try {
    mkdirSync(dirname(pluginDest()), { recursive: true });
    for (const [relPath, content] of Object.entries(PLUGIN_FILES)) {
      const dest = join(pluginDest(), relPath);
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, content);
    }
    return true;
  } catch {
    return false;
  }
}

function writeMarketplaceJson(): void {
  const marketplace = {
    name: MARKETPLACE_NAME,
    owner: { name: 'Nick Nisi', email: 'nick@nisi.org' },
    metadata: { description: 'Skills for summarizing and recalling AI coding sessions', version: PLUGIN_VERSION },
    plugins: [
      {
        name: PLUGIN_NAME,
        source: './plugin',
        description: 'Weekly summaries, standups, recall, and metrics for AI coding sessions.',
      },
    ],
  };
  const dir = join(sessionsDir(), '.claude-plugin');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'marketplace.json'), JSON.stringify(marketplace, null, 2) + '\n');
}

function installPlugin(): boolean {
  const source = findPluginSource();
  const ok = source ? installPluginFromDisk(source) : installPluginFromEmbed();
  if (ok) writeMarketplaceJson();
  return ok;
}

function sessionsCommand(): string {
  try {
    const result = Bun.spawnSync(['which', 'sessions']);
    const path = new TextDecoder().decode(result.stdout).trim();
    if (path) return path;
  } catch {}
  return 'sessions';
}

/** Wire one detected client into the file it actually reads. */
function configureMcp(client: McpClient): WireResult {
  const cmd = sessionsCommand();
  switch (client.id) {
    // Claude Code gets its server from the plugin, not from a config file of ours.
    case 'claude':
      return registerClaudePlugin();
    case 'codex':
      return wireCodex(client.configPath, cmd);
    default:
      return wireJsonClient(client.configPath, client.id, cmd);
  }
}

function unconfigureMcp(client: McpClient): WireResult {
  switch (client.id) {
    case 'claude':
      return unregisterClaudePlugin();
    case 'codex':
      return unwireCodex(client.configPath);
    default:
      return unwireJsonClient(client.configPath);
  }
}

function hasClaudeCli(): boolean {
  try {
    return Bun.spawnSync(['which', 'claude'], { stdout: 'pipe', stderr: 'pipe' }).exitCode === 0;
  } catch {
    return false;
  }
}

function runClaude(...args: string[]): boolean {
  try {
    const result = Bun.spawnSync(['claude', 'plugins', ...args], { stderr: 'pipe', stdout: 'pipe' });
    return result.exitCode === 0;
  } catch {
    return false;
  }
}

/**
 * Register the plugin, which is how the MCP server reaches Claude Code. Without
 * the CLI there is nothing to register through — say so rather than report a
 * success the user would only discover was false when a tool call went missing.
 */
function registerClaudePlugin(): WireResult {
  if (!hasClaudeCli()) return { status: 'refused', reason: '`claude` is not on your PATH' };
  runClaude('marketplace', 'add', sessionsDir());
  if (!runClaude('install', `${PLUGIN_NAME}@${MARKETPLACE_NAME}`)) return { status: 'unchanged' };
  return { status: 'added' };
}

function unregisterClaudePlugin(): WireResult {
  if (!hasClaudeCli()) return { status: 'refused', reason: '`claude` is not on your PATH' };
  const removed = runClaude('uninstall', `${PLUGIN_NAME}@${MARKETPLACE_NAME}`);
  runClaude('marketplace', 'remove', MARKETPLACE_NAME);
  return { status: removed ? 'added' : 'unchanged' };
}

export interface SetupOptions {
  /** Explicitly enable the SessionStart auto-injection hook (default: off). */
  hooks?: boolean;
}

/**
 * Decide whether to enable the SessionStart hook. Default is OFF: auto-injection
 * costs tokens on every session, so it is never enabled silently.
 *  - `--hooks` → enable.
 *  - no flag + TTY → ask once (default no).
 *  - no flag + non-TTY → leave off.
 */
function shouldEnableHook(opts: SetupOptions): boolean {
  if (opts.hooks) return true;
  if (!process.stdin.isTTY) return false;

  process.stderr.write(
    `\n  ${C.bold}Auto-inject a context primer at session start?${C.reset}\n` +
      `  ${C.dim}Runs \`sessions context --hook\` on every Claude Code session start.${C.reset}\n` +
      `  ${C.dim}Costs a small number of tokens each session. Reversible via \`sessions uninstall\`.${C.reset}\n` +
      `  ${C.dim}Enable? [y/N] ${C.reset}`,
  );
  const answer = (prompt('') ?? '').trim().toLowerCase();
  return answer === 'y' || answer === 'yes';
}

function tilde(path: string): string {
  const home = getHome();
  return path.startsWith(home) ? '~' + path.slice(home.length) : path;
}

/** What to do by hand when we could not, or would not, edit a client's config. */
function manualStep(client: McpClient): string[] {
  const cmd = sessionsCommand();
  if (client.id === 'claude') {
    return [
      `claude plugins marketplace add ${sessionsDir()}`,
      `claude plugins install ${PLUGIN_NAME}@${MARKETPLACE_NAME}`,
    ];
  }
  if (client.id === 'codex') return codexManualBlock(cmd).split('\n');
  const entry =
    client.id === 'pi'
      ? `"type": "stdio", "command": "${cmd}", "args": ["--mcp"]`
      : `"command": "${cmd}", "args": ["--mcp"]`;
  return [`"sessions": { ${entry} }`];
}

/**
 * Report only what happened. A client we detected but did not wire says so and
 * says what to do about it — the alternative is a green check for a client that
 * will never load the server.
 */
function reportWiring(w: (s: string) => void, client: McpClient, result: WireResult): void {
  const name = client.name.padEnd(12);
  const isPlugin = client.id === 'claude';
  const where = isPlugin ? 'the plugin' : tilde(client.configPath);

  if (result.status === 'added') {
    const what = isPlugin
      ? `plugin registered ${C.dim}(the MCP server ships with it)${C.reset}`
      : `MCP server ${client.id === 'codex' ? 'merged into' : 'written to'} ${C.dim}${where}${C.reset}`;
    w(`  ${C.green}✓${C.reset} ${name}${what}\n`);
    return;
  }
  if (result.status === 'unchanged') {
    const what = isPlugin ? 'plugin already registered' : `already configured in ${C.dim}${where}${C.reset}`;
    w(`  ${C.dim}ℹ${C.reset} ${name}${what}\n`);
    return;
  }

  w(`  ${C.red}✗${C.reset} ${name}detected but NOT configured — ${result.reason}\n`);
  w(`      ${C.dim}${isPlugin ? 'Register it yourself:' : `Add it yourself in ${where}:`}${C.reset}\n`);
  for (const line of manualStep(client)) w(`        ${C.dim}${line}${C.reset}\n`);
}

export function runSetup(opts: SetupOptions = {}): void {
  const w = (s: string) => process.stderr.write(s);

  w(`\n${C.bold}sessions setup${C.reset}\n\n`);

  if (installPlugin()) {
    w(`  ${C.green}✓${C.reset} Plugin installed to ${C.dim}${pluginDest()}${C.reset}\n`);
  } else {
    w(`  ${C.red}✗${C.reset} Failed to install plugin to ${pluginDest()}\n`);
    process.exit(1);
  }

  for (const path of cleanDeadConfigs()) {
    w(`  ${C.green}✓${C.reset} Removed dead config no client reads ${C.dim}${tilde(path)}${C.reset}\n`);
  }

  const detected = detectClients().filter((c) => c.detected);

  if (detected.length === 0) {
    w(`\n  ${C.dim}No AI tools detected. Install Claude Code, Cursor, Codex, or Pi first.${C.reset}\n\n`);
    process.exit(0);
  }

  w('\n');
  for (const client of detected) {
    reportWiring(w, client, configureMcp(client));
  }

  // SessionStart auto-injection hook — opt-in, Claude Code only for now.
  const claudeDetected = detected.some((c) => c.id === 'claude');
  if (claudeDetected && shouldEnableHook(opts)) {
    const res = enableSessionHook('claude');
    if (res.changed) {
      w(`  ${C.green}✓${C.reset} SessionStart auto-injection enabled for ${C.dim}Claude Code${C.reset}\n`);
    } else {
      w(`  ${C.dim}ℹ${C.reset} SessionStart auto-injection already enabled for ${C.dim}Claude Code${C.reset}\n`);
    }
    w(`  ${C.dim}  Disable any time with \`sessions uninstall\`.${C.reset}\n`);
  }

  w(`\n  ${C.bold}Skills available:${C.reset}\n`);
  w(`    ${C.cyan}/context${C.reset}           Context primer for the current repo\n`);
  w(`    ${C.cyan}/weekly-summary${C.reset}    Summarize your past week's AI sessions\n`);
  w(`    ${C.cyan}/standup${C.reset}           Yesterday + today activity for standups\n`);
  w(`    ${C.cyan}/recall${C.reset}            What did I do on a specific project?\n`);
  w(`    ${C.cyan}/session-metrics${C.reset}   Usage dashboard with tool breakdown\n`);
  w(`\n  ${C.dim}Run \`sessions setup\` again after upgrading to update skills.${C.reset}\n\n`);
}

export interface UninstallOptions {
  /** Delete memory.db too. Opt-in, never implied, and refused without `yes` on a TTY. */
  purgeLessons?: boolean;
  yes?: boolean;
}

export function runUninstall(opts: UninstallOptions = {}): void {
  const w = (s: string) => process.stderr.write(s);

  w(`\n${C.bold}sessions uninstall${C.reset}\n\n`);

  for (const path of cleanDeadConfigs()) {
    w(`  ${C.green}✓${C.reset} Removed dead config ${C.dim}${tilde(path)}${C.reset}\n`);
  }

  for (const client of detectClients().filter((c) => c.detected)) {
    const result = unconfigureMcp(client);
    const where = client.id === 'claude' ? 'the plugin' : tilde(client.configPath);
    if (result.status === 'added') {
      w(`  ${C.green}✓${C.reset} Removed MCP server from ${C.dim}${where}${C.reset}\n`);
    } else if (result.status !== 'unchanged') {
      w(`  ${C.red}✗${C.reset} Left ${where} alone — ${result.reason}\n`);
    }

    if (client.id === 'claude') {
      const res = disableSessionHook('claude');
      if (res.changed) {
        w(`  ${C.green}✓${C.reset} Removed SessionStart auto-injection from ${C.dim}${client.name}${C.reset}\n`);
      }
    }
  }

  // Remove only what setup created. This used to be `rm -rf` on the whole data dir,
  // which now also holds memory.db — the one thing here that no amount of re-scanning
  // can reproduce.
  for (const dir of [pluginDest(), join(sessionsDir(), '.claude-plugin')]) {
    try {
      if (existsSync(dir)) {
        rmSync(dir, { recursive: true, force: true });
        w(`  ${C.green}✓${C.reset} Removed ${C.dim}${dir}${C.reset}\n`);
      }
    } catch {}
  }

  reportLessons(w, opts);

  w(`\n  ${C.dim}Done. Plugin and MCP config removed.${C.reset}\n\n`);
}

/** Say plainly what was kept and where, or purge it if the user explicitly asked twice. */
function reportLessons(w: (s: string) => void, opts: UninstallOptions): void {
  const kept = countLessons();
  if (kept === 0) return; // nothing saved: no warning to give and nothing to purge

  if (opts.purgeLessons) {
    // --yes is required whether or not there is a TTY. Gating only the interactive
    // case would protect the user who can see the warning and not the script that
    // cannot — and a script is where a silent purge actually happens.
    if (!opts.yes) {
      w(
        `  ${C.red}✗${C.reset} --purge-lessons deletes ${kept} lesson${kept === 1 ? '' : 's'} that nothing can regenerate.\n` +
          `  ${C.dim}Re-run with --yes to confirm, or export first: sessions lessons export --out lessons.json${C.reset}\n`,
      );
      return;
    }
    purgeLessons();
    w(
      `  ${C.green}✓${C.reset} Purged ${kept} lesson${kept === 1 ? '' : 's'} from ${C.dim}${getMemoryDbPath()}${C.reset}\n`,
    );
    return;
  }

  w(
    `  ${C.dim}Kept ${kept} lesson${kept === 1 ? '' : 's'} at ${getMemoryDbPath()} — not re-derivable from transcripts.${C.reset}\n` +
      `  ${C.dim}Export: sessions lessons export --out lessons.json   Delete: sessions uninstall --purge-lessons${C.reset}\n`,
  );
}
