import type { AttributeKey, AttributeSet } from '@/players/types';
import { getDifficulty } from './rulesets';
import type { PlayContext } from './play-types';
import { otherSide, type ControllerKind, type DifficultyProfile, type TeamSide } from './types';

/**
 * Per-side difficulty. The selected difficulty is the CPU opponent's: in a human-vs-CPU game the CPU team decides
 * under the selected profile (and, at All-Pro / Legend, plays with its CPU PERFORMANCE EDGE), while the human's own
 * AI teammates decide under the neutral 'pro' profile so a hard setting is never cancelled out by equally sharp
 * teammates. The human-only assists (pass / tackle / ball security) come from the selected profile and apply to the
 * human. AI-vs-AI games (watch mode, league sims, balance tests) have no per-side profiles: both sides read the
 * selected profile exactly as before and nobody gets an edge.
 *
 * Every AI / engine read of the difficulty goes through `difficultyFor`. On scrimmage downs where the human DEFENDS,
 * his team instead plays under userDefenseProfile (a Legend-like defense with a big performance edge).
 */

/** The CPU team's performance edge: fractional rating boosts (0.1 = +10%). */
export interface CpuEdge {
  speed: number;
  strength: number;
  skill: number;
}

/** No edge (AI vs AI, the human's team, Rookie / Pro). */
export const NO_EDGE: Readonly<CpuEdge> = Object.freeze({ speed: 0, strength: 0, skill: 0 });

/** Ratings each edge multiplies. Stamina, awareness, reaction, vision and kicking are never boosted. */
export const EDGE_KEYS: Readonly<Record<keyof CpuEdge, readonly AttributeKey[]>> = {
  speed: ['speed', 'acceleration', 'agility'],
  strength: ['strength', 'balance'],
  skill: ['hands', 'catching', 'throwAccuracy', 'tackling', 'carrying', 'blocking', 'passRush', 'routeRunning', 'release', 'coverage'],
};

/** Highest rating an edge can lift an attribute to (the rating scale's ceiling). */
export const EDGE_RATING_CAP = 99;
/**
 * Speed and acceleration may go past 99 under the edge (movement continues the speed curves linearly above 99:
 * physics/speed.ts overTopSpeed / overAccelScale),
 * so the edge still separates a CPU burner from a user one who is already near the top of the scale.
 */
export const EDGE_SPEED_RATING_CAP = 125;
const OVERFLOW_KEYS: ReadonlySet<AttributeKey> = new Set<AttributeKey>(['speed', 'acceleration']);

/** What decides who the human is: the controllers plus the optional managed side of a simulated user game. */
export interface HumanTeamSource {
  controllers: Record<TeamSide, ControllerKind>;
  humanTeam?: TeamSide | null;
}

/**
 * The side a single human plays against the CPU, or null for AI vs AI: exactly one 'human' controller wins; any
 * 'watch' controller (watch mode) or two humans (head to head) means no CPU opponent; with both sides 'ai' the
 * managed `humanTeam` of a simulated user game is used.
 */
export const humanTeamSide = (s: HumanTeamSource): TeamSide | null => {
  const sides: readonly TeamSide[] = ['home', 'away'];
  if (sides.some((x) => s.controllers[x] === 'watch')) return null;
  const humans = sides.filter((x) => s.controllers[x] === 'human');
  if (humans.length === 1) return humans[0] as TeamSide;
  if (humans.length === 2) return null;
  return s.humanTeam ?? null;
};

/**
 * The profile the human's AI teammates decide under: the neutral 'pro' decisions (never boosted, no edge) with the
 * selected profile's user assists, which only ever touch the athlete the human controls.
 */
export const teammateProfile = (selected: DifficultyProfile): DifficultyProfile => {
  const pro = getDifficulty('pro');
  return {
    ...pro,
    userBallSecurityAssist: selected.userBallSecurityAssist,
    userPassAssist: selected.userPassAssist,
    userTackleAssist: selected.userTackleAssist ?? pro.userTackleAssist,
    cpuSpeedEdge: 0,
    cpuStrengthEdge: 0,
    cpuSkillEdge: 0,
  };
};

