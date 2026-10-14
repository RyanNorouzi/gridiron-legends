/**
 * Club ledgers: club-state access, rivalries, and the head-coach playoff ledger / Coach of the Year inputs
 * (re-exported by staff.ts).
 *
 * CLUB STATE. League.club is optional (leagues created before the club layer have none). Every club
 * function reads it through `ensureClub`, which fills defaults for every field, and writes a complete
 * object back through `withClub`. Nothing here mutates its input.
 *
 * RIVALRIES. `rivalryIntensity` (0..100) blends structure (same division, named rivals from the team
 * templates, same conference) with history from the ledger (close games, playoff meetings, a balanced
 * head-to-head) and fades history that has gone stale. A game is a rivalry game at RIVALRY_TUNING.threshold
 * or more, so every division game qualifies. `rivalryEffects` turns intensity into the multipliers the fan,
 * finance and morale modules apply. `updateRivalryLedger` folds finished games into the ledger.
 *
 * COACHING LEDGERS. Regular-season career records are credited by history.ts at season close; here live
 * the playoff ledger (recordCoachPlayoffResults), the live record including the season in progress
 * (coachRecord) and the Coach of the Year inputs (coachOfYearInputs).
 */
import type { CoachId, TeamId } from '@/core/ids';
import { clamp, mean } from '@/core/math';
import { winPct } from './standings';
import type { ClubState, League, RivalryLedgerEntry, ScheduledGame } from './types';

/* ------------------------------------------------------------------ club state */

/** ClubState with every optional field present. */
export type FullClubState = Required<ClubState>;

/** A fresh, empty club state. */
export const emptyClubState = (): FullClubState => ({
  rivalries: {}, playerFlags: {}, staffDeadMoney: {}, facilityUpgrades: {}, ownerSubsidy: {},
  ownerConfidence: {}, tenure: {}, retiredCoachIds: [], coachPlayoffRecord: {}, financeHistory: {}, chemistryBonus: {}, attendance: {},
  staffYear: 0, lastClubWeek: null, extensionTalks: {}, practicePlan: {},
});

/** The league's club state with defaults filled in (a new object; the League is not touched). */
export const ensureClub = (league: Pick<League, 'club'>): FullClubState => ({ ...emptyClubState(), ...(league.club ?? {}) });

/** A League whose club state is the current one with `patch` applied (always a complete object). */
export const withClub = (league: League, patch: Partial<ClubState>): League => ({ ...league, club: { ...ensureClub(league), ...patch } });

/* -------------------------------------------------------------------- rivalries */

/** Rivalry tuning. */
export const RIVALRY_TUNING = Object.freeze({
  /** Intensity at or above which a game is a rivalry game (division games sit exactly here). */
  threshold: 40,
  division: 40,
  conference: 6,
  /** Named rival from the team templates (Team.rivalIds, either direction). */
  named: 32,
  perCloseGame: 4,
  closeGameCap: 20,
  perPlayoffMeeting: 10,
  playoffCap: 24,
  /** Bonus for an even head-to-head once there are at least `balanceMinMeetings` meetings. */
  balance: 8,
  balanceMinMeetings: 4,
  /** History older than this many seasons counts half. */
  staleYears: 5,
  /** A game decided by this many points or fewer (or in overtime) is a close game. */
  closeMargin: 7,
});

/** Ledger key of a pair: the two ids sorted and joined with '|'. */
export const rivalryKey = (a: TeamId, b: TeamId): string => (a < b ? `${a}|${b}` : `${b}|${a}`);

/** The ledger entry of a pair, or null when they have never met. */
export const rivalryLedgerEntry = (league: Pick<League, 'club'>, a: TeamId, b: TeamId): RivalryLedgerEntry | null =>
  league.club?.rivalries[rivalryKey(a, b)] ?? null;

/** Structural part of intensity: division, conference and named rivals. */
const structuralIntensity = (league: Pick<League, 'teams'>, a: TeamId, b: TeamId): number => {
  const ta = league.teams[a];
  const tb = league.teams[b];
  if (!ta || !tb) return 0;
  const R = RIVALRY_TUNING;
  let v = 0;
  if (ta.conference === tb.conference) v += ta.division === tb.division ? R.division : R.conference;
  if (ta.rivalIds.includes(b) || tb.rivalIds.includes(a)) v += R.named;
  return v;
};

/** History part of intensity from a ledger entry. */
const historyIntensity = (e: RivalryLedgerEntry | null, year: number): number => {
  if (!e || e.meetings === 0) return 0;
  const R = RIVALRY_TUNING;
  let v = Math.min(R.closeGameCap, e.closeGames * R.perCloseGame) + Math.min(R.playoffCap, e.playoffMeetings * R.perPlayoffMeeting);
  if (e.meetings >= R.balanceMinMeetings) v += (1 - Math.abs(e.wins[0] - e.wins[1]) / e.meetings) * R.balance;
  return year - e.lastYear > R.staleYears ? v / 2 : v;
};

