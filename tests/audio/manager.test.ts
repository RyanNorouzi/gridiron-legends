import { describe, expect, it } from 'vitest';
import { createRng } from '@/core/rng';
import { DEFAULT_SETTINGS, type AudioLevels } from '@/core/settings';
import type { PlayEvent } from '@/game/play-events';
import { SOUNDS } from '@/audio/sounds';
import { createNullBackend } from '@/audio/synth';
import {
  AudioManager, CROWD_LOOP_ID, CROWD_RAMP_SEC, SOUND_THROTTLE_MS, categoryGain, crowdReaction, soundsForEvent,
  type AudioGameEvent, type EventContext,
} from '@/audio/manager';

const LEVELS: AudioLevels = { master: 0.5, sfx: 0.8, music: 0.6, crowd: 1, commentary: 0.2 };

const make = (levels: AudioLevels = LEVELS, crowdSide: 'home' | 'away' = 'home') => {
  let t = 0;
  const backend = createNullBackend();
  // The reactive crowd (the 'max' default is tested on its own below).
  const audio = new AudioManager(backend, levels, { now: () => t, crowdSide, crowdNoise: 'reactive' });
  return { backend, audio, advance: (ms: number) => (t += ms), at: (ms: number) => (t = ms) };
};

const ev = <T extends PlayEvent['type']>(type: T, extra: Omit<Extract<PlayEvent, { type: T }>, 'type' | 'tick'>): PlayEvent =>
  ({ type, tick: 0, ...extra }) as PlayEvent;

describe('AudioManager.play', () => {
  it('pushes master × level onto every category bus at construction and routes plays through recipes', () => {
    const { backend, audio } = make();
    expect(backend.gains).toEqual({ sfx: 0.4, crowd: 0.5, music: 0.3, commentary: 0.1 });
    expect(audio.play('tackle', { volume: 0.5 })).toBe(true);
    const [call] = backend.plays();
    expect(call?.recipe).toBe(SOUNDS.tackle);
    expect(call?.gain).toBeCloseTo(SOUNDS.tackle.gain * 0.5);
    expect(call?.effectiveGain).toBeCloseTo(SOUNDS.tackle.gain * 0.5 * 0.4);
    audio.play('touchdown');
    expect(backend.plays()[1]?.effectiveGain).toBeCloseTo(SOUNDS.touchdown.gain * 0.3);
  });

  it('rejects loops, unknown ids, out-of-range volume and silent plays', () => {
    const { backend, audio } = make();
    expect(audio.play('crowdAmbient')).toBe(false);
    expect(audio.play('nope' as 'tackle')).toBe(false);
    expect(audio.play('tackle', { volume: 0 })).toBe(false);
    expect(audio.play('tackle', { volume: 5 })).toBe(true);
    expect(backend.plays()[0]?.gain).toBeCloseTo(SOUNDS.tackle.gain);
    expect(backend.plays()).toHaveLength(1);
  });

  it('never forwards a non-finite gain to the backend', () => {
    const { backend, audio, advance } = make();
    expect(audio.play('tackle', { volume: Number.NaN })).toBe(true);
    advance(100);
    expect(audio.play('tackle', { volume: Number.POSITIVE_INFINITY })).toBe(true);
    advance(100);
    expect(audio.play('tackle', { volume: Number.NEGATIVE_INFINITY })).toBe(true);
    advance(100);
    expect(audio.play('tackle', { volume: -1 })).toBe(false);
    for (const p of backend.plays()) {
      expect(Number.isFinite(p.gain)).toBe(true);
      expect(p.gain).toBeCloseTo(SOUNDS.tackle.gain);
    }
    expect(backend.plays()).toHaveLength(3);
  });

  it('throttles the same sfx within 50ms but not different ids', () => {
    const { backend, audio, advance, at } = make();
    expect(audio.play('catch')).toBe(true);
    advance(SOUND_THROTTLE_MS - 1);
    expect(audio.play('catch')).toBe(false);
    expect(audio.play('throw')).toBe(true);
    advance(1);
    expect(audio.play('catch')).toBe(true);
    at(1000);
    expect(audio.play('catch')).toBe(true);
    expect(backend.plays().map((p) => p.recipe)).toEqual([SOUNDS.catch, SOUNDS.throw, SOUNDS.catch, SOUNDS.catch]);
    // a throttled attempt does not extend the window
    at(2000);
    audio.play('snap');
    at(2040);
    audio.play('snap');
    at(2055);
    expect(audio.play('snap')).toBe(true);
  });

  it('varies pitch deterministically from the injected rng and never without one', () => {
    const { backend, audio } = make();
    audio.play('catch', { pitchVariance: 0.1, rng: createRng(11) });
    audio.play('throw', { pitchVariance: 0.1 });
    const [varied, plain] = backend.plays();
    const factor = varied!.recipe.startHz / SOUNDS.catch.startHz;
    expect(factor).not.toBe(1);
    expect(factor).toBeGreaterThanOrEqual(0.9);
    expect(factor).toBeLessThanOrEqual(1.1);
    expect(varied!.recipe.endHz / SOUNDS.catch.endHz).toBeCloseTo(factor);
    expect(varied!.recipe.filter!.hz / SOUNDS.catch.filter!.hz).toBeCloseTo(factor);
    expect(plain!.recipe).toBe(SOUNDS.throw);
    const again = make();
    again.audio.play('catch', { pitchVariance: 0.1, rng: createRng(11) });
    expect(again.backend.plays()[0]?.recipe.startHz).toBe(varied!.recipe.startHz);
    const wild = make();
    wild.audio.play('catch', { pitchVariance: 9, rng: createRng(2) });
    const f = wild.backend.plays()[0]!.recipe.startHz / SOUNDS.catch.startHz;
    expect(f).toBeGreaterThanOrEqual(0.5);
    expect(f).toBeLessThanOrEqual(1.5);
  });
});

