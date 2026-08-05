// omp (can1357/oh-my-pi) is a fork of Pi that kept an identical on-disk session
// shape for the fields parsePi reads: {type:'session', id, cwd} and
// {type:'message', message:{role, provider, model, usage:{input, output,
// cacheRead, cacheWrite, cost:{total}}}} — confirmed against real captured
// ~/.omp/agent/sessions logs, byte-for-byte against a real Pi session. Reusing
// the sessions-owned Pi parser and relabeling its output avoids duplicating the
// accounting logic. Dedup keys must be relabeled too: the report dedupes across
// all tools, so a copied Pi and omp response must remain separate usage events.
import type { UsageEvent } from './types.ts';
import { parsePi, parsePiFile } from './pi.ts';
import type { WalkOptions } from './walk.ts';

function asOmp(events: UsageEvent[]): UsageEvent[] {
  return events.map((event) => ({
    ...event,
    tool: 'omp',
    ...(event.dedupKey?.startsWith('pi|') ? { dedupKey: `omp|${event.dedupKey.slice(3)}` } : {}),
  }));
}

export async function parseOmp(root: string, opts: WalkOptions = {}): Promise<UsageEvent[]> {
  return asOmp(await parsePi(root, opts));
}

export async function parseOmpFile(path: string): Promise<UsageEvent[]> {
  return asOmp(await parsePiFile(path));
}
