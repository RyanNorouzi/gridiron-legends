/**
 * The draft state machine: scouting season -> start (class, order, pro days) -> picks -> finish
 * (UDFA signings, leftovers to free agency, pick window rolled forward).
 *
 * Every function takes a League and returns a NEW League (maps/arrays that change are copied; players
 * and teams that change are replaced, never mutated). Randomness comes from the injected Rng; per-step
 * forks keep the outcome independent of how callers batch calls.
 *
 * Roster moves go through franchise/roster.ts (assignPlayerInPlace / canSign / signPlayerInPlace on a
 * beginRosterEdit working copy) and contracts come from franchise/contracts.ts (slotted rookieContract,
 * undraftedContract). Draft-phase deals start in the next season: capYearFor(draft.year, 'draft').
 */
import type { Rng } from '@/core/rng';
import type { PlayerId, TeamId } from '@/core/ids';
import { POSITION_GROUP } from '@/players/types';
import type { Player } from '@/players/types';
import { JERSEY_RANGES } from '@/players/generator';
import type { NameSource } from '@/players/generator';
import { createNamePool } from '@/players/names';
import { loadColleges, loadRegions } from '@/teams/data';
import { DEFAULT_PICK_YEARS } from '@/teams/league-generator';
import type { DraftPick, Team } from '@/teams/types';
import type { DraftState, League, Prospect } from '@/franchise/types';
import { runProDay } from '@/franchise/combine';
import { DRAFT_CONFIG, generateDraftClass } from '@/franchise/prospects';
import { grantScoutingPoints, refreshReports, scoutQualityFor, scoutingPointsPerWeek } from '@/franchise/scouting';
import { applyPickNumbers, currentOwner, draftOrder, removePick, rollPickWindow } from '@/franchise/draft-order';
import { aiAllocateScouting, aiPick, pickUndrafted } from '@/franchise/draft-ai';
import { assignPlayerInPlace, beginRosterEdit, canSign, rosterPlayers, signPlayerInPlace } from '@/franchise/roster';
import { capYearFor, rookieContract, undraftedContract } from '@/franchise/contracts';
import { userBoardAvailable } from '@/franchise/draft-board';
import { facilityEffects } from '@/franchise/facilities';
import { staffEffects } from '@/franchise/staff';

/* ---------------------------------------------------------------- helpers */

/** First free jersey number for the player's position group on the team (keeps his own when free). */
const freeJersey = (league: League, teamId: TeamId, player: Player): number => {
  const taken = new Set(rosterPlayers(league, teamId).map((p) => p.jerseyNumber));
  if (!taken.has(player.jerseyNumber)) return player.jerseyNumber;
  for (const [lo, hi] of JERSEY_RANGES[POSITION_GROUP[player.position]]) for (let n = lo; n <= hi; n++) if (!taken.has(n)) return n;
  for (let n = 1; n <= 99; n++) if (!taken.has(n)) return n;
  return player.jerseyNumber;
};

/** Season a draft-phase contract starts in (the contracts module's cap year for the draft phase). */
const contractYear = (draft: Pick<DraftState, 'year'>): number => capYearFor(draft.year, 'draft');

/* -------------------------------------------------------------- lifecycle */

/** Inputs for creating the class (tests and custom leagues can inject a pre-built pool or names). */
export interface DraftClassOptions {
  prospects?: Prospect[];
  names?: NameSource;
}

const sortedTeamIds = (league: League): TeamId[] => (Object.keys(league.teams) as TeamId[]).sort();

/**
 * Points a team's scouting department starts a draft class with: the scouting facility's class budget
 * (facilities.ts scoutingPoints, 0..50 by level) plus the staff's scouting bonus (staff.ts scoutingBonus, about
 * -20..+20 from the Scout and head coach), never negative. Weekly points (scoutingPointsPerWeek) come on top.
 */
export const classScoutingBudget = (league: Pick<League, 'coaches'>, team: Team): number =>
  Math.max(0, Math.round(facilityEffects(team).scoutingPoints + staffEffects(league, team).scoutingBonus));

/** A fresh DraftState for league.year: the class, a stable seed, each team's opening budget (classScoutingBudget), the
 *  analytics accuracy and film-only reports. */
