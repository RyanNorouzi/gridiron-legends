import { clamp01 } from '@/core/math';
import type { Rng } from '@/core/rng';
import { DEFAULT_SETTINGS, type AudioLevels, type CrowdNoise } from '@/core/settings';
import type { PenaltyInfo, PlayEvent } from '@/game/play-events';
import { otherSide, type Side, type TeamSide } from '@/game/types';
import { CAPTION_REPEAT_MS, captionFor } from './captions';
import { SOUNDS, SOUND_CATEGORIES, isSoundId, transposeRecipe, type SoundCategory, type SoundId } from './sounds';
import { MusicSequencer, type MusicTrackId } from './music';
import type { CrowdSituation, CrowdVenue } from './crowd-model';
import type { AudioScene } from './sample-cues';
import type { SampleLayerApi } from './sample-layer';
import type { AudioBackend } from './synth';

/** Minimum gap between two triggers of the same sound, in milliseconds. */
export const SOUND_THROTTLE_MS = 50;
export const CROWD_LOOP_ID = 'crowdAmbient';
/** Seconds the ambient crowd loop takes to reach a new level. */
export const CROWD_RAMP_SEC = 0.6;
const MAX_PITCH_VARIANCE = 0.5;

export interface PlayOptions {
  /** 0..1 multiplier on the recipe gain. */
  volume?: number;
  /** Random pitch spread as a fraction of the base frequency (0.05 = ±5%). Requires `rng`; without one the pitch is fixed. */
  pitchVariance?: number;
  rng?: Rng;
}

/**
 * Events the game screen / controller forward besides PlayEvents. 'possession' tells the manager which
 * TeamSide is on offense so Side-based PlayEvents resolve to the right crowd reaction. Duplicates of the same
 * sound within SOUND_THROTTLE_MS (e.g. a 'score' event on the same tick as a 'touchdown' PlayEvent) are dropped.
 */
export type ControllerAudioEvent =
  /** `play` / `stadium` (optional) feed the recorded crowd's situation model at the start of each play. */
  | { type: 'possession'; offense: TeamSide; play?: CrowdSituation; stadium?: CrowdVenue }
  /** The play was applied (no sound): tells the recorded crowd how the next down shapes up before it is called. */
  | { type: 'playResult'; firstDown: boolean; turnover: boolean; yards: number }
  | { type: 'twoMinuteWarning' }
  | { type: 'gameOver'; winner: TeamSide | null }
  | { type: 'score'; teamSide: TeamSide; points: number }
  | { type: 'timeout'; teamSide: TeamSide }
  | { type: 'quarterEnd' }
  | { type: 'halftime' }
  | { type: 'menuMove' }
  | { type: 'menuSelect' }
  | { type: 'menuBack' };

export type AudioGameEvent = PlayEvent | ControllerAudioEvent;

/** One sound the event mapper wants played; `volume` scales the recipe gain. */
export interface SoundTrigger {
  id: SoundId;
  volume: number;
}

export interface EventContext {
  /** TeamSide currently on offense; null until known (crowd reactions turn neutral). */
  offense: TeamSide | null;
  /** Team the stadium crowd supports. */
  crowdSide: TeamSide;
}

export interface AudioManagerOptions {
  /** Monotonic clock in milliseconds used for throttling. Defaults to performance.now(). */
  now?: () => number;
  /** Which team the crowd cheers for. Default 'home'. */
  crowdSide?: TeamSide;
  /** Recorded-sample layer on top of the synth (browser only); absent = synth only. */
  samples?: SampleLayerApi | null;
  /** Crowd noise mode; absent = 'max' (the stadium roars at full volume the whole game). */
  crowdNoise?: CrowdNoise;
}

const trig = (id: SoundId, volume = 1): SoundTrigger => ({ id, volume });
const asTeamSide = (v: unknown): TeamSide | null => (v === 'home' || v === 'away' ? v : null);
const asSide = (v: unknown): Side | null => (v === 'offense' || v === 'defense' ? v : null);
const flipSide = (s: Side): Side => (s === 'offense' ? 'defense' : 'offense');
/** Play-local athlete ids are 'off:ROLE' / 'def:ROLE'. */
const athleteSide = (id: unknown): Side | null =>
  typeof id !== 'string' ? null : id.startsWith('off:') ? 'offense' : id.startsWith('def:') ? 'defense' : null;
