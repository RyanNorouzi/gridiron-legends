/**
 * The real-audio layer on top of the synth: for every game event it plays the recorded field sounds
 * (sample-cues.ts) and crowd reactions (crowd-cues.ts) with variant rotation, small pitch/gain variation,
 * per-sample cooldowns and stereo panning, runs the crowd beds (crowd-engine.ts), and tells the
 * AudioManager how to adjust the synth: replaced (a real whistle / crowd instead of the chip-tune one),
 * softened underneath (hits, catches, kicks), or untouched when the recording is missing or not decoded yet.
 */
import type { Rng } from '@/core/rng';
import type { TeamSide } from '@/game/types';
import { CrowdEngine } from './crowd-engine';
import { crowdCuesForEvent, LAYERED_UNDER, REPLACED_BY, SYNTH_UNDER_SAMPLES } from './crowd-cues';
import type { CrowdSituation, CrowdVenue } from './crowd-model';
import type { AudioGameEvent, EventContext, SoundTrigger } from './manager';
import type { SampleBank } from './sample-bank';
import { cueTier, isImpactEvent, sfxCuesForEvent, type AudioScene, type SampleCue } from './sample-cues';
import { sampleIdsFor, type SampleBus, type SampleId } from './sample-manifest';
import type { SampleOutput, VoiceHandle } from './sample-output';
import type { SoundCategory, SoundId } from './sounds';

/** Minimum gap (ms) between two plays of the same recording; unlisted ids use the bus default. */
export const SAMPLE_COOLDOWN_MS: Readonly<Partial<Record<SampleId, number>>> = Object.freeze({
  'sfx.whistle_short': 600, 'sfx.whistle_long': 600, 'sfx.catch': 150, 'sfx.kick': 250, 'sfx.snap': 300,
  'sfx.tackle_big': 150, 'sfx.helmet_clack': 120, 'sfx.grunt_hit': 180, 'sfx.grunt_effort': 300, 'sfx.stomp': 200,
  'sfx.pad_clatter': 90,
  'crowd.roar': 2500, 'crowd.horn': 5000, 'crowd.drum': 1500, 'crowd.oooh': 1800, 'crowd.boo': 2500, 'crowd.cheer': 1200,
  'crowd.applause': 1500, 'crowd.groan': 1500, 'crowd.swell': 3000, 'crowd.defense_build': 2000,
});
/** Cooldown for recordings without an entry in SAMPLE_COOLDOWN_MS, per bus. */
export const DEFAULT_COOLDOWN_MS: Readonly<Record<SampleBus, number>> = Object.freeze({ sfx: 70, crowd: 1000 });
/** Random playback-rate spread (±) per bus; whistles keep a steadier pitch. */
export const PITCH_SPREAD: Readonly<Record<SampleBus, number>> = Object.freeze({ sfx: 0.05, crowd: 0.025 });
const WHISTLE_SPREAD = 0.02;
/** Random gain spread (multiplier range). */
export const GAIN_SPREAD: readonly [number, number] = [0.88, 1.08];

const BOOTH: ReadonlySet<SoundId> = new Set<SoundId>(['boothExcited', 'boothWhoa', 'boothAww']);

/**
 * The owner wants the hits LOUD over the max-roar crowd: contact recordings play this many times their (clamped) cue
 * gain, past the usual 1.2 ceiling; the output limiter keeps the sum from clipping.
 */
export const CONTACT_BOOST = 2.6;
/** Recordings that are bodies colliding (boosted by CONTACT_BOOST, and they dip the crowd for a moment). */
export const CONTACT_IDS: ReadonlySet<SampleId> = new Set<SampleId>([
  'sfx.tackle_light', 'sfx.tackle_solid', 'sfx.tackle_big', 'sfx.pad_clatter', 'sfx.helmet_clack', 'sfx.turf', 'sfx.grunt_hit',
]);

