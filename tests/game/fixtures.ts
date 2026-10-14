import { createRng, type Rng } from '@/core/rng';
import type { CoachId, GameId, PlayerId, StadiumId, TeamId } from '@/core/ids';
import { ATTRIBUTE_KEYS, POSITIONS, type AttributeSet, type Player, type Position } from '@/players/types';
import type { DefensivePlay, OffensivePlay, PlayConcept } from '@/playbook/types';
import type { DepthChart, DepthSlot, Stadium, Team } from '@/teams/types';
import { createGameState, directionFor } from '@/game/game-state';
import { GameController, type ControllerOptions } from '@/game/game-controller';
import { getDifficulty, getRuleset } from '@/game/rulesets';
import { clearWeather } from '@/game/weather';
import type { ControllerKind, GameSetup, GameState, Ruleset, TeamSide } from '@/game/types';

/** Roster composition used by every test team (54 players). */
const ROSTER: readonly (readonly [Position, number])[] = [
  ['QB', 3], ['RB', 4], ['FB', 1], ['WR', 6], ['TE', 3], ['OT', 4], ['OG', 4], ['C', 2],
  ['DE', 4], ['DT', 4], ['OLB', 4], ['MLB', 3], ['CB', 6], ['FS', 2], ['SS', 2], ['K', 1], ['P', 1],
];

const attrs = (rng: Rng, base: number): AttributeSet => {
  const out = {} as AttributeSet;
  for (const k of ATTRIBUTE_KEYS) out[k] = Math.max(1, Math.min(99, Math.round(base + rng.range(-12, 12))));
  return out;
};

export const makePlayer = (rng: Rng, position: Position, index: number, teamId: TeamId, side: string): Player => {
  const overall = Math.round(82 - index * 6 + rng.range(-3, 3));
  const id = `p_${side}_${position}${index + 1}` as PlayerId;
  return {
    id, firstName: `${position}${index + 1}`, lastName: side.toUpperCase(), position, age: 26, jerseyNumber: 10 + index,
    heightIn: 73, weightLb: 225, attrs: attrs(rng, overall), overall, potential: overall + 5, devTrait: 'normal', experience: 4,
    traits: [], morale: { morale: 70, confidence: 70, coachRelationship: 70 }, contract: null, teamId, injury: null, injuryHistory: [],
    draft: null, retired: false, rookieYear: 2022, askingSalary: 1_000_000,
    preferences: { money: 0.5, playingTime: 0.5, winning: 0.5, location: 0.5, coach: 0.5, role: 0.5, chemistry: 0.5 },
    homeRegion: 'northeast', college: null, trainingFocus: null, progressionLog: [],
  };
};

export const makeTeam = (side: TeamSide, seed: number): { team: Team; players: Record<PlayerId, Player> } => {
  const rng = createRng(seed);
  const teamId = `t_${side}` as TeamId;
  const players: Record<PlayerId, Player> = {};
  const depthChart = {} as DepthChart;
  for (const pos of POSITIONS) depthChart[pos] = [];
  depthChart.KR = [];
  depthChart.PR = [];
  for (const [pos, count] of ROSTER) {
    for (let i = 0; i < count; i++) {
      const p = makePlayer(rng, pos, i, teamId, side);
      players[p.id] = p;
      depthChart[pos].push(p.id);
    }
  }
  depthChart.KR = [depthChart.WR[3] as PlayerId, depthChart.RB[2] as PlayerId];
  depthChart.PR = [depthChart.WR[4] as PlayerId, depthChart.CB[4] as PlayerId];
  const team: Team = {
    id: teamId, city: side === 'home' ? 'Harbor City' : 'Ridgeport', name: side === 'home' ? 'Anchors' : 'Summits', abbr: side === 'home' ? 'HAR' : 'RDG',
    conference: 'Liberty', division: 'Colonial', colors: { primary: '#123456', secondary: '#abcdef', accent: '#ffffff', helmet: '#123456' },
    logoSeed: seed, stadiumId: 's_home' as StadiumId, rosterIds: Object.keys(players) as PlayerId[], depthChart, headCoachId: null, staffIds: [],
    playbookId: 'balanced', rivalIds: [], picks: [],
    finances: { cash: 0, ticketPrice: 80, seasonRevenue: { tickets: 0, merchandise: 0, sponsors: 0, concessions: 0 }, seasonExpenses: { playerSalaries: 0, staffSalaries: 0, stadium: 0, facilities: 0 }, deadMoney: {}, capCarryover: 0 },
    facilities: { training: 3, medical: 3, scouting: 3, stadium: 3, development: 3, analytics: 3 },
    fans: { support: 70, excitement: 60, attendancePct: 0.9 }, history: [], championships: 0, chemistry: 70, overall: 78, offenseRating: 78, defenseRating: 78,
    region: 'northeast', marketSize: 'medium', isUserControlled: side === 'home',
  };
  return { team, players };
};

