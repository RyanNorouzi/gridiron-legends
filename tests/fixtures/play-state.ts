/**
 * Shared test fixture: builds a real PlayState (presnap) from bundled playbook data and generated players.
 * Used by AI, engine and simulation tests. Do not edit; add new fixture files alongside instead.
 */
import { createRng, type Rng } from '@/core/rng';
import { vec2, type Vec2 } from '@/core/vec2';
import { generatePlayer, type PlayerQuality } from '@/players/generator';
import { createNamePool } from '@/players/names';
import type { Player, Position } from '@/players/types';
import { loadPlaybookData, materializeDefensivePlay, materializePlay, type PlaybookRegistry } from '@/playbook/loader';
import { formationToField } from '@/playbook/transform';
import type { DefensivePlay, OffensivePlay, RouteDef } from '@/playbook/types';
import { createAthlete, createPlayState } from '@/game/athlete';
import { createBall } from '@/physics/ball';
import { getDifficulty, getRuleset } from '@/game/rulesets';
import { clearWeather } from '@/game/weather';
import type { Athlete, PlayContext, PlayState } from '@/game/play-types';
import { fieldY, MIDDLE_X, otherSide, type Direction, type TeamSide } from '@/game/types';
import type { DifficultyId } from '@/game/types';

export interface FixtureOptions {
  offensePlayId?: string;
  defensePlayId?: string;
  ballOn?: number;
  ballX?: number;
  direction?: Direction;
  down?: number;
  distance?: number;
  offense?: TeamSide;
  seed?: number;
  quality?: PlayerQuality;
  difficulty?: DifficultyId;
  ruleset?: 'arcade' | 'simulation';
  /** Formation role the human controls (offense: e.g. 'QB'; defense: e.g. 'FS'); null = nobody. */
  controlRole?: string | null;
  userSide?: TeamSide | null;
  recordFrames?: boolean;
}

export interface Fixture {
  state: PlayState;
  registry: PlaybookRegistry;
  routes: Record<string, RouteDef>;
  rng: Rng;
  offensivePlay: OffensivePlay;
  defensivePlay: DefensivePlay;
  athlete(id: string): Athlete;
  byRole(side: 'offense' | 'defense', role: string): Athlete;
}

const DEFAULT_OFF = 'shotgun-mesh';
const DEFAULT_DEF = '43-cover3';

const pickPlay = <T extends { id: string }>(plays: Record<string, T>, id: string | undefined, fallback: string, label: string): T => {
  const chosen = plays[id ?? fallback] ?? (id === undefined ? Object.values(plays)[0] : undefined);
  if (!chosen) throw new Error(`fixture: unknown ${label} play '${id ?? fallback}'. Available: ${Object.keys(plays).slice(0, 12).join(', ')}...`);
  return chosen;
};

const makePlayer = (rng: Rng, position: Position, quality: PlayerQuality, names: ReturnType<typeof createNamePool>): Player =>
  generatePlayer(rng, { position, quality, names, regions: ['northeast'], year: 2026 });

