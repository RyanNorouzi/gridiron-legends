import { clamp01 } from '@/core/math';
import type { PlayerId } from '@/core/ids';
import type { Rng } from '@/core/rng';
import type { Player } from '@/players/types';
import type { DefensiveFormation, DefensivePlay, FormationSlot, OffensiveFormation, OffensivePlay, PlayConcept } from '@/playbook/types';
import type { Coach, Stadium, Team } from '@/teams/types';
import { lineupChemistry } from './chemistry';
import { inferPositionFromRole, selectLineup, type LineupOptions } from './lineups';
import type { PlayContext, UserControlMode } from './play-types';
import { playSideDifficulties } from './difficulty-sides';
import type { SpecialKind } from './rules/scoring';
import { MIDDLE_X, otherSide, type GameSetup, type GameState, type TeamSide } from './types';

/** Formation lookups supplied by the playbook loader; missing entries fall back to role-name inference. */
export interface PlayRegistries {
  offensiveFormations?: Record<string, OffensiveFormation>;
  defensiveFormations?: Record<string, DefensiveFormation>;
}

export interface BuildContextOptions {
  /** Override the special-teams kind (the controller passes 'twoPoint' for a two-point try). */
  special?: SpecialKind;
  controlRole?: string | null;
  substitutions?: Partial<Record<TeamSide, Record<string, PlayerId>>>;
  lineup?: LineupOptions;
  /** No-huddle call (PlayContext.hurryUp). */
  hurryUp?: boolean;
}

/** Concepts that are special-teams plays (and their kick kind). Fakes keep the kick formation. */
export const specialFor = (concept: PlayConcept): SpecialKind => {
  switch (concept) {
    case 'kickoff': return 'kickoff';
    case 'onside': return 'onside';
    case 'punt':
    case 'fakePunt': return 'punt';
    case 'fieldGoal':
    case 'fakeFieldGoal': return 'fieldGoal';
    case 'extraPoint': return 'extraPoint';
    default: return 'none';
  }
};

export const isSpecialConcept = (concept: PlayConcept): boolean => specialFor(concept) !== 'none';

/** Fallback formation from the play's assignment roles (used when no registry entry exists). */
export const formationFromRoles = (roles: readonly string[]): { slots: FormationSlot[] } => {
  const slots: FormationSlot[] = [];
  let wr = 0;
  let idx = 0;
  for (const role of roles) {
    const pos = inferPositionFromRole(role);
    if (!pos) throw new Error(`Cannot infer a position for role "${role}"`);
    const lateral = (idx % 2 === 0 ? 1 : -1) * (2 + Math.floor(idx / 2) * 3);
    idx += 1;
    switch (pos) {
      case 'QB': slots.push({ role, position: pos, x: 0, y: -1.5 }); break;
      case 'RB': case 'FB': slots.push({ role, position: pos, x: 0, y: pos === 'FB' ? -4 : -6, eligible: true }); break;
      case 'WR': wr += 1; slots.push({ role, position: pos, x: (wr % 2 === 0 ? -1 : 1) * (12 + Math.floor(wr / 2) * 4), y: -0.5, eligible: true }); break;
      case 'TE': slots.push({ role, position: pos, x: 4, y: -0.5, eligible: true }); break;
      case 'OT': case 'OG': case 'C': slots.push({ role, position: pos, x: pos === 'C' ? 0 : lateral, y: -0.5 }); break;
      case 'K': case 'P': slots.push({ role, position: pos, x: 0, y: role === 'H' ? -7 : -8 }); break;
      default: slots.push({ role, position: pos, x: lateral, y: pos === 'DE' || pos === 'DT' ? 1 : pos === 'CB' ? 5 : pos === 'FS' || pos === 'SS' ? 12 : 4 });
    }
  }
  return { slots };
};

export const resolveOffensiveFormation = (play: OffensivePlay, registries: PlayRegistries): { slots: FormationSlot[]; personnel?: OffensiveFormation['personnel'] } =>
  registries.offensiveFormations?.[play.formation] ?? formationFromRoles(Object.keys(play.assignments));

export const resolveDefensiveFormation = (play: DefensivePlay, registries: PlayRegistries): { slots: FormationSlot[] } =>
  registries.defensiveFormations?.[play.formation] ?? formationFromRoles(Object.keys(play.assignments));

/* ------------------------------ Synthetic plays ------------------------------ */