export const createDraftState = (league: League, rng: Rng, opts: DraftClassOptions = {}): DraftState => {
  const existingIds = new Set<string>([...Object.keys(league.players), ...Object.keys(league.retiredPlayers)]);
  const prospects = opts.prospects ?? generateDraftClass(rng.fork('class'), league.year, league.settings, {
    colleges: loadColleges(), regions: loadRegions(), names: opts.names ?? createNamePool(), existingIds,
  });
  const scouting: DraftState['scouting'] = {};
  for (const id of sortedTeamIds(league)) {
    const team = league.teams[id] as Team;
    scouting[id] = { pointsAvailable: classScoutingBudget(league, team), invested: {}, scoutQuality: scoutQualityFor(team, league.coaches), accuracy: facilityEffects(team).scoutingAccuracy };
  }
  const draft: DraftState = {
    year: league.year, order: [], currentPickIndex: 0, prospects, selections: [], reports: {}, scouting,
    userBoard: [], complete: false, seed: rng.int(0, 0x7fffffff),
  };
  return refreshReports(draft);
};

const hasOpenDraft = (league: League): boolean => league.draft !== null && league.draft.year === league.year && !league.draft.complete;

/** Opens the scouting season for this year's class (no-op when an unfinished draft for the year exists). */
export const openScouting = (league: League, rng: Rng, opts: DraftClassOptions = {}): League =>
  hasOpenDraft(league) ? league : { ...league, draft: createDraftState(league, rng, opts) };

/**
 * One (or `weeks`) scouting week(s): every team earns scoutingPointsPerWeek (department quality is
 * re-read so staff changes show up), AI teams spend theirs, the user's bank for manual allocation.
 */
export const weeklyScouting = (league: League, rng: Rng, weeks = 1): League => {
  let draft = league.draft;
  if (!draft || !hasOpenDraft(league)) throw new Error(`weeklyScouting: no open ${league.year} draft class (call openScouting first)`);
  for (let w = 0; w < weeks; w++) {
    const weekRng = rng.fork(`scoutWeek:${w}`);
    for (const id of sortedTeamIds(league)) {
      const team = league.teams[id] as Team;
      draft = grantScoutingPoints(draft, id, scoutingPointsPerWeek(team, league.coaches), scoutQualityFor(team, league.coaches), undefined, facilityEffects(team).scoutingAccuracy);
      if (id !== league.userTeamId) draft = aiAllocateScouting(league, draft, id, weekRng.fork(id));
    }
  }
  return { ...league, draft };
};

/** Runs a pro day for every prospect who has not had one and refreshes every team's reports. */
export const runProDays = (draft: DraftState, rng: Rng): DraftState => {
  if (draft.prospects.every((p) => p.proDay !== null)) return draft;
  const prospects = draft.prospects.map((p) => (p.proDay !== null ? p : { ...p, proDay: runProDay(rng.fork(`proDay:${p.player.id}`), p) }));
  return refreshReports({ ...draft, prospects });
};

/**
 * Starts the draft for league.year. Reuses the class scouted during the season when one is open;
 * otherwise creates it and simulates `initialWeeks` of pre-draft scouting. Then runs pro days,
 * resolves the order (overall numbers are written onto Team.picks) and puts pick 1 on the clock.
 * Idempotent while the draft is running; throws when this year's draft is already complete.
 */
export const startDraft = (league: League, rng: Rng, opts: DraftClassOptions = {}): League => {
  if (league.draft && league.draft.year === league.year && league.draft.complete) throw new Error(`startDraft: the ${league.year} draft is already complete`);
  if (hasOpenDraft(league) && (league.draft as DraftState).order.length > 0) return league;
  let next = league;
  if (!hasOpenDraft(league)) {
    next = openScouting(league, rng.fork('open'), opts);
    next = weeklyScouting(next, rng.fork('preDraft'), DRAFT_CONFIG.scouting.initialWeeks);
  }
  const draft = runProDays(next.draft as DraftState, rng.fork('proDays'));
  const order = draftOrder(next, next.year, rng.fork('order'));
  return { ...next, teams: applyPickNumbers(next.teams, order), draft: { ...draft, order, currentPickIndex: 0, selections: [] } };
};

/** The pick on the clock (null when every pick is made or the draft is complete). */
export const currentPick = (draft: DraftState): DraftPick | null => (draft.complete ? null : draft.order[draft.currentPickIndex] ?? null);