/**
 * Rivalry intensity 0..100 between two teams: division +40, same conference +6, named rivals +32, close
 * games +4 each (max 20), playoff meetings +10 each (max 24), an even series up to +8; history older than
 * five seasons counts half. 0 for the same team or unknown teams.
 */
export const rivalryIntensity = (league: Pick<League, 'teams' | 'club' | 'year'>, a: TeamId, b: TeamId): number => {
  if (a === b || !league.teams[a] || !league.teams[b]) return 0;
  return clamp(Math.round(structuralIntensity(league, a, b) + historyIntensity(rivalryLedgerEntry(league, a, b), league.year)), 0, 100);
};

/** True when a scheduled game is a rivalry game (intensity at or above the threshold). */
export const isRivalryGame = (game: Pick<ScheduledGame, 'home' | 'away'>, league: Pick<League, 'teams' | 'club' | 'year'>): boolean =>
  rivalryIntensity(league, game.home, game.away) >= RIVALRY_TUNING.threshold;

/** What a rivalry does to the club systems. */
export interface RivalryEffects {
  /** Multiplier on fan reactions to the result (1..2). */
  fanMultiplier: number;
  /** Added to the attendance share of a rivalry home game (0..0.1). */
  attendanceBoost: number;
  /** Added to the stadium atmosphere for the game (0..8). */
  atmosphereBonus: number;
  /** Multiplier on the morale swing of the result (1..1.5). */
  moraleMultiplier: number;
}

/** Club effects of a rivalry of the given intensity (neutral below the threshold). */
export const rivalryEffects = (intensity: number): RivalryEffects => {
  const t = intensity >= RIVALRY_TUNING.threshold ? clamp(intensity, 0, 100) / 100 : 0;
  return { fanMultiplier: 1 + t, attendanceBoost: 0.1 * t, atmosphereBonus: Math.round(8 * t), moraleMultiplier: 1 + 0.5 * t };
};

/** Club effects of a scheduled game's rivalry. */
export const gameRivalryEffects = (league: Pick<League, 'teams' | 'club' | 'year'>, game: Pick<ScheduledGame, 'home' | 'away'>): RivalryEffects =>
  rivalryEffects(rivalryIntensity(league, game.home, game.away));

const emptyEntry = (a: TeamId, b: TeamId): RivalryLedgerEntry => {
  const teams: [TeamId, TeamId] = a < b ? [a, b] : [b, a];
  return { teams, meetings: 0, closeGames: 0, playoffMeetings: 0, wins: [0, 0], ties: 0, lastYear: 0, lastMargin: 0 };
};

/** The entry after one finished game (unchanged when this game was already folded in). */
export const applyGameToLedger = (entry: RivalryLedgerEntry | null, game: ScheduledGame, year: number): RivalryLedgerEntry => {
  const e = entry ?? emptyEntry(game.home, game.away);
  const r = game.result;
  if (!r || e.lastGameId === game.id) return e;
  const homeFirst = e.teams[0] === game.home;
  const margin = (r.homeScore - r.awayScore) * (homeFirst ? 1 : -1);
  const wins: [number, number] = [e.wins[0] + (margin > 0 ? 1 : 0), e.wins[1] + (margin < 0 ? 1 : 0)];
  return {
    ...e,
    meetings: e.meetings + 1,
    closeGames: e.closeGames + (Math.abs(margin) <= RIVALRY_TUNING.closeMargin || r.overtime ? 1 : 0),
    playoffMeetings: e.playoffMeetings + (game.isPlayoff ? 1 : 0),
    wins,
    ties: e.ties + (margin === 0 ? 1 : 0),
    lastYear: year,
    lastMargin: margin,
    lastGameId: game.id,
  };
};

/** Folds finished regular-season and playoff games (preseason ignored) into the rivalry ledger. */
export const updateRivalryLedger = (league: League, games: readonly ScheduledGame[]): League => {
  const club = ensureClub(league);
  const rivalries = { ...club.rivalries };
  let changed = false;
  for (const g of games) {
    if (!g.result || g.isPreseason || g.home === g.away) continue;
    const key = rivalryKey(g.home, g.away);
    const next = applyGameToLedger(rivalries[key] ?? null, g, league.season.year);
    if (next !== rivalries[key]) {
      rivalries[key] = next;
      changed = true;
    }
  }
  return changed ? withClub(league, { rivalries }) : league;
};