/** What the AudioManager needs from the layer (the class below; tests may stub it). */
export interface SampleLayerApi {
  /** First user gesture: start decoding the field sounds. */
  unlock(): void;
  setBusGain(category: SoundCategory, v: number): void;
  /** AudioManager.crowd() level (0 stops the beds). */
  setCrowdLevel(level: number): void;
  setCrowdSide(side: TeamSide): void;
  /** Max-roar crowd mode on/off (optional so test stubs need not implement it). */
  setCrowdMax?(on: boolean): void;
  /** Situation at the start of each play (possession event). */
  setSituation(situation: CrowdSituation | null, venue?: CrowdVenue | null): void;
  /** Plays the event's recordings; returns synth gain multipliers per trigger id (missing = 1). */
  handleEvent(event: AudioGameEvent, triggers: readonly SoundTrigger[], ctx: EventContext, scene: AudioScene | null): Map<SoundId, number>;
  /** True while recorded beds carry the ambience (the synth crowd loop steps aside). */
  readonly bedsActive: boolean;
  update(dt: number): void;
  stop(): void;
  dispose(): void;
}

/** Dependencies of a SampleLayer (all injectable for Node tests). */
export interface SampleLayerOptions<B> {
  bank: SampleBank<B>;
  output: SampleOutput<B>;
  rng: Rng;
  /** Monotonic ms clock (cooldowns, contact memory). */
  now: () => number;
}

/** Recorded field sounds + crowd over the synth; see the module comment. */
export class SampleLayer<B> implements SampleLayerApi {
  readonly crowd: CrowdEngine<B>;
  private readonly bank: SampleBank<B>;
  private readonly output: SampleOutput<B>;
  private readonly rng: Rng;
  private readonly now: () => number;
  private readonly lastPlayed = new Map<SampleId, number>();
  private lastContact = Number.NEGATIVE_INFINITY;
  private struggle = false;
  private sfxLoading: Promise<void> | null = null;

  constructor(opts: SampleLayerOptions<B>) {
    this.bank = opts.bank;
    this.output = opts.output;
    this.rng = opts.rng;
    this.now = opts.now;
    this.crowd = new CrowdEngine({ bank: this.bank, output: this.output, rng: this.rng.fork('crowd'), playCue: (c) => this.playCue(c) });
  }

  get bedsActive(): boolean {
    return this.crowd.bedsActive;
  }

  /** Resolves once the field sounds settled (tests / dev tools). */
  unlock(): Promise<void> {
    this.sfxLoading ??= this.bank.preload(sampleIdsFor('sfx'));
    return this.sfxLoading;
  }

  setBusGain(category: SoundCategory, v: number): void {
    if (category === 'sfx' || category === 'crowd') this.output.setBusGain(category, v);
  }

  setCrowdLevel(level: number): void {
    this.crowd.setBase(level);
  }

  setCrowdSide(side: TeamSide): void {
    this.crowd.setCrowdSide(side);
  }

  setCrowdMax(on: boolean): void {
    this.crowd.setMax(on);
  }

  setSituation(situation: CrowdSituation | null, venue?: CrowdVenue | null): void {
    this.crowd.setSituation(situation, venue);
  }

  update(dt: number): void {
    this.crowd.update(dt);
  }

  handleEvent(event: AudioGameEvent, triggers: readonly SoundTrigger[], ctx: EventContext, scene: AudioScene | null): Map<SoundId, number> {
    const t = this.now();
    this.trackPhase(event);
    const msSinceContact = this.struggle ? 0 : t - this.lastContact;
    const sfx = sfxCuesForEvent(event, { scene, msSinceContact });
    const tier = cueTier(sfx);
    this.trackContact(event, tier !== null, t);
    const crowd = crowdCuesForEvent(event, triggers, { ...ctx, tier });
    if (triggers.some((tr) => BOOTH.has(tr.id))) this.crowd.duck();
    let sfxPlayed = false;
    // Ids that are sounding: played now, or still ringing from a play inside their cooldown. A recording that
    // was dropped (voice cap, silent bus, locked context) does NOT count, so its synth stand-in keeps playing.
    const sounding = new Set<SampleId>();
    let hit = false;
    for (const c of sfx) {
      if (this.playCue(c) !== null) {
        sfxPlayed = true;
        sounding.add(c.id);
        if (CONTACT_IDS.has(c.id)) hit = true;
      } else if (this.coolingDown(c.id)) sounding.add(c.id);
    }
    // Let the hit punch through the crowd: a short dip of the crowd bus (even in max-roar mode).
    if (hit) this.crowd.impactDuck(tier === 'big' ? 'big' : 'normal');
    for (const c of crowd) {
      const h = this.playCue(c);
      if (h !== null || this.coolingDown(c.id)) sounding.add(c.id);
      if (c.id === 'crowd.swell') this.crowd.trackSwell(h);
    }
    const factors = new Map<SoundId, number>();
    for (const tr of triggers) {
      const replacements = REPLACED_BY[tr.id];
      if (replacements && replacements.some((id) => sounding.has(id))) factors.set(tr.id, 0);
      else if (sfxPlayed && LAYERED_UNDER.has(tr.id)) factors.set(tr.id, SYNTH_UNDER_SAMPLES);
    }
    return factors;
  }