export const makeStadium = (roof: Stadium['roof'] = 'open'): Stadium => ({
  id: 's_home' as StadiumId, name: 'Harbor Point', city: 'Harbor City', capacity: 65000, fieldType: 'grass', roof, climate: 'temperate', atmosphere: 80, level: 3, yearBuilt: 2001,
});

const off = (id: string, concept: PlayConcept, extra: Partial<OffensivePlay> = {}): OffensivePlay => ({
  id, name: id, formation: `form_${concept}`, type: concept === 'insideRun' ? 'run' : concept === 'kneel' ? 'kneel' : concept === 'spike' ? 'spike' : ['kickoff', 'onside', 'punt', 'fieldGoal', 'extraPoint'].includes(concept) ? 'special' : 'pass',
  concept,
  assignments: { QB: { type: 'qb' }, RB: { type: 'carry' }, WR1: { type: 'route', route: 'curl' }, WR2: { type: 'route', route: 'go' }, TE1: { type: 'route', route: 'flat' }, LT: { type: 'passBlock' }, LG: { type: 'passBlock' }, C: { type: 'passBlock' }, RG: { type: 'passBlock' }, RT: { type: 'passBlock' } },
  primary: 'WR1', progression: ['WR2', 'TE1'], tags: [], ...extra,
});

export const OFFENSE_PLAYS: OffensivePlay[] = [
  off('run-inside', 'insideRun', { ballCarrier: 'RB', runGap: 'A-right' }),
  off('pass-curl', 'curl'),
  off('pass-deep', 'go'),
  off('kneel', 'kneel'),
  off('spike', 'spike'),
  off('punt', 'punt', { assignments: { P: { type: 'kicker' }, LS: { type: 'longSnapper' }, LT: { type: 'passBlock' }, LG: { type: 'passBlock' }, RG: { type: 'passBlock' }, RT: { type: 'passBlock' }, FB: { type: 'passBlock' }, TE1: { type: 'passBlock' }, TE2: { type: 'passBlock' }, G1: { type: 'gunner' }, G2: { type: 'gunner' } }, primary: 'P', progression: [] }),
  off('fg', 'fieldGoal', { assignments: { K: { type: 'kicker' }, H: { type: 'holder' }, LS: { type: 'longSnapper' }, LT: { type: 'passBlock' }, LG: { type: 'passBlock' }, RG: { type: 'passBlock' }, RT: { type: 'passBlock' }, TE1: { type: 'passBlock' }, TE2: { type: 'passBlock' }, WR1: { type: 'passBlock' }, WR2: { type: 'passBlock' } }, primary: 'K', progression: [] }),
  off('xp', 'extraPoint', { assignments: { K: { type: 'kicker' }, H: { type: 'holder' }, LS: { type: 'longSnapper' }, LT: { type: 'passBlock' }, LG: { type: 'passBlock' }, RG: { type: 'passBlock' }, RT: { type: 'passBlock' }, TE1: { type: 'passBlock' }, TE2: { type: 'passBlock' }, WR1: { type: 'passBlock' }, WR2: { type: 'passBlock' } }, primary: 'K', progression: [] }),
  off('kickoff', 'kickoff', { assignments: { K: { type: 'kicker' }, KC1: { type: 'kickCoverage' }, KC2: { type: 'kickCoverage' }, KC3: { type: 'kickCoverage' }, KC4: { type: 'kickCoverage' }, KC5: { type: 'kickCoverage' }, KC6: { type: 'kickCoverage' }, KC7: { type: 'kickCoverage' }, KC8: { type: 'kickCoverage' }, KC9: { type: 'kickCoverage' }, KC10: { type: 'kickCoverage' } }, primary: 'K', progression: [] }),
  off('onside', 'onside', { assignments: { K: { type: 'kicker' }, KC1: { type: 'kickCoverage' }, KC2: { type: 'kickCoverage' }, KC3: { type: 'kickCoverage' }, KC4: { type: 'kickCoverage' }, KC5: { type: 'kickCoverage' } }, primary: 'K', progression: [] }),
];

