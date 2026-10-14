import type { PlayerId, TeamId } from '@/core/ids';
import { createRng } from '@/core/rng';
import { addEvents, generateEvents, leagueClock, type RecordBreak } from '@/franchise/events';
import { rivalryKey, withClub } from '@/franchise/rivalries';
import { teamStaff } from '@/franchise/staff';
import type { FranchiseEvent, FranchiseEventType, League, LeagueRecord, SeasonPhase } from '@/franchise/types';
import type { Player, ProgressionEntry } from '@/players/types';
import { emptyPlayerStatLine } from '@/statistics/empty';
import type { Team } from '@/teams/types';
import { aiTeam, atDepth, clubLeague, patchPlayer, patchStanding, patchTeam, userTeamOf, withPhase } from './helpers';

/** Who plays which part in the in-season scenario. */
export interface InSeasonCast {
  team: Team;
  other: Team;
  opponent: TeamId;
  star: Player;
  extension: Player;
  hotHead: Player;
  hurt: Player;
  wr1: Player;
  benched: Player;
  records: RecordBreak[];
}

const withStat = (l: League, id: PlayerId, patch: (line: ReturnType<typeof emptyPlayerStatLine>) => void): League => {
  const line = emptyPlayerStatLine();
  patch(line);
  return { ...l, season: { ...l.season, stats: { ...l.season.stats, [id]: line } } };
};

/**
 * A regular-season league where the user team (BOS) triggers almost every in-season event: a losing
 * 2-5 skid, an unhappy star, an expiring starter after a good season, a hot head, an injured starter, an
 * aggressive head coach with a weak offense, an ignored WR1, a benched better backup, angry fans, a record
 * and a strong rival next week. A second (AI) team is on a 4-game winning streak.
 */
export const inSeasonScenario = (seed = 21): { league: League; cast: InSeasonCast } => {
  const raw = clubLeague(seed);
  const team = userTeamOf(raw);
  const year = raw.season.year;
  const week = [8, 9, 10, 7, 11, 6].find((w) => raw.season.schedule.some((g) => !g.isPreseason && g.week === w && (g.home === team.id || g.away === team.id))) ?? 8;
  const game = raw.season.schedule.find((g) => !g.isPreseason && g.week === week && (g.home === team.id || g.away === team.id));
  if (!game) throw new Error('no game for the scenario week');
  const opponent = game.home === team.id ? game.away : game.home;
  let l = withPhase(raw, 'regularSeason', week);
  const star = atDepth(l, team, 'QB', 0);
  const extension = atDepth(l, team, 'OT', 0);
  const hotHead = atDepth(l, team, 'DE', 0);
  const hurt = atDepth(l, team, 'MLB', 0);
  const wr1 = atDepth(l, team, 'WR', 0);
  const cbStarter = atDepth(l, team, 'CB', 0);
  const benched = atDepth(l, team, 'CB', 2);
  l = patchPlayer(l, star.id, { overall: 86, morale: { morale: 30, confidence: 50, coachRelationship: 40 }, traits: [] });
  l = patchPlayer(l, extension.id, (p) => ({
    ...p, overall: 80, traits: [], morale: { morale: 70, confidence: 60, coachRelationship: 60 },
    contract: p.contract ? { ...p.contract, signedYear: year - 2, years: 3, yearsRemaining: 1 } : p.contract,
  }));
  l = patchPlayer(l, hotHead.id, { traits: ['hotHeaded'], overall: 70, morale: { morale: 45, confidence: 50, coachRelationship: 50 } });
  l = patchPlayer(l, hurt.id, { overall: 75, traits: [], injury: { bodyArea: 'upperBody', severity: 'moderate', weeksRemaining: 4, permanentPenalty: null, occurredYear: year, occurredWeek: week - 1 } });
  l = patchPlayer(l, wr1.id, { overall: 80, traits: [], injury: null, morale: { morale: 60, confidence: 60, coachRelationship: 60 } });
  l = patchPlayer(l, benched.id, { overall: cbStarter.overall + 10, traits: [], injury: null, morale: { morale: 40, confidence: 50, coachRelationship: 50 } });
  l = withStat(l, star.id, (s) => { s.passing.attempts = 250; s.gamesPlayed = 7; s.gamesStarted = 7; });
  l = { ...l, season: { ...l.season, stats: { ...l.season.stats, [extension.id]: { ...emptyPlayerStatLine(), gamesPlayed: 7, gamesStarted: 7, snaps: 450 } } } };
  l = { ...l, season: { ...l.season, stats: { ...l.season.stats, [wr1.id]: { ...emptyPlayerStatLine(), gamesPlayed: 7, gamesStarted: 7, receiving: { ...emptyPlayerStatLine().receiving, targets: 12 } } } } };
  l = patchStanding(l, team.id, { wins: 2, losses: 5, streak: -4, pointsFor: 105, pointsAgainst: 190 });
  const hc = teamStaff(l, team).HC;
  if (hc) l = { ...l, coaches: { ...l.coaches, [hc.id]: { ...hc, traits: ['aggressive'] } } };
  l = patchTeam(l, team.id, (t) => ({ ...t, fans: { ...t.fans, support: 30 }, rivalIds: [...t.rivalIds.filter((r) => r !== opponent), opponent] }));
  const [x, y] = team.id < opponent ? [team.id, opponent] : [opponent, team.id];
  l = withClub(l, { rivalries: { [rivalryKey(team.id, opponent)]: { teams: [x, y], meetings: 8, closeGames: 5, playoffMeetings: 2, wins: [4, 4], ties: 0, lastYear: year - 1, lastMargin: 3 } } });
  const other = aiTeam(l, 0).id === opponent ? aiTeam(l, 1) : aiTeam(l, 0);
  l = patchStanding(l, other.id, { wins: 6, losses: 1, streak: 4, pointsFor: 200, pointsAgainst: 120 });
  const record: LeagueRecord = { key: 'receivingYards.game', label: 'Receiving Yards (Game)', scope: 'game', value: 312, holderPlayerId: wr1.id, holderTeamId: team.id, holderName: `${wr1.firstName} ${wr1.lastName}`, year };
  const records: RecordBreak[] = [{ record, previous: { ...record, value: 300, holderPlayerId: null, holderName: 'Old Timer', year: year - 3 } }];
  const cast: InSeasonCast = {
    team, other, opponent, star, extension, hotHead, hurt, wr1, benched, records,
  };
  return { league: l, cast };
};