/** Per-team profiles for a human-vs-CPU game (undefined for AI vs AI). */
export const sideDifficulties = (s: HumanTeamSource & { difficulty: DifficultyProfile }): Record<TeamSide, DifficultyProfile> | undefined => {
  const human = humanTeamSide(s);
  if (human === null) return undefined;
  const cpu = otherSide(human);
  const out = { [human]: teammateProfile(s.difficulty), [cpu]: { ...s.difficulty } } as Record<TeamSide, DifficultyProfile>;
  return out;
};

/**
 * USER DEFENSE BOOST (the owner asked to "extremely buff the defense when you're playing as it"): on scrimmage downs
 * where the human's team is on DEFENSE, his whole defense decides like a Legend unit (instant reactions, perfect
 * angles, sure tackles, ball-hawking coverage), his own tackling gets the full assist, and the unit plays with a big
 * performance edge (same mechanism as the CPU edge: speed, strength and skill ratings, incl. tackling, coverage, pass
 * rush and hands for picks). Kicks and the human's offense are unchanged.
 */
export const USER_DEFENSE_EDGE: Readonly<CpuEdge> = Object.freeze({ speed: 0.25, strength: 0.35, skill: 0.5 });

/** The profile the human's defense plays under on a scrimmage down (see USER_DEFENSE_EDGE). */
export const userDefenseProfile = (selected: DifficultyProfile): DifficultyProfile => {
  const base = teammateProfile(selected);
  return {
    ...base,
    aiReactionDelay: 0.02,
    coverageAnticipation: 1,
    pursuitQuality: 1,
    tackleDecisionQuality: 1,
    interceptionAwareness: 1,
    blockingIq: 1,
    userTackleAssist: 1,
    cpuSpeedEdge: USER_DEFENSE_EDGE.speed,
    cpuStrengthEdge: USER_DEFENSE_EDGE.strength,
    cpuSkillEdge: USER_DEFENSE_EDGE.skill,
  };
};

/**
 * CPU OFFENSE BOOST (the owner: "make the offense of the opposing team even stronger"): on scrimmage downs where the
 * CPU has the ball against the human, its unit plays with this extra performance edge on top of its difficulty's own
 * (added to cpuSpeedEdge / cpuStrengthEdge / cpuSkillEdge, each capped at CPU_OFFENSE_EDGE_CAP). It counters the user
 * defense boost so the CPU offense still moves the ball, while every level stays harder than the one below.
 */
export const CPU_OFFENSE_EDGE: Readonly<CpuEdge> = Object.freeze({ speed: 0.24, strength: 0.32, skill: 0.5 });
export const CPU_OFFENSE_EDGE_CAP = 0.8;

/** The CPU's profile on a scrimmage down where it has the ball against the human (see CPU_OFFENSE_EDGE). */
export const cpuOffenseProfile = (selected: DifficultyProfile): DifficultyProfile => {
  const add = (base: number | undefined, extra: number): number => Math.min(CPU_OFFENSE_EDGE_CAP, Math.max(0, base ?? 0) + extra);
  return {
    ...selected,
    cpuSpeedEdge: add(selected.cpuSpeedEdge, CPU_OFFENSE_EDGE.speed),
    cpuStrengthEdge: add(selected.cpuStrengthEdge, CPU_OFFENSE_EDGE.strength),
    cpuSkillEdge: add(selected.cpuSkillEdge, CPU_OFFENSE_EDGE.skill),
  };
};

/** Scrimmage downs (not kicks): where the user defense boost applies. */
const isScrimmageSpecial = (special: string): boolean => special === 'none' || special === 'twoPoint';

