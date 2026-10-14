/**
 * Pure mapping from game events to recorded-sample cues: which field recordings a snap, a hit, a catch or a
 * whistle layers on top of the synth, how hard a tackle lands (contact intensity from the tackle kind, the
 * closing speed and the bodies involved) and where it sits in the stereo field of the HORIZONTAL screen.
 * Crowd reactions (cheer / roar / groan / boo / oooh / swell) live in crowd-cues.ts.
 */
import { clamp, clamp01 } from '@/core/math';
import type { PlayEvent, TackleKind } from '@/game/play-events';
import type { AudioGameEvent } from './manager';
import type { SampleId } from './sample-manifest';

/** Field position / velocity in absolute yards (x across, y along the field). */
export interface SceneVec {
  x: number;
  y: number;
}

/** The slice of a live athlete the audio layer reads. */
export interface SceneAthlete {
  id: string;
  pos: SceneVec;
  vel: SceneVec;
  massLb: number;
}

/** The slice of the live PlayState the audio layer reads (PlayState satisfies it structurally). */
export interface AudioScene {
  ctx: { direction: 1 | -1 };
  athletes: readonly SceneAthlete[];
  ball: { pos: SceneVec };
}

/** One sample to play for an event. */
export interface SampleCue {
  id: SampleId;
  /** Multiplier on the manifest gain (0..1.2). */
  gain: number;
  /** Milliseconds after the event. */
  delayMs: number;
  /** Stereo position -1..1. */
  pan: number;
}

/** How a contact is voiced: soft thud, solid pad pop or big hit. */
export type ContactTier = 'light' | 'solid' | 'big';

/** How hard each tackle kind lands before speed and mass. */
export const TACKLE_BASE: Readonly<Record<TackleKind, number>> = Object.freeze({
  arm: 0.22, wrap: 0.42, dive: 0.38, strip: 0.45, openField: 0.55, gang: 0.6, hitStick: 0.88,
});

/** Facts about one tackle / collision. */
export interface ContactInput {
  kind: TackleKind;
  /** Relative speed of the two bodies at contact, yards/second (a full sprint is ~9, two sprinters head-on ~18). */
  closingSpeed?: number;
  /** Combined weight of tackler + carrier, lb. */
  massLb?: number;
  /** Extra defenders in on the tackle. */
  assists?: number;
}

/** Closing speed (yd/s) below which speed adds nothing, and the span over which it ramps to its full +0.35. */
export const CLOSING_SPEED_FLOOR = 4;
/** Span (yd/s) above the floor for the full speed bonus: only a near head-on collision of two runners maxes it out. */
export const CLOSING_SPEED_SPAN = 14;

/** 0..1 contact intensity: kind base + up to +0.35 for closing speed, +-0.08 for mass, +0.15 for a pile. */
export const contactIntensity = (c: ContactInput): number => {
  const base = TACKLE_BASE[c.kind] ?? 0.4;
  const speed = c.closingSpeed !== undefined && Number.isFinite(c.closingSpeed)
    ? clamp(((c.closingSpeed - CLOSING_SPEED_FLOOR) / CLOSING_SPEED_SPAN) * 0.35, 0, 0.35) : 0.1;
  const mass = c.massLb !== undefined && Number.isFinite(c.massLb) ? clamp(((c.massLb - 430) / 300) * 0.08, -0.05, 0.08) : 0;
  const pile = Math.min(0.15, Math.max(0, c.assists ?? 0) * 0.06);
  return clamp01(base + speed + mass + pile);
};

/** Tier for a 0..1 contact intensity. */
export const contactTier = (intensity: number): ContactTier => (intensity >= 0.7 ? 'big' : intensity >= 0.4 ? 'solid' : 'light');

/** Yards from the ball (the camera focus) that map to full pan, and the widest pan used. */
export const PAN_YARDS = 20;
/** Widest stereo position used for field sounds (never hard-panned). */
export const PAN_WIDTH = 0.8;

const find = (scene: AudioScene | null, id: unknown): SceneAthlete | null =>
  scene && typeof id === 'string' ? scene.athletes.find((a) => a.id === id) ?? null : null;

/**
 * Stereo position of a point on the horizontal screen. The camera follows the ball and turns the view so the
 * offense attacks to the right, so screen-x is (y - ballY) x direction.
 */
export const panFor = (scene: AudioScene | null, at: SceneVec | null): number => {
  if (!scene || !at) return 0;
  const dy = (at.y - scene.ball.pos.y) * (scene.ctx.direction === -1 ? -1 : 1);
  return clamp(dy / PAN_YARDS, -1, 1) * PAN_WIDTH;
};

