/**
 * Pure view-models of the Standings tab: division tables and conference tables (grouped rows with headings,
 * ordered with the engine's tiebreakers), clinch/elimination marks, the playoff picture (current seeds,
 * teams in the hunt, eliminated teams; the bracket's seeds once the playoffs are drawn) and the bracket by round.
 */
import type { GameId, TeamId } from '@/core/ids';
import { seedOf } from '@/franchise/playoffs';
import { playoffRoundCount } from '@/franchise/settings';
import {
  clinchStatuses, conferenceStandings, divisionStandings, emptyStanding, seeding, tiebreakContext, winPct, type ClinchStatus,
} from '@/franchise/standings';
import type { BracketMatchup, League, Standing } from '@/franchise/types';
import { formatRecord, formatStreak, type Tone, type ToneText } from '../kit/format';
import { heading, pctText, roundName, teamAbbr, teamName, type HeadingRow } from './common';

/** One team line of a standings table. */
export interface TeamStandingRow {
  kind: 'team';
  id: string;
  teamId: TeamId;
  rank: number;
  abbr: string;
  name: string;
  wins: number;
  losses: number;
  ties: number;
  pct: string;
  pctValue: number;
  pf: number;
  pa: number;
  diff: number;
  div: string;
  conf: string;
  streak: string;
  /** Clinch letter: y = division, x = playoff berth, e = eliminated, '' = undecided. */
  mark: string;
  markTone: Tone;
  user: boolean;
}

/** A standings row (group heading or team). */
export type StandingRow = HeadingRow | TeamStandingRow;

/** Legend of the clinch marks. */
export const CLINCH_LEGEND = 'y division · x playoffs · e eliminated';

const markOf = (s: ClinchStatus): { mark: string; tone: Tone } =>
  s === 'clinchedDivision' ? { mark: 'y', tone: 'success' } : s === 'clinchedPlayoffs' ? { mark: 'x', tone: 'success' } : s === 'eliminated' ? { mark: 'e', tone: 'danger' } : { mark: '', tone: 'dim' };

/** Clinch statuses for the current season (all null before any game). */
export const leagueClinch = (league: League): Record<TeamId, ClinchStatus> => {
  const played = Object.values(league.season.standings).some((s) => s.wins + s.losses + s.ties > 0);
  if (!played) return {};
  return clinchStatuses(tiebreakContext(league), league.settings);
};

const teamRow = (league: League, id: TeamId, rank: number, clinch: Record<TeamId, ClinchStatus>, user: TeamId | null): TeamStandingRow => {
  const s: Standing = league.season.standings[id] ?? emptyStanding(id);
  const m = markOf(clinch[id] ?? null);
  return {
    kind: 'team', id, teamId: id, rank, abbr: teamAbbr(league, id), name: teamName(league, id), wins: s.wins, losses: s.losses, ties: s.ties,
    pct: pctText(s.wins, s.losses, s.ties), pctValue: winPct(s), pf: s.pointsFor, pa: s.pointsAgainst, diff: s.pointsFor - s.pointsAgainst,
    div: `${s.divisionWins}-${s.divisionLosses}`, conf: `${s.conferenceWins}-${s.conferenceLosses}`, streak: formatStreak(s.streak),
    mark: m.mark, markTone: m.tone, user: id === user,
  };
};

/** Division tables: a heading per "Conference Division" followed by its teams, best first. */
export const divisionRows = (league: League, userTeamId: TeamId | null): StandingRow[] => {
  const ctx = tiebreakContext(league);
  const clinch = leagueClinch(league);
  const out: StandingRow[] = [];
  for (const [key, order] of Object.entries(divisionStandings(ctx))) {
    out.push(heading(`div:${key}`, key.replace('/', ' ')));
    order.forEach((id, i) => out.push(teamRow(league, id, i + 1, clinch, userTeamId)));
  }
  return out;
};

/** Conference tables: a heading per conference followed by all its teams, best first. */
export const conferenceRows = (league: League, userTeamId: TeamId | null): StandingRow[] => {
  const ctx = tiebreakContext(league);
  const clinch = leagueClinch(league);
  const out: StandingRow[] = [];
  for (const [conf, order] of Object.entries(conferenceStandings(ctx))) {
    out.push(heading(`conf:${conf}`, conf));
    order.forEach((id, i) => out.push(teamRow(league, id, i + 1, clinch, userTeamId)));
  }
  return out;
};

/* ---------------------------- playoff picture ---------------------------- */

/** One team of the playoff picture. */
export interface PictureRow {
  kind: 'team';
  id: string;
  teamId: TeamId;
  seed: number | null;
  abbr: string;
  name: string;
  record: string;
  status: ToneText;
  user: boolean;
}

/** A playoff-picture row. */
export type PictureLine = HeadingRow | PictureRow;

/**
 * Per conference: the seeds (bracket seeds once drawn, else the current seeding), then teams still in the hunt,
 * then eliminated teams. Status: division leader / wild card, clinched marks, "In the hunt", "Eliminated".
 */