/** Team on the clock, by the canonical Team.picks ownership (null when no pick is pending). */
export const onTheClock = (league: League): TeamId | null => {
  const pick = league.draft ? currentPick(league.draft) : null;
  return pick ? currentOwner(league.teams, pick) : null;
};

/** True when the user's team owns the pick on the clock. */
export const isUserOnTheClock = (league: League): boolean => league.userTeamId !== null && onTheClock(league) === league.userTeamId;

const requireRunningDraft = (league: League, fn: string): DraftState => {
  const draft = league.draft;
  if (!draft || draft.complete) throw new Error(`${fn}: no draft in progress`);
  if (draft.order.length === 0) throw new Error(`${fn}: the draft has not started (call startDraft)`);
  return draft;
};

/**
 * Uses the pick on the clock on `prospectId`: the prospect's Player moves into League.players on the
 * owner's roster with a slotted rookie contract and DraftInfo, the pick leaves Team.picks, and the
 * next pick comes on the clock. Throws when the prospect is unavailable or no pick is pending.
 */
export const makePick = (league: League, prospectId: PlayerId): League => {
  const draft = requireRunningDraft(league, 'makePick');
  const pick = currentPick(draft);
  if (!pick) throw new Error('makePick: every pick has been made (call finishDraft)');
  const prospect = draft.prospects.find((p) => p.player.id === prospectId);
  if (!prospect) throw new Error(`makePick: prospect '${prospectId}' is not available`);
  const owner = currentOwner(league.teams, pick);
  const roundPicks = draft.order.filter((p) => p.round === pick.round);
  const pickInRound = roundPicks.findIndex((p) => p.id === pick.id) + 1;
  const overall = pick.overall ?? draft.currentPickIndex + 1;
  const work = beginRosterEdit(league);
  work.players[prospectId] = {
    ...prospect.player,
    teamId: null,
    jerseyNumber: freeJersey(league, owner, prospect.player),
    contract: rookieContract(pick.round, pickInRound, contractYear(draft), league.settings),
    draft: { year: draft.year, round: pick.round, pick: pickInRound, overall, teamId: owner },
  };
  assignPlayerInPlace(work, prospectId, owner);
  return {
    ...work,
    teams: removePick(work.teams, pick.id),
    draft: {
      ...draft,
      prospects: draft.prospects.filter((p) => p.player.id !== prospectId),
      selections: [...draft.selections, { pick: { ...pick, ownerTeamId: owner, overall }, playerId: prospectId }],
      currentPickIndex: draft.currentPickIndex + 1,
      userBoard: draft.userBoard.filter((id) => id !== prospectId),
    },
  };
};

/** Auto-selection for a team: the user's board first (for the user team), otherwise the AI board on the team's reports. */
export const autoPickFor = (league: League, teamId: TeamId, rng: Rng): PlayerId => {
  const draft = requireRunningDraft(league, 'autoPickFor');
  if (teamId === league.userTeamId) {
    const fromBoard = userBoardAvailable(draft)[0];
    if (fromBoard) return fromBoard;
  }
  return aiPick(league, draft, teamId, rng);
};

/**
 * Makes the next pick. AI owners pick from their own boards; when the user's team is on the clock a
 * `userPick` (a prospect id, or 'auto' for the board/AI choice) is required. The pick that empties the
 * order also finishes the draft (UDFAs, free agency, pick window). No-op on a completed draft.
 */
export const advanceDraft = (league: League, rng: Rng, userPick?: PlayerId | 'auto'): League => {
  if (league.draft?.complete) return league;
  const draft = requireRunningDraft(league, 'advanceDraft');
  const pick = currentPick(draft);
  if (!pick) return finishDraft(league, rng.fork('finish'));
  const owner = currentOwner(league.teams, pick);
  const pickRng = rng.fork(`pick:${draft.currentPickIndex}`);
  let prospectId: PlayerId;
  if (league.userTeamId !== null && owner === league.userTeamId) {
    if (userPick === undefined) throw new Error('advanceDraft: the user team is on the clock; pass a prospect id or "auto"');
    prospectId = userPick === 'auto' ? autoPickFor(league, owner, pickRng) : userPick;
  } else {
    prospectId = aiPick(league, draft, owner, pickRng);
  }
  const next = makePick(league, prospectId);
  return next.draft && currentPick(next.draft) === null ? finishDraft(next, rng.fork('finish')) : next;
};