export const DEFENSE_PLAYS: DefensivePlay[] = [
  { id: 'cover3', name: 'Cover 3', formation: 'form_43', coverage: 'cover3', family: 'zone', blitz: 'none', tags: [], assignments: { DE1: { type: 'rushGap', gap: 'C-left' }, DT1: { type: 'rushGap', gap: 'A-left' }, DT2: { type: 'rushGap', gap: 'A-right' }, DE2: { type: 'rushGap', gap: 'C-right' }, OLB1: { type: 'zone', zone: 'curlFlatLeft' }, MLB: { type: 'zone', zone: 'middleHook' }, OLB2: { type: 'zone', zone: 'curlFlatRight' }, CB1: { type: 'zone', zone: 'deepThirdLeft' }, CB2: { type: 'zone', zone: 'deepThirdRight' }, FS: { type: 'zone', zone: 'deepThirdMiddle' }, SS: { type: 'zone', zone: 'hookCurlRight' } } },
  { id: 'man-blitz', name: 'Man Blitz', formation: 'form_43', coverage: 'cover1', family: 'man', blitz: 'lb', tags: [], assignments: { DE1: { type: 'rushGap', gap: 'C-left' }, DT1: { type: 'rushGap', gap: 'A-left' }, DT2: { type: 'rushGap', gap: 'A-right' }, DE2: { type: 'rushGap', gap: 'C-right' }, OLB1: { type: 'blitz', gap: 'B-left' }, MLB: { type: 'manCover', manTarget: 'RB' }, OLB2: { type: 'manCover', manTarget: 'TE1' }, CB1: { type: 'manCover', manTarget: 'WR1' }, CB2: { type: 'manCover', manTarget: 'WR2' }, FS: { type: 'zone', zone: 'deepThirdMiddle' }, SS: { type: 'blitz', gap: 'C-right' } } },
  { id: 'kick-return', name: 'Kick Return', formation: 'form_kr', coverage: 'cover0', family: 'man', blitz: 'none', tags: ['kickReturn'], assignments: { KR: { type: 'returner' }, RB1: { type: 'returnBlock' }, RB2: { type: 'returnBlock' }, RB3: { type: 'returnBlock' }, RB4: { type: 'returnBlock' }, RB5: { type: 'returnBlock' } } },
  { id: 'punt-return', name: 'Punt Return', formation: 'form_pr', coverage: 'cover0', family: 'man', blitz: 'none', tags: ['puntReturn'], assignments: { PR: { type: 'returner' }, RB1: { type: 'returnBlock' }, RB2: { type: 'returnBlock' }, RB3: { type: 'returnBlock' } } },
];

export interface SetupOverrides {
  rulesetId?: 'arcade' | 'simulation';
  ruleset?: Partial<Ruleset>;
  controllers?: Record<TeamSide, ControllerKind>;
  userSide?: TeamSide | null;
  seed?: number;
  isPlayoff?: boolean;
  roof?: Stadium['roof'];
}

export const makeSetup = (o: SetupOverrides = {}): GameSetup => {
  const home = makeTeam('home', 101);
  const away = makeTeam('away', 202);
  return {
    id: 'g_test' as GameId,
    home: { team: home.team, players: home.players, headCoach: null, offensePlays: OFFENSE_PLAYS, defensePlays: DEFENSE_PLAYS },
    away: { team: away.team, players: away.players, headCoach: null, offensePlays: OFFENSE_PLAYS, defensePlays: DEFENSE_PLAYS },
    stadium: makeStadium(o.roof),
    ruleset: { ...getRuleset(o.rulesetId ?? 'simulation'), ...o.ruleset },
    difficulty: getDifficulty('pro'),
    weather: clearWeather(),
    seed: o.seed ?? 4242,
    userSide: o.userSide === undefined ? null : o.userSide,
    controllers: o.controllers ?? { home: 'ai', away: 'ai' },
    isPlayoff: o.isPlayoff ?? false,
  };
};

/** A GameState at a situation: starts from createGameState and overlays fields (clock merged). */
export const situation = (setup: GameSetup, patch: Partial<GameState> = {}): GameState => {
  const s = createGameState(setup);
  const { clock, ...rest } = patch;
  Object.assign(s, rest);
  if (clock) s.clock = { ...s.clock, ...clock };
  if (patch.direction === undefined) s.direction = directionFor(s.possession, s.clock.quarter);
  if (patch.phase === undefined) s.phase = 'playcall';
  if (patch.receivedOpeningKickoff === undefined) s.receivedOpeningKickoff = 'away';
  return s;
};

/** Controller positioned at a situation (phase 'playcall' unless the patch says otherwise). */
export const controllerAt = (patch: Partial<GameState> = {}, o: SetupOverrides = {}, opts: ControllerOptions = {}): GameController => {
  const setup = makeSetup(o);
  return new GameController(setup, { ...opts, state: situation(setup, patch) });
};

export const pid = (s: string): PlayerId => s as PlayerId;
export const cid = (s: string): CoachId => s as CoachId;
export const depthOf = (team: Team, slot: DepthSlot): PlayerId[] => team.depthChart[slot];
