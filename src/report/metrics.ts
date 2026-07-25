import type { SessionMetrics, Tool } from '../types.ts';
import type { ToolId } from './types.ts';
import { aggregate } from './aggregate.ts';
import { gatherEvents, defaultRoots, mtimeFloor, type ReportRoots } from './extract.ts';
import { localDate } from './parsers/util.ts';
import { defaultTz } from './period.ts';
import { resolveProject } from './project.ts';

// get_session_metrics, on the report pipeline.
//
// It used to be a second implementation over the search index, and it bucketed active
// hours by `timestamp.slice(11, 13)` — the UTC hour — while every other surface in the
// product buckets by a configurable timezone. A 9pm Chicago session was reported at
// 02:00 or 03:00 depending on daylight saving. There is now one path: the same events,
// the same localDate/localHour, the same aggregate() the HTML dashboard renders.
//
// The output shape is unchanged; two of its meanings sharpen. `activeHours` counts
// messages per LOCAL hour (it counted sessions per UTC hour, from the first line of
// each transcript), and a project is the resolved project name the report uses rather
// than a raw cwd path.

const TOOL_ID: Record<Tool, ToolId> = { claude: 'claude-code', codex: 'codex', pi: 'pi', opencode: 'opencode' };
/** Back to the names the tool has always emitted — `claude`, not the report's `claude-code`. */
const TOOL_NAME: Record<ToolId, string> = { 'claude-code': 'claude', codex: 'codex', pi: 'pi', opencode: 'opencode' };

export interface MetricsOptions {
  /** Test seam: where to read sessions from. Defaults to the real per-tool roots. */
  roots?: ReportRoots;
  tz?: string;
  now?: string;
}

export async function getSessionMetrics(
  startDate: string,
  endDate: string,
  toolFilter: Tool | '',
  project: string,
  opts: MetricsOptions = {},
): Promise<SessionMetrics> {
  const tz = opts.tz ?? defaultTz();
  const now = opts.now ?? new Date().toISOString();
  const tools = toolFilter ? new Set<ToolId>([TOOL_ID[toolFilter]]) : undefined;
  // The window is the point of this tool, so it prunes before parsing: a transcript last
  // written before startDate cannot hold an event inside the range.
  const events = await gatherEvents(opts.roots ?? defaultRoots(), { tools, since: mtimeFloor(startDate) });

  // Same scoping rule as `report --here`: match on the resolved project name, so a
  // cwd the resolver cannot name ('unknown') drops out of a project-scoped call.
  const scope = project ? resolveProject(project) : '';
  const inRange = events.filter((e) => {
    if (scope && resolveProject(e.projectPath) !== scope) return false;
    const d = localDate(e.timestamp, tz);
    return d >= startDate && d <= endDate;
  });

  const data = aggregate({ events: inRange, prs: [], now, tz, exclude: new Set<string>(), priorDaily: [] });

  const toolBreakdown: Record<string, number> = {};
  for (const t of data.byTool) toolBreakdown[TOOL_NAME[t.id] ?? t.id] = t.sessions;

  // The report's ProjectBreakdown carries no message count (it is a vendored contract),
  // so messages come from the same filtered events the aggregation just consumed.
  const messagesByProject = new Map<string, number>();
  for (const e of inRange) {
    const label = resolveProject(e.projectPath);
    messagesByProject.set(label, (messagesByProject.get(label) ?? 0) + 1);
  }

  const activeHours: Record<string, number> = {};
  data.insights.hourCounts.forEach((count, hour) => {
    if (count > 0) activeHours[String(hour).padStart(2, '0')] = count;
  });

  return {
    period: { start: startDate, end: endDate },
    totalSessions: data.summary.sessions,
    totalMessages: data.summary.messages,
    toolBreakdown,
    projectBreakdown: data.byProject
      .map((p) => ({ project: p.label, sessions: p.sessions, messages: messagesByProject.get(p.label) ?? 0 }))
      .sort((a, b) => b.sessions - a.sessions),
    dailyActivity: data.daily.map((d) => ({ date: d.date, sessions: d.sessions, messages: d.messages })),
    activeHours,
  };
}
