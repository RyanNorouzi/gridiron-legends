/**
 * Drill scenarios: turns a drill definition + options + rep seed into a complete PlayContext (the same record
 * the GameController builds with buildPlayContext for a real snap) over the fixed practice squads. Plays come
 * from the bundled playbook, materialized so flipped / mirrored plays line up correctly, and the registries handed
 * to the engine carry exactly the materialized formations.
 */
import { createRng } from '@/core/rng';
import { loadPlaybookData, materializeDefensivePlay, materializePlay, offensiveStrength } from '@/playbook/loader';
import { receiverSlots, type DefensivePlay, type OffensiveFormation, type OffensivePlay, type RouteDef } from '@/playbook/types';
import { getDifficulty, getRuleset } from '../rulesets';
import { specialFor, type PlayRegistries } from '../play-context';
import type { PlayContext } from '../play-types';
import { clearWeather } from '../weather';
import { HASH_LEFT, HASH_RIGHT, MIDDLE_X, otherSide, type Direction, type Ruleset, type TeamSide, type WeatherState } from '../types';
import { lineupFor, practiceSquad, type SquadIdentity } from './roster';
import type { DrillDefinition, DrillLevel, DrillOptions, HashChoice, WindChoice } from './types';

/** The user always wears GOLD and is the home side; the scout team is away. */
export const PRACTICE_USER_SIDE: TeamSide = 'home';
/** Practice snaps always attack toward +y (the camera turns the field for the user). */
export const PRACTICE_DIRECTION: Direction = 1;

/** The defensive "play" of a drill with nobody across from the offense. */
export const EMPTY_DEFENSE: DefensivePlay = Object.freeze({
  id: 'practice:empty', name: 'No Defense', formation: 'practice:empty', coverage: 'cover0', family: 'zone', blitz: 'none', tags: [], assignments: {},
}) as DefensivePlay;

/** Everything one rep needs: the drill, its options and level, the PlayContext and the play registries. */
export interface DrillScenario {
  def: DrillDefinition;
  options: DrillOptions;
  level: DrillLevel;
  /** Seed of this rep (every scripted choice and the play rng derive from it). */
  seed: number;
  /** Rotation index into def.offensePlays. */
  rotation: number;
  ctx: PlayContext;
  registries: PlayRegistries;
  /** Materialized offensive formation and role -> route (play art, back-shoulder rule). */
  formation: OffensiveFormation;
  routes: Record<string, RouteDef>;
  /** Receiver roles for throw1..5. */
  receiverSlots: string[];
  userSide: TeamSide;
  squads: Record<TeamSide, SquadIdentity>;
}

/** Practice ruleset: arcade flow with no flags and no injuries. */
export const practiceRuleset = (): Ruleset => ({ ...getRuleset('arcade'), penalties: false, penaltyFrequency: 0, injuries: false });

/** Absolute x of a hash for the offense attacking `dir` (offense-perspective left/right). */
export const hashX = (hash: HashChoice, dir: Direction): number => {
  if (hash === 'middle') return MIDDLE_X;
  const left = dir === 1 ? HASH_LEFT : HASH_RIGHT;
  const right = dir === 1 ? HASH_RIGHT : HASH_LEFT;
  return hash === 'left' ? left : right;
};

/** Wind direction (radians, where it blows to) for a choice relative to the kicking direction. */
export const windDirFor = (wind: WindChoice, dir: Direction): number => {
  switch (wind) {
    case 'calm':
    case 'tailwind': return dir === 1 ? Math.PI / 2 : -Math.PI / 2;
    case 'headwind': return dir === 1 ? -Math.PI / 2 : Math.PI / 2;
    case 'crossLeft': return dir === 1 ? Math.PI : 0;
    case 'crossRight': return dir === 1 ? 0 : Math.PI;
  }
};

/** Weather for a drill: clear skies unless the drill exposes wind and the player picked some. */
export const drillWeather = (def: DrillDefinition, options: DrillOptions, dir: Direction): WeatherState => {
  const base = clearWeather();
  if (!def.options.includes('wind') || options.wind === 'calm') return base;
  return { ...base, type: 'wind', windDir: windDirFor(options.wind, dir), windMph: Math.max(0, options.windMph) };
};

