import { clamp01 } from '@/core/math';
import { rollInjury } from '@/players/injuries';
import { momentum } from '@/physics/contact';
import type { Athlete, PlayState } from '../play-types';
import { emit, type EngineEnv } from './env';

/**
 * In-play injury rolls on tackles and big hits. Contact intensity comes from the combined momentum of the
 * bodies involved (a hit stick adds a third); fatigue, age, durability, history, the slick field and the
 * ruleset's injury switch are all folded in by players/injuries.ts. An injured athlete finishes the play and
 * is reported in PlayOutcome.injuries; the engine deactivates him once the play is dead.
 */
export const INJURY_MOMENTUM_SCALE = 4000;

/** 0..1 contact intensity for a collision between two athletes. */
export const contactIntensity = (a: Athlete, b: Athlete, hitStick = false): number =>
  clamp01(((momentum(a) + momentum(b)) / INJURY_MOMENTUM_SCALE) * (hitStick ? 1.3 : 1));

/** Rolls an injury for every athlete in the collision (at most one per athlete per play). */
export const rollContactInjuries = (state: PlayState, env: EngineEnv, athletes: readonly Athlete[], intensity: number): void => {
  const ctx = state.ctx;
  if (!ctx.ruleset.injuries) return;
  for (const a of athletes) {
    if (env.injuredIds.has(a.id)) continue;
    const player = env.players[a.id];
    if (!player) continue;
    const injury = rollInjury(env.rng, player, {
      contact: intensity, fatigue: a.fatigue, playCount: Math.floor(ctx.playIndex / 2), injuriesEnabled: true, weatherSlick: ctx.weather.fieldSlick,
    });
    if (!injury) continue;
    env.injuredIds.add(a.id);
    env.injuries.push({ playerId: a.playerId, severity: injury.severity });
    emit(state, { type: 'injury', tick: state.tick, athlete: a.id, severity: injury.severity });
  }
};