/** Contact facts for a two-body collision read from the scene (speeds unknown without one). */
export const contactFromScene = (scene: AudioScene | null, a: unknown, b: unknown, kind: TackleKind, assists = 0): { intensity: number; pan: number } => {
  const p = find(scene, a);
  const q = find(scene, b);
  const closingSpeed = p && q ? Math.hypot(p.vel.x - q.vel.x, p.vel.y - q.vel.y) : undefined;
  const massLb = p && q ? p.massLb + q.massLb : undefined;
  const intensity = contactIntensity({ kind, assists, ...(closingSpeed !== undefined ? { closingSpeed } : {}), ...(massLb !== undefined ? { massLb } : {}) });
  return { intensity, pan: panFor(scene, (q ?? p)?.pos ?? null) };
};

const cue = (id: SampleId, gain: number, delayMs = 0, pan = 0): SampleCue => ({ id, gain, delayMs, pan });

/** The impact layers for a contact of the given intensity. */
export const impactCues = (intensity: number, pan: number): SampleCue[] => {
  const tier = contactTier(intensity);
  if (tier === 'light') return [cue('sfx.tackle_light', 0.95 + intensity * 0.25, 0, pan), cue('sfx.grunt_hit', 0.5, 30, pan)];
  if (tier === 'solid') return [cue('sfx.tackle_solid', 1.1, 0, pan), cue('sfx.pad_clatter', 0.6, 15, pan), cue('sfx.grunt_hit', 0.8, 30, pan)];
  return [
    cue('sfx.tackle_big', 1.2, 0, pan),
    cue('sfx.helmet_clack', 1.1, 5, pan),
    cue('sfx.pad_clatter', 0.8, 15, pan),
    cue('sfx.grunt_hit', 0.95, 35, pan),
  ];
};

/** The runner hitting the turf (and the pile clattering when several defenders are in on it). */
export const downCues = (intensity: number, pan: number, pile: boolean, delayMs: number): SampleCue[] => {
  const out = [cue('sfx.turf', 0.8 + intensity * 0.4, delayMs, pan)];
  if (pile) out.push(cue('sfx.pad_clatter', 1, Math.max(0, delayMs - 60), pan));
  return out;
};

/** A contact within this many ms before a tackle already sounded the impact: the tackle is just the fall. */
export const CONTACT_MEMORY_MS = 900;

/** What the field-sound mapper knows besides the event itself. */
export interface CueContext {
  scene: AudioScene | null;
  /** Milliseconds since the last impact the layer sounded (wrap-up, hit stick, sack); Infinity when none. */
  msSinceContact: number;
}

const kickGain = (power: unknown): number => 0.7 + 0.3 * clamp01(typeof power === 'number' ? power : 0.7);
const LONG_WHISTLE_REASONS = new Set(['touchdown', 'safety', 'timeExpired']);

