// omp (can1357/oh-my-pi) is a fork of Pi that kept an identical on-disk session
// shape for the fields parsePi reads: {type:'session', id, cwd} and
// {type:'message', message:{role, provider, model, usage:{input, output,
// cacheRead, cacheWrite, cost:{total}}}} — confirmed against real captured
// ~/.omp/agent/sessions logs, byte-for-byte against a real Pi session. Reusing
// parsePi (vendored verbatim from tokenmaxing — do not fork its logic here) and
// relabeling the tool avoids duplicating that parsing logic for a shape that
// hasn't actually diverged in the fields this report cares about.
import type { UsageEvent } from './types.ts';
import { parsePi, parsePiFile } from './pi.ts';
import type { WalkOptions } from './walk.ts';

function asOmp(events: UsageEvent[]): UsageEvent[] {
  return events.map((event) => ({ ...event, tool: 'omp' }));
}

export async function parseOmp(root: string, opts: WalkOptions = {}): Promise<UsageEvent[]> {
  return asOmp(await parsePi(root, opts));
}

export async function parseOmpFile(path: string): Promise<UsageEvent[]> {
  return asOmp(await parsePiFile(path));
}