const teamOf = (side: Side | null, ctx: EventContext): TeamSide | null =>
  side === null || ctx.offense === null ? null : side === 'offense' ? ctx.offense : otherSide(ctx.offense);
const penaltySide = (p: PenaltyInfo | undefined): Side | null => (p && typeof p === 'object' ? asSide(p.side) : null);

/** Crowd reaction to something that benefits `team`: roar/cheer for the crowd's side, groan otherwise; neutral when unknown. */
export const crowdReaction = (team: TeamSide | null, ctx: EventContext, big = false, scale = 1): SoundTrigger => {
  if (team === null) return trig('crowdCheer', 0.5 * scale);
  const ours = team === ctx.crowdSide;
  if (big) return ours ? trig('crowdRoar', scale) : trig('crowdGroan', scale);
  return ours ? trig('crowdCheer', 0.8 * scale) : trig('crowdGroan', 0.6 * scale);
};

/**
 * The broadcast booth's reaction to an event (commentary bus): excitement for scores and takeaways, a "whoa" for
 * big hits and sacks, disappointment for misses, and the PA chime before flags, timeouts and period breaks.
 */
export const commentaryForEvent = (event: AudioGameEvent): SoundTrigger | null => {
  switch (event.type) {
    case 'touchdown': case 'interception': case 'onsideRecovery': return trig('boothExcited');
    case 'kickResult': return event.kind === 'fieldGoal' ? trig(event.made === true ? 'boothExcited' : 'boothAww', 0.8) : null;
    case 'fumble': case 'sack': case 'kickBlocked': return trig('boothWhoa');
    case 'tackle': return event.kind === 'hitStick' ? trig('boothWhoa', 0.8) : null;
    case 'incomplete': return trig('boothAww', 0.35);
    case 'penalty': case 'timeout': case 'quarterEnd': case 'halftime': case 'twoMinuteWarning': return trig('paChime');
    case 'gameOver': return trig('boothExcited', 0.9);
    default: return null;
  }
};

/** Everything an event plays: the effects and crowd (soundsForEvent) plus the booth's reaction. */
export const eventSounds = (event: AudioGameEvent, ctx: EventContext): SoundTrigger[] => {
  const booth = commentaryForEvent(event);
  const sounds = soundsForEvent(event, ctx);
  return booth ? [...sounds, booth] : sounds;
};

