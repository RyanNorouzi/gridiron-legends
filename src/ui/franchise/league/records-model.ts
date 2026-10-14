/**
 * Pure view-models of the Records & History tab: the league record book by scope (every tracked record, held or
 * not), a franchise record book computed from career stats and team history, the season history (champion,
 * runner-up, MVP, the user's finish), awards by year and All-Pro teams by year (the current season's projected
 * team while it is being played).
 */
import type { CoachId, PlayerId, TeamId } from '@/core/ids';
import { AWARD_LABELS, AWARD_ORDER } from '@/franchise/awards';
import { allProTeam } from '@/franchise/hall-of-fame';
import { runnerUp } from '@/franchise/playoffs';
import { LEAGUE_RECORD_DEFINITIONS, recordBook } from '@/franchise/records';
import type { AwardResult, League, RecordScope, SeasonSummary } from '@/franchise/types';
import { isGamePhase } from '@/franchise/week';
import { POSITIONS } from '@/players/types';
import { addLines } from '@/statistics/aggregate';
import { recordValue } from '@/statistics/records';
import type { PlayerStatLine } from '@/statistics/types';
import { formatRecord, type Tone } from '../kit/format';
import { findPlayer, heading, pctText, playerName, teamAbbr, teamName, type HeadingRow } from './common';

/** Scopes of the league record book. */
export const RECORD_SCOPES: readonly RecordScope[] = ['game', 'season', 'career', 'team'];
/** Pager labels of the record-book scopes. */
export const RECORD_SCOPE_LABELS: Readonly<Record<RecordScope, string>> = Object.freeze({ game: 'Single game', season: 'Single season', career: 'Career', team: 'Team' });

/** One record-book line. */
export interface RecordRow {
  kind: 'record';
  id: string;
  label: string;
  value: string;
  holder: string;
  team: string;
  year: string;
  playerId: PlayerId | null;
  teamId: TeamId | null;
  held: boolean;
  user: boolean;
}

/** A record-book row (section heading or record). */
export type RecordLine = HeadingRow | RecordRow;

const valueText = (v: number): string => (Number.isInteger(v) ? String(v) : v.toFixed(1));
const plainLabel = (label: string): string => label.replace(/ \((Game|Season|Career)\)$/, '');

/** Every tracked record of a scope, with its holder (or "No record yet"). */
export const leagueRecordRows = (league: League, scope: RecordScope, userTeamId: TeamId | null): RecordRow[] => {
  const held = new Map(recordBook(league, scope).map((r) => [r.key, r]));
  return LEAGUE_RECORD_DEFINITIONS.filter((d) => d.scope === scope).map((d): RecordRow => {
    const r = held.get(d.key);
    if (!r) return { kind: 'record', id: d.key, label: plainLabel(d.label), value: '-', holder: 'No record yet', team: '', year: '', playerId: null, teamId: null, held: false, user: false };
    return {
      kind: 'record', id: d.key, label: plainLabel(r.label), value: valueText(r.value), holder: r.holderName, team: r.holderTeamId ? teamAbbr(league, r.holderTeamId) : '',
      year: String(r.year), playerId: r.holderPlayerId, teamId: r.holderTeamId, held: true, user: r.holderTeamId !== null && r.holderTeamId === userTeamId,
    };
  });
};

/* ---------------------------- franchise records ---------------------------- */

interface Mark { value: number; playerId: PlayerId | null; year: string }

const better = (a: Mark | null, v: number, higher: boolean): boolean => a === null || (higher ? v > a.value : v < a.value);

