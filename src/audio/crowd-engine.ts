/**
 * Real crowd engine: keeps the three recorded beds (murmur / engaged / loud) looping and crossfades them to
 * the level the crowd model computes from the game situation, scaled by the stadium. Also runs the timed
 * reactions that belong to the bed rather than to one event: the 3rd/4th-down "defense" build-up before the
 * snap (cut on the snap), the swell while a deep ball is in the air (cut when it lands), and ducking under
 * the broadcast booth.
 */
import { clamp } from '@/core/math';
import type { Rng } from '@/core/rng';
import type { TeamSide } from '@/game/types';
import {
  bedMix, crowdIntensity, freshPlayFacts, isDefensiveStand, notePlayFact, predictNextSituation, venueScale,
  type CrowdPhase, type CrowdSituation, type CrowdVenue, type PlayFactEvent, type PlayFacts, type VenueScale,
} from './crowd-model';
import type { SampleBank } from './sample-bank';
import type { SampleCue } from './sample-cues';
import { CROWD_BED_IDS, sampleIdsFor } from './sample-manifest';
import type { SampleOutput, VoiceHandle } from './sample-output';

/** Level changes per second while rising / falling (the crowd jumps up quicker than it settles). */
export const CROWD_RISE_PER_SEC = 0.9;
/** Level drop per second while the crowd settles. */
export const CROWD_FALL_PER_SEC = 0.3;
/** Crowd multiplier while the booth talks, and how long a duck holds. */
export const DUCK_LEVEL = 0.6;
/** Seconds a booth duck holds before the crowd comes back up. */
export const DUCK_HOLD_SEC = 1.4;
/** Decoded takes per crowd reaction (memory: decoded audio costs ~0.2 MB per second per channel at 48 kHz). */
export const REACTION_VARIANTS = 3;
/**
 * Seconds after the whistle the crowd reacts to the play before it turns to the next snap. The next play's
 * situation only arrives when it is called (a fraction of a second before an AI snap), so between plays the
 * crowd anticipates the guessed next down: a 3rd-down stand gets loud while the offense picks its play.
 */
export const ANTICIPATION_DELAY_SEC = 1.5;
/** Crowd bus level during the instant after a body hit (and a bigger dip for a big hit), and how long it holds. */
export const IMPACT_DUCK = 0.6;
export const IMPACT_DUCK_BIG = 0.45;
export const IMPACT_DUCK_SEC = 0.28;
/** Max-roar mode (the owner's default): extra gain on the beds and reactions. */
export const MAX_ROAR_BOOST = 1.6;
/** Seconds between the roar layers stacked on the loud bed in max-roar mode. */
export const MAX_ROAR_EVERY: readonly [number, number] = [1.4, 2.6];
/** Nominal AudioManager.crowd() level: the game screen asks for 0.5. */
const NOMINAL_BASE = 0.5;

/** What the crowd engine plays through. */
export interface CrowdEngineDeps<B> {
  bank: SampleBank<B>;
  output: SampleOutput<B>;
  rng: Rng;
  /** Plays a crowd one-shot through the layer (cooldowns, variation); returns its voice handle. */
  playCue: (cue: SampleCue) => VoiceHandle | null;
}

/** Bed loudness for a level: never fully silent, near-silent at the kick tension level. */
export const bedLoudness = (level: number): number => 0.2 + 0.8 * clamp(level, 0, 1);

/** Recorded crowd beds + timed reactions driven by the crowd model. */
export class CrowdEngine<B> {
  private base = 0;
  private situation: CrowdSituation | null = null;
  private venue: CrowdVenue | null = null;
  private scale: VenueScale = { gain: 1, reverb: 0 };
  private phase: CrowdPhase = 'presnap';
  private liveSeconds = 0;
  private deadSeconds = 0;
  private facts: PlayFacts = freshPlayFacts();
  private levelValue = 0.4;
  private loading: Promise<void> | null = null;
  private readonly applied = new Map<string, number>();
  private duckRemaining = 0;
  private swell: VoiceHandle | null = null;
  private build: VoiceHandle | null = null;
  private crowdSide: TeamSide = 'home';
  /** Max-roar mode: the stadium roars at full volume the whole game, never ducked (see setMax). */
  private max = false;
  private roarIn = 0;
  private impactRemaining = 0;

  constructor(private readonly deps: CrowdEngineDeps<B>) {}

  /** Current smoothed level 0..1. */
  get level(): number {
    return this.levelValue;
  }

  /** Whether the recorded beds are sounding (the synth ambient loop steps aside). */
  get bedsActive(): boolean {
    return this.base > 0 && CROWD_BED_IDS.some((id) => this.deps.output.hasBed(id));
  }