/** Pure mapping from a game event to the effects and crowd sounds it should trigger (before throttling/mute). */
export const soundsForEvent = (event: AudioGameEvent, ctx: EventContext): SoundTrigger[] => {
  const off = teamOf('offense', ctx);
  const def = teamOf('defense', ctx);
  switch (event.type) {
    case 'snap': return [trig('snap')];
    case 'throw': return [trig('throw')];
    case 'catch': return event.contested === true ? [trig('catch'), crowdReaction(off, ctx, false, 0.6)] : [trig('catch')];
    case 'tipped': return [trig('catch', 0.6)];
    case 'incomplete': return [trig('incomplete'), crowdReaction(def, ctx, false, 0.5)];
    case 'interception': return [trig('interception'), trig('turnover'), crowdReaction(def, ctx, true)];
    case 'tackle':
      return event.kind === 'hitStick'
        ? [trig('bigHit'), crowdReaction(teamOf(flipSide(athleteSide(event.carrier) ?? 'offense'), ctx), ctx, false, 0.7)]
        : [trig('tackle')];
    case 'hitStick': return [trig('hitStick')];
    case 'brokenTackle': return [crowdReaction(teamOf(athleteSide(event.carrier), ctx), ctx, false, 0.5)];
    case 'specialMove':
      if (event.move === 'juke' || event.move === 'spin' || event.move === 'hurdle') return [trig('hitStick', 0.35)];
      if (event.move === 'stiffArm' || event.move === 'truck') return [trig('tackle', 0.4)];
      return [];
    case 'pancake': return [trig('tackle', 0.5)];
    case 'fumble': {
      const carrier = athleteSide(event.carrier);
      return [trig('fumble'), crowdReaction(teamOf(carrier ? flipSide(carrier) : null, ctx), ctx, false, 0.7)];
    }
    case 'muff': return [trig('fumble')];
    case 'recovery': {
      const side = asSide(event.side);
      if (side === 'defense') return [trig('turnover'), crowdReaction(def, ctx, true)];
      return [crowdReaction(teamOf(side, ctx), ctx, false, 0.5)];
    }
    case 'sack': return [trig('sack'), crowdReaction(def, ctx)];
    case 'touchdown': return [trig('touchdown'), crowdReaction(teamOf(asSide(event.side), ctx), ctx, true)];
    case 'safety': return [trig('fieldGoal', 0.8), crowdReaction(def, ctx, true)];
    case 'firstDown': return [trig('firstDown'), crowdReaction(off, ctx, false, 0.5)];
    case 'kick':
      if (event.kind === 'punt') return [trig('punt')];
      if (event.kind === 'fieldGoal' || event.kind === 'extraPoint') return [trig('kickoff', 0.7)];
      return [trig('kickoff')];
    case 'kickResult': {
      if (event.kind !== 'fieldGoal' && event.kind !== 'extraPoint') return [];
      const big = event.kind === 'fieldGoal';
      return event.made === true ? [trig('fieldGoal'), crowdReaction(off, ctx, big)] : [crowdReaction(def, ctx, big)];
    }
    case 'kickBlocked': return [trig('bigHit', 0.8), crowdReaction(def, ctx, true)];
    case 'onsideRecovery':
      return asSide(event.side) === 'offense' ? [trig('firstDown'), crowdReaction(off, ctx, true)] : [crowdReaction(def, ctx, false, 0.6)];
    case 'penalty': {
      const flagged = penaltySide(event.penalty);
      return [trig('penaltyFlag'), crowdReaction(teamOf(flagged ? flipSide(flagged) : null, ctx), ctx, false, 0.7)];
    }
    case 'whistle': return [trig('whistle')];
    case 'audible': return [trig('menuMove', 0.7)];
    case 'switchPlayer': return [trig('menuMove', 0.5)];
    case 'injury': return [trig('crowdGroan', 0.5)];
    case 'challenge': {
      const challenger = asTeamSide(event.side);
      if (!challenger) return [trig('whistle')];
      return [trig('whistle'), crowdReaction(event.overturned === true ? challenger : otherSide(challenger), ctx, true, 0.8)];
    }
    case 'twoMinuteWarning': return [trig('twoMinute')];
    case 'gameOver': {
      const winner = asTeamSide(event.winner);
      return [trig('gameOver'), winner ? crowdReaction(winner, ctx, true) : trig('crowdCheer', 0.5)];
    }
    case 'score': {
      const team = asTeamSide(event.teamSide);
      const pts = typeof event.points === 'number' ? event.points : 0;
      if (pts >= 6) return [trig('touchdown'), crowdReaction(team, ctx, true)];
      if (pts === 3) return [trig('fieldGoal'), crowdReaction(team, ctx, true)];
      if (pts === 2) return [trig('firstDown'), crowdReaction(team, ctx)];
      if (pts === 1) return [trig('fieldGoal', 0.7), crowdReaction(team, ctx, false, 0.5)];
      return [];
    }
    case 'timeout': case 'quarterEnd': case 'halftime': return [trig('whistle')];
    case 'menuMove': return [trig('menuMove')];
    case 'menuSelect': return [trig('menuSelect')];
    case 'menuBack': return [trig('menuBack')];
    default: return [];
  }
};

const defaultClock = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/** Clamps each level to 0..1; non-numeric / non-finite entries fall back to the shipped defaults. */
const sanitizeLevels = (levels: AudioLevels): AudioLevels => {
  const d = DEFAULT_SETTINGS.audio;
  const one = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) ? clamp01(v) : fallback);
  return {
    master: one(levels.master, d.master),
    sfx: one(levels.sfx, d.sfx),
    music: one(levels.music, d.music),
    crowd: one(levels.crowd, d.crowd),
    commentary: one(levels.commentary, d.commentary),
  };
};

/** Effective bus gain for a category: master × category level. */
export const categoryGain = (levels: AudioLevels, category: SoundCategory): number => clamp01(levels.master) * clamp01(levels[category]);

/**
 * Front door for everything that makes noise: looks recipes up, applies levels/mute through the backend's
 * category buses, throttles repeats, runs the crowd loop and translates game events into sounds.
 */