/** Season lines a team's players produced for it (finished seasons, plus the current one before it is committed). */
const franchiseSeasons = (league: League, teamId: TeamId): { playerId: PlayerId; year: number; line: PlayerStatLine }[] => {
  const out: { playerId: PlayerId; year: number; line: PlayerStatLine }[] = [];
  const year = league.season.year;
  for (const [id, c] of Object.entries(league.careerStats) as [PlayerId, League['careerStats'][PlayerId]][]) {
    for (const s of c.seasons) if (s.teamId === teamId) out.push({ playerId: id, year: s.year, line: s.line });
  }
  for (const [id, line] of Object.entries(league.season.stats) as [PlayerId, PlayerStatLine][]) {
    const committed = league.careerStats[id]?.seasons.some((s) => s.year === year);
    if (!committed && findPlayer(league, id)?.teamId === teamId) out.push({ playerId: id, year, line });
  }
  return out;
};

/**
 * A team's own record book: single-season and with-the-franchise career marks of its players (every player
 * record definition), then team marks (most wins, best record, playoff trips, titles) from Team.history.
 */
export const franchiseRecordRows = (league: League, teamId: TeamId): RecordLine[] => {
  const team = league.teams[teamId];
  if (!team) return [];
  const seasons = franchiseSeasons(league, teamId);
  const careers = new Map<PlayerId, PlayerStatLine>();
  for (const s of seasons) careers.set(s.playerId, careers.has(s.playerId) ? addLines(careers.get(s.playerId) as PlayerStatLine, s.line) : s.line);
  const rows: RecordLine[] = [];
  const add = (id: string, label: string, m: Mark | null, holder: (m: Mark) => string): void => {
    rows.push(m && (m.value !== 0 || m.playerId === null)
      ? { kind: 'record', id, label, value: valueText(m.value), holder: holder(m), team: team.abbr, year: m.year, playerId: m.playerId, teamId, held: true, user: false }
      : { kind: 'record', id, label, value: '-', holder: 'No record yet', team: '', year: '', playerId: null, teamId: null, held: false, user: false });
  };
  const playerHolder = (m: Mark): string => playerName(league, m.playerId, 'Unknown');
  rows.push(heading('fr:season', 'Single season'));
  for (const d of LEAGUE_RECORD_DEFINITIONS.filter((x) => x.scope === 'season')) {
    let best: Mark | null = null;
    for (const s of seasons) {
      const v = recordValue(d, { scope: 'season', playerId: s.playerId, name: '', year: s.year, line: s.line });
      if (v !== null && better(best, v, d.higherIsBetter)) best = { value: v, playerId: s.playerId, year: String(s.year) };
    }
    add(`fr:${d.key}`, plainLabel(d.label), best, playerHolder);
  }
  rows.push(heading('fr:career', `With the ${team.name}`));
  for (const d of LEAGUE_RECORD_DEFINITIONS.filter((x) => x.scope === 'career')) {
    let best: Mark | null = null;
    for (const [id, line] of careers) {
      const v = recordValue(d, { scope: 'career', playerId: id, name: '', year: league.season.year, line });
      if (v !== null && better(best, v, d.higherIsBetter)) best = { value: v, playerId: id, year: '' };
    }
    add(`frc:${d.key}`, plainLabel(d.label), best, playerHolder);
  }
  rows.push(heading('fr:team', 'Team'));
  const hist = team.history;
  const most = hist.reduce<Mark | null>((m, h) => (better(m, h.wins, true) ? { value: h.wins, playerId: null, year: String(h.year) } : m), null);
  const bestPct = hist.reduce<{ pct: number; h: (typeof hist)[number] } | null>((m, h) => {
    const g = h.wins + h.losses + h.ties;
    const p = g > 0 ? (h.wins + h.ties / 2) / g : 0;
    return m === null || p > m.pct ? { pct: p, h } : m;
  }, null);
  const teamHolder = (): string => `${team.city} ${team.name}`;
  add('ft:wins', 'Most wins in a season', most, teamHolder);
  rows.push(bestPct
    ? { kind: 'record', id: 'ft:best', label: 'Best record', value: formatRecord(bestPct.h), holder: `${pctText(bestPct.h.wins, bestPct.h.losses, bestPct.h.ties)} win pct`, team: team.abbr, year: String(bestPct.h.year), playerId: null, teamId, held: true, user: false }
    : { kind: 'record', id: 'ft:best', label: 'Best record', value: '-', holder: 'No finished season', team: '', year: '', playerId: null, teamId: null, held: false, user: false });
  add('ft:po', 'Playoff appearances', { value: hist.filter((h) => h.madePlayoffs).length, playerId: null, year: '' }, () => `${hist.length} seasons`);
  add('ft:titles', 'Championships', { value: team.championships, playerId: null, year: hist.filter((h) => h.champion).map((h) => h.year).join(' ') }, teamHolder);
  return rows;
};