/**
 * Per-team profiles for ONE play: sideDifficulties, plus — on a scrimmage down where the human DEFENDS — the user
 * defense boost for his team and the CPU offense boost for the CPU. Undefined for AI vs AI (nobody gets an edge,
 * balance tests unchanged).
 */
export const playSideDifficulties = (
  s: HumanTeamSource & { difficulty: DifficultyProfile }, offense: TeamSide, special: string,
): Record<TeamSide, DifficultyProfile> | undefined => {
  const base = sideDifficulties(s);
  const human = humanTeamSide(s);
  if (!base || human === null || human === offense || !isScrimmageSpecial(special)) return base;
  return { ...base, [human]: userDefenseProfile(s.difficulty), [offense]: cpuOffenseProfile(s.difficulty) };
};

/** The profile a team decides under in a game state (coach hooks, play callers): per-side when human vs CPU. */
export const teamDifficulty = (s: HumanTeamSource & { difficulty: DifficultyProfile }, side: TeamSide): DifficultyProfile =>
  sideDifficulties(s)?.[side] ?? s.difficulty;

type DifficultyCtx = Pick<PlayContext, 'difficulty' | 'sideDifficulty'>;

/**
 * THE difficulty read for AI decisions and engine systems: the profile of the team `who` plays for (an athlete or a
 * team side). Accepts a PlayContext or anything carrying one (a PlayState). AI vs AI: the context's difficulty.
 */
export const difficultyFor = (src: DifficultyCtx | { ctx: DifficultyCtx }, who: TeamSide | { teamSide: TeamSide }): DifficultyProfile => {
  const ctx = 'ctx' in src ? src.ctx : src;
  const side = typeof who === 'string' ? who : who.teamSide;
  return ctx.sideDifficulty?.[side] ?? ctx.difficulty;
};

/** The CPU performance edge of a team in this play (NO_EDGE unless it is the CPU side of a human-vs-CPU game). */
export const cpuEdgeFor = (ctx: Pick<PlayContext, 'sideDifficulty'>, side: TeamSide): Readonly<CpuEdge> => {
  const p = ctx.sideDifficulty?.[side];
  if (!p) return NO_EDGE;
  const edge = { speed: Math.max(0, p.cpuSpeedEdge ?? 0), strength: Math.max(0, p.cpuStrengthEdge ?? 0), skill: Math.max(0, p.cpuSkillEdge ?? 0) };
  return edge.speed === 0 && edge.strength === 0 && edge.skill === 0 ? NO_EDGE : edge;
};

/** Effective ratings with the edge applied: each boosted rating x (1 + edge), capped at EDGE_RATING_CAP (speed and
 *  acceleration at EDGE_SPEED_RATING_CAP). */
export const applyCpuEdge = (attrs: AttributeSet, edge: Readonly<CpuEdge>): AttributeSet => {
  if (edge === NO_EDGE || (edge.speed === 0 && edge.strength === 0 && edge.skill === 0)) return attrs;
  const out: AttributeSet = { ...attrs };
  for (const group of Object.keys(EDGE_KEYS) as (keyof CpuEdge)[]) {
    const m = 1 + edge[group];
    if (m === 1) continue;
    for (const key of EDGE_KEYS[group]) out[key] = Math.min(OVERFLOW_KEYS.has(key) ? EDGE_SPEED_RATING_CAP : EDGE_RATING_CAP, Math.max(out[key], out[key] * m));
  }
  return out;
};

/**
 * CPU PERFORMANCE EDGE on ball skills: multiplier on a CPU defender's chance to FINISH an interception he gets to
 * (1 + the skill edge; 1 for everyone else). The skill edge's hands / catching boost stops at the 99 ceiling, so a
 * sure-handed CPU defensive back would otherwise gain nothing from it; this keeps Legend's takeaways clearly up.
 */
export const cpuPickScale = (ctx: Pick<PlayContext, 'sideDifficulty'>, side: TeamSide): number => 1 + cpuEdgeFor(ctx, side).skill;