  /** Multiplier the layer applies to crowd one-shots (stadium size / atmosphere / dome). */
  get reactionGain(): number {
    return this.scale.gain * clamp(this.base / NOMINAL_BASE, 0, 1.6) * (this.max ? MAX_ROAR_BOOST : 1);
  }

  /** Max-roar mode on/off: on = full-intensity loud bed + a continuous roar layer, no ducking under the booth. */
  setMax(on: boolean): void {
    this.max = on;
    if (on) {
      this.levelValue = 1;
      this.roarIn = 0;
      if (this.duckRemaining > 0) {
        this.duckRemaining = 0;
        this.deps.output.setDuck(1, 0.3);
      }
    }
  }

  /** True in max-roar mode. */
  get maxRoar(): boolean {
    return this.max;
  }

  /** The AudioManager.crowd() level: > 0 starts (and lazily loads) the beds, 0 stops them. */
  setBase(level: number): void {
    const v = Number.isFinite(level) ? clamp(level, 0, 1) : 0;
    if (v <= 0) {
      this.stop();
      return;
    }
    this.base = v;
    this.loading ??= this.deps.bank
      .preload(CROWD_BED_IDS, { maxVariants: 1, rng: this.deps.rng })
      .then(() => this.deps.bank.preload(sampleIdsFor('crowd').filter((id) => !(CROWD_BED_IDS as readonly string[]).includes(id)), { maxVariants: REACTION_VARIANTS, rng: this.deps.rng }));
  }

  setCrowdSide(side: TeamSide): void {
    this.crowdSide = side;
  }

  /** New play context (and stadium) at the start of each play: back to the pre-snap phase. */
  setSituation(situation: CrowdSituation | null, venue?: CrowdVenue | null): void {
    this.situation = situation;
    if (venue !== undefined) this.venue = venue;
    this.scale = venueScale(this.venue, situation?.crowdFactor);
    this.deps.output.setReverb(this.scale.reverb);
    this.setPhase('presnap');
    this.facts = freshPlayFacts();
    // A build-up already running from the between-plays anticipation carries on when the guess was right.
    if (isDefensiveStand(situation, this.crowdSide)) {
      if (this.build === null) this.startBuild(situation, 400);
    } else {
      this.cutBuild(0.4);
    }
  }

  /** Something happened in the play (first down, turnover, score...): feeds the next-down guess. */
  noteEvent(event: PlayFactEvent): void {
    this.facts = notePlayFact(this.facts, event);
    if (!this.anticipating()) return;
    // A late flag or the applied result can change the guess: drop a build-up that no longer fits, start one that does.
    const stand = isDefensiveStand(this.anticipated(), this.crowdSide);
    if (this.build !== null && !stand) this.cutBuild(0.5);
    else if (this.build === null && stand) { const next = this.anticipated(); if (next) this.startBuild(next, 0); }
  }

  /** The guessed situation of the next snap (null when unknown). */
  anticipated(): CrowdSituation | null {
    return predictNextSituation(this.situation, this.facts);
  }

  private startBuild(s: CrowdSituation, delayMs: number): void {
    if (this.base <= 0) return;
    this.build = this.deps.playCue({ id: 'crowd.defense_build', gain: s.down >= 4 ? 0.9 : 0.75, delayMs, pan: 0 });
  }

  setPhase(phase: CrowdPhase): void {
    if (phase === this.phase) return;
    this.phase = phase;
    if (phase === 'live') {
      this.liveSeconds = 0;
      this.cutBuild(0.35);
    } else if (phase === 'dead') {
      this.deadSeconds = 0;
      this.cutSwell(0.6);
      this.cutBuild(0.3);
    }
  }

  /** Remember a swell voice so it can be cut when the ball lands. */
  trackSwell(handle: VoiceHandle | null): void {
    if (handle !== null) {
      this.cutSwell(0.2);
      this.swell = handle;
    }
  }

  /** The deep ball came down (catch / incompletion / pick): the swell gives way to the reaction. */
  cutSwell(fadeSec = 0.25): void {
    if (this.swell !== null) this.deps.output.stopVoice(this.swell, fadeSec);
    this.swell = null;
  }

  private cutBuild(fadeSec: number): void {
    if (this.build !== null) this.deps.output.stopVoice(this.build, fadeSec);
    this.build = null;
  }

  /** Duck the crowd under the broadcast booth for a moment. */
  duck(holdSec = DUCK_HOLD_SEC): void {
    if (this.max) return;
    if (this.duckRemaining <= 0) this.deps.output.setDuck(DUCK_LEVEL, 0.12);
    this.duckRemaining = Math.max(this.duckRemaining, holdSec);
  }