export class AudioManager {
  private levels: AudioLevels;
  private muted = false;
  private readonly lastPlayed = new Map<SoundId, number>();
  private offense: TeamSide | null = null;
  private crowdSide: TeamSide;
  private crowdLevel = 0;
  private crowdLoopActive = false;
  private readonly now: () => number;
  private readonly captionListeners = new Set<(text: string) => void>();
  private readonly lastCaption = new Map<string, number>();
  private readonly music: MusicSequencer;
  private readonly samples: SampleLayerApi | null;
  /** The synth ambient loop was faded out because the recorded crowd beds took over. */
  private synthCrowdYielded = false;
  private crowdNoise: CrowdNoise;

  constructor(readonly backend: AudioBackend, levels: AudioLevels, opts: AudioManagerOptions = {}) {
    this.levels = sanitizeLevels(levels);
    this.crowdSide = opts.crowdSide ?? 'home';
    this.now = opts.now ?? defaultClock;
    this.samples = opts.samples ?? null;
    this.samples?.setCrowdSide(this.crowdSide);
    this.crowdNoise = opts.crowdNoise ?? 'max';
    this.samples?.setCrowdMax?.(this.crowdNoise === 'max');
    this.music = new MusicSequencer((recipe, gain) => { if (!this.muted) this.backend.play(recipe, recipe.gain * gain); });
    this.applyGains();
  }

  /** Background music loop now playing (null = none). */
  get musicTrack(): MusicTrackId | null {
    return this.music.current;
  }

  /** Picks the background loop (null stops it) and advances it by `dt` seconds; call once per frame / tick. */
  updateMusic(dt: number, track: MusicTrackId | null): number {
    this.music.setTrack(track);
    this.updateSamples(dt);
    return this.music.update(dt);
  }

  /** Advances the recorded crowd (it rides the per-frame music tick) and hands the ambience to it once decoded. */
  private updateSamples(dt: number): void {
    if (!this.samples) return;
    this.samples.update(dt);
    if (this.crowdLoopActive && !this.synthCrowdYielded && this.samples.bedsActive) {
      this.synthCrowdYielded = true;
      this.backend.setLoopGain(CROWD_LOOP_ID, 0, 2);
    }
  }

  /** Fire a one-shot. Returns false when muted, throttled, silent or the id is not a one-shot. */
  play(id: SoundId, opts: PlayOptions = {}): boolean {
    if (this.muted || !isSoundId(id)) return false;
    const recipe = SOUNDS[id];
    if (recipe.loop) return false;
    const t = this.now();
    const last = this.lastPlayed.get(id);
    if (last !== undefined && t - last < SOUND_THROTTLE_MS) return false;
    const volume = opts.volume ?? 1;
    const gain = recipe.gain * (Number.isFinite(volume) ? clamp01(volume) : 1);
    if (!(gain > 0)) return false;
    this.lastPlayed.set(id, t);
    const variance = Math.min(Math.abs(opts.pitchVariance ?? 0), MAX_PITCH_VARIANCE);
    const shaped = variance > 0 && opts.rng ? transposeRecipe(recipe, 1 + opts.rng.range(-variance, variance)) : recipe;
    this.backend.play(shaped, gain);
    return true;
  }

  /** Ambient crowd intensity 0..1: starts the loop when it rises above 0, ramps its gain, stops it at 0. */
  crowd(level: number): void {
    const asked = Number.isFinite(level) ? clamp01(level) : 0;
    this.crowdLevel = asked;
    // Max-roar mode: any crowd at all is a full-volume crowd.
    const v = asked > 0 && this.crowdNoise === 'max' ? 1 : asked;
    this.samples?.setCrowdLevel(v);
    const recipe = SOUNDS.crowdAmbient;
    if (v <= 0) {
      if (this.crowdLoopActive) this.backend.stopLoop(CROWD_LOOP_ID);
      this.crowdLoopActive = false;
      this.synthCrowdYielded = false;
      return;
    }
    const gain = this.synthCrowdYielded ? 0 : recipe.gain * v;
    if (!this.crowdLoopActive) {
      this.backend.startLoop(CROWD_LOOP_ID, recipe, gain);
      this.crowdLoopActive = true;
    } else {
      this.backend.setLoopGain(CROWD_LOOP_ID, gain, CROWD_RAMP_SEC);
    }
  }

  getCrowdLevel(): number {
    return this.crowdLevel;
  }