  /** Cooldown of a recording (ms): its own entry, else the bus default. */
  private cooldownFor(id: SampleId): number {
    return SAMPLE_COOLDOWN_MS[id] ?? DEFAULT_COOLDOWN_MS[id.startsWith('crowd.') ? 'crowd' : 'sfx'];
  }

  /** True while `id` played recently enough that it is still inside its cooldown (and so still sounding). */
  private coolingDown(id: SampleId): boolean {
    const last = this.lastPlayed.get(id);
    return last !== undefined && this.now() - last < this.cooldownFor(id);
  }

  /** Plays one cue (cooldown, variant rotation, variation, stadium scaling). Null when skipped. */
  playCue(cue: SampleCue): VoiceHandle | null {
    const entry = this.bank.entry(cue.id);
    if (!entry || !this.bank.isReady(cue.id) || !this.output.ready) return null;
    const t = this.now();
    if (this.coolingDown(cue.id)) return null;
    const picked = this.bank.pick(cue.id, this.rng);
    if (!picked) return null;
    const spread = cue.id.startsWith('sfx.whistle') ? WHISTLE_SPREAD : PITCH_SPREAD[entry.bus];
    const rate = 1 + this.rng.range(-spread, spread);
    const vary = this.rng.range(GAIN_SPREAD[0], GAIN_SPREAD[1]);
    const stadium = entry.bus === 'crowd' ? this.crowd.reactionGain : 1;
    const boost = CONTACT_IDS.has(cue.id) ? CONTACT_BOOST : 1;
    const gain = entry.gain * Math.max(0, Math.min(1.2, cue.gain)) * vary * stadium * boost;
    const handle = this.output.play(picked.buffer, { bus: entry.bus, gain, rate, pan: cue.pan, delaySec: Math.max(0, cue.delayMs) / 1000 });
    if (handle !== null) this.lastPlayed.set(cue.id, t);
    return handle;
  }

  private trackPhase(e: AudioGameEvent): void {
    this.crowd.noteEvent(e);
    switch (e.type) {
      case 'snap': this.crowd.setPhase('live'); break;
      case 'kick': this.crowd.setPhase('live'); break;
      case 'catch': case 'incomplete': case 'interception': case 'tipped': this.crowd.cutSwell(); break;
      // Fast-simulated plays forward no whistle: the applied result ends them for the crowd.
      case 'whistle': case 'playResult': this.crowd.setPhase('dead'); break;
      default: break;
    }
  }

  /** Contact memory: a wrap-up starts a struggle, so the tackle that ends it only sounds the fall. */
  private trackContact(e: AudioGameEvent, impact: boolean, t: number): void {
    if (isImpactEvent(e) && impact) this.lastContact = t;
    if (e.type === 'wrapUp' || e.type === 'pileJoin') this.struggle = true;
    else if (e.type === 'tackle' || e.type === 'brokenTackle' || e.type === 'whistle' || e.type === 'snap' || e.type === 'fumble' || e.type === 'sack') {
      this.struggle = false;
    }
  }

  stop(): void {
    this.crowd.stop();
    this.lastPlayed.clear();
    this.struggle = false;
    this.lastContact = Number.NEGATIVE_INFINITY;
  }

  dispose(): void {
    this.stop();
    this.output.dispose();
    this.bank.clear();
  }
}