/** Field-sound cues for an event (empty when the event has no recording). */
export const sfxCuesForEvent = (event: AudioGameEvent, cx: CueContext): SampleCue[] => {
  const scene = cx.scene;
  switch (event.type) {
    case 'snap': return [cue('sfx.snap', 0.9), cue('sfx.stomp', 0.35), cue('sfx.pad_clatter', 1, 90), cue('sfx.grunt_effort', 0.45, 120)];
    case 'audible': return [cue('sfx.stomp', 0.6)];
    case 'throw': return event.throwType === 'throwAway' ? [] : [cue('sfx.grunt_effort', 0.3, 0, panFor(scene, find(scene, event.thrower)?.pos ?? null))];
    case 'catch': {
      const pan = panFor(scene, find(scene, event.receiver)?.pos ?? null);
      const out = [cue('sfx.catch', 1, 0, pan)];
      if (event.catchKind === 'diving') out.push(cue('sfx.turf', 0.7, 160, pan));
      if (event.contested) out.push(cue('sfx.tackle_solid', 0.9, 40, pan));
      return out;
    }
    case 'tipped': return [cue('sfx.catch', 0.5, 0, panFor(scene, find(scene, event.by)?.pos ?? null))];
    case 'wrapUp': {
      const c = contactFromScene(scene, event.tackler, event.carrier, event.kind);
      return [...impactCues(c.intensity, c.pan), cue('sfx.grunt_effort', 0.3, 90, c.pan)];
    }
    case 'hitStick': {
      const c = contactFromScene(scene, event.by, event.on, 'hitStick');
      return impactCues(Math.max(0.8, c.intensity), c.pan);
    }
    case 'tackle': {
      const assists = Array.isArray(event.assists) ? event.assists.length : 0;
      const c = contactFromScene(scene, event.tackler, event.carrier, event.kind, assists);
      const pile = event.kind === 'gang' || assists >= 2;
      // After a struggle the tackle is the finishing blow AND the fall: both sound.
      if (cx.msSinceContact < CONTACT_MEMORY_MS) return [cue('sfx.tackle_solid', 1, 0, c.pan), ...downCues(c.intensity, c.pan, pile, 60)];
      return [...impactCues(c.intensity, c.pan), ...downCues(c.intensity, c.pan, pile, 120 + Math.round(c.intensity * 110))];
    }
    case 'sack': {
      const qb = scene?.athletes.find((a) => a.id.startsWith('off:QB')) ?? null;
      const c = contactFromScene(scene, event.by, qb?.id, 'openField', event.assists.length);
      if (cx.msSinceContact < CONTACT_MEMORY_MS) return [cue('sfx.tackle_solid', 1, 0, c.pan), ...downCues(c.intensity, c.pan, event.assists.length >= 1, 60)];
      const i = Math.max(0.5, c.intensity);
      return [...impactCues(i, c.pan), ...downCues(i, c.pan, event.assists.length >= 1, 170)];
    }
    case 'pileJoin': {
      const pan = panFor(scene, find(scene, event.carrier)?.pos ?? null);
      return [cue('sfx.pad_clatter', 1, 0, pan), cue('sfx.tackle_solid', 0.9, 20, pan), cue('sfx.grunt_hit', 0.6, 40, pan)];
    }
    case 'brokenTackle': {
      const pan = panFor(scene, find(scene, event.carrier)?.pos ?? null);
      return [cue('sfx.tackle_solid', 1, 0, pan), cue('sfx.grunt_effort', 0.6, 40, pan)];
    }
    case 'missedTackle': return [cue('sfx.tackle_light', 0.8, 0, panFor(scene, find(scene, event.defender)?.pos ?? null)), cue('sfx.turf', 0.8, 110, panFor(scene, find(scene, event.defender)?.pos ?? null))];
    case 'specialMove': {
      const pan = panFor(scene, find(scene, event.athlete)?.pos ?? null);
      if (event.move === 'stiffArm' || event.move === 'truck') return [cue('sfx.tackle_solid', 0.55, 0, pan), cue('sfx.grunt_effort', 0.5, 30, pan)];
      if (event.move === 'hurdle') return [cue('sfx.grunt_effort', 0.4, 0, pan)];
      if (event.move === 'juke' || event.move === 'spin') return [cue('sfx.footstep_grass', 0.6, 0, pan)];
      return [];
    }
    case 'pancake': {
      const pan = panFor(scene, find(scene, event.defender)?.pos ?? null);
      return [cue('sfx.tackle_solid', 1.1, 0, pan), cue('sfx.pad_clatter', 1, 20, pan), cue('sfx.turf', 1, 150, pan)];
    }
    case 'blockShed': return [cue('sfx.tackle_light', 0.9, 0, panFor(scene, find(scene, event.defender)?.pos ?? null))];
    case 'blockEngage': {
      // Every lock-up on the line and downfield pops: pads on a pass set, a heavier thud when a run block fires out.
      const pan = panFor(scene, find(scene, event.defender)?.pos ?? null);
      return event.kind === 'run' ? [cue('sfx.tackle_solid', 0.95, 0, pan)] : [cue('sfx.tackle_light', 1, 0, pan)];
    }
    case 'fumble': return [cue('sfx.tackle_solid', 1, 0, panFor(scene, find(scene, event.carrier)?.pos ?? null))];
    case 'recovery': {
      const pan = panFor(scene, find(scene, event.by)?.pos ?? null);
      return [cue('sfx.turf', 0.6, 0, pan), cue('sfx.pad_clatter', 0.45, 80, pan)];
    }
    case 'outOfBounds': case 'slide': return [cue('sfx.turf', 0.35)];
    case 'kick': return [cue('sfx.kick', kickGain(event.power))];
    case 'kickBlocked': return [cue('sfx.tackle_solid', 0.8), cue('sfx.pad_clatter', 0.6, 40)];
    case 'whistle': return [cue(LONG_WHISTLE_REASONS.has(event.reason) ? 'sfx.whistle_long' : 'sfx.whistle_short', 1)];
    case 'timeout': case 'quarterEnd': case 'halftime': case 'twoMinuteWarning': return [cue('sfx.whistle_long', 1)];
    case 'challenge': return [cue('sfx.whistle_short', 1)];
    default: return [];
  }
};

/** Events whose sample layer counts as a body impact (feeds CueContext.msSinceContact). */
export const isImpactEvent = (e: AudioGameEvent): e is Extract<PlayEvent, { type: 'wrapUp' | 'hitStick' | 'tackle' | 'sack' }> =>
  e.type === 'wrapUp' || e.type === 'hitStick' || e.type === 'tackle' || e.type === 'sack';

/** Highest contact tier among an event's impact cues (drives the crowd "oooh"); null without an impact. */
export const cueTier = (cues: readonly SampleCue[]): ContactTier | null => {
  if (cues.some((c) => c.id === 'sfx.tackle_big')) return 'big';
  if (cues.some((c) => c.id === 'sfx.tackle_solid')) return 'solid';
  if (cues.some((c) => c.id === 'sfx.tackle_light')) return 'light';
  return null;
};