describe('levels, mute and crowd loop', () => {
  it('setLevels re-pushes bus gains and sanitizes bad numbers', () => {
    const { backend, audio } = make();
    backend.reset();
    audio.setLevels({ master: 1, sfx: 0.25, music: 2, crowd: Number.NaN, commentary: -1 });
    expect(backend.gains).toEqual({ sfx: 0.25, crowd: DEFAULT_SETTINGS.audio.crowd, music: 1, commentary: 0 });
    expect(audio.getLevels()).toEqual({ master: 1, sfx: 0.25, music: 1, crowd: DEFAULT_SETTINGS.audio.crowd, commentary: 0 });
    expect(backend.calls.filter((c) => c.kind === 'setGain')).toHaveLength(4);
    expect(categoryGain({ master: 0.5, sfx: 0.5, music: 1, crowd: 1, commentary: 1 }, 'sfx')).toBe(0.25);
  });

  it('mute silences buses and skips one-shots; unmute restores the configured levels', () => {
    const { backend, audio } = make();
    audio.mute();
    expect(audio.isMuted).toBe(true);
    expect(backend.gains).toEqual({ sfx: 0, crowd: 0, music: 0, commentary: 0 });
    expect(audio.play('tackle')).toBe(false);
    expect(backend.plays()).toHaveLength(0);
    audio.setLevels({ ...LEVELS, sfx: 1 });
    expect(backend.gains.sfx).toBe(0);
    audio.unmute();
    expect(backend.gains).toEqual({ sfx: 0.5, crowd: 0.5, music: 0.3, commentary: 0.1 });
    expect(audio.play('tackle')).toBe(true);
    expect(audio.toggleMute()).toBe(true);
    expect(audio.toggleMute()).toBe(false);
  });

  it("max-roar crowd (the default): any crowd level plays at full volume, and it can be switched to reactive", () => {
    const backend = createNullBackend();
    const audio = new AudioManager(backend, LEVELS, { now: () => 0 });
    expect(audio.getCrowdNoise()).toBe('max');
    audio.crowd(0.3);
    expect(backend.loops.get(CROWD_LOOP_ID)?.gain).toBeCloseTo(SOUNDS.crowdAmbient.gain);
    audio.setCrowdNoise('reactive');
    expect(backend.loops.get(CROWD_LOOP_ID)?.gain).toBeCloseTo(SOUNDS.crowdAmbient.gain * 0.3);
    audio.setCrowdNoise('max');
    expect(backend.loops.get(CROWD_LOOP_ID)?.gain).toBeCloseTo(SOUNDS.crowdAmbient.gain);
    audio.crowd(0);
    expect(backend.loops.has(CROWD_LOOP_ID)).toBe(false);
  });

  it('crowd() starts, ramps and stops the ambient loop', () => {
    const { backend, audio } = make();
    backend.reset();
    audio.crowd(0.5);
    expect(backend.calls).toEqual([{ kind: 'startLoop', id: CROWD_LOOP_ID, recipe: SOUNDS.crowdAmbient, gain: SOUNDS.crowdAmbient.gain * 0.5 }]);
    audio.crowd(0.8);
    expect(backend.calls[1]).toEqual({ kind: 'setLoopGain', id: CROWD_LOOP_ID, gain: SOUNDS.crowdAmbient.gain * 0.8, rampSec: CROWD_RAMP_SEC });
    audio.crowd(1.7);
    expect(backend.loops.get(CROWD_LOOP_ID)?.gain).toBeCloseTo(SOUNDS.crowdAmbient.gain);
    expect(audio.getCrowdLevel()).toBe(1);
    audio.crowd(0);
    expect(backend.calls[3]).toEqual({ kind: 'stopLoop', id: CROWD_LOOP_ID });
    audio.crowd(0);
    audio.crowd(Number.NaN);
    expect(backend.calls).toHaveLength(4);
    audio.crowd(0.3);
    expect(backend.calls[4]?.kind).toBe('startLoop');
    audio.stop();
    expect(backend.loops.size).toBe(0);
  });

  it('resume forwards to the backend', async () => {
    const { backend, audio } = make();
    await audio.resume();
    expect(backend.resumeCount).toBe(1);
  });
});

