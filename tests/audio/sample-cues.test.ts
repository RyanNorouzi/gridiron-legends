import { describe, expect, it } from 'vitest';
import type { PlayEvent } from '@/game/play-events';
import { crowdCuesForEvent, crowdCueForTrigger } from '@/audio/crowd-cues';
import { soundsForEvent, type AudioGameEvent, type EventContext } from '@/audio/manager';
import {
  CONTACT_MEMORY_MS, PAN_WIDTH, contactIntensity, contactTier, cueTier, panFor, sfxCuesForEvent, type AudioScene, type SampleCue,
} from '@/audio/sample-cues';

const ev = <T extends PlayEvent['type']>(type: T, extra: Omit<Extract<PlayEvent, { type: T }>, 'type' | 'tick'>): PlayEvent =>
  ({ type, tick: 0, ...extra }) as PlayEvent;
const ids = (cues: readonly SampleCue[]): string[] => cues.map((c) => c.id);

const scene = (over: { tacklerVel?: number; carrierY?: number; direction?: 1 | -1; ballY?: number } = {}): AudioScene => ({
  ctx: { direction: over.direction ?? 1 },
  ball: { pos: { x: 26, y: over.ballY ?? 50 } },
  athletes: [
    { id: 'def:MLB', pos: { x: 26, y: 50 }, vel: { x: 0, y: -(over.tacklerVel ?? 0) }, massLb: 240 },
    { id: 'off:RB', pos: { x: 26, y: over.carrierY ?? 50 }, vel: { x: 0, y: 2 }, massLb: 215 },
    { id: 'off:QB', pos: { x: 26, y: 44 }, vel: { x: 0, y: 0 }, massLb: 225 },
  ],
});
const noMemory = (s: AudioScene | null = null) => ({ scene: s, msSinceContact: Number.POSITIVE_INFINITY });

describe('contact intensity', () => {
  it('orders tackle kinds and rises with closing speed and assists', () => {
    expect(contactIntensity({ kind: 'arm' })).toBeLessThan(contactIntensity({ kind: 'wrap' }));
    expect(contactIntensity({ kind: 'wrap' })).toBeLessThan(contactIntensity({ kind: 'hitStick' }));
    expect(contactIntensity({ kind: 'wrap', closingSpeed: 11 })).toBeGreaterThan(contactIntensity({ kind: 'wrap', closingSpeed: 2 }));
    expect(contactIntensity({ kind: 'gang', assists: 3 })).toBeGreaterThan(contactIntensity({ kind: 'gang', assists: 0 }));
    expect(contactTier(contactIntensity({ kind: 'arm', closingSpeed: 1 }))).toBe('light');
    expect(contactTier(contactIntensity({ kind: 'hitStick', closingSpeed: 9 }))).toBe('big');
    // Measured in the running game: routine wrap-ups close at ~8-11 yd/s. They land solid, not big (no crowd
    // "oooh" on every play); an open-field hit near head-on is big.
    expect(contactTier(contactIntensity({ kind: 'wrap', closingSpeed: 11, massLb: 460 }))).toBe('solid');
    expect(contactTier(contactIntensity({ kind: 'arm', closingSpeed: 8, massLb: 420 }))).toBe('light');
    expect(contactTier(contactIntensity({ kind: 'openField', closingSpeed: 14, massLb: 450 }))).toBe('big');
  });
});