export const playoffPictureRows = (league: League, userTeamId: TeamId | null): PictureLine[] => {
  const ctx = tiebreakContext(league);
  const bracket = league.season.bracket;
  const seeds = bracket ? bracket.seeds : seeding(league.season.standings, league.teams, league.settings, { games: ctx.games, seed: ctx.seed });
  const clinch = bracket ? {} : leagueClinch(league);
  const divisions = divisionStandings(ctx);
  const leaders = new Set(Object.values(divisions).map((o) => o[0]).filter((id): id is TeamId => !!id));
  const out: PictureLine[] = [];
  const rec = (id: TeamId): string => formatRecord(league.season.standings[id] ?? emptyStanding(id));
  for (const [conf, order] of Object.entries(conferenceStandings(ctx))) {
    const confSeeds = seeds[conf] ?? [];
    out.push(heading(`seeds:${conf}`, `${conf} seeds`));
    confSeeds.forEach((id, i) => {
      const c = clinch[id] ?? null;
      const base = leaders.has(id) ? 'Division leader' : 'Wild card';
      const status: ToneText = bracket ? { text: leaders.has(id) ? 'Division winner' : 'Wild card', tone: 'success' }
        : c === 'clinchedDivision' ? { text: 'Clinched division', tone: 'success' }
          : c === 'clinchedPlayoffs' ? { text: 'Clinched berth', tone: 'success' } : { text: base, tone: 'info' };
      out.push({ kind: 'team', id: `${conf}:${id}`, teamId: id, seed: i + 1, abbr: teamAbbr(league, id), name: teamName(league, id), record: rec(id), status, user: id === userTeamId });
    });
    const rest = order.filter((id) => !confSeeds.includes(id));
    if (rest.length > 0) out.push(heading(`rest:${conf}`, bracket ? `${conf} out` : `${conf} hunt`));
    for (const id of rest) {
      const out_ = bracket || clinch[id] === 'eliminated';
      out.push({
        kind: 'team', id: `${conf}:${id}`, teamId: id, seed: null, abbr: teamAbbr(league, id), name: teamName(league, id), record: rec(id),
        status: out_ ? { text: 'Eliminated', tone: 'danger' } : { text: 'In the hunt', tone: 'warning' }, user: id === userTeamId,
      });
    }
  }
  return out;
};

/* -------------------------------- bracket -------------------------------- */

/** One matchup of the bracket. */
export interface BracketRow {
  id: string;
  conference: string;
  high: string;
  highId: TeamId | null;
  low: string;
  lowId: TeamId | null;
  score: string;
  winner: string;
  winnerId: TeamId | null;
  gameId: GameId | null;
  played: boolean;
  bye: boolean;
  user: boolean;
}

/** One round of the bracket. */
export interface BracketRound {
  round: number;
  name: string;
  rows: BracketRow[];
}

const seedLabel = (league: League, id: TeamId | null): string => {
  if (!id) return 'TBD';
  const s = league.season.bracket ? seedOf(league.season.bracket, id)?.seed : undefined;
  return `${s ? `#${s} ` : ''}${teamAbbr(league, id)}`;
};

const bracketRow = (league: League, m: BracketMatchup, i: number, user: TeamId | null): BracketRow => {
  const game = m.gameId ? league.season.schedule.find((g) => g.id === m.gameId) : undefined;
  const r = game?.result;
  const bye = m.lowerSeed === null;
  const hs = r && game ? (game.home === m.higherSeed ? r.homeScore : r.awayScore) : null;
  const ls = r && game ? (game.home === m.higherSeed ? r.awayScore : r.homeScore) : null;
  return {
    id: `r${m.round}:${m.conference ?? 'final'}:${i}`, conference: m.conference ?? 'Final', high: seedLabel(league, m.higherSeed), highId: m.higherSeed,
    low: bye ? 'BYE' : seedLabel(league, m.lowerSeed), lowId: m.lowerSeed,
    score: bye ? '' : hs !== null && ls !== null ? `${hs}-${ls}${r?.overtime ? ' OT' : ''}` : '-',
    winner: bye ? 'Bye' : m.winner ? teamAbbr(league, m.winner) : '', winnerId: m.winner, gameId: m.gameId, played: !!r, bye,
    user: user !== null && (m.higherSeed === user || m.lowerSeed === user),
  };
};

/** Every playoff round (future rounds empty until drawn). */
export const bracketRounds = (league: League, userTeamId: TeamId | null): BracketRound[] => {
  const bracket = league.season.bracket;
  const total = playoffRoundCount(league.settings);
  return Array.from({ length: total }, (_, i) => {
    const round = i + 1;
    const ms = bracket ? bracket.matchups.filter((m) => m.round === round) : [];
    return { round, name: roundName(league, round), rows: ms.map((m, k) => bracketRow(league, m, k, userTeamId)) };
  });
};

/** The round to show first: the one being played, the last one once a champion exists, else the first. */
export const currentBracketRound = (league: League): number => {
  const s = league.season;
  const total = Math.max(1, playoffRoundCount(league.settings));
  if (s.phase === 'playoffs' && s.week > 0) return Math.min(total, s.week);
  return s.bracket?.champion ? total : 1;
};

/** Standings summary: the user's line ("BOS 9-5 #2") plus the clinch legend. */
export const standingsSummary = (rows: readonly StandingRow[]): string => {
  const mine = rows.find((r): r is TeamStandingRow => r.kind === 'team' && r.user);
  return mine ? `${mine.abbr} ${formatRecord(mine)} #${mine.rank} · ${CLINCH_LEGEND}` : CLINCH_LEGEND;
};