const OL = ['LT', 'LG', 'C', 'RG', 'RT'] as const;

/** Minimal special-teams plays so a team without playbook data can still kick, punt and try PATs. */
export const syntheticSpecialPlay = (concept: 'kickoff' | 'onside' | 'punt' | 'fieldGoal' | 'extraPoint'): OffensivePlay => {
  const assignments: OffensivePlay['assignments'] = {};
  if (concept === 'kickoff' || concept === 'onside') {
    assignments['K'] = { type: 'kicker' };
    for (let i = 1; i <= 10; i++) assignments[`KC${i}`] = { type: 'kickCoverage' };
  } else if (concept === 'punt') {
    assignments['P'] = { type: 'kicker' };
    assignments['LS'] = { type: 'longSnapper' };
    for (const r of ['LT', 'LG', 'RG', 'RT']) assignments[r] = { type: 'passBlock' };
    assignments['FB'] = { type: 'passBlock' };
    assignments['TE1'] = { type: 'passBlock' };
    assignments['TE2'] = { type: 'passBlock' };
    assignments['G1'] = { type: 'gunner' };
    assignments['G2'] = { type: 'gunner' };
  } else {
    assignments['K'] = { type: 'kicker' };
    assignments['H'] = { type: 'holder' };
    assignments['LS'] = { type: 'longSnapper' };
    for (const r of ['LT', 'LG', 'RG', 'RT']) assignments[r] = { type: 'passBlock' };
    assignments['TE1'] = { type: 'passBlock' };
    assignments['TE2'] = { type: 'passBlock' };
    assignments['WR1'] = { type: 'passBlock' };
    assignments['WR2'] = { type: 'passBlock' };
  }
  return {
    id: `synthetic:${concept}`, name: `Synthetic ${concept}`, formation: `synthetic:${concept}`, type: 'special', concept,
    assignments, primary: concept === 'punt' ? 'P' : 'K', progression: [], tags: [],
  };
};

/** A plain inside run so an empty offensive playbook can still snap the ball. */
export const syntheticScrimmagePlay = (): OffensivePlay => {
  const assignments: OffensivePlay['assignments'] = { QB: { type: 'qb' }, RB: { type: 'carry' } };
  for (const r of OL) assignments[r] = { type: 'runBlock', gap: 'A-right' };
  assignments['TE1'] = { type: 'runBlock', gap: 'C-right' };
  assignments['WR1'] = { type: 'route', route: 'go' };
  assignments['WR2'] = { type: 'route', route: 'go' };
  assignments['WR3'] = { type: 'route', route: 'slant' };
  return {
    id: 'synthetic:insideRun', name: 'Synthetic Inside Run', formation: 'synthetic:base', type: 'run', concept: 'insideRun',
    assignments, primary: 'WR1', progression: ['WR2', 'WR3'], ballCarrier: 'RB', runGap: 'A-right', tags: [],
  };
};

/** A base 4-3 zone defense for a team without defensive plays. */
export const syntheticDefensePlay = (): DefensivePlay => ({
  id: 'synthetic:cover3', name: 'Synthetic Cover 3', formation: 'synthetic:4-3', coverage: 'cover3', family: 'zone', blitz: 'none', tags: [],
  assignments: {
    DE1: { type: 'rushGap', gap: 'C-left' }, DT1: { type: 'rushGap', gap: 'A-left' }, DT2: { type: 'rushGap', gap: 'A-right' }, DE2: { type: 'rushGap', gap: 'C-right' },
    OLB1: { type: 'zone', zone: 'curlFlatLeft' }, MLB: { type: 'zone', zone: 'middleHook' }, OLB2: { type: 'zone', zone: 'curlFlatRight' },
    CB1: { type: 'zone', zone: 'deepThirdLeft' }, CB2: { type: 'zone', zone: 'deepThirdRight' }, FS: { type: 'zone', zone: 'deepThirdMiddle' }, SS: { type: 'zone', zone: 'hookCurlRight' },
  },
});

/** Kick / punt return unit for the receiving side. */
export const syntheticReturnPlay = (kind: 'kickoff' | 'punt'): DefensivePlay => {
  const assignments: DefensivePlay['assignments'] = { KR: { type: 'returner' } };
  if (kind === 'punt') assignments['PR'] = { type: 'returner' };
  for (let i = 1; i <= (kind === 'punt' ? 9 : 10); i++) assignments[`RB${i}`] = { type: 'returnBlock' };
  return { id: `synthetic:${kind}Return`, name: `Synthetic ${kind} return`, formation: `synthetic:${kind}Return`, coverage: 'cover0', family: 'man', blitz: 'none', tags: [kind === 'punt' ? 'puntReturn' : 'kickReturn'], assignments };
};