/* ------------------------------ season history ------------------------------ */

/** One finished (or crowned) season. */
export interface SeasonRow {
  id: string;
  year: number;
  champion: string;
  championId: TeamId;
  runnerUp: string;
  runnerUpId: TeamId | null;
  mvp: string;
  mvpId: PlayerId | null;
  /** The user's record and finish that year ("" when absent). */
  user: string;
  userTone: Tone;
  inProgress: boolean;
}

/** Season summaries newest first; the current season joins once crowned, before it is archived. */
export const seasonSummaries = (league: League): SeasonSummary[] => {
  const out = [...league.history];
  const s = league.season;
  const second = runnerUp(s.bracket);
  if (s.champion && second && !out.some((h) => h.year === s.year)) {
    const standings: SeasonSummary['standings'] = {};
    for (const id of Object.keys(league.teams) as TeamId[]) {
      const st = s.standings[id];
      standings[id] = { wins: st?.wins ?? 0, losses: st?.losses ?? 0, ties: st?.ties ?? 0 };
    }
    out.push({ year: s.year, champion: s.champion, runnerUp: second, mvp: s.awards.find((a) => a.award === 'MVP')?.playerId ?? null, standings, awards: s.awards });
  }
  return out.sort((a, b) => b.year - a.year);
};

/** How a team finished a season ("Champion", a playoff round, "Playoffs", "Missed playoffs"). */
export const seasonFinish = (league: League, teamId: TeamId, year: number): { text: string; tone: Tone } => {
  const h = league.teams[teamId]?.history.find((x) => x.year === year);
  const s = league.season;
  if (!h && year === s.year && s.champion) {
    if (s.champion === teamId) return { text: 'Champion', tone: 'accent' };
    if (runnerUp(s.bracket) === teamId) return { text: 'Runner-up', tone: 'success' };
  }
  if (!h) return { text: '', tone: 'dim' };
  if (h.champion) return { text: 'Champion', tone: 'accent' };
  if (h.playoffResult) return { text: h.playoffResult, tone: 'success' };
  return h.madePlayoffs ? { text: 'Playoffs', tone: 'success' } : { text: 'Missed playoffs', tone: 'dim' };
};

/** Season history rows. */
export const seasonHistoryRows = (league: League, userTeamId: TeamId | null): SeasonRow[] =>
  seasonSummaries(league).map((h) => {
    const rec = userTeamId ? h.standings[userTeamId] : undefined;
    const fin = userTeamId ? seasonFinish(league, userTeamId, h.year) : { text: '', tone: 'dim' as Tone };
    return {
      id: String(h.year), year: h.year, champion: teamName(league, h.champion), championId: h.champion, runnerUp: teamAbbr(league, h.runnerUp), runnerUpId: h.runnerUp,
      mvp: h.mvp ? playerName(league, h.mvp) : '-', mvpId: h.mvp, user: rec ? `${formatRecord(rec)}${fin.text ? ` ${fin.text}` : ''}` : '', userTone: fin.tone,
      inProgress: !league.history.some((x) => x.year === h.year),
    };
  });

/* ---------------------------------- awards ---------------------------------- */

