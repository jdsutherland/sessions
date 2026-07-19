// The wrapped page — a scroll-snap story, not a dashboard. Design rules from
// the Spotify Wrapped research: one stat per full-viewport card, payoffs late
// (persona is the climax), numerals as artwork, decoration behind flat text
// panels, a limited high-contrast palette (the report's OKLCH accents, one per
// card), self-relative comparisons only, hedged copy on disputable stats, and
// zero external requests. JS is textContent-only — never innerHTML.

import type { WrappedData, FunCard, WrappedExtra } from './types.ts';
import { prettyModel } from './model-name.ts';

// Re-exported so existing importers (and tests) keep resolving prettyModel here.
export { prettyModel } from './model-name.ts';

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const fmtInt = (n: number): string => n.toLocaleString('en-US');
/** "1 day" / "2 days" — never "1 days". */
const plural = (n: number, one: string, many = `${one}s`): string => (n === 1 ? one : many);

function fmtTokens(n: number): string {
  if (n >= 1_000_000_000) return (n / 1_000_000_000).toFixed(2) + 'B';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return String(n);
}

const fmtUSD = (n: number): string => '$' + Math.round(n).toLocaleString('en-US');

function fmtDuration(ms: number): string {
  const mins = Math.round(ms / 60_000);
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

/** Seconds-capable variant — a median loop is often under a minute, and "0m"
 *  reads as a bug. */
function fmtDurationShort(ms: number): string {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : fmtDuration(ms);
}

function hourLabel(h: number): string {
  if (h === 0) return '12 AM';
  if (h === 12) return '12 PM';
  return h < 12 ? h + ' AM' : h - 12 + ' PM';
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const DAY_LETTERS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function formatDate(ymd: string): string {
  const [y, m, d] = ymd.split('-').map(Number);
  return `${MONTHS[m! - 1]} ${d}, ${y}`;
}

function shortDate(ymd: string): string {
  const [, m, d] = ymd.split('-').map(Number);
  return `${MONTHS[m! - 1]} ${d}`;
}

// Same accents as the report — wrapped and report read as one product. The
// page commits to dark (it's a mood); each card adopts one accent in rotation.
const ACCENTS = [
  { name: 'magenta', c: 'oklch(70% 0.24 350)' },
  { name: 'lime', c: 'oklch(86% 0.23 132)' },
  { name: 'cyan', c: 'oklch(80% 0.14 200)' },
  { name: 'cobalt', c: 'oklch(70% 0.17 262)' },
  { name: 'tangerine', c: 'oklch(76% 0.18 50)' },
  { name: 'red', c: 'oklch(68% 0.21 25)' },
] as const;

/** Reframe the raw token count as something human — the "minutes listened" move. */
export function tokenEquivalence(tokens: number): string | null {
  // Recognizable units beat precise ones, and big multipliers are the point —
  // "469 Harry Potter series" lands harder than "11 Britannicas".
  const scales: { unit: number; many: string }[] = [
    { unit: 6_000_000_000, many: 'copies of the English Wikipedia' },
    { unit: 1_400_000, many: 'read-throughs of the Harry Potter series' },
    { unit: 780_000, many: 'copies of War and Peace' },
  ];
  for (const s of scales) {
    const x = tokens / s.unit;
    if (x >= 1.5) {
      const n = x >= 10 ? fmtInt(Math.round(x)) : x.toFixed(1);
      return `that’s ${n} ${s.many}`;
    }
  }
  return tokens >= 400_000 ? 'that’s most of War and Peace' : null;
}

/** The receipt's version of tokenEquivalence — the bill, in things. */
export function costEquivalence(costUSD: number): string | null {
  const scales: { unit: number; many: string }[] = [
    { unit: 1999, many: 'MacBook Airs' },
    { unit: 249, many: 'pairs of AirPods Pro' },
    { unit: 6, many: 'oat-milk lattes' },
  ];
  for (const s of scales) {
    const x = costUSD / s.unit;
    if (x >= 1.5) {
      const n = x >= 10 ? fmtInt(Math.round(x)) : x.toFixed(1);
      return `about ${n} ${s.many}`;
    }
  }
  return null;
}

/** Pick the type ramp that fits — hero numerals for short strings, then
 *  progressively smaller word ramps, so a long line (a roast punchline, an
 *  abandoned project's name) never becomes a wall of 9rem type that outgrows
 *  its viewport-height card. `min: 'word'` skips the numeral ramp for text
 *  that is never a number. */
export function heroClass(text: string, min: 'num' | 'word' = 'num'): string {
  const cp = [...text].length;
  if (cp <= 8 && min === 'num') return 'big';
  if (cp <= 28) return 'big bigword';
  if (cp <= 80) return 'big midword';
  return 'big punchline';
}

interface Card {
  id: string;
  cls?: string;
  body: string;
}

function kicker(text: string): string {
  return `<p class="kicker">${esc(text)}</p>`;
}

function foot(text: string): string {
  return `<p class="foot">${esc(text)}</p>`;
}

/** Oversized echo of the card's hero — the decoration layer, never the data. */
function echo(text: string): string {
  return `<div class="echo" aria-hidden="true">${esc(text)}</div>`;
}

function bigNum(n: number, fmt: 'int' | 'tok' | 'usd'): string {
  const rendered = fmt === 'usd' ? fmtUSD(n) : fmt === 'tok' ? fmtTokens(n) : fmtInt(n);
  return `<div class="big"><span class="n" data-n="${n}" data-fmt="${fmt}">${esc(rendered)}</span></div>`;
}

// The outline marks the busiest-HOUR column and busiest-DAY row — the same two
// marginals the caption names — so text and picture never disagree. (An earlier
// version outlined the single hottest cell, which could sit on a different
// hour/day than the caption's independently-computed marginals.)
function heatmap(heat: number[][], peakHour: number, peakWeekday: number): string {
  let max = 0;
  for (let wd = 0; wd < 7; wd++) {
    for (let h = 0; h < 24; h++) {
      if (heat[wd]![h]! > max) max = heat[wd]![h]!;
    }
  }
  if (max === 0) return '';
  let cells = '';
  for (let wd = 0; wd < 7; wd++) {
    cells += `<div class="hm-lbl${wd === peakWeekday ? ' on' : ''}">${DAY_LETTERS[wd]}</div>`;
    for (let h = 0; h < 24; h++) {
      const v = heat[wd]![h]!;
      const pct = v === 0 ? 0 : Math.round(12 + 78 * Math.sqrt(v / max));
      const band = (wd === peakWeekday ? ' pk-row' : '') + (h === peakHour ? ' pk-col' : '');
      const peak = wd === peakWeekday && h === peakHour ? ' peak' : '';
      cells += `<div class="hm-cell${band}${peak}" style="--p:${pct}%" data-tip="${esc(`${WEEKDAYS[wd]} ${hourLabel(h)} — ${fmtInt(v)} ${plural(v, 'reply', 'replies')}`)}"></div>`;
    }
  }
  let hours = '<div></div>';
  for (let h = 0; h < 24; h++) {
    hours += `<div class="hm-hr${h === peakHour ? ' on' : ''}">${h % 6 === 0 ? hourLabel(h).replace(' ', '') : ''}</div>`;
  }
  return `<div class="scrollx"><div class="hm">${cells}${hours}</div></div>`;
}

function streakStrip(daily: { date: string; tokens: number }[], streak: { from: string; to: string } | null): string {
  if (daily.length === 0) return '';
  const byDate = new Map(daily.map((d) => [d.date, d.tokens]));
  const max = Math.max(...daily.map((d) => d.tokens), 1);
  const first = daily[0]!.date;
  const last = daily[daily.length - 1]!.date;
  // Start the strip on the Sunday on/before the first active day.
  const start = new Date(`${first}T00:00:00Z`);
  start.setUTCDate(start.getUTCDate() - start.getUTCDay());
  let cells = '';
  const cur = new Date(start);
  while (cur.toISOString().slice(0, 10) <= last) {
    const ymd = cur.toISOString().slice(0, 10);
    const v = byDate.get(ymd) ?? 0;
    const pct = v === 0 ? 0 : Math.round(15 + 75 * Math.sqrt(v / max));
    const inStreak = streak && ymd >= streak.from && ymd <= streak.to ? ' streak' : '';
    cells += `<div class="cal-cell${inStreak}" style="--p:${pct}%" data-tip="${esc(`${formatDate(ymd)} — ${fmtTokens(v)} tokens`)}"></div>`;
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return `<div class="scrollx"><div class="cal">${cells}</div></div>`;
}

function rankedList(rows: { name: string; value: number; detail: string }[], unit: 'tok' | 'usd' | 'count'): string {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return `<ol class="rank">${rows
    .map((r, i) => {
      const pct = ((r.value / max) * 100).toFixed(1);
      const val = unit === 'usd' ? fmtUSD(r.value) : unit === 'count' ? fmtInt(r.value) : fmtTokens(r.value);
      return `<li style="--i:${rows.length - 1 - i}"><span class="pos">${i + 1}</span><span class="rname">${esc(r.name)}</span><span class="rtrack"><span class="rfill" style="width:${pct}%"></span></span><span class="rval" data-tip="${esc(r.detail)}">${val}</span></li>`;
    })
    .join('')}</ol>`;
}

function funCard(card: FunCard): Card {
  const [lead, ...rest] = card.stats;
  const restRows = rest
    .map(
      (s, i) =>
        `<div class="substat" style="--i:${i + 1}"><span class="sn">${esc(s.big)}</span><span class="sl">${esc(s.label)}${s.sub ? ` <em>· ${esc(s.sub)}</em>` : ''}</span></div>`,
    )
    .join('');
  return {
    id: `fun-${card.id}`,
    body: `${echo(lead!.big.length <= 8 ? lead!.big : '!?')}<div class="panel">${kicker(card.kicker)}<h2>${esc(card.title)}</h2><div class="${heroClass(lead!.big)}"><span class="n">${esc(lead!.big)}</span></div><p class="lede">${esc(lead!.label)}${lead!.sub ? ` <em>· ${esc(lead!.sub)}</em>` : ''}</p>${restRows}${card.footnote ? foot(card.footnote) : ''}</div>`,
  };
}

function extraCard(x: WrappedExtra, i: number): Card {
  return {
    id: `extra-${i}`,
    body: `<div class="panel">${kicker(x.title ?? 'guest appearance')}<div class="${heroClass(x.headline, 'word')}"><span class="n">${esc(x.headline)}</span></div>${x.subline ? `<p class="lede">${esc(x.subline)}</p>` : ''}${x.footnote ? foot(x.footnote) : ''}</div>`,
  };
}

export function renderWrappedHtml(d: WrappedData): string {
  const cards: Card[] = [];
  const empty = d.totals.sessions === 0;

  const horizon =
    d.dataBegins && d.dataBegins > d.period.from
      ? `data begins ${formatDate(d.dataBegins)} — older transcripts have been pruned by your tools`
      : null;

  cards.push({
    id: 'cover',
    cls: 'cover',
    body: `${echo(String(d.year))}<div class="panel center">
<p class="brand">sessions</p>
<h1><span>your</span> <span class="yr">${d.year}</span> <span>wrapped</span></h1>
<p class="lede">${esc(formatDate(d.period.from))} → ${esc(formatDate(d.period.to))}${d.period.to.slice(5) !== '12-31' ? ' · so far' : ''}</p>
${empty ? `<p class="lede">A quiet year — no sessions found. The mystery of you deepens.</p>` : `<p class="hint">scroll<span class="chev">▾</span></p>`}
<p class="foot">generated locally from your own transcripts · nothing leaves your machine${horizon ? ` · ${esc(horizon)}` : ''}</p>
</div>`,
  });

  if (!empty) {
    // Local-model years (Ollama, gpt-oss, etc.) report no billed tokens. Showing
    // a hero "0" / "$0" would read as broken, so the token and cost cards only
    // appear when there's a meter to report — the deck leans on the non-zero
    // signals (sessions, replies, rhythm, models, persona) instead.
    if (d.totals.tokens > 0) {
      const equiv = tokenEquivalence(d.totals.tokens);
      cards.push({
        id: 'tokens',
        body: `${echo(fmtTokens(d.totals.tokens))}<div class="panel center">${kicker('the year in tokens')}<h2>You and your agents had a lot to say.</h2>${bigNum(d.totals.tokens, 'tok')}<p class="lede">tokens exchanged${equiv ? ` — ${esc(equiv)}` : ''}</p>${foot('input + output + cache writes · same math as sessions report')}</div>`,
      });
    }

    if (d.totals.costUSD > 0) {
      const cachePct = d.cacheHitRate !== null ? Math.round(d.cacheHitRate * 100) : null;
      const costEq = costEquivalence(d.totals.costUSD);
      cards.push({
        id: 'cost',
        body: `${echo(fmtUSD(d.totals.costUSD))}<div class="panel center">${kicker('the receipt')}<h2>All of that, à la carte?</h2>${bigNum(d.totals.costUSD, 'usd')}<p class="lede">what this year would have cost at API list prices${costEq ? ` — ${esc(costEq)}` : ''}</p>${
          cachePct !== null
            ? `<div class="substat" style="--i:1"><span class="sn">${cachePct}%</span><span class="sl">cache hit rate — ${fmtTokens(d.totals.cacheReadTokens)} tokens re-read from cache instead of full price</span></div>`
            : ''
        }${
          d.warnings.length > 0
            ? foot(
                `${d.warnings.length} model(s) had no pricing — the real number is higher: ${d.warnings.map((w) => w.model).join(', ')}`,
              )
            : foot('estimated from LiteLLM list prices · cache reads billed at cache rates')
        }</div>`,
      });
    } else if (d.totals.tokens > 0 && d.warnings.length > 0) {
      // Metered tokens but every model was unpriced → cost is 0 not because it
      // was free but because we couldn't price it. Surface that instead of
      // silently dropping the warning with the (hidden) $0 receipt card.
      cards.push({
        id: 'cost',
        body: `<div class="panel center">${kicker('the receipt')}<h2>No price tag this year.</h2><p class="lede">cost couldn’t be estimated — ${d.warnings.length} model(s) had no list price</p>${foot(`unpriced: ${d.warnings.map((w) => w.model).join(', ')}`)}</div>`,
      });
    }

    const streak = d.totals.longestStreak;
    cards.push({
      id: 'showedup',
      body: `${echo(fmtInt(d.totals.sessions))}<div class="panel">${kicker('attendance')}<h2>You showed up.</h2>
<div class="statrow">
<div class="stat" style="--i:0"><span class="n" data-n="${d.totals.sessions}" data-fmt="int">${fmtInt(d.totals.sessions)}</span><span class="l">conversations</span></div>
<div class="stat" style="--i:1"><span class="n" data-n="${d.totals.messages}" data-fmt="int">${fmtInt(d.totals.messages)}</span><span class="l">replies</span></div>
<div class="stat" style="--i:2"><span class="n" data-n="${d.totals.activeDays}" data-fmt="int">${fmtInt(d.totals.activeDays)}</span><span class="l">active days</span></div>
</div>
${streakStrip(d.daily, streak ? { from: streak.from, to: streak.to } : null)}
${streak ? `<p class="lede">longest streak: <b>${streak.days} ${plural(streak.days, 'day')}</b> <em>(${esc(shortDate(streak.from))} – ${esc(shortDate(streak.to))})</em></p>` : ''}
</div>`,
    });

    cards.push({
      id: 'rhythm',
      body: `<div class="panel">${kicker('your rhythm')}<h2>You have a witching hour.</h2>
${heatmap(d.rhythm.heat, d.rhythm.peakHour, d.rhythm.peakWeekday)}
<p class="lede">busiest hour: <b>${esc(hourLabel(d.rhythm.peakHour))}</b> · busiest day: <b>${esc(WEEKDAYS[d.rhythm.peakWeekday]!)}s</b>${
        d.rhythm.nightsPastMidnight > 0
          ? ` <em>· past midnight on ${fmtInt(d.rhythm.nightsPastMidnight)} ${plural(d.rhythm.nightsPastMidnight, 'night')}</em>`
          : ''
      }</p>${foot(`local time (${d.tz}) · busiest hour and day are counted separately`)}</div>`,
    });

    if (d.projects.length > 0) {
      const topShare = Math.round((d.projects[0]?.share ?? 0) * 100);
      const byTokens = d.totals.tokens > 0;
      cards.push({
        id: 'projects',
        body: `<div class="panel">${kicker('the obsessions')}<h2>Where the year actually went.</h2>${rankedList(
          d.projects.map((p) => ({
            name: p.name,
            value: byTokens ? p.tokens : p.sessions,
            detail: byTokens
              ? `${fmtInt(p.sessions)} ${plural(p.sessions, 'session')} · ${fmtUSD(p.costUSD)}`
              : `${fmtInt(p.sessions)} ${plural(p.sessions, 'session')}`,
          })),
          byTokens ? 'tok' : 'count',
        )}${topShare >= 25 ? `<p class="lede"><b>${esc(d.projects[0]!.name)}</b> alone ate <b>${topShare}%</b> of everything.</p>` : ''}</div>`,
      });
    }

    if (d.models.length > 0) {
      // The adoption story features the newest model that actually took over —
      // "the week X arrived" beats restating the year-long #1.
      const adopters = d.models.filter((m) => m.firstTopDay && m.share >= 0.1);
      const newest = adopters.sort((a, b) => (a.firstSeen < b.firstSeen ? 1 : -1))[0];
      const takeover =
        newest && newest.firstTopDay === newest.firstSeen
          ? 'your daily #1 the day it landed'
          : newest
            ? `your daily #1 by <b>${esc(shortDate(newest.firstTopDay!))}</b>`
            : '';
      const story = newest
        ? `<p class="lede"><b>${esc(prettyModel(newest.label))}</b> arrived <b>${esc(shortDate(newest.firstSeen))}</b> — ${takeover}. ${newest.id === d.models[0]!.id ? 'It never looked back.' : 'The old guard held on.'}</p>`
        : '';
      // A tool you actually used must never read "0%": floor sub-1% shares to "<1%".
      const sharePct = (share: number): string => {
        const p = Math.round(share * 100);
        return share > 0 && p < 1 ? '<1%' : `${p}%`;
      };
      const toolStrip =
        d.tools.length > 1
          ? `<div class="pills">${d.tools.map((t) => `<span class="pill">${esc(t.label)} ${sharePct(t.share)}</span>`).join('')}</div>`
          : '';
      cards.push({
        id: 'models',
        body: `<div class="panel">${kicker('the cast')}<h2>Every voice in the room.</h2>${rankedList(
          d.models.slice(0, 5).map((m) => ({
            name: prettyModel(m.label),
            value: m.messages,
            detail: `${fmtTokens(m.tokens)} tokens · first seen ${shortDate(m.firstSeen)}`,
          })),
          'count',
        )}${story}${toolStrip}${foot(
          `ranked by replies · bars show reply volume${
            d.modelsTried > d.models.length
              ? ` · ${fmtInt(d.modelsTried)} models auditioned, ${d.models.length} made the cut`
              : ''
          }`,
        )}</div>`,
      });
    }

    if (d.biggestDay) {
      // Show tokens normally; on local-model years (no token meter) show messages
      // so the card is a real day, not a giant "0".
      const bd = d.biggestDay;
      const byTokens = bd.tokens > 0;
      const value = byTokens ? bd.tokens : bd.messages;
      const median = byTokens ? bd.medianTokens : bd.medianMessages;
      const noun = byTokens ? 'tokens' : 'messages';
      const ratio = median > 0 ? value / median : 0;
      cards.push({
        id: 'bigday',
        body: `${echo(shortDate(bd.date))}<div class="panel center">${kicker('the bender')}<h2>Then there was ${esc(formatDate(bd.date))}.</h2>${bigNum(value, byTokens ? 'tok' : 'int')}<p class="lede">${noun} in a single day${
          ratio >= 2 ? ` — <b>${ratio >= 10 ? Math.round(ratio) : ratio.toFixed(1)}×</b> your median day` : ''
        }</p></div>`,
      });
    }

    if (d.longestGap && d.longestGap.days >= 7) {
      cards.push({
        id: 'vanish',
        body: `${echo(`${d.longestGap.days}d`)}<div class="panel center">${kicker('the disappearance')}<h2>And then one day — nothing.</h2>${bigNum(d.longestGap.days, 'int')}<p class="lede">days of total silence, <b>${esc(shortDate(d.longestGap.from))}</b> → <b>${esc(shortDate(d.longestGap.to))}</b> — the agents waited</p>${foot('your longest gap between active days · touching grass, presumably')}</div>`,
      });
    }

    // A sitting under an hour isn't a superlative — drop the line, keep the card.
    const soy = d.sessionOfYear;
    const ls = d.longestSession && d.longestSession.durationMs >= 3_600_000 ? d.longestSession : null;
    if (soy || ls) {
      cards.push({
        id: 'magnum',
        body: `<div class="panel">${kicker('your magnum opus')}${
          soy
            ? `<h2>“${esc(soy.title)}”</h2><p class="lede">${esc(formatDate(soy.date))} · <b>${esc(soy.project)}</b> · ${fmtInt(soy.messageCount)} ${plural(soy.messageCount, 'message')} · ${fmtInt(soy.filesTouched)} ${plural(soy.filesTouched, 'file')}${soy.shipped ? ' · <span class="badge">shipped</span>' : ''}</p>`
            : ''
        }${
          ls
            ? `<div class="substat" style="--i:1"><span class="sn">${esc(fmtDuration(ls.durationMs))}</span><span class="sl">your longest sitting — ${fmtInt(ls.replies)} ${plural(ls.replies, 'reply', 'replies')}, ${esc(formatDate(ls.date))}, ${esc(ls.project)}</span></div>`
            : ''
        }${soy ? foot('ranked by substance: message volume, files edited, and whether something shipped') : ''}</div>`,
      });
    }

    // The loop — the longest stretch the machine ran with nobody home. The
    // sitting above measures endurance WITH you in the chair; this one measures
    // trust. Under ten minutes isn't a story (the JSON still carries it).
    if (d.loops && d.loops.longest.durationMs >= 10 * 60_000) {
      const lp = d.loops;
      const L = lp.longest;
      const dur = fmtDuration(L.durationMs);
      const ratio = lp.medianMs >= 1000 ? L.durationMs / lp.medianMs : null;
      cards.push({
        id: 'loop',
        body: `${echo(dur)}<div class="panel center">${kicker('the loop')}<h2>You hit enter. And walked away.</h2><div class="${heroClass(dur, 'word')}"><span class="n">${esc(dur)}</span></div><p class="lede">of unsupervised machine — <b>${fmtInt(L.steps)}</b> model ${plural(L.steps, 'call')} back to back${
          L.tokens > 0 ? `, <b>${fmtTokens(L.tokens)}</b> tokens` : ''
        }, zero human input · from <b>${esc(L.startClock)}</b>, ${esc(formatDate(L.date))}, on <b>${esc(L.project)}</b></p>${
          L.prompt ? `<p class="lede">last known human words: <em>“${esc(L.prompt)}”</em></p>` : ''
        }${
          ratio !== null && ratio >= 3
            ? `<div class="substat" style="--i:1"><span class="sn">${esc(fmtDurationShort(lp.medianMs))}</span><span class="sl">your median loop — this one went ${fmtInt(Math.round(ratio))}× longer, and nobody stopped it</span></div>`
            : ''
        }${foot(`a loop = back-to-back model calls ≤ 30 min apart with no human turn in between · you set ${fmtInt(lp.count)} of them loose this year · Claude Code sessions only`)}</div>`,
      });
    }

    for (const card of d.fun) cards.push(funCard(card));

    if (d.wordOfYear) {
      const w = d.wordOfYear;
      cards.push({
        id: 'word',
        body: `${echo(w.word)}<div class="panel center">${kicker('your word of the year')}<div class="big bigword"><span class="n">${esc(w.word)}</span></div><p class="lede">in <b>${fmtInt(w.count)}</b> of your ${plural(w.count, 'message')} across <b>${fmtInt(w.sessions)}</b> ${plural(w.sessions, 'session')}</p>${
          w.runnersUp.length > 0 ? `<p class="lede"><em>also in rotation: ${esc(w.runnersUp.join(', '))}</em></p>` : ''
        }${foot('mined from your own prompts · common words excluded')}</div>`,
      });
    }

    for (const [i, x] of d.extras.entries()) cards.push(extraCard(x, i));

    if (d.persona) {
      const pa = d.persona;
      cards.push({
        id: 'persona',
        cls: 'persona',
        body: `<div class="panel center">${kicker(`the reveal — this year you were`)}
<div class="big bigword"><span class="n">${esc(pa.name)}</span></div>
<p class="lede tagline">${esc(pa.tagline)}</p>
<div class="axes">${pa.axes
          .map(
            (a, i) =>
              `<div class="axis" style="--i:${i}"><span class="al">${esc(a.label)}</span><span class="av">${esc(a.value)}</span><span class="ax">${esc(a.lean)}</span></div>`,
          )
          .join('')}</div>
${pa.flavor ? `<p class="lede"><em>${esc(pa.flavor)}</em></p>` : ''}
${foot('a description of how you worked this year, not who you are · this card wants to be a screenshot')}</div>`,
      });
    }
  }

  // Extras render even on an empty year — an agent-authored roast of a quiet
  // year is still a slide, and --stdout already includes them unconditionally.
  if (empty) for (const [i, x] of d.extras.entries()) cards.push(extraCard(x, i));

  const creditRows: [string, string][] = [];
  if (d.models[0]) creditRows.push(['starring', prettyModel(d.models[0].label)]);
  if (d.models[1]) creditRows.push(['the understudy', prettyModel(d.models[1].label)]);
  if (d.content?.topCommands[0]) {
    const tc = d.content.topCommands[0];
    creditRows.push(['featuring', `${tc.name} (${fmtInt(tc.sessions)} ${plural(tc.sessions, 'session')})`]);
  }
  if (d.projects[0]) creditRows.push(['on location', d.projects[0].name]);
  if (d.content?.topFiles[0]) creditRows.push(['set dressing', d.content.topFiles[0].name]);
  // Busiest month, straight from the daily series — the shooting schedule.
  const byMonth = new Map<string, number>();
  for (const day of d.daily) {
    const mo = day.date.slice(0, 7);
    byMonth.set(mo, (byMonth.get(mo) ?? 0) + day.tokens);
  }
  let peakMonth: { mo: string; tokens: number } | null = null;
  for (const [mo, tokens] of byMonth) {
    if (tokens > (peakMonth?.tokens ?? 0)) peakMonth = { mo, tokens };
  }
  if (peakMonth) {
    creditRows.push([
      'principal photography',
      `${MONTHS[Number(peakMonth.mo.slice(5)) - 1]} ${peakMonth.mo.slice(0, 4)} — ${fmtTokens(peakMonth.tokens)} tokens`,
    ]);
  }
  if (d.content?.errors && d.content.errors.totalErrors > 0) {
    const n = d.content.errors.totalErrors;
    creditRows.push(['stunts', `${fmtInt(n)} ${plural(n, 'error')}, all survived`]);
  }
  if (d.content?.abandoned) {
    creditRows.push([
      'in memoriam',
      `${d.content.abandoned.name} — last seen ${shortDate(d.content.abandoned.lastSeen)}`,
    ]);
  }
  creditRows.push(['directed by', 'you']);
  cards.push({
    id: 'credits',
    cls: 'credits',
    body: `<div class="panel center">${kicker('roll credits')}<dl class="creditlist">${creditRows
      .map(([k, v], i) => `<div style="--i:${i}"><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`)
      .join(
        '',
      )}</dl><p class="foot">sessions wrapped ${d.year} · generated ${esc(d.generatedAt.slice(0, 10))} · locally, with no telemetry</p></div>`,
  });

  const sections = cards
    .map((c, i) => {
      const accent = ACCENTS[i % ACCENTS.length]!;
      return `<section class="card ${c.cls ?? ''}" id="${c.id}" style="--a:${accent.c}">${c.body}</section>`;
    })
    .join('\n');

  const dots = cards
    .map((c) => `<button type="button" data-for="${c.id}" aria-label="${esc(c.id)}"></button>`)
    .join('');

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>sessions wrapped ${d.year}</title>
<style>${CSS}</style></head>
<body>
<main>
${sections}
</main>
<nav class="dots" aria-label="slides">${dots}</nav>
<div class="tip" id="tip"></div>
<script>${JS}</script>
</body></html>`;
}

const CSS = `
:root{--bg:oklch(13% 0.01 280);--panel:oklch(17% 0.012 280);--ink:oklch(97% 0 0);--muted:oklch(72% 0 0);--faint:oklch(45% 0 0);--track:oklch(24% 0.01 280);--mono:ui-monospace,SFMono-Regular,Menlo,monospace;--sans:-apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Roboto,sans-serif;}
*{box-sizing:border-box}
html{background:var(--bg);scroll-snap-type:y mandatory;}
body{margin:0;background:var(--bg);color:var(--ink);font-family:var(--sans);font-size:16px;line-height:1.5;}
main{width:100%;}
.card{position:relative;min-height:100svh;display:flex;align-items:center;justify-content:center;scroll-snap-align:start;overflow:hidden;padding:48px 24px;background:radial-gradient(120% 90% at 50% 110%,color-mix(in oklch,var(--a) 14%,transparent),transparent 60%),var(--bg);}
.panel{position:relative;z-index:1;max-width:680px;width:100%;}
.panel.center{text-align:center;}
.echo{position:absolute;inset:auto -4% -6% auto;z-index:0;font-weight:900;font-size:clamp(8rem,34vw,26rem);line-height:.8;letter-spacing:-.04em;color:transparent;-webkit-text-stroke:1.5px color-mix(in oklch,var(--a) 38%,transparent);transform:rotate(-6deg);user-select:none;pointer-events:none;white-space:nowrap;}
.kicker{font-family:var(--mono);font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.14em;color:var(--a);margin:0 0 14px;}
h1{font-size:clamp(3rem,9vw,5.6rem);font-weight:900;line-height:.95;letter-spacing:-.03em;text-transform:uppercase;margin:12px 0;}
h1 .yr{color:var(--a);text-shadow:0 0 70px color-mix(in oklch,var(--a) 45%,transparent);}
h1 span{display:block;}
h2{font-size:clamp(1.5rem,4vw,2.2rem);font-weight:800;letter-spacing:-.01em;line-height:1.15;margin:0 0 18px;text-wrap:balance;}
.big{margin:10px 0 14px;}
.big .n{font-size:clamp(4rem,14vw,9.5rem);font-weight:900;letter-spacing:-.04em;line-height:1;color:var(--a);text-shadow:0 0 70px color-mix(in oklch,var(--a) 40%,transparent);}
.big.bigword .n{font-size:clamp(2.4rem,9vw,5.5rem);letter-spacing:-.02em;text-wrap:balance;overflow-wrap:break-word;}
.big.midword .n{font-size:clamp(1.8rem,6vw,3.4rem);letter-spacing:-.015em;line-height:1.15;text-wrap:balance;overflow-wrap:break-word;}
.big.punchline .n{font-size:clamp(1.35rem,4.5vw,2.1rem);font-weight:800;letter-spacing:-.01em;line-height:1.3;text-wrap:balance;overflow-wrap:break-word;}
.lede{font-size:clamp(1.05rem,2.2vw,1.3rem);color:var(--ink);margin:10px 0 0;text-wrap:balance;}
.lede em,.sl em{color:var(--muted);font-style:normal;}
.lede b{color:var(--a);font-weight:800;}
.foot{font-family:var(--mono);font-size:11px;color:var(--faint);margin:26px 0 0;line-height:1.6;}
.brand{font-family:var(--mono);font-weight:700;font-size:14px;color:var(--a);margin:0;}
.hint{font-family:var(--mono);font-size:12px;color:var(--muted);margin-top:34px;}
.chev{display:inline-block;margin-left:6px;animation:bob 1.6s ease-in-out infinite;}
@keyframes bob{0%,100%{transform:translateY(0)}50%{transform:translateY(5px)}}
.statrow{display:flex;gap:36px;flex-wrap:wrap;margin:18px 0 22px;}
.stat{display:flex;flex-direction:column;}
.stat .n{font-size:clamp(2.2rem,6vw,3.6rem);font-weight:900;letter-spacing:-.03em;line-height:1.05;color:var(--a);}
.stat .l{font-family:var(--mono);font-size:11.5px;color:var(--muted);margin-top:4px;}
.substat{display:flex;align-items:baseline;gap:14px;margin:20px 0 0;text-align:left;}
.panel.center .substat{justify-content:center;}
.substat .sn{font-size:clamp(1.5rem,4vw,2.3rem);font-weight:900;letter-spacing:-.02em;color:var(--a);white-space:nowrap;}
.substat .sl{font-size:.98rem;color:var(--ink);max-width:44ch;}
.badge{display:inline-block;font-family:var(--mono);font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:var(--bg);background:var(--a);border-radius:3px;padding:2px 7px;vertical-align:2px;}
.pills{display:flex;gap:8px;flex-wrap:wrap;margin-top:18px;}
.pill{font-family:var(--mono);font-size:11.5px;font-weight:600;color:var(--ink);border:1px solid var(--track);border-radius:999px;padding:4px 11px;}
.rank{list-style:none;margin:6px 0 14px;padding:0;display:flex;flex-direction:column;gap:12px;}
.rank li{display:grid;grid-template-columns:1.6em minmax(7em,14em) 1fr auto;gap:12px;align-items:center;}
.rank .pos{font-weight:900;font-size:1.15rem;color:var(--a);text-align:right;}
.rank .rname{font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.rank .rtrack{height:12px;background:var(--track);border-radius:0 3px 3px 0;overflow:hidden;}
.rank .rfill{display:block;height:100%;background:var(--a);border-radius:0 3px 3px 0;transform-origin:left;}
.rank .rval{font-family:var(--mono);font-size:12px;color:var(--muted);}
.scrollx{overflow-x:auto;margin:8px 0 14px;padding-bottom:4px;}
.hm{display:grid;grid-template-columns:1.2em repeat(24,minmax(14px,1fr));gap:3px;min-width:520px;}
.hm-lbl,.hm-hr{font-family:var(--mono);font-size:9.5px;color:var(--faint);display:flex;align-items:center;}
.hm-hr{justify-content:flex-start;}
.hm-cell{aspect-ratio:1;border-radius:2px;background:color-mix(in oklch,var(--a) var(--p),oklch(20% 0.01 280));}
.hm-cell.pk-row,.hm-cell.pk-col{box-shadow:inset 0 0 0 1px color-mix(in oklch,var(--ink) 30%,transparent);}
.hm-cell.peak{outline:2px solid var(--ink);outline-offset:-1px;}
.hm-lbl.on,.hm-hr.on{color:var(--a);font-weight:700;}
.cal{display:grid;grid-auto-flow:column;grid-template-rows:repeat(7,10px);gap:3px;width:max-content;}
.cal-cell{width:10px;height:10px;border-radius:2px;background:color-mix(in oklch,var(--a) var(--p),oklch(20% 0.01 280));}
.cal-cell.streak{outline:1.5px solid var(--ink);outline-offset:-1px;}
.axes{display:flex;flex-direction:column;gap:10px;margin:26px auto 0;max-width:430px;}
.axis{display:grid;grid-template-columns:5.5em 1fr auto;gap:12px;align-items:baseline;border-top:1px solid var(--track);padding-top:10px;text-align:left;}
.axis .al{font-family:var(--mono);font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);}
.axis .av{font-weight:700;}
.axis .ax{font-family:var(--mono);font-size:11.5px;font-weight:700;color:var(--a);}
.tagline{margin-top:2px;}
.card.persona{background:radial-gradient(130% 100% at 20% 0%,color-mix(in oklch,var(--a) 22%,transparent),transparent 55%),radial-gradient(130% 100% at 90% 100%,color-mix(in oklch,oklch(70% 0.24 350) 18%,transparent),transparent 55%),var(--bg);}
.creditlist{margin:10px 0 0;padding:0;display:flex;flex-direction:column;gap:14px;}
.creditlist div{display:flex;flex-direction:column;gap:2px;}
.creditlist dt{font-family:var(--mono);font-size:11px;text-transform:uppercase;letter-spacing:.14em;color:var(--muted);}
.creditlist dd{margin:0;font-size:clamp(1.2rem,3vw,1.7rem);font-weight:800;letter-spacing:-.01em;}
.dots{position:fixed;right:14px;top:50%;transform:translateY(-50%);display:flex;flex-direction:column;gap:8px;z-index:5;}
.dots button{width:8px;height:8px;border-radius:50%;border:0;padding:0;background:var(--track);cursor:pointer;transition:background .2s,transform .2s;}
.dots button.on{background:var(--ink);transform:scale(1.3);}
.tip{position:fixed;pointer-events:none;background:var(--ink);color:var(--bg);font-family:var(--mono);font-size:11px;padding:4px 7px;border-radius:4px;opacity:0;transform:translate(-50%,-130%);white-space:nowrap;z-index:10;}
.card .panel>*,.card .echo{opacity:0;transform:translateY(18px);transition:opacity .7s ease-out,transform .7s ease-out;}
.card .echo{transform:rotate(-6deg) translateY(24px);transition-duration:1.1s;}
.card.live .panel>*,.card.live .echo{opacity:1;transform:translateY(0);}
.card.live .echo{transform:rotate(-6deg);}
.card.live .panel>*:nth-child(2){transition-delay:.08s}
.card.live .panel>*:nth-child(3){transition-delay:.16s}
.card.live .panel>*:nth-child(4){transition-delay:.26s}
.card.live .panel>*:nth-child(5){transition-delay:.36s}
.card.live .panel>*:nth-child(6){transition-delay:.46s}
.card.live .panel>*:nth-child(n+7){transition-delay:.56s}
.card.live .rank li,.card.live .substat,.card.live .axis,.card.live .creditlist div{opacity:0;transform:translateY(14px);animation:rise .6s ease-out forwards;animation-delay:calc(.3s + var(--i,0)*.18s);}
@keyframes rise{to{opacity:1;transform:translateY(0)}}
@media (max-width:640px){.dots{display:none;}.rank li{grid-template-columns:1.4em 1fr auto;}.rank .rtrack{display:none;}}
@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important;}.card .panel>*,.card .echo,.card.live .rank li,.card.live .substat,.card.live .axis,.card.live .creditlist div{opacity:1!important;transform:none!important;}}
`;

// Count-up + card reveal + tooltip + dots. textContent only — never innerHTML.
const JS = `(function(){
var reduce=window.matchMedia&&window.matchMedia('(prefers-reduced-motion: reduce)').matches;
function fmt(n,kind){if(kind==='usd')return '$'+Math.round(n).toLocaleString('en-US');if(kind==='tok'){if(n>=1e9)return (n/1e9).toFixed(2)+'B';if(n>=1e6)return (n/1e6).toFixed(1)+'M';if(n>=1e3)return (n/1e3).toFixed(1)+'K';return String(Math.round(n));}return Math.round(n).toLocaleString('en-US');}
function countUp(el){var n=Number(el.getAttribute('data-n'));var kind=el.getAttribute('data-fmt');if(!isFinite(n)||!kind)return;if(reduce){el.textContent=fmt(n,kind);return;}var t0=null;function step(t){if(t0===null)t0=t;var p=Math.min(1,(t-t0)/1200);var e=1-Math.pow(1-p,3);el.textContent=fmt(n*e,kind);if(p<1)requestAnimationFrame(step);}requestAnimationFrame(step);}
var seen=new WeakSet();
var obs=new IntersectionObserver(function(entries){entries.forEach(function(en){if(!en.isIntersecting)return;var card=en.target;card.classList.add('live');dotFor(card.id);if(!seen.has(card)){seen.add(card);card.querySelectorAll('[data-n]').forEach(countUp);}});},{threshold:0.45});
document.querySelectorAll('.card').forEach(function(c){obs.observe(c);});
var dots=document.querySelectorAll('.dots button');
function dotFor(id){dots.forEach(function(b){b.classList.toggle('on',b.getAttribute('data-for')===id);});}
dots.forEach(function(b){b.addEventListener('click',function(){var el=document.getElementById(b.getAttribute('data-for'));if(el)el.scrollIntoView({behavior:reduce?'auto':'smooth'});});});
var tip=document.getElementById('tip');
document.addEventListener('mousemove',function(e){var el=e.target&&e.target.closest?e.target.closest('[data-tip]'):null;if(!el){tip.style.opacity='0';return;}tip.textContent=el.getAttribute('data-tip');tip.style.opacity='1';tip.style.left=e.clientX+'px';tip.style.top=e.clientY+'px';});
console.log('sessions wrapped \\u2014 generated locally from your own session logs. No telemetry.');
})();`;