  /** Crowd noise mode: 'max' roars at full volume the whole game, 'reactive' follows the game. */
  setCrowdNoise(mode: CrowdNoise): void {
    this.crowdNoise = mode === 'reactive' ? 'reactive' : 'max';
    this.samples?.setCrowdMax?.(this.crowdNoise === 'max');
    this.crowd(this.crowdLevel);
  }

  getCrowdNoise(): CrowdNoise {
    return this.crowdNoise;
  }

  setLevels(levels: AudioLevels): void {
    this.levels = sanitizeLevels(levels);
    this.applyGains();
  }

  getLevels(): AudioLevels {
    return { ...this.levels };
  }

  mute(): void {
    this.muted = true;
    this.applyGains();
  }

  unmute(): void {
    this.muted = false;
    this.applyGains();
  }

  toggleMute(): boolean {
    if (this.muted) this.unmute();
    else this.mute();
    return this.muted;
  }

  get isMuted(): boolean {
    return this.muted;
  }

  /** Forward to the backend; call from the first user gesture so the browser unlocks audio. */
  resume(): Promise<void> {
    const p = this.backend.resume();
    this.samples?.unlock();
    return p;
  }

  setPossession(offense: TeamSide | null): void {
    this.offense = asTeamSide(offense);
  }

  getPossession(): TeamSide | null {
    return this.offense;
  }

  setCrowdSide(side: TeamSide): void {
    this.crowdSide = asTeamSide(side) ?? this.crowdSide;
    this.samples?.setCrowdSide(this.crowdSide);
  }

  getCrowdSide(): TeamSide {
    return this.crowdSide;
  }

  /**
   * Map a PlayEvent / controller event to sounds and play them. Returns the synth ids actually played.
   * `scene` (the live PlayState, optional) lets the recorded layer pan and size contacts from positions/speeds.
   */
  onGameEvent(event: AudioGameEvent | { type: string }, scene?: AudioScene | null): SoundId[] {
    if (typeof event !== 'object' || event === null || typeof event.type !== 'string') return [];
    if (event.type === 'possession') {
      const p = event as { offense?: unknown; play?: CrowdSituation; stadium?: CrowdVenue };
      this.setPossession(asTeamSide(p.offense));
      if (p.play && typeof p.play === 'object') this.samples?.setSituation(p.play, p.stadium && typeof p.stadium === 'object' ? p.stadium : undefined);
      return [];
    }
    const played: SoundId[] = [];
    const ctx: EventContext = { offense: this.offense, crowdSide: this.crowdSide };
    const triggers = eventSounds(event as AudioGameEvent, ctx);
    this.caption(triggers.map((t) => t.id));
    // Runs while muted too (the silent buses drop the voices) so the crowd's play phase stays in step.
    const factors = this.samples ? this.samples.handleEvent(event as AudioGameEvent, triggers, ctx, scene ?? null) : null;
    for (const t of triggers) {
      const f = factors?.get(t.id) ?? 1;
      if (f > 0 && this.play(t.id, { volume: t.volume * f })) played.push(t.id);
    }
    return played;
  }

  /**
   * Subscribes to captions of important sound cues ("[WHISTLE]"). Captions fire even while muted or at zero
   * volume (that is when they matter most). Returns the unsubscribe function.
   */
  onCaption(listener: (text: string) => void): () => void {
    this.captionListeners.add(listener);
    return () => { this.captionListeners.delete(listener); };
  }

  private caption(ids: readonly SoundId[]): void {
    if (this.captionListeners.size === 0) return;
    const t = this.now();
    for (const id of ids) {
      const text = captionFor(id);
      if (!text) continue;
      const last = this.lastCaption.get(text);
      if (last !== undefined && t - last < CAPTION_REPEAT_MS) continue;
      this.lastCaption.set(text, t);
      for (const l of this.captionListeners) l(text);
    }
  }

  /** Stop the crowd loop and forget throttle state (screen change, game end). */
  stop(): void {
    this.crowd(0);
    this.samples?.stop();
    this.lastPlayed.clear();
  }

  private applyGains(): void {
    for (const c of SOUND_CATEGORIES) {
      const g = this.muted ? 0 : categoryGain(this.levels, c);
      this.backend.setGain(c, g);
      this.samples?.setBusGain(c, g);
    }
  }
}
