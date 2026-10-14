import { clamp } from '@/core/math';
import type { Rng } from '@/core/rng';
import type { PlayContext } from '@/game/play-types';
import type { CatchKind, IncompleteReason, TackleKind, ThrowType } from '@/game/play-events';
import { isFakePlay } from '@/playbook/special-teams';
import { roundYards } from './sim-random';
import type { MatchupKnobs, Matchups, RatedPlayer, ReceiverOption } from './matchups';
import { resolvePass } from './pass-model';
import { resolveRun } from './run-model';
import { difficultyFor } from '@/game/difficulty-sides';

/**
 * Statistical play model: turns matchups + situation + weather + difficulty into ONE resolved play
 * (who carried/threw/caught, yards, turnovers, tackles, time). The outcome assembler (fast-sim.ts)
 * translates a resolution into a PlayOutcome; the special-teams module has its own resolutions.
 * Pure apart from the injected rng: the same ctx.rng stream always yields the same resolution.
 */

/**
 * Difficulty knobs, null for a human side (attributes only). They only ever steer the model's stand-ins for AI
 * DECISIONS (how open a receiver gets, which man the QB reads, whether a defender breaks on the ball, how a tackler
 * approaches, how the front fits the run); the dice resolved after those decisions (catch vs contest, pick vs
 * break-up, broken tackle, fumble) are ratings only, like the live engine.
 */
export interface ModelKnobs extends MatchupKnobs {
  /** DifficultyProfile.interceptionAwareness for an AI defense: how often a defender breaks on the ball (contests it). */
  interceptionIq: number | null;
  /** DifficultyProfile.tackleDecisionQuality for an AI defense: how often a tackler squares up instead of lunging. */
  tackleIq: number | null;
  /** DifficultyProfile.pursuitQuality for an AI defense: run fits (stuffs at the line). Optional for older literals. */
  pursuitIq?: number | null;
}

export interface TackleInfo {
  tackler: RatedPlayer;
  assists: RatedPlayer[];
  kind: TackleKind;
  /** Defenders who whiffed (broken tackles) before the runner went down. */
  missed: RatedPlayer[];
}

export interface FumbleInfo {
  forcedBy: RatedPlayer | null;
  recoveredBy: RatedPlayer;
  /** True when the defense recovered (a turnover). */
  lost: boolean;
  /** Offense-perspective yard line where the ball came loose. */
  spotBallOn: number;
  returnYards: number;
  /** The recovering defender took it to the house. */
  touchdown: boolean;
}

export interface RunResolution {
  kind: 'run';
  carrier: RatedPlayer;
  /** QB took off on a called pass. */
  scramble: boolean;
  designedQb: boolean;
  /** Yards gained by the runner before any fumble return (negative for losses). */
  yards: number;
  stuffed: boolean;
  brokenTackles: number;
  yardsAfterContact: number;
  contact: boolean;
  slide: boolean;
  tackle: TackleInfo | null;
  outOfBounds: boolean;
  touchdown: boolean;
  safety: boolean;
  fumble: FumbleInfo | null;
  timeElapsed: number;
}

export interface SackInfo {
  by: RatedPlayer;
  assists: RatedPlayer[];
  /** Positive yards lost. */
  yardsLost: number;
  /** A blocker charged with the sack. */
  beatenBlocker: RatedPlayer | null;
}

export interface InterceptionInfo {
  by: RatedPlayer;
  /** Offense-perspective yard line of the pick. */
  spotBallOn: number;
  returnYards: number;
  touchdown: boolean;
  /** Picked in the end zone and downed there. */
  touchback: boolean;
  tackledBy: RatedPlayer | null;
}

export interface PassResolution {
  kind: 'pass';
  passer: RatedPlayer;
  playAction: boolean;
  screen: boolean;
  fakeTo: RatedPlayer | null;
  pressure: boolean;
  pressureBy: RatedPlayer | null;
  sack: SackInfo | null;
  throwAway: boolean;
  target: ReceiverOption | null;
  throwType: ThrowType;
  airYards: number;
  /** Separation (yards) at the throw. */
  separation: number;
  complete: boolean;
  incompleteReason: IncompleteReason | null;
  /** Defender who influenced the catch point (break-up, contest, interception). */
  defender: RatedPlayer | null;
  contested: boolean;
  catchKind: CatchKind;
  yac: number;
  yardsAfterContact: number;
  brokenTackles: number;
  /** Offensive yards: air + yac on a completion, 0 otherwise (sack losses live in sack.yardsLost). */
  yards: number;
  interception: InterceptionInfo | null;
  tackle: TackleInfo | null;
  outOfBounds: boolean;
  touchdown: boolean;
  /** Sacked in his own end zone. */
  safety: boolean;
  fumble: FumbleInfo | null;
  timeElapsed: number;
}