/** Builds a presnap PlayState for the given play call. Deterministic per seed. */
export const buildPlayState = (o: FixtureOptions = {}): Fixture => {
  const registry = loadPlaybookData();
  const rng = createRng(o.seed ?? 1);
  const names = createNamePool(rng.fork('names'));
  const quality = o.quality ?? 'starter';
  const rawOff = pickPlay(registry.offensePlays, o.offensePlayId, DEFAULT_OFF, 'offensive');
  const rawDef = pickPlay(registry.defensePlays, o.defensePlayId, DEFAULT_DEF, 'defensive');
  const offForm = registry.offensiveFormations[rawOff.formation];
  const defForm = registry.defensiveFormations[rawDef.formation];
  if (!offForm || !defForm) throw new Error(`fixture: formation missing for ${rawOff.id}/${rawDef.id}`);
  const mOff = materializePlay(rawOff, offForm, registry.routes);
  const mDef = materializeDefensivePlay(rawDef, defForm, undefined, offForm);
  const offensivePlay = mOff.play;
  const defensivePlay = mDef.play;
  const direction: Direction = o.direction ?? 1;
  const ballOn = o.ballOn ?? 25;
  const ballX = o.ballX ?? MIDDLE_X;
  const losY = fieldY(ballOn, direction);
  const distance = o.distance ?? 10;
  const offense: TeamSide = o.offense ?? 'home';
  const defense = otherSide(offense);
  const prng = rng.fork('players');

  const offenseLineup: Record<string, Player> = {};
  for (const slot of mOff.formation.slots) offenseLineup[slot.role] = makePlayer(prng, slot.position, quality, names);
  const defenseLineup: Record<string, Player> = {};
  for (const slot of mDef.formation.slots) defenseLineup[slot.role] = makePlayer(prng, slot.position, quality, names);

  const ctx: PlayContext = {
    playIndex: 0,
    down: o.down ?? 1,
    distance,
    ballOn,
    ballX,
    direction,
    offense,
    offensivePlay,
    defensivePlay,
    offenseLineup,
    defenseLineup,
    coaches: {},
    weather: clearWeather(),
    difficulty: getDifficulty(o.difficulty ?? 'pro'),
    ruleset: getRuleset(o.ruleset ?? 'simulation'),
    controllers: { home: 'ai', away: 'ai' },
    userSide: o.userSide ?? null,
    userControl: o.userSide ? (o.userSide === offense ? 'offense' : 'defense') : 'none',
    controlRole: o.controlRole ?? null,
    quarter: 1,
    clockRemaining: 600,
    scoreDiff: 0,
    special: 'none',
    crowdFactor: 0.5,
    rng: rng.fork('play:0'),
    fatigue: {},
  };
  if (o.userSide) ctx.controllers[o.userSide] = 'human';

  const offPositions = formationToField(mOff.formation, ballX, losY, direction);
  const defPositions = formationToField(mDef.formation, ballX, losY, direction);
  const offFacing = direction === 1 ? Math.PI / 2 : -Math.PI / 2;
  const athletes: Athlete[] = [];
  for (const slot of mOff.formation.slots) {
    const assignment = offensivePlay.assignments[slot.role];
    if (!assignment) throw new Error(`fixture: no assignment for offensive role ${slot.role}`);
    athletes.push(createAthlete({ player: offenseLineup[slot.role] as Player, side: 'offense', teamSide: offense, role: slot.role, pos: offPositions[slot.role] as Vec2, facing: offFacing, assignment, eligible: slot.eligible === true }));
  }
  for (const slot of mDef.formation.slots) {
    const assignment = defensivePlay.assignments[slot.role];
    if (!assignment) throw new Error(`fixture: no assignment for defensive role ${slot.role}`);
    athletes.push(createAthlete({ player: defenseLineup[slot.role] as Player, side: 'defense', teamSide: defense, role: slot.role, pos: defPositions[slot.role] as Vec2, facing: offFacing + Math.PI, assignment }));
  }
  const ball = createBall(vec2(ballX, losY), 'snap');
  ball.phase = 'presnap';
  const state = createPlayState(ctx, athletes, ball, { losY, firstDownY: losY + direction * distance, recordFrames: o.recordFrames ?? false });
  if (o.controlRole && o.userSide) {
    const side = o.userSide === offense ? 'offense' : 'defense';
    const a = athletes.find((x) => x.side === side && x.role === o.controlRole);
    if (a) { a.controlled = true; state.controlledId = a.id; state.controlledIds[o.userSide] = a.id; }
  }
  const athlete = (id: string): Athlete => {
    const a = athletes.find((x) => x.id === id);
    if (!a) throw new Error(`fixture: no athlete ${id}`);
    return a;
  };
  return {
    state, registry, routes: mOff.routes, rng, offensivePlay, defensivePlay, athlete,
    byRole: (side, role) => athlete(`${side === 'offense' ? 'off' : 'def'}:${role}`),
  };
};
