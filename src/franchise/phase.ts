/**
 * Season phase machine along SEASON_PHASE_ORDER. `nextPhase` moves one step with guards (every regular-season
 * game played before the playoffs, a champion before awards end, free agency and the draft finished before
 * the phases that follow them); entering the playoffs seeds the bracket, leaving awards closes the season's
 * books (history.ts finalizeSeason) and trainingCamp -> preseason rolls the year over via `startNewSeason`.
 * The offseason modules (re-signing, free agency, draft, camp) do their own work inside their phases; this
 * module only moves the calendar. Pure.
 */
import type { PlayerId } from '@/core/ids';
import type { Player } from '@/players/types';
import { advanceInjury } from '@/players/injuries';
import type { DraftPick, Team } from '@/teams/types';
import { crownChampion, finalizeSeason } from './history';
import { createSeason, leagueRng, withRngState } from './league';
import { beginPlayoffs, isBracketComplete } from './playoffs';
import { regularSeasonGames } from './schedule';
import { SEASON_CONFIG, projectedCap } from './settings';
import { divisionRanks, tiebreakContext } from './standings';
import { SEASON_PHASE_ORDER, type DraftState, type League, type LeagueSettings, type SeasonPhase } from './types';

const LABELS: Record<SeasonPhase, string> = {
  preseason: 'Preseason', regularSeason: 'Regular Season', playoffs: 'Playoffs', awards: 'Awards', offseason: 'Offseason',
  resigning: 'Re-signing', freeAgency: 'Free Agency', draft: 'Draft', postDraft: 'Post-Draft', trainingCamp: 'Training Camp',
};

/**
 * Human label for a phase and week: "Preseason Week 2", "Week 7", the playoff round name, or the phase name.
 */
export const phaseLabel = (phase: SeasonPhase, week = 0, settings?: Pick<LeagueSettings, 'playoff'>): string => {
  if (phase === 'preseason') return week > 0 ? `Preseason Week ${week}` : LABELS.preseason;
  if (phase === 'regularSeason') return week > 0 ? `Week ${week}` : LABELS.regularSeason;
  if (phase === 'playoffs') return (week > 0 ? settings?.playoff.roundNames[week - 1] : undefined) ?? (week > 0 ? `Playoffs Round ${week}` : LABELS.playoffs);
  return LABELS[phase];
};

/** "2027 Week 5" style label for the league's current point in time. */
export const seasonLabel = (league: Pick<League, 'season' | 'settings'>): string =>
  `${league.season.year} ${phaseLabel(league.season.phase, league.season.week, league.settings)}`;

/** The phase after `phase` (wrapping trainingCamp -> preseason). */
export const nextPhaseOf = (phase: SeasonPhase): SeasonPhase => {
  const i = SEASON_PHASE_ORDER.indexOf(phase);
  return SEASON_PHASE_ORDER[(i + 1) % SEASON_PHASE_ORDER.length] as SeasonPhase;
};

/** Why the league cannot leave its current phase yet, or null when it can. */
export const phaseBlocker = (league: League): string | null => {
  const s = league.season;
  switch (s.phase) {
    case 'regularSeason': {
      const left = regularSeasonGames(s.schedule).filter((g) => g.result === null).length;
      return left > 0 ? `${left} regular-season game(s) remain` : null;
    }
    case 'playoffs':
      return isBracketComplete(s.bracket) ? null : 'the playoffs are not finished';
    case 'awards':
      return s.champion ? null : 'no champion has been crowned';
    case 'freeAgency':
      // FreeAgencyState.round is the round about to run (1-based); finishFreeAgency leaves it at maxRounds + 1.
      return league.freeAgency && league.freeAgency.round <= league.freeAgency.maxRounds ? 'free agency is still running' : null;
    case 'draft':
      return league.draft && !league.draft.complete ? 'the draft is not complete' : null;
    case 'trainingCamp':
      return s.champion ? null : 'the season has no champion';
    default:
      return null;
  }
};

/** True when nextPhase would succeed. */
export const canAdvancePhase = (league: League): boolean => phaseBlocker(league) === null;

/** Every team's own picks for `year` that do not exist yet, appended; picks for past drafts dropped. */
const refreshPicks = (teams: Readonly<Record<string, Team>>, newYear: number, rounds: number): Record<string, Team> => {
  const addYear = newYear + 2;
  const existing = new Set(Object.values(teams).flatMap((t) => t.picks.map((p) => p.id)));
  const out: Record<string, Team> = {};
  for (const t of Object.values(teams)) {
    const fresh: DraftPick[] = [];
    for (let round = 1; round <= rounds; round++) {
      const id = `${addYear}-r${round}-${t.id}`;
      if (!existing.has(id)) fresh.push({ id, year: addYear, round, originalTeamId: t.id, ownerTeamId: t.id, overall: null });
    }
    out[t.id] = { ...t, picks: [...t.picks.filter((p) => p.year >= newYear), ...fresh] };
  }
  return out;
};

