/**
 * Pure view-models of the hub's Home and Inbox tabs: the user's division table, league headlines derived from
 * the League itself (so they survive a reload: the latest week's results with the user's game first, records
 * set this season once the record book holds a completed season, the user's injured players) and the inbox
 * rows of the user team's franchise events (newest first, unread marked, status open / auto-resolved / the
 * chosen answer).
 */
import type { TeamId } from '@/core/ids';
import { PEAK_RECORD_BASES } from '@/franchise/history';
import { newsHeadlines } from '@/franchise/news';
import { divisionKey } from '@/franchise/schedule';
import { divisionStandings, tiebreakContext } from '@/franchise/standings';
import type { FranchiseEvent, League, ScheduledGame } from '@/franchise/types';
import { shortName } from '@/players/types';
import { formatInjury, formatRecord, type Tone } from '../kit/format';
import type { RecapLine } from './recap-model';

/** One division table row. */
export interface DivisionRow {
  rank: number;
  teamId: TeamId;
  abbr: string;
  record: string;
  pointsFor: number;
  pointsAgainst: number;
  user: boolean;
}

/** The user's division, best first. */
export const divisionRows = (league: League, teamId: TeamId): DivisionRow[] => {
  const team = league.teams[teamId];
  if (!team) return [];
  const ids = divisionStandings(tiebreakContext(league))[divisionKey(team)] ?? [];
  return ids.map((id, i) => {
    const st = league.season.standings[id];
    return {
      rank: i + 1, teamId: id, abbr: league.teams[id]?.abbr ?? '?', record: st ? formatRecord(st) : '0-0',
      pointsFor: st?.pointsFor ?? 0, pointsAgainst: st?.pointsAgainst ?? 0, user: id === teamId,
    };
  });
};

/** Sort key of a game in calendar order (preseason, regular season, playoffs). */
const calendarKey = (g: ScheduledGame): number => (g.isPreseason ? 0 : g.isPlayoff ? 200 : 100) + (g.isPlayoff ? (g.playoffRound ?? g.week) : g.week);

/** The most recently completed week's games of the current season. */
export const latestResults = (league: League): ScheduledGame[] => {
  const done = league.season.schedule.filter((g) => g.result !== null);
  if (done.length === 0) return [];
  const last = Math.max(...done.map(calendarKey));
  return done.filter((g) => calendarKey(g) === last);
};