/** True when the defensive play is a return unit (has a returner assignment). */
export const isReturnPlay = (play: DefensivePlay): boolean => Object.values(play.assignments).some((a) => a.type === 'returner');

/** Home-field factor 0..1 from the stadium atmosphere and attendance. */
export const crowdFactorFor = (stadium: Stadium, homeTeam: Team): number =>
  clamp01((stadium.atmosphere / 99) * 0.7 + clamp01(homeTeam.fans.attendancePct) * 0.3);

const userControlFor = (state: GameState, offense: TeamSide): UserControlMode => {
  if (state.userSide === null) return 'none';
  if (state.controllers[state.userSide] === 'watch') return 'watch';
  if (state.controllers[state.userSide] !== 'human') return 'none';
  return state.userSide === offense ? 'offense' : 'defense';
};

/**
 * Builds the PlayContext for the next snap: lineups from depth charts, coaches, weather, difficulty,
 * ruleset, score/clock situation, the special-teams kind from the play concept and a per-play forked rng.
 */
export const buildPlayContext = (
  state: GameState, setup: GameSetup, offensivePlay: OffensivePlay, defensivePlay: DefensivePlay, rng: Rng,
  registries: PlayRegistries = {}, opts: BuildContextOptions = {},
): PlayContext => {
  const offense = state.possession;
  const defense = otherSide(offense);
  const special = opts.special ?? specialFor(offensivePlay.concept);
  const offSetup = setup[offense];
  const defSetup = setup[defense];
  const offForm = resolveOffensiveFormation(offensivePlay, registries);
  const defForm = resolveDefensiveFormation(defensivePlay, registries);
  const lineupOpts = (side: TeamSide): LineupOptions => ({ snapIndex: state.playLog.length, ...opts.lineup, overrides: { ...opts.lineup?.overrides, ...opts.substitutions?.[side] } });
  const offenseLineup = selectLineup(offSetup.team, offSetup.players, offForm, state.fatigue, state.injuries, lineupOpts(offense));
  const defenseLineup = selectLineup(defSetup.team, defSetup.players, defForm, state.fatigue, state.injuries, lineupOpts(defense));
  const coaches: Partial<Record<TeamSide, Coach>> = {};
  if (setup.home.headCoach) coaches.home = setup.home.headCoach;
  if (setup.away.headCoach) coaches.away = setup.away.headCoach;
  const centred = special === 'kickoff' || special === 'onside' || special === 'fieldGoal' || special === 'extraPoint';
  const fatigue: Record<PlayerId, number> = { ...state.fatigue };
  const playersOnField: Player[] = [...Object.values(offenseLineup), ...Object.values(defenseLineup)];
  for (const p of playersOnField) if (fatigue[p.id] === undefined) fatigue[p.id] = 0;
  const sideDifficulty = playSideDifficulties(state, offense, special);
  return {
    playIndex: state.playLog.length,
    down: state.down,
    distance: state.distance,
    ballOn: state.ballOn,
    ballX: centred ? MIDDLE_X : state.ballX,
    direction: state.direction,
    offense,
    offensivePlay,
    defensivePlay,
    offenseLineup,
    defenseLineup,
    coaches,
    weather: state.weather,
    difficulty: state.difficulty,
    ...(sideDifficulty ? { sideDifficulty } : {}),
    ruleset: state.ruleset,
    controllers: { ...state.controllers },
    userSide: state.userSide,
    userControl: userControlFor(state, offense),
    controlRole: opts.controlRole ?? null,
    quarter: state.clock.quarter,
    clockRemaining: state.clock.secondsRemaining,
    scoreDiff: state.score[offense] - state.score[defense],
    special,
    crowdFactor: crowdFactorFor(setup.stadium, setup.home.team),
    teamAbbrs: { home: setup.home.team.abbr, away: setup.away.team.abbr },
    rng: rng.fork(`play:${state.playLog.length}`),
    fatigue,
    clockRunning: state.clock.running,
    hurryUp: opts.hurryUp ?? false,
    passChemistry: lineupChemistry(offenseLineup, offSetup.team.id, offSetup.team.chemistry),
  };
};