describe('game event mapping', () => {
  const home: EventContext = { offense: 'home', crowdSide: 'home' };
  const away: EventContext = { offense: 'away', crowdSide: 'home' };
  const ids = (event: AudioGameEvent, ctx: EventContext) => soundsForEvent(event, ctx).map((t) => t.id);

  it('crowdReaction follows allegiance and is neutral when possession is unknown', () => {
    expect(crowdReaction('home', home, true)).toEqual({ id: 'crowdRoar', volume: 1 });
    expect(crowdReaction('away', home, true)).toEqual({ id: 'crowdGroan', volume: 1 });
    expect(crowdReaction('home', home)).toEqual({ id: 'crowdCheer', volume: 0.8 });
    expect(crowdReaction('away', home, false, 0.5)).toEqual({ id: 'crowdGroan', volume: 0.3 });
    expect(crowdReaction(null, home)).toEqual({ id: 'crowdCheer', volume: 0.5 });
    expect(crowdReaction('away', { offense: null, crowdSide: 'away' }, true).id).toBe('crowdRoar');
  });

  it('maps touchdowns to a fanfare plus roar for the crowd side and groan for the visitors', () => {
    expect(ids(ev('touchdown', { scorer: 'off:WR1', side: 'offense' }), home)).toEqual(['touchdown', 'crowdRoar']);
    expect(ids(ev('touchdown', { scorer: 'off:WR1', side: 'offense' }), away)).toEqual(['touchdown', 'crowdGroan']);
    expect(ids(ev('touchdown', { scorer: 'def:CB1', side: 'defense' }), away)).toEqual(['touchdown', 'crowdRoar']);
    expect(ids(ev('touchdown', { scorer: 'off:WR1', side: 'offense' }), { offense: null, crowdSide: 'home' })).toEqual(['touchdown', 'crowdCheer']);
  });

  it('maps tackles, hit sticks, sacks and turnovers', () => {
    const base = { tackler: 'def:LB1', carrier: 'off:RB1', assists: [] };
    expect(ids(ev('tackle', { ...base, kind: 'wrap' }), home)).toEqual(['tackle']);
    expect(ids(ev('tackle', { ...base, kind: 'hitStick' }), home)).toEqual(['bigHit', 'crowdGroan']);
    expect(ids(ev('tackle', { ...base, kind: 'hitStick' }), away)).toEqual(['bigHit', 'crowdCheer']);
    expect(ids(ev('hitStick', { by: 'def:SS', on: 'off:RB1' }), home)).toEqual(['hitStick']);
    expect(ids(ev('sack', { by: 'def:DE1', assists: [], yardsLost: 7 }), away)).toEqual(['sack', 'crowdCheer']);
    expect(ids(ev('interception', { defender: 'def:FS', ballOn: 40 }), away)).toEqual(['interception', 'turnover', 'crowdRoar']);
    expect(ids(ev('interception', { defender: 'def:FS', ballOn: 40 }), home)).toEqual(['interception', 'turnover', 'crowdGroan']);
    expect(ids(ev('fumble', { carrier: 'off:RB1', forcedBy: 'def:LB1', ballOn: 30, forward: false }), home)).toEqual(['fumble', 'crowdGroan']);
    expect(ids(ev('fumble', { carrier: 'def:CB1', forcedBy: null, ballOn: 30, forward: false }), home)).toEqual(['fumble', 'crowdCheer']);
    expect(ids(ev('recovery', { by: 'def:LB1', side: 'defense', ballOn: 30, advanced: false }), home)).toEqual(['turnover', 'crowdGroan']);
    expect(ids(ev('recovery', { by: 'off:OL1', side: 'offense', ballOn: 30, advanced: false }), home)).toEqual(['crowdCheer']);
  });

  it('maps passing, kicking, penalties, whistles and special moves', () => {
    expect(ids(ev('throw', { thrower: 'off:QB', target: 'off:WR1', throwType: 'bullet', airYards: 12, difficulty: 0.3 }), home)).toEqual(['throw']);
    expect(ids(ev('catch', { receiver: 'off:WR1', contested: false, catchKind: 'possession', ballOn: 50 }), home)).toEqual(['catch']);
    expect(ids(ev('catch', { receiver: 'off:WR1', contested: true, catchKind: 'highPoint', ballOn: 50 }), home)).toEqual(['catch', 'crowdCheer']);
    expect(ids(ev('incomplete', { reason: 'drop', target: 'off:WR1', defender: null }), home)).toEqual(['incomplete', 'crowdGroan']);
    expect(ids(ev('kick', { kicker: 'off:K', kind: 'kickoff', power: 1, accuracy: 1 }), home)).toEqual(['kickoff']);
    expect(ids(ev('kick', { kicker: 'off:P', kind: 'punt', power: 1, accuracy: 1 }), home)).toEqual(['punt']);
    expect(soundsForEvent(ev('kick', { kicker: 'off:K', kind: 'fieldGoal', power: 1, accuracy: 1 }), home)).toEqual([{ id: 'kickoff', volume: 0.7 }]);
    expect(ids(ev('kickResult', { kind: 'fieldGoal', made: true, distance: 45 }), home)).toEqual(['fieldGoal', 'crowdRoar']);
    expect(ids(ev('kickResult', { kind: 'fieldGoal', made: false, distance: 45 }), home)).toEqual(['crowdGroan']);
    expect(ids(ev('kickResult', { kind: 'extraPoint', made: true, distance: 33 }), away)).toEqual(['fieldGoal', 'crowdGroan']);
    expect(ids(ev('kickResult', { kind: 'punt', made: true, distance: 45 }), home)).toEqual([]);
    expect(ids(ev('kickBlocked', { by: 'def:DE1' }), away)).toEqual(['bigHit', 'crowdRoar']);
    const penalty = { foul: 'holdingOffense', side: 'offense', yards: 10, playerId: null, automaticFirstDown: false, lossOfDown: false,
      enforcement: 'previousSpot', spotBallOn: null, deadBall: false, replayDown: true, accepted: false } as const;
    expect(ids(ev('penalty', { penalty }), home)).toEqual(['penaltyFlag', 'crowdGroan']);
    expect(ids(ev('penalty', { penalty: { ...penalty, side: 'defense' } }), home)).toEqual(['penaltyFlag', 'crowdCheer']);
    expect(ids(ev('whistle', { reason: 'tackle' }), home)).toEqual(['whistle']);
    expect(ids(ev('firstDown', {}), home)).toEqual(['firstDown', 'crowdCheer']);
    expect(ids(ev('safety', {}), home)).toEqual(['fieldGoal', 'crowdGroan']);
    expect(ids(ev('specialMove', { athlete: 'off:RB1', move: 'juke' }), home)).toEqual(['hitStick']);
    expect(ids(ev('specialMove', { athlete: 'off:RB1', move: 'truck' }), home)).toEqual(['tackle']);
    expect(ids(ev('specialMove', { athlete: 'off:RB1', move: 'none' }), home)).toEqual([]);
    expect(ids(ev('injury', { athlete: 'off:RB1', severity: 'minor' }), away)).toEqual(['crowdGroan']);
    expect(ids(ev('challenge', { side: 'away', call: 'catch', overturned: true }), home)).toEqual(['whistle', 'crowdGroan']);
    expect(ids(ev('challenge', { side: 'away', call: 'catch', overturned: false }), home)).toEqual(['whistle', 'crowdRoar']);
    expect(ids(ev('onsideRecovery', { by: 'off:K', side: 'offense' }), home)).toEqual(['firstDown', 'crowdRoar']);
    expect(ids(ev('snap', {}), home)).toEqual(['snap']);
    expect(ids(ev('handoff', { from: 'off:QB', to: 'off:RB1' }), home)).toEqual([]);
  });

  it('maps controller-level events', () => {
    expect(ids({ type: 'twoMinuteWarning' }, home)).toEqual(['twoMinute']);
    expect(ids({ type: 'gameOver', winner: 'home' }, home)).toEqual(['gameOver', 'crowdRoar']);
    expect(ids({ type: 'gameOver', winner: null }, home)).toEqual(['gameOver', 'crowdCheer']);
    expect(ids({ type: 'score', teamSide: 'away', points: 6 }, home)).toEqual(['touchdown', 'crowdGroan']);
    expect(ids({ type: 'score', teamSide: 'home', points: 3 }, home)).toEqual(['fieldGoal', 'crowdRoar']);
    expect(ids({ type: 'score', teamSide: 'home', points: 2 }, home)).toEqual(['firstDown', 'crowdCheer']);
    expect(ids({ type: 'score', teamSide: 'home', points: 1 }, home)).toEqual(['fieldGoal', 'crowdCheer']);
    expect(ids({ type: 'score', teamSide: 'home', points: 0 }, home)).toEqual([]);
    expect(ids({ type: 'timeout', teamSide: 'home' }, home)).toEqual(['whistle']);
    expect(ids({ type: 'menuMove' }, home)).toEqual(['menuMove']);
    expect(ids({ type: 'menuSelect' }, home)).toEqual(['menuSelect']);
    expect(ids({ type: 'menuBack' }, home)).toEqual(['menuBack']);
    expect(ids({ type: 'possession', offense: 'home' }, home)).toEqual([]);
  });
});