/** Injury recovery over the offseason (SEASON_CONFIG.offseasonRecoveryWeeks weekly countdowns). */
const offseasonRecovery = (players: Readonly<Record<PlayerId, Player>>): Record<PlayerId, Player> => {
  const out: Record<PlayerId, Player> = { ...players };
  for (const p of Object.values(players)) {
    let q = p;
    for (let w = 0; w < SEASON_CONFIG.offseasonRecoveryWeeks && q.injury; w++) q = advanceInjury(q);
    if (q !== p) out[p.id] = q;
  }
  return out;
};

/** Settings with the cap grown one year (rounded to $10K) and stamped as `capYear`'s cap. */
const grownSettings = (settings: LeagueSettings, capYear: number): LeagueSettings =>
  ({ ...settings, salaryCap: Math.round(projectedCap(settings, 1) / 10_000) * 10_000, salaryCapYear: capYear });

/**
 * Enters the offseason's cap year (league.year + 1): the cap grows once, so offseason cap math (capYearFor is
 * already next season) uses next season's cap. Idempotent via settings.salaryCapYear, so an older save already
 * past this point is not grown twice. Unused room is not carried over (TeamFinances.capCarryover stays as is):
 * AI teams cannot spend it on the market, and carrying it leaves them far under the cap (cap-usage.test.ts).
 */
export const openNextCapYear = (league: League): League => {
  const capYear = league.year + 1;
  if ((league.settings.salaryCapYear ?? league.year) >= capYear) return league;
  return { ...league, settings: grownSettings(league.settings, capYear) };
};

/** The draft state that survives the rollover into `newYear`: an unfinished class for that year or later, else null. */
export const carriedDraft = (draft: DraftState | null, newYear: number): DraftState | null =>
  draft && !draft.complete && draft.year >= newYear ? draft : null;

/**
 * Year rollover (trainingCamp -> preseason): closes the finished season's books if needed (history,
 * careers, coach records), grows the cap unless the offseason already did (openNextCapYear), adds every team's picks for (new year + 2) and drops spent ones,
 * heals injuries by the offseason's length (anything longer carries over), clears fatigue, keeps only the
 * finished season's user-team/playoff play logs, clears the finished free-agency state and the finished draft
 * (a draft class already opened for the new year or later is kept, with its scouting ledgers, so scouting can
 * continue into the new season) and creates the new Season (schedule seeded by last season's division finish).
 * Requires a crowned champion.
 */
export const startNewSeason = (league: League): League => {
  if (!league.season.champion) throw new Error('startNewSeason: the current season has no champion yet');
  const closed = finalizeSeason(league).league;
  const year = closed.season.year + 1;
  const settings = (closed.settings.salaryCapYear ?? closed.year) < year ? grownSettings(closed.settings, year) : closed.settings;
  const ranks = divisionRanks(tiebreakContext(closed));
  const keepLogs = new Set(closed.season.schedule.filter((g) => g.isPlayoff || g.home === closed.userTeamId || g.away === closed.userTeamId).map((g) => g.id as string));
  const playLogs = Object.fromEntries(Object.entries(closed.playLogs).filter(([id]) => keepLogs.has(id)));
  // Compact logs of the season just finished stay one more season (older ones drop): bounded save size.
  const finishedIds = new Set(closed.season.schedule.map((g) => g.id as string));
  const playSummaries = Object.fromEntries(Object.entries(closed.playSummaries ?? {}).filter(([id]) => finishedIds.has(id)));
  const teams = refreshPicks(closed.teams, year, settings.draftRounds) as League['teams'];
  const rng = leagueRng(closed);
  const season = createSeason(teams, settings, year, rng.fork(`season:${year}`), { divisionRank: ranks });
  const rolled: League = {
    ...closed, year, settings, teams, season, playLogs, playSummaries, players: offseasonRecovery(closed.players), draft: carriedDraft(closed.draft, year), freeAgency: null,
    ...(closed.fatigue !== undefined ? { fatigue: {} } : {}),
  };
  return withRngState(rolled, rng);
};

/**
 * Moves to the next phase. Throws with the blocker's reason when the current phase is unfinished; with
 * `force` the offseason guards (free agency, draft) are skipped, but game-phase guards always apply.
 */
export const nextPhase = (league: League, opts: { force?: boolean } = {}): League => {
  const s = league.season;
  const blocker = phaseBlocker(league);
  const forceable = s.phase === 'freeAgency' || s.phase === 'draft';
  if (blocker && !(opts.force && forceable)) throw new Error(`nextPhase: cannot leave ${s.phase}: ${blocker}`);
  const to = nextPhaseOf(s.phase);
  switch (to) {
    case 'regularSeason':
      return { ...league, season: { ...s, phase: 'regularSeason', week: 1 } };
    case 'playoffs':
      return beginPlayoffs(league);
    case 'awards': {
      if (s.champion || !s.bracket?.champion) return { ...league, season: { ...s, phase: 'awards', week: 0 } };
      const crowned = crownChampion(league, s.bracket.champion).league;
      return { ...crowned, season: { ...crowned.season, phase: 'awards', week: 0 } };
    }
    case 'offseason': {
      const closed = openNextCapYear(finalizeSeason(league).league);
      return { ...closed, season: { ...closed.season, phase: 'offseason', week: 0 } };
    }
    case 'preseason':
      return startNewSeason(league);
    default:
      return { ...league, season: { ...s, phase: to, week: 0 } };
  }
};