  /**
   * A body hit just sounded: dip the crowd bus for an instant so the pads crack through (IMPACT_DUCK, deeper for a big
   * hit), then let it roar back. Works in max-roar mode too; a booth duck in progress is left alone.
   */
  impactDuck(size: 'normal' | 'big' = 'normal'): void {
    if (this.duckRemaining > 0) return;
    this.deps.output.setDuck(size === 'big' ? IMPACT_DUCK_BIG : IMPACT_DUCK, 0.02);
    this.impactRemaining = IMPACT_DUCK_SEC;
  }

  /** Target level for the current situation (exposed for tests / dev tools). */
  target(): number {
    if (this.max) return 1;
    const next = this.anticipating() ? this.anticipated() : null;
    if (next) return crowdIntensity({ situation: next, crowdSide: this.crowdSide, phase: 'presnap', liveSeconds: 0 });
    return crowdIntensity({ situation: this.situation, crowdSide: this.crowdSide, phase: this.phase, liveSeconds: this.liveSeconds });
  }

  /** Between plays, after the reaction to the last one: the crowd looks ahead to the next snap. */
  private anticipating(): boolean {
    return this.phase === 'dead' && this.deadSeconds >= ANTICIPATION_DELAY_SEC;
  }

  /** Advance smoothing, start beds once decoded, retarget bed gains. Call every frame. */
  update(dt: number): void {
    const step = Number.isFinite(dt) && dt > 0 ? Math.min(dt, 0.25) : 0;
    if (this.duckRemaining > 0) {
      this.duckRemaining -= step;
      if (this.duckRemaining <= 0) this.deps.output.setDuck(1, 0.6);
    }
    if (this.impactRemaining > 0) {
      this.impactRemaining -= step;
      if (this.impactRemaining <= 0 && this.duckRemaining <= 0) this.deps.output.setDuck(1, 0.35);
    }
    if (this.base <= 0) return;
    if (this.phase === 'live') this.liveSeconds += step;
    if (this.phase === 'dead') {
      const was = this.anticipating();
      this.deadSeconds += step;
      const next = !was && this.anticipating() ? this.anticipated() : null;
      if (next && this.build === null && isDefensiveStand(next, this.crowdSide)) this.startBuild(next, 0);
    }
    const target = this.target();
    const rate = target > this.levelValue ? CROWD_RISE_PER_SEC : CROWD_FALL_PER_SEC;
    this.levelValue += clamp(target - this.levelValue, -rate * step, rate * step);
    this.applyBeds();
    if (this.max) this.stackRoar(step);
  }

  /** Max-roar mode: keep a roar (or a cheer while the roar cools down) stacked on the loud bed every couple of seconds. */
  private stackRoar(step: number): void {
    if (!this.deps.output.ready) return;
    this.roarIn -= step;
    if (this.roarIn > 0) return;
    const { rng } = this.deps;
    this.roarIn = rng.range(MAX_ROAR_EVERY[0], MAX_ROAR_EVERY[1]);
    const pan = rng.range(-0.35, 0.35);
    const gain = rng.range(0.8, 1);
    if (this.deps.playCue({ id: 'crowd.roar', gain, delayMs: 0, pan }) === null) this.deps.playCue({ id: 'crowd.cheer', gain, delayMs: 0, pan });
  }

  private applyBeds(): void {
    const { bank, output, rng } = this.deps;
    if (!output.ready) return;
    const mix = bedMix(this.levelValue);
    const loud = bedLoudness(this.levelValue) * this.reactionGain;
    const weights: Record<(typeof CROWD_BED_IDS)[number], number> = { 'crowd.bed_murmur': mix.murmur, 'crowd.bed_engaged': mix.engaged, 'crowd.bed_loud': mix.loud };
    for (const id of CROWD_BED_IDS) {
      const entry = bank.entry(id);
      const gain = (entry?.gain ?? 0) * weights[id] * loud;
      if (!output.hasBed(id)) {
        const picked = bank.pick(id, rng);
        const v = picked?.variant;
        if (!picked || !v || v.loopStart === undefined || v.loopEnd === undefined) continue;
        output.startBed(id, picked.buffer, { start: v.loopStart, end: v.loopEnd }, gain, 2);
        this.applied.set(id, gain);
        continue;
      }
      const prev = this.applied.get(id) ?? -1;
      if (Math.abs(prev - gain) < 0.004) continue;
      output.setBedGain(id, gain, 0.3);
      this.applied.set(id, gain);
    }
  }

  /** Fade the beds out (leaving the game) and forget the situation. */
  stop(): void {
    for (const id of CROWD_BED_IDS) this.deps.output.stopBed(id, 1.2);
    this.applied.clear();
    this.cutSwell(0.3);
    this.cutBuild(0.3);
    this.base = 0;
    this.situation = null;
    this.facts = freshPlayFacts();
    this.phase = 'presnap';
    this.levelValue = 0.4;
  }
}