describe('AudioManager.onGameEvent', () => {
  it('tracks possession and plays home/away crowd reactions through the backend', () => {
    const { backend, audio, advance } = make();
    expect(audio.getPossession()).toBeNull();
    expect(audio.onGameEvent({ type: 'possession', offense: 'home' })).toEqual([]);
    expect(audio.getPossession()).toBe('home');
    expect(audio.onGameEvent(ev('touchdown', { scorer: 'off:WR1', side: 'offense' }))).toEqual(['touchdown', 'crowdRoar', 'boothExcited']);
    advance(100);
    audio.setPossession('away');
    expect(audio.onGameEvent(ev('touchdown', { scorer: 'off:WR1', side: 'offense' }))).toEqual(['touchdown', 'crowdGroan', 'boothExcited']);
    expect(backend.plays().map((p) => p.recipe.category)).toEqual(['music', 'crowd', 'commentary', 'music', 'crowd', 'commentary']);
    expect(backend.plays()[1]?.effectiveGain).toBeCloseTo(SOUNDS.crowdRoar.gain * 0.5);
    advance(100);
    audio.setCrowdSide('away');
    expect(audio.getCrowdSide()).toBe('away');
    expect(audio.onGameEvent(ev('touchdown', { scorer: 'off:WR1', side: 'offense' }))).toEqual(['touchdown', 'crowdRoar', 'boothExcited']);
  });

  it('dedups a controller score arriving on the same tick as the touchdown event', () => {
    const { audio, advance } = make();
    audio.onGameEvent({ type: 'possession', offense: 'home' });
    expect(audio.onGameEvent(ev('touchdown', { scorer: 'off:WR1', side: 'offense' }))).toEqual(['touchdown', 'crowdRoar', 'boothExcited']);
    expect(audio.onGameEvent({ type: 'score', teamSide: 'home', points: 6 })).toEqual([]);
    advance(SOUND_THROTTLE_MS);
    expect(audio.onGameEvent({ type: 'score', teamSide: 'home', points: 6 })).toEqual(['touchdown', 'crowdRoar']);
  });

  it('ignores unknown, malformed and muted events', () => {
    const { backend, audio } = make();
    expect(audio.onGameEvent({ type: 'somethingNew' })).toEqual([]);
    expect(audio.onGameEvent({ type: 'penalty' })).toEqual(['penaltyFlag', 'crowdCheer', 'paChime']);
    expect(audio.onGameEvent({ type: 'tackle' })).toEqual(['tackle']);
    expect(audio.onGameEvent(null as unknown as AudioGameEvent)).toEqual([]);
    expect(audio.onGameEvent({ type: 7 } as unknown as AudioGameEvent)).toEqual([]);
    expect(audio.onGameEvent({ type: 'possession', offense: 'nowhere' } as { type: string })).toEqual([]);
    expect(audio.getPossession()).toBeNull();
    audio.mute();
    expect(audio.onGameEvent(ev('whistle', { reason: 'tackle' }))).toEqual([]);
    expect(backend.plays()).toHaveLength(4);
  });

  it('stop() clears throttle state so the next play goes through immediately', () => {
    const { audio } = make();
    audio.play('whistle');
    expect(audio.play('whistle')).toBe(false);
    audio.stop();
    expect(audio.play('whistle')).toBe(true);
  });
});