/** A team's strongest rivalries, most intense first. */
export const topRivals = (league: Pick<League, 'teams' | 'club' | 'year'>, teamId: TeamId, n = 3): { teamId: TeamId; intensity: number }[] =>
  (Object.keys(league.teams) as TeamId[])
    .filter((id) => id !== teamId)
    .map((id) => ({ teamId: id, intensity: rivalryIntensity(league, teamId, id) }))
    .sort((a, b) => b.intensity - a.intensity || (a.teamId < b.teamId ? -1 : 1))
    .slice(0, Math.max(0, n));

/* --------------------------------------------------------- coaching ledgers */

/** Credits head coaches with playoff wins and losses from finished playoff games. */
export const recordCoachPlayoffResults = (league: League, games: readonly ScheduledGame[]): League => {
  const record = { ...ensureClub(league).coachPlayoffRecord };
  let changed = false;
  for (const g of games) {
    if (!g.isPlayoff || !g.result || g.result.homeScore === g.result.awayScore) continue;
    const homeWon = g.result.homeScore > g.result.awayScore;
    for (const [teamId, won] of [[g.home, homeWon], [g.away, !homeWon]] as const) {
      const hc = league.teams[teamId]?.headCoachId;
      if (!hc) continue;
      const r = record[hc] ?? { wins: 0, losses: 0 };
      record[hc] = { wins: r.wins + (won ? 1 : 0), losses: r.losses + (won ? 0 : 1) };
      changed = true;
    }
  }
  return changed ? withClub(league, { coachPlayoffRecord: record }) : league;
};

/** A coach's record: career (credited at season close) plus the running season for a sitting head coach. */
export interface CoachRecord {
  wins: number;
  losses: number;
  seasonWins: number;
  seasonLosses: number;
  playoffWins: number;
  playoffLosses: number;
  championships: number;
}

/** Career record including the season in progress (when not yet credited by history.finalizeSeason). */
export const coachRecord = (league: League, coachId: CoachId): CoachRecord | null => {
  const c = league.coaches[coachId];
  if (!c) return null;
  const team = c.teamId ? league.teams[c.teamId] : undefined;
  const st = team && team.headCoachId === c.id ? league.season.standings[team.id] : undefined;
  const credited = league.history.some((h) => h.year === league.season.year);
  const seasonWins = st && !credited ? st.wins : 0;
  const seasonLosses = st && !credited ? st.losses : 0;
  const po = ensureClub(league).coachPlayoffRecord[coachId] ?? { wins: 0, losses: 0 };
  return {
    wins: c.careerWins + seasonWins, losses: c.careerLosses + seasonLosses, seasonWins, seasonLosses,
    playoffWins: po.wins, playoffLosses: po.losses, championships: c.championships,
  };
};

/** One head coach's Coach of the Year case. */
export interface CoachOfYearInput {
  coachId: CoachId;
  teamId: TeamId;
  wins: number;
  losses: number;
  winPct: number;
  /** Win% expected from the roster's overall relative to the league. */
  expectedWinPct: number;
  /** winPct - expectedWinPct. */
  overPerformance: number;
  /** Change in win% over last season (0 without a previous season). */
  improvement: number;
  madePlayoffs: boolean;
  /** Composite ranking score, higher is better. */
  score: number;
}

/** Coach of the Year inputs for every sitting head coach, best case first. */
export const coachOfYearInputs = (league: League): CoachOfYearInput[] => {
  const teams = Object.values(league.teams);
  const avg = mean(teams.map((t) => t.overall));
  const seeds = league.season.bracket ? Object.values(league.season.bracket.seeds).flat() : [];
  const out: CoachOfYearInput[] = [];
  for (const t of teams) {
    const hc = t.headCoachId ? league.coaches[t.headCoachId] : undefined;
    const st = league.season.standings[t.id];
    if (!hc || !st) continue;
    const pct = winPct(st);
    const expected = clamp(0.5 + (t.overall - avg) * 0.025, 0.1, 0.9);
    const last = [...t.history].filter((h) => h.year < league.season.year).sort((a, b) => b.year - a.year)[0];
    const lastPct = last && last.wins + last.losses + last.ties > 0 ? (last.wins + last.ties / 2) / (last.wins + last.losses + last.ties) : null;
    const improvement = lastPct === null ? 0 : pct - lastPct;
    const madePlayoffs = seeds.includes(t.id);
    const score = (pct - expected) * 100 + pct * 40 + improvement * 20 + (madePlayoffs ? 8 : 0);
    out.push({ coachId: hc.id, teamId: t.id, wins: st.wins, losses: st.losses, winPct: pct, expectedWinPct: expected, overPerformance: pct - expected, improvement, madePlayoffs, score });
  }
  return out.sort((a, b) => b.score - a.score || (a.coachId < b.coachId ? -1 : 1));
};
