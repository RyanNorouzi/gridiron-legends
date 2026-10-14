/**
 * Event lookups for chain B's contact looks (art bible §6.2-§7): which contact event concerns an athlete right now
 * and how long ago it happened, the render-only shed-move choice, the tackle-kind -> clip-pair table and the
 * hitstop clock. Everything is a pure function of the play's events, the scene tick and id hashes, so live play, a
 * replay and a replay seek pick the same clips (no Math.random, no frame clock).
 */
import type { PlayEvent, TackleKind } from '@/game/play-events';
import type { LineAnimId, TackleAnimId } from '../anim-ids';
import { MAX_RENDER_OFFSET, type Look } from '../anim';
import type { AnimMemory } from '../anim-memory';
import { idHash } from '../anim-select';

/** An event of type T. */
export type EventOf<T extends PlayEvent['type']> = Extract<PlayEvent, { type: T }>;

/**
 * The athlete's latest event of one of `types` at or before the current tick and at most `within` seconds old
 * (null when none), with its age in seconds.
 */
export const recentEvent = <T extends PlayEvent['type']>(mem: AnimMemory, id: string, types: readonly T[], within: number): { ev: EventOf<T>; age: number } | null => {
  const list = mem.eventsOf(id);
  for (let i = list.length - 1; i >= 0; i--) {
    const e = list[i] as PlayEvent;
    const age = mem.timeSince(e);
    if (age < -1e-6) continue;
    if (age > within) return null;
    if ((types as readonly string[]).includes(e.type)) return { ev: e as EventOf<T>, age: Math.max(0, age) };
  }
  return null;
};

/** The play's latest event of a type at or before now (any athlete), or null. */
export const lastPlayEvent = <T extends PlayEvent['type']>(mem: AnimMemory, type: T): EventOf<T> | null => {
  const list = mem.events;
  for (let i = list.length - 1; i >= 0; i--) {
    const e = list[i] as PlayEvent;
    if (e.type === type && e.tick <= mem.tick + 1e-6) return e as EventOf<T>;
  }
  return null;
};

/** Shed moves (bible §6.2). */
export type ShedMove = 'swim' | 'rip' | 'spinMove' | 'longArmShed';

const pickWeighted = (h: number, table: readonly (readonly [ShedMove, number])[]): ShedMove => {
  let r = h % 100;
  for (const [m, w] of table) {
    if (r < w) return m;
    r -= w;
  }
  return (table[0] as readonly [ShedMove, number])[0];
};

/**
 * Render-only shed choice of a defender beating a block, weighted by role (bible §6.2): interior linemen mostly rip
 * and long-arm (a bull rush turned into a rip), edge rushers swim, spin and rip, blitzers rip or swim. Deterministic
 * from the defender id and the shed tick.
 */
export const shedChoice = (defenderId: string, position: string, tick: number): ShedMove => {
  const h = idHash(`${defenderId}|${Math.round(tick)}`);
  if (position === 'DT' || position === 'NT') return pickWeighted(h, [['rip', 70], ['longArmShed', 20], ['swim', 10]]);
  if (position === 'DE') return pickWeighted(h, [['swim', 35], ['spinMove', 25], ['rip', 25], ['longArmShed', 15]]);
  return pickWeighted(h, [['rip', 50], ['swim', 50]]);
};

/** Tackler / carrier clips of a tackle kind, and the tackler frame at the moment of contact. */
export interface TackleChoreo { tackler: TackleAnimId; carrierHeadOn: TackleAnimId; carrierBehind: TackleAnimId; impactFrame: number }

/** Clip pairs per tackle kind (bible §6.3). */
export const TACKLE_CHOREO: Readonly<Record<TackleKind, TackleChoreo>> = Object.freeze({
  wrap: { tackler: 'wrap', carrierHeadOn: 'tackledBack', carrierBehind: 'tackledFwd', impactFrame: 1 },
  gang: { tackler: 'wrap', carrierHeadOn: 'tackledBack', carrierBehind: 'tackledFwd', impactFrame: 1 },
  strip: { tackler: 'wrap', carrierHeadOn: 'tackledBack', carrierBehind: 'tackledFwd', impactFrame: 1 },
  openField: { tackler: 'openFieldWrap', carrierHeadOn: 'rolledDown', carrierBehind: 'rolledDown', impactFrame: 1 },
  arm: { tackler: 'armGrab', carrierHeadOn: 'spunDown', carrierBehind: 'spunDown', impactFrame: 1 },
  dive: { tackler: 'diveTackle', carrierHeadOn: 'tripped', carrierBehind: 'tripped', impactFrame: 2 },
  hitStick: { tackler: 'bigHit', carrierHeadOn: 'blownUp', carrierBehind: 'blownUp', impactFrame: 2 },
});

/** Seconds both looks of a hit stick freeze at the impact (render-only hitstop: 3 frames at 60 Hz). */
export const HITSTOP_SECONDS = 3 / 60;

/** Clip time with a hitstop at `impact` seconds: the clock stands still for HITSTOP_SECONDS there. */
export const withHitstop = (t: number, impact: number): number => (t <= impact ? t : Math.max(impact, t - HITSTOP_SECONDS));

/** Line clips a shed move plays for the defender (the blocker plays 'beaten'). */
export const SHED_CLIP: Readonly<Record<ShedMove, LineAnimId>> = Object.freeze({ swim: 'swim', rip: 'rip', spinMove: 'spinMove', longArmShed: 'longArmShed' });

/** Smooth 0..1 ramp (offsets ease in instead of popping). */
export const ramp = (t: number, over: number): number => {
  const x = Math.max(0, Math.min(1, t / over));
  return x * x * (3 - 2 * x);
};

/**
 * Draws a body over another one (a tackler finishing on top of the carrier, a pancaking blocker on his man): the
 * compositor sorts by feet y (look.dy included) and clamps dx / dy to MAX_RENDER_OFFSET x tier, but not the lift.
 * So the body sorts `need` art px lower and is lifted back up by the same amount, only while the whole dy stays
 * within the clamp; otherwise the clamp would eat part of the dy but none of the lift and the body would be drawn
 * `need` px off his real spot (floating away from the man he tackled). When the room is not there the look is left
 * where it is (drawn behind; `layer` still breaks ties). `feetY` / `otherFeetY` are the placed feet (art px).
 */
export const liftOver = (l: Look, feetY: number, otherFeetY: number, tierScale: number, maxLift = Infinity): Look => {
  const maxOff = Math.round(MAX_RENDER_OFFSET * tierScale);
  const dy = Math.round(l.dy);
  const need = Math.ceil(otherFeetY - (feetY + dy) + 1);
  const layer = Math.max(1, l.layer ?? 1);
  if (need <= 0 || need > maxLift || dy + need > maxOff) return { ...l, layer };
  return { ...l, dy: dy + need, lift: (l.lift ?? 0) + need, layer };
};