/** Headlines for the Home tab (at most `max`). */
export const homeHeadlines = (league: League, teamId: TeamId, max = 10): RecapLine[] => {
  const out: RecapLine[] = [];
  const abbr = (id: TeamId): string => league.teams[id]?.abbr ?? '?';
  const games = latestResults(league);
  const mine = games.find((g) => g.home === teamId || g.away === teamId);
  if (mine?.result) {
    const home = mine.home === teamId;
    const us = home ? mine.result.homeScore : mine.result.awayScore;
    const them = home ? mine.result.awayScore : mine.result.homeScore;
    const opp = home ? mine.away : mine.home;
    const verb = us > them ? 'beat' : us < them ? 'lost to' : 'tied';
    out.push({ id: `mine:${mine.id}`, text: `You ${verb} ${abbr(opp)} ${us}-${them}${mine.result.overtime ? ' in OT' : ''}`, tone: us > them ? 'success' : us < them ? 'danger' : 'normal', teamId: opp });
  }
  const others = games.filter((g) => g !== mine && g.result).sort((a, b) => {
    const m = (g: ScheduledGame): number => Math.abs((g.result?.homeScore ?? 0) - (g.result?.awayScore ?? 0)) + (g.result?.overtime ? 50 : 0);
    return m(b) - m(a);
  });
  for (const g of others.slice(0, 4)) {
    const r = g.result;
    if (!r) continue;
    const homeWon = r.homeScore >= r.awayScore;
    const [w, l, ws, ls] = homeWon ? [g.home, g.away, r.homeScore, r.awayScore] : [g.away, g.home, r.awayScore, r.homeScore];
    out.push({ id: `res:${g.id}`, text: `${abbr(w)} ${ws}, ${abbr(l)} ${ls}${r.overtime ? ' (OT)' : ''}`, tone: 'normal', teamId: w });
  }
  for (const h of newsHeadlines(league, teamId, 3)) {
    out.push({ id: `news:${h.id}`, text: h.text, tone: h.tone, ...(h.playerId ? { playerId: h.playerId } : {}), ...(h.teamId ? { teamId: h.teamId } : {}) });
  }
  // Records set this season, once the book holds a completed season (a first season's marks are only running
  // bests) and not career marks (those move every week for their holder; passing one is news in the recap), nor the
  // season copy of a single-play mark (the game record is the same feat).
  const established = league.history.some((h) => h.year < league.year);
  const shown = (r: League['records'][number]): boolean =>
    r.year === league.year && r.scope !== 'career' && !(r.scope === 'season' && PEAK_RECORD_BASES.has(r.key.split('.')[0] ?? ''));
  const records = established ? league.records.filter(shown).slice(-2) : [];
  records.forEach((r, i) => out.push({ id: `rec:${i}:${r.key}`, text: `Record: ${r.label} - ${r.holderName} (${r.value})`, tone: 'accent', ...(r.holderPlayerId ? { playerId: r.holderPlayerId } : {}) }));
  const team = league.teams[teamId];
  const hurt = (team?.rosterIds ?? []).map((id) => league.players[id]).filter((p) => p?.injury && p.injury.weeksRemaining > 0);
  hurt.sort((a, b) => (b?.overall ?? 0) - (a?.overall ?? 0));
  for (const p of hurt.slice(0, 3)) {
    if (!p) continue;
    const inj = formatInjury(p.injury);
    out.push({ id: `inj:${p.id}`, text: `Injury: ${p.position} ${shortName(p)} - ${inj.text}`, tone: inj.tone ?? 'warning', playerId: p.id });
  }
  return out.slice(0, max);
};

/** One inbox row. */
export interface InboxRow {
  id: string;
  unread: boolean;
  date: string;
  sortKey: number;
  title: string;
  status: string;
  statusTone: Tone;
  event: FranchiseEvent;
}

/** Status text of an event: "Open", the chosen answer, or "Auto: <answer>". */
export const eventStatus = (e: FranchiseEvent): { text: string; tone: Tone } => {
  if (e.resolvedChoice === null) return { text: e.choices.length > 0 ? 'Open' : 'Info', tone: e.choices.length > 0 ? 'warning' : 'dim' };
  const label = e.choices.find((c) => c.id === e.resolvedChoice)?.label ?? e.resolvedChoice;
  return { text: e.data?.autoResolved ? `Auto: ${label}` : label, tone: 'dim' };
};

/**
 * The user team's events, newest first. League.events is append-only in calendar order, so the list position is
 * the sort key (year * 1000 + week would put offseason events, week 0, below the season that preceded them and
 * mix preseason with regular-season weeks of the same number).
 */
export const inboxRows = (league: League, teamId: TeamId): InboxRow[] => {
  const rows: InboxRow[] = [];
  league.events.forEach((e, i) => {
    if (e.teamId !== teamId) return;
    const st = eventStatus(e);
    rows.push({
      id: e.id, unread: !e.read, date: e.week > 0 ? `${e.year} Wk ${e.week}` : `${e.year}`, sortKey: i,
      title: e.title, status: st.text, statusTone: st.tone, event: e,
    });
  });
  return rows.sort((a, b) => b.sortKey - a.sortKey);
};

/** Unread user-team events. */
export const unreadCount = (league: League, teamId: TeamId): number => league.events.filter((e) => e.teamId === teamId && !e.read).length;

/** Unresolved user-team events that still need an answer. */
export const openDecisions = (league: League, teamId: TeamId): number =>
  league.events.filter((e) => e.teamId === teamId && e.resolvedChoice === null && e.choices.length > 0).length;