/** One award winner. */
export interface AwardRow {
  id: string;
  award: string;
  winner: string;
  position: string;
  team: string;
  teamId: TeamId;
  playerId: PlayerId | null;
  coachId: CoachId | null;
  summary: string;
}

const awardsOf = (league: League, year: number): AwardResult[] =>
  league.history.find((h) => h.year === year)?.awards ?? (league.season.year === year ? league.season.awards : []);

/** Years with awards, newest first. */
export const awardYears = (league: League): number[] => {
  const years = new Set(league.history.filter((h) => h.awards.length > 0).map((h) => h.year));
  if (league.season.awards.length > 0) years.add(league.season.year);
  return [...years].sort((a, b) => b - a);
};

/** The awards of a year in award order. */
export const awardRows = (league: League, year: number): AwardRow[] => {
  const order = new Map(AWARD_ORDER.map((a, i) => [a, i]));
  return [...awardsOf(league, year)].sort((a, b) => (order.get(a.award) ?? 99) - (order.get(b.award) ?? 99)).map((a) => {
    const coach = a.coachId ? league.coaches[a.coachId] : undefined;
    return {
      id: `${year}:${a.award}`, award: AWARD_LABELS[a.award] ?? a.award, winner: a.playerId ? playerName(league, a.playerId) : coach ? `${coach.firstName} ${coach.lastName}` : '-',
      position: a.playerId ? findPlayer(league, a.playerId)?.position ?? '' : 'HC', team: teamAbbr(league, a.teamId), teamId: a.teamId, playerId: a.playerId,
      coachId: a.coachId, summary: a.summary,
    };
  });
};

/* --------------------------------- All-Pro --------------------------------- */

/** One All-Pro spot. */
export interface AllProRow {
  id: string;
  position: string;
  name: string;
  team: string;
  teamId: TeamId | null;
  playerId: PlayerId;
  overall: number;
}

const recordedAllPro = (league: League): Map<number, PlayerId[]> => {
  const out = new Map<number, PlayerId[]>();
  for (const [id, years] of Object.entries(league.offseasonFlags?.allPro ?? {}) as [PlayerId, number[]][]) {
    for (const y of years) out.set(y, [...(out.get(y) ?? []), id]);
  }
  return out;
};

/** True when the current season's All-Pro team is still a projection (games played, not yet named). */
export const allProProjected = (league: League): boolean =>
  isGamePhase(league.season.phase) && Object.keys(league.season.stats).length > 0 && !recordedAllPro(league).has(league.season.year);

/** Years with an All-Pro team (named or projected), newest first. */
export const allProYears = (league: League): number[] => {
  const years = new Set(recordedAllPro(league).keys());
  if (allProProjected(league)) years.add(league.season.year);
  return [...years].sort((a, b) => b - a);
};

/** The All-Pro team of a year, in position order. */
export const allProRows = (league: League, year: number): AllProRow[] => {
  const posOrder = new Map(POSITIONS.map((p, i) => [p, i]));
  const recorded = recordedAllPro(league).get(year);
  const ids: { id: PlayerId; teamId: TeamId | null }[] = recorded
    ? recorded.map((id) => ({ id, teamId: league.careerStats[id]?.seasons.find((s) => s.year === year)?.teamId ?? findPlayer(league, id)?.teamId ?? null }))
    : year === league.season.year && allProProjected(league) ? allProTeam(league).map((s) => ({ id: s.playerId, teamId: s.teamId })) : [];
  return ids.map(({ id, teamId }) => {
    const p = findPlayer(league, id);
    return { id: `${year}:${id}`, position: p?.position ?? '', name: playerName(league, id), team: teamAbbr(league, teamId), teamId, playerId: id, overall: p?.overall ?? 0 };
  }).sort((a, b) => (posOrder.get(a.position as (typeof POSITIONS)[number]) ?? 99) - (posOrder.get(b.position as (typeof POSITIONS)[number]) ?? 99) || (a.name < b.name ? -1 : 1));
};