/** Who plays which part in the offseason scenario. */
export interface OffseasonCast {
  team: Team;
  rookie: Player;
  jumper: Player;
  slumper: Player;
  decliner: Player;
  retiree: Player;
  holdout: Player;
}

const entry = (year: number, kind: ProgressionEntry['kind']): ProgressionEntry => ({ year, overallBefore: 70, overallAfter: 70, deltas: {}, kind });

/** An offseason league whose user team has progression news, an old veteran and an underpaid star. */
export const offseasonScenario = (seed = 21): { league: League; cast: OffseasonCast } => {
  const raw = clubLeague(seed);
  const team = userTeamOf(raw);
  const year = raw.season.year;
  let l = withPhase(raw, 'offseason', 0);
  const pick = (pos: Parameters<typeof atDepth>[2], rank: number): Player => atDepth(l, team, pos, rank);
  const rookie = pick('RB', 1);
  const jumper = pick('WR', 1);
  const slumper = pick('TE', 0);
  const decliner = pick('SS', 0);
  const retiree = pick('K', 0);
  const holdout = pick('DE', 0);
  const calm = { morale: 60, confidence: 60, coachRelationship: 60 };
  l = patchPlayer(l, rookie.id, { experience: 1, age: 22, overall: 72, progressionLog: [entry(year, 'breakout')], morale: calm, traits: [] });
  l = patchPlayer(l, jumper.id, { experience: 5, age: 27, overall: 76, progressionLog: [entry(year, 'jump')], morale: calm, traits: [] });
  l = patchPlayer(l, slumper.id, { experience: 6, age: 28, overall: 68, progressionLog: [entry(year, 'slump')], morale: calm, traits: [] });
  l = patchPlayer(l, decliner.id, { experience: 9, age: 31, overall: 72, progressionLog: [entry(year, 'decline')], morale: calm, traits: [] });
  l = patchPlayer(l, retiree.id, { experience: 15, age: 37, overall: 66, progressionLog: [], morale: calm, traits: [] });
  l = patchPlayer(l, holdout.id, (p) => ({
    ...p, experience: 4, age: 27, overall: 86, askingSalary: 12_000_000, progressionLog: [], morale: calm, traits: [],
    contract: { salary: 2_000_000, years: 4, yearsRemaining: 4, guaranteed: 0, signingBonus: 0, role: 'starter', signedYear: year, restructured: false, tag: null },
  }));
  return { league: l, cast: { team, rookie, jumper, slumper, decliner, retiree, holdout } };
};

/** Runs generateEvents over consecutive clock steps (adding each batch), returning every event raised. */
export const runWeeks = (league: League, weeks: readonly number[], opts: { teamIds?: TeamId[]; records?: RecordBreak[]; phase?: SeasonPhase; seed?: number } = {}): { league: League; batches: FranchiseEvent[][] } => {
  let l = league;
  const batches: FranchiseEvent[][] = [];
  const rng = createRng(opts.seed ?? 99);
  for (const w of weeks) {
    const batch = generateEvents(l, w, rng.fork(`w${w}`), { ...(opts.teamIds ? { teamIds: opts.teamIds } : {}), brokenRecords: opts.records ?? [], ...(opts.phase ? { phase: opts.phase } : {}) });
    batches.push(batch);
    l = addEvents(l, batch);
  }
  return { league: l, batches };
};

/** Runs the offseason phases in order, generating the user team's events in each. */
export const runOffseason = (league: League, seed = 7): { league: League; events: FranchiseEvent[] } => {
  let l = league;
  const events: FranchiseEvent[] = [];
  const rng = createRng(seed);
  for (const phase of ['offseason', 'resigning', 'freeAgency', 'draft', 'postDraft', 'trainingCamp'] as const) {
    l = withPhase(l, phase, 0);
    const batch = generateEvents(l, 0, rng.fork(phase));
    events.push(...batch);
    l = addEvents(l, batch);
  }
  return { league: l, events };
};

/** First event of a type in a list (throws when absent). */
export const firstOf = (events: readonly FranchiseEvent[], type: FranchiseEventType): FranchiseEvent => {
  const e = events.find((x) => x.type === type);
  if (!e) throw new Error(`no ${type} event among ${events.map((x) => x.type).join(', ')}`);
  return e;
};

/** Clock of the scenario's regular-season week. */
export const clockAt = (league: League, week: number): number => leagueClock(league, 'regularSeason', week);