describe('sfxCuesForEvent', () => {
  it('layers a big hit: pad crack + helmet + pad clatter + grunt, then the body hitting the turf', () => {
    const cues = sfxCuesForEvent(ev('tackle', { tackler: 'def:MLB', carrier: 'off:RB', kind: 'hitStick', assists: [] }), noMemory(scene({ tacklerVel: 9 })));
    expect(ids(cues)).toEqual(['sfx.tackle_big', 'sfx.helmet_clack', 'sfx.pad_clatter', 'sfx.grunt_hit', 'sfx.turf']);
    expect(cues.find((c) => c.id === 'sfx.turf')!.delayMs).toBeGreaterThan(100);
    expect(cueTier(cues)).toBe('big');
  });

  it('gives a slow arm tackle a softer thud and piles a clatter', () => {
    const arm = sfxCuesForEvent(ev('tackle', { tackler: 'def:MLB', carrier: 'off:RB', kind: 'arm', assists: [] }), noMemory(scene()));
    expect(ids(arm)).toEqual(['sfx.tackle_light', 'sfx.grunt_hit', 'sfx.turf']);
    const gang = sfxCuesForEvent(ev('tackle', { tackler: 'def:MLB', carrier: 'off:RB', kind: 'gang', assists: ['def:SS', 'def:CB1'] }), noMemory(scene()));
    expect(ids(gang)).toContain('sfx.pad_clatter');
  });

  it('after a wrap-up already sounded the impact, the tackle is the finishing blow and the fall', () => {
    const cues = sfxCuesForEvent(ev('tackle', { tackler: 'def:MLB', carrier: 'off:RB', kind: 'wrap', assists: [] }), { scene: scene(), msSinceContact: CONTACT_MEMORY_MS - 1 });
    expect(ids(cues)).toEqual(['sfx.tackle_solid', 'sfx.turf']);
    // A solid finishing blow, never a second big hit: the crowd's 'oooh' (big tier only) is not doubled.
    expect(cueTier(cues)).toBe('solid');
  });

  it('maps the snap, whistles, catches and kicks', () => {
    expect(ids(sfxCuesForEvent(ev('snap', {}), noMemory()))).toEqual(['sfx.snap', 'sfx.stomp', 'sfx.pad_clatter', 'sfx.grunt_effort']);
    expect(ids(sfxCuesForEvent(ev('whistle', { reason: 'tackle' }), noMemory()))).toEqual(['sfx.whistle_short']);
    expect(ids(sfxCuesForEvent(ev('whistle', { reason: 'touchdown' }), noMemory()))).toEqual(['sfx.whistle_long']);
    expect(ids(sfxCuesForEvent({ type: 'quarterEnd' }, noMemory()))).toEqual(['sfx.whistle_long']);
    expect(ids(sfxCuesForEvent(ev('catch', { receiver: 'off:RB', contested: false, catchKind: 'diving', ballOn: 30 }), noMemory()))).toEqual(['sfx.catch', 'sfx.turf']);
    const kick = sfxCuesForEvent(ev('kick', { kicker: 'off:K', kind: 'punt', power: 1, accuracy: 1 }), noMemory());
    expect(kick[0]?.id).toBe('sfx.kick');
    expect(kick[0]?.gain).toBeCloseTo(1);
    expect(sfxCuesForEvent({ type: 'menuMove' }, noMemory())).toEqual([]);
  });

  it('pans relative to the ball on the horizontal screen (offense attacks right)', () => {
    expect(panFor(null, { x: 0, y: 0 })).toBe(0);
    const right = panFor(scene({ direction: 1 }), { x: 26, y: 60 });
    expect(right).toBeGreaterThan(0);
    expect(panFor(scene({ direction: -1 }), { x: 26, y: 60 })).toBeCloseTo(-right);
    expect(panFor(scene(), { x: 26, y: 200 })).toBeCloseTo(PAN_WIDTH);
    const pancake = sfxCuesForEvent(ev('pileJoin', { defender: 'def:MLB', carrier: 'off:QB' }), noMemory(scene()));
    expect(pancake[0]?.pan).toBeLessThan(0);
  });
});

describe('crowdCuesForEvent', () => {
  const home: EventContext = { offense: 'home', crowdSide: 'home' };
  const away: EventContext = { offense: 'away', crowdSide: 'home' };
  const crowd = (e: AudioGameEvent, ctx: EventContext, tier: 'big' | null = null) => ids(crowdCuesForEvent(e, soundsForEvent(e, ctx), { ...ctx, tier }));

  it('turns synth crowd triggers into recordings', () => {
    expect(crowdCueForTrigger({ id: 'crowdRoar', volume: 1 })?.id).toBe('crowd.roar');
    expect(crowdCueForTrigger({ id: 'crowdCheer', volume: 0.3 })?.id).toBe('crowd.applause');
    expect(crowdCueForTrigger({ id: 'tackle', volume: 1 })).toBeNull();
  });

  it('roars and sounds the horn for a home touchdown, boos an away one', () => {
    const td = ev('touchdown', { scorer: 'off:RB', side: 'offense' });
    expect(crowd(td, home)).toEqual(['crowd.roar', 'crowd.horn']);
    expect(crowd(td, away)).toEqual(['crowd.groan', 'crowd.boo']);
  });

  it('boos a flag on the home side and cheers one on the visitors', () => {
    const pen = (side: 'offense' | 'defense') => ev('penalty', { penalty: { foul: 'holdingOffense', side, yards: 10, playerId: null, automaticFirstDown: false, lossOfDown: false, enforcement: 'previousSpot', spotBallOn: null, deadBall: false, replayDown: true, accepted: false } });
    expect(crowd(pen('offense'), home)).toEqual(['crowd.boo']);
    expect(crowd(pen('offense'), away)).toEqual(['crowd.cheer']);
  });

  it('adds an oooh on big hits, a drum on home takeaways and a swell on deep balls', () => {
    expect(crowd(ev('tackle', { tackler: 'def:MLB', carrier: 'off:RB', kind: 'wrap', assists: [] }), home, 'big')).toContain('crowd.oooh');
    expect(crowd(ev('interception', { defender: 'def:CB1', ballOn: 40 }), away)).toEqual(['crowd.roar', 'crowd.drum']);
    expect(crowd(ev('throw', { thrower: 'off:QB', target: 'off:WR1', throwType: 'lob', airYards: 35, difficulty: 0.5 }), home)).toEqual(['crowd.swell']);
    expect(crowd(ev('throw', { thrower: 'off:QB', target: 'off:WR1', throwType: 'bullet', airYards: 6, difficulty: 0.5 }), home)).toEqual([]);
  });
});

describe('block lock-ups', () => {
  it('every block engagement sounds: a pad pop on a pass set, a heavier thud on a run block', () => {
    expect(sfxCuesForEvent(ev('blockEngage', { blocker: 'off:LT', defender: 'def:DE1', kind: 'pass' }), noMemory()).map((c) => c.id)).toEqual(['sfx.tackle_light']);
    expect(sfxCuesForEvent(ev('blockEngage', { blocker: 'off:RG', defender: 'def:DT1', kind: 'run' }), noMemory()).map((c) => c.id)).toEqual(['sfx.tackle_solid']);
  });
});