export interface KneelResolution { kind: 'kneel'; passer: RatedPlayer; yards: number; timeElapsed: number }
export interface SpikeResolution { kind: 'spike'; passer: RatedPlayer; timeElapsed: number }

export type PlayResolution = RunResolution | PassResolution | KneelResolution | SpikeResolution;

/** Difficulty knobs for the sides the AI controls ('watch' counts as AI; only 'human' is exempt). */
export const knobsFor = (ctx: PlayContext): ModelKnobs => {
  const defense = ctx.offense === 'home' ? 'away' : 'home';
  // Each side's own profile (difficultyFor): in a simulated user game the CPU decides at the selected level and the
  // user's club at the neutral 'pro' one; AI vs AI both read the game's difficulty.
  const o = difficultyFor(ctx, ctx.offense);
  const d = difficultyFor(ctx, defense);
  const aiOffense = ctx.controllers[ctx.offense] !== 'human';
  const aiDefense = ctx.controllers[defense] !== 'human';
  return {
    qbIq: aiOffense ? o.qbDecisionQuality : null,
    coverageIq: aiDefense ? d.coverageAnticipation : null,
    interceptionIq: aiDefense ? d.interceptionAwareness : null,
    tackleIq: aiDefense ? d.tackleDecisionQuality : null,
    pursuitIq: aiDefense ? d.pursuitQuality : null,
  };
};

/** The QB in the matchups, or whoever snaps the ball on plays without one. */
const passerOf = (m: Matchups): RatedPlayer => {
  const p = m.passer ?? m.offense[0];
  if (!p) throw new Error('play-model: the offense has no players on the field');
  return p;
};

/** RPO read: the QB pulls the ball and throws when the box is loaded or a blitz shows. */
export const rpoThrows = (m: Matchups, rng: Rng): boolean => {
  const loaded = m.boxCount >= 7 || m.blitzCount > 0;
  const p = clamp((loaded ? 0.6 : 0.35) + 0.2 * (m.qbDecision - 0.5), 0.1, 0.9);
  return rng.chance(p);
};

/** A kneel-down: a yard or two lost, a couple of seconds, no contact. */
export const resolveKneel = (m: Matchups, rng: Rng): KneelResolution => ({
  kind: 'kneel', passer: passerOf(m), yards: roundYards(-clamp(Math.round(rng.gaussian(1.2, 0.5)), 0, 2)), timeElapsed: clamp(1.5 + rng.range(0, 1.2), 1, 3),
});

/** A clock-stopping spike. */
export const resolveSpike = (m: Matchups, rng: Rng): SpikeResolution => ({ kind: 'spike', passer: passerOf(m), timeElapsed: clamp(0.8 + rng.range(0, 0.7), 0.5, 2) });

/**
 * Resolves a scrimmage play (anything that is not a live kick): kneels and spikes short-circuit, runs and
 * designed QB runs go to the run model, RPOs read the box, everything else is a dropback whose pressure may
 * turn it into a scramble (a RunResolution with `scramble: true`).
 */
export const resolveScrimmagePlay = (ctx: PlayContext, m: Matchups, knobs: ModelKnobs, rng: Rng = ctx.rng): PlayResolution => {
  const play = ctx.offensivePlay;
  const passer = passerOf(m);
  switch (play.type) {
    case 'kneel': return resolveKneel(m, rng);
    case 'spike': return resolveSpike(m, rng);
    case 'run':
      return resolveRun(ctx, m, knobs, rng, { carrier: m.carrier ?? passer, scramble: false, designedQb: false, draw: play.concept === 'draw' });
    case 'qbRun':
      return resolveRun(ctx, m, knobs, rng, { carrier: passer, scramble: false, designedQb: true, draw: play.concept === 'draw' });
    case 'rpo':
      if (rpoThrows(m, rng)) return resolvePass(ctx, m, knobs, rng, { playAction: false, screen: false, rpo: true });
      return resolveRun(ctx, m, knobs, rng, { carrier: m.carrier ?? passer, scramble: false, designedQb: false, draw: false });
    case 'screen':
      return resolvePass(ctx, m, knobs, rng, { playAction: false, screen: true, rpo: false });
    case 'playAction':
      return resolvePass(ctx, m, knobs, rng, { playAction: true, screen: false, rpo: false });
    case 'special':
      // A fake kick that is typed 'special' by data error: treat the kick unit as a run.
      return resolveRun(ctx, m, knobs, rng, { carrier: m.carrier ?? passer, scramble: false, designedQb: false, draw: false });
    case 'pass':
    default:
      return resolvePass(ctx, m, knobs, rng, { playAction: play.concept === 'playAction', screen: play.concept === 'screen', rpo: false });
  }
};

/** True when the play should run through the scrimmage model (regular plays, two-point tries and fakes). */
export const isScrimmageContext = (ctx: PlayContext): boolean =>
  ctx.special === 'none' || ctx.special === 'twoPoint' || isFakePlay(ctx.offensivePlay);