/** Line of scrimmage for a drill: kicking drills derive it from the chosen distance / spot. */
export const drillBallOn = (def: DrillDefinition, options: DrillOptions): number => {
  if (def.evaluator === 'fieldGoal') return Math.min(98, Math.max(40, 117 - options.kickDistance));
  if (def.evaluator === 'punt') return Math.min(60, Math.max(1, options.puntFrom));
  return def.ballOn;
};

const requireOf = <T>(value: T | undefined, what: string): T => {
  if (value === undefined) throw new Error(`practice: ${what} is missing from the playbook data`);
  return value;
};

/** Builds the scenario (context, registries, receiver slots) for one rep of a drill. Deterministic per seed. */
export const buildDrillScenario = (def: DrillDefinition, options: DrillOptions, seed: number, rotation = 0): DrillScenario => {
  const registry = loadPlaybookData();
  const level = def.levels[options.difficulty];
  const playId = def.offensePlays[((rotation % def.offensePlays.length) + def.offensePlays.length) % def.offensePlays.length] as string;
  const rawOff: OffensivePlay = requireOf(registry.offensePlays[playId], `offensive play "${playId}"`);
  const offForm = requireOf(registry.offensiveFormations[rawOff.formation], `formation "${rawOff.formation}"`);
  const mOff = materializePlay(rawOff, offForm, registry.routes);
  const registries: PlayRegistries = { offensiveFormations: { [mOff.play.formation]: mOff.formation }, defensiveFormations: {} };
  let defensivePlay: DefensivePlay = EMPTY_DEFENSE;
  let defSlots: OffensiveFormation['slots'] = [];
  if (def.defensePlay) {
    const rawDef = requireOf(registry.defensePlays[def.defensePlay], `defensive play "${def.defensePlay}"`);
    const defForm = requireOf(registry.defensiveFormations[rawDef.formation], `formation "${rawDef.formation}"`);
    const mDef = materializeDefensivePlay(rawDef, defForm, offensiveStrength(mOff.formation), mOff.formation);
    defensivePlay = mDef.play;
    defSlots = mDef.formation.slots;
    registries.defensiveFormations = { [mDef.play.formation]: mDef.formation };
  }
  const userSide = PRACTICE_USER_SIDE;
  const opponent = otherSide(userSide);
  const offense: TeamSide = def.userUnit === 'offense' ? userSide : opponent;
  const gold = practiceSquad('gold', level.userQuality ?? 'starter');
  const scout = practiceSquad('scout', level.opponent);
  const squadOf = (side: TeamSide) => (side === userSide ? gold : scout);
  const direction = PRACTICE_DIRECTION;
  const special = specialFor(rawOff.concept);
  const ballOn = drillBallOn(def, options);
  const kick = special === 'fieldGoal' || special === 'punt' || special === 'extraPoint';
  const controllers: PlayContext['controllers'] = { home: 'ai', away: 'ai' };
  if (def.control === 'engine') controllers[userSide] = 'human';
  const ctx: PlayContext = {
    playIndex: rotation,
    down: kick ? 4 : 1,
    distance: 10,
    ballOn,
    ballX: kick ? hashX(options.hash, direction) : MIDDLE_X,
    direction,
    offense,
    offensivePlay: mOff.play,
    defensivePlay,
    offenseLineup: lineupFor(squadOf(offense), mOff.formation.slots),
    defenseLineup: lineupFor(squadOf(otherSide(offense)), defSlots),
    coaches: {},
    weather: drillWeather(def, options, direction),
    difficulty: getDifficulty(options.difficulty),
    ruleset: practiceRuleset(),
    controllers,
    userSide,
    userControl: def.userUnit,
    controlRole: def.controlRole,
    quarter: 1,
    clockRemaining: 900,
    scoreDiff: 0,
    special,
    crowdFactor: 0,
    rng: createRng(seed).fork('play'),
    fatigue: {},
    clockRunning: false,
    hurryUp: false,
  };
  return {
    def, options, level, seed, rotation, ctx, registries,
    formation: mOff.formation, routes: mOff.routes, receiverSlots: receiverSlots(mOff.play, mOff.formation),
    userSide, squads: { [userSide]: gold.identity, [opponent]: scout.identity } as Record<TeamSide, SquadIdentity>,
  };
};