/** Makes AI picks until the user's team is on the clock or the draft is over. */
export const simToUserPick = (league: League, rng: Rng): League => {
  let next = league;
  while (next.draft && !next.draft.complete && !isUserOnTheClock(next)) next = advanceDraft(next, rng);
  return next;
};

/**
 * Runs the rest of the draft. With `autoPickUser` (default true) the user's picks are made from the
 * user board / AI board; with false the run stops when the user is on the clock.
 */
export const runDraftToEnd = (league: League, rng: Rng, opts: { autoPickUser?: boolean } = {}): League => {
  const autoPickUser = opts.autoPickUser ?? true;
  let next = league;
  let guard = (league.draft?.order.length ?? 0) + 2;
  while (next.draft && !next.draft.complete && guard-- > 0) {
    if (isUserOnTheClock(next)) {
      if (!autoPickUser) break;
      next = advanceDraft(next, rng, 'auto');
    } else {
      next = advanceDraft(next, rng);
    }
  }
  return next;
};

/** Offseason roster ceiling before cuts: the regular roster plus a draft class worth of spots. */
export const offseasonRosterLimit = (league: Pick<League, 'settings'>): number => league.settings.rosterSize + DRAFT_CONFIG.udfa.rosterExtra;

/**
 * Closes the draft once every pick is made: AI teams with roster room and cap space sign undrafted
 * prospects they rate (minimum deals, several passes in a shuffled order, at most udfa.maxPerTeam each); everyone
 * left becomes a free agent; AI teams' reports are pruned (the user's are kept for history); used
 * picks are dropped and the pick window rolls forward so each team holds DEFAULT_PICK_YEARS future
 * drafts. Sets draft.complete.
 */
export const finishDraft = (league: League, rng: Rng): League => {
  const draft = league.draft;
  if (!draft) throw new Error('finishDraft: no draft');
  if (draft.complete) return league;
  if (currentPick(draft) !== null) throw new Error(`finishDraft: ${draft.order.length - draft.currentPickIndex} picks remain`);
  const limit = offseasonRosterLimit(league);
  const aiTeams = rng.shuffle(sortedTeamIds(league).filter((id) => id !== league.userTeamId));
  const undrafted: NonNullable<DraftState['undrafted']> = [];
  const work = beginRosterEdit(league);
  let pool = draft;
  for (let pass = 0; pass < DRAFT_CONFIG.udfa.maxPerTeam; pass++) {
    for (const teamId of aiTeams) {
      if ((work.teams[teamId]?.rosterIds.length ?? limit) >= limit || pool.prospects.length === 0) continue;
      const id = pickUndrafted(work, pool, teamId, rng.fork(`udfa:${pass}:${teamId}`));
      const prospect = id === null ? undefined : pool.prospects.find((p) => p.player.id === id);
      if (!prospect) continue;
      const contract = undraftedContract(contractYear(draft), league.settings);
      work.players[prospect.player.id] = { ...prospect.player, teamId: null, jerseyNumber: freeJersey(work, teamId, prospect.player) };
      const check = canSign(work, teamId, prospect.player.id, contract, { year: contractYear(draft), rosterLimit: limit });
      if (!check.ok) {
        delete work.players[prospect.player.id];
        continue;
      }
      signPlayerInPlace(work, teamId, prospect.player.id, contract, { year: contractYear(draft), rosterLimit: limit });
      pool = { ...pool, prospects: pool.prospects.filter((p) => p.player.id !== prospect.player.id) };
      undrafted.push({ playerId: prospect.player.id, teamId });
    }
  }
  for (const prospect of pool.prospects) {
    work.players[prospect.player.id] = { ...prospect.player, teamId: null, contract: null };
    assignPlayerInPlace(work, prospect.player.id, null);
    undrafted.push({ playerId: prospect.player.id, teamId: null });
  }
  const user = league.userTeamId;
  const userReports = user !== null ? draft.reports[user] : undefined;
  return {
    ...work,
    teams: rollPickWindow(work.teams, draft.year, DEFAULT_PICK_YEARS, league.settings.draftRounds),
    draft: {
      ...pool,
      prospects: [],
      reports: user !== null && userReports ? { [user]: userReports } : {},
      userBoard: [],
      complete: true,
      undrafted,
    },
  };
};
