import { afterEach, describe, expect, it } from 'vitest';
import type { PlayEvent } from '@/game/play-events';
import type { AthleteState } from '@/game/play-types';
import { AnimMemory, eventActors } from '@/ui/render/anim-memory';
import { chooseLooks, coreLook, registerLookOverride, stanceFor, type LookAthlete, type LookContext, type PlacedAthlete } from '@/ui/render/anim-select';

/** A test athlete; the drawn heading follows the velocity unless given (as the scene does). */
const athlete = (over: Partial<LookAthlete> = {}): LookAthlete => ({
  id: 'off:WR1', side: 'offense', position: 'WR', role: 'WR1', state: 'moving', stateTimer: 0, hasBall: false, vx: 0, vy: 0, topSpeed: 8,
  facing: Math.atan2(over.vy ?? 0, over.vx ?? 0), ...over,
});
/** Placed on a horizontal field: world +y is screen right (the camera's non-flipped view). */
const place = (a: LookAthlete, wx: number, wy: number): PlacedAthlete => {
  const h = a.facing;
  const b = a.bodyFacing ?? a.facing;
  return { a, x: wy * 22, y: wx * 22, wx, wy, dir: { x: Math.sin(h), y: Math.cos(h) }, body: { x: Math.sin(b), y: Math.cos(b) } };
};
const context = (placed: PlacedAthlete[], mem: AnimMemory, over: Partial<LookContext> = {}): LookContext => ({
  mem, presnap: false, tier: 1, animate: true, ball: { x: 26, y: 40, phase: 'held', carrierId: null }, losY: 40, snapX: 26, placed,
  byId: new Map(placed.map((p) => [p.a.id, p])), ...over,
});
const sync = (mem: AnimMemory, tick: number, events: PlayEvent[] = [], key = 'p1'): void => {
  mem.sync({ playKey: key, tick, events, frames: null });
};
const lookAt = (a: LookAthlete, mem: AnimMemory, tick: number, events: PlayEvent[] = [], over: Partial<LookContext> = {}) => {
  sync(mem, tick, events);
  const p = place(a, 26, 40);
  return chooseLooks(context([p], mem, over)).get(a.id) as NonNullable<ReturnType<typeof coreLook>>;
};

const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) cleanups.pop()?.(); });

describe('clip selection', () => {
  it('picks pre-snap stances by position and alignment', () => {
    const ctx = { snapX: 26, ball: { x: 26, y: 40, phase: 'presnap' as const, carrierId: null } };
    expect(stanceFor(place(athlete({ position: 'C', role: 'C' }), 26, 40.5), ctx)).toBe('snapStance');
    expect(stanceFor(place(athlete({ position: 'OG' }), 27.3, 40.5), ctx)).toBe('stance3');
    expect(stanceFor(place(athlete({ position: 'DT', side: 'defense' }), 27, 39), ctx)).toBe('stance3');
    expect(stanceFor(place(athlete({ position: 'QB' }), 26, 41), ctx)).toBe('qbUnderCenter');
    expect(stanceFor(place(athlete({ position: 'QB' }), 26, 45), ctx)).toBe('qbShotgun');
    expect(stanceFor(place(athlete({ position: 'TE' }), 29, 41), ctx)).toBe('stance3');
    expect(stanceFor(place(athlete({ position: 'TE' }), 40, 41), ctx)).toBe('stance2');
    expect(stanceFor(place(athlete({ position: 'CB', side: 'defense' }), 5, 33), ctx)).toBe('dbReady');
    expect(stanceFor(place(athlete(), 4, 40.5), ctx)).toBe('stance2');
  });

  it('chooses jog / run / sprint by the share of top speed, carry with the ball, backpedal and shuffle by body facing', () => {
    const mem = new AnimMemory();
    expect(lookAt(athlete({ vy: 3 }), mem, 10).clip).toBe('jog');
    expect(lookAt(athlete({ vy: 5.5 }), mem, 11).clip).toBe('run');
    expect(lookAt(athlete({ vy: 7.5 }), mem, 12).clip).toBe('sprint');
    expect(lookAt(athlete({ vy: 5, hasBall: true }), mem, 13).clip).toBe('carry');
    expect(lookAt(athlete({ vy: 7.5, hasBall: true }), mem, 14).clip).toBe('carrySprint');
    expect(lookAt(athlete({ vy: 0.1 }), mem, 15).clip).toBe('idle');
    // a corner moving backward against his body facing backpedals and keeps facing the play
    const cb = athlete({ id: 'def:CB1', side: 'defense', position: 'CB', vy: 3, facing: Math.PI / 2, bodyFacing: -Math.PI / 2 });
    const back = lookAt(cb, mem, 16);
    expect(back.clip).toBe('backpedal');
    expect(back.facing).toBe('w');
    const lb = athlete({ id: 'def:MLB', side: 'defense', position: 'MLB', vx: 3, bodyFacing: -Math.PI / 2 });
    expect(lookAt(lb, mem, 17).clip).toBe('shuffle');
  });

  it('advances run cycles with distance travelled, not time', () => {
    const mem = new AnimMemory();
    sync(mem, 0);
    const a = athlete({ vy: 5.5 });
    const frames: number[] = [];
    for (let i = 0; i < 6; i++) {
      sync(mem, i * 10);
      const p = place(a, 26, 40 + i * 0.6);
      frames.push(chooseLooks(context([p], mem)).get(a.id)!.frame);
    }
    // standing still for a while does not advance the cycle
    const still: number[] = [];
    for (let i = 0; i < 4; i++) {
      sync(mem, 100 + i * 10);
      const p = place(a, 26, 43);
      still.push(chooseLooks(context([p], mem)).get(a.id)!.frame);
    }
    expect(new Set(frames).size).toBeGreaterThan(3);
    expect(new Set(still.slice(1)).size).toBe(1);
  });

  it('plays a throw from its event and finishes it after the state changed, then hands back', () => {
    const mem = new AnimMemory();
    const ev: PlayEvent = { type: 'throw', tick: 100, thrower: 'off:QB', target: 'off:WR1', throwType: 'bullet', airYards: 20, difficulty: 0.3 };
    const qb = (state: AthleteState) => athlete({ id: 'off:QB', position: 'QB', role: 'QB', state });
    expect(lookAt(qb('throwing'), mem, 99, [ev]).clip).toBe('throw');
    const after = lookAt(qb('idle'), mem, 104, [ev]);
    expect(after.clip).toBe('throw');
    expect(after.frame).toBeGreaterThanOrEqual(2);
    expect(lookAt(qb('idle'), mem, 140, [ev]).clip).toBe('idle');
  });

  it('lets a state one-shot (a juke) finish even when the state ends early, but contact interrupts it', () => {
    const mem = new AnimMemory();
    const rb = (state: AthleteState, timer = 0) => athlete({ id: 'off:RB', position: 'RB', state, stateTimer: timer, vy: 6, hasBall: true });
    expect(lookAt(rb('juking', 0.05), mem, 200).clip).toBe('juke');
    expect(lookAt(rb('moving'), mem, 204).clip).toBe('juke');
    expect(lookAt(rb('moving'), mem, 240).clip).toBe('carry');
    expect(lookAt(rb('juking', 0.02), mem, 250).clip).toBe('juke');
    expect(lookAt(rb('tackled', 0.1), mem, 252).clip).toMatch(/^tackled/);
  });

  it('faces an engaged partner and lets a contact override take over (with a render offset)', () => {
    const mem = new AnimMemory();
    sync(mem, 10);
    const ol = place(athlete({ id: 'off:LG', position: 'OG', state: 'engaged', engagedWith: 'def:DT1' }), 25, 40.4);
    const dl = place(athlete({ id: 'def:DT1', side: 'defense', position: 'DT', state: 'engaged', engagedWith: 'off:LG' }), 25, 39.6);
    const looks = chooseLooks(context([ol, dl], mem));
    expect(looks.get('off:LG')).toMatchObject({ clip: 'handFight', facing: 'w' });
    expect(looks.get('def:DT1')).toMatchObject({ clip: 'handFight', facing: 'e' });
    cleanups.push(registerLookOverride((_ctx, core) => new Map([['off:LG', { ...(core.get('off:LG') as NonNullable<ReturnType<typeof core.get>>), clip: 'driveBlock', dx: 3 }]])));
    const over = chooseLooks(context([ol, dl], mem));
    expect(over.get('off:LG')).toMatchObject({ clip: 'driveBlock', dx: 3 });
    expect(over.get('def:DT1')?.clip).toBe('handFight');
  });

  it('infers the engaged partner when the scene has none (replays)', () => {
    const mem = new AnimMemory();
    sync(mem, 10);
    const ol = place(athlete({ id: 'off:LG', position: 'OG', state: 'engaged' }), 25, 40.4);
    const dl = place(athlete({ id: 'def:DT1', side: 'defense', position: 'DT', state: 'engaged' }), 25.2, 39.5);
    const looks = chooseLooks(context([ol, dl], mem));
    expect(looks.get('off:LG')?.facing).toBe('w');
  });

  it('gets up after lying down', () => {
    const mem = new AnimMemory();
    const a = (state: AthleteState) => athlete({ id: 'off:RB', position: 'RB', state });
    expect(lookAt(a('down'), mem, 10).lying).toBe(true);
    expect(lookAt(a('idle'), mem, 12).clip).toBe('getUp');
    expect(lookAt(a('idle'), mem, 60).clip).toBe('idle');
  });
});

describe('animation memory', () => {
  it('indexes events by the athletes they concern', () => {
    const e: PlayEvent = { type: 'tackle', tick: 5, tackler: 'def:MLB', carrier: 'off:RB', kind: 'wrap', assists: ['def:SS'] };
    expect(eventActors(e).sort()).toEqual(['def:MLB', 'def:SS', 'off:RB']);
    const mem = new AnimMemory();
    mem.sync({ playKey: 'k', tick: 6, events: [e], frames: null });
    expect(mem.lastEvent('def:SS', 'tackle')).toBe(e);
    expect(mem.lastEvent('off:WR1', 'tackle')).toBeNull();
    expect(mem.timeSince(e)).toBeCloseTo(1 / 60);
  });

  it('resets on a new play and on a seek (clock backward or far forward)', () => {
    const mem = new AnimMemory();
    expect(mem.sync({ playKey: 'a', tick: 0, events: [], frames: null })).toBe(true);
    expect(mem.sync({ playKey: 'a', tick: 1.5, events: [], frames: null })).toBe(false);
    expect(mem.sync({ playKey: 'a', tick: 1, events: [], frames: null })).toBe(true);
    expect(mem.sync({ playKey: 'a', tick: 200, events: [], frames: null })).toBe(true);
    expect(mem.sync({ playKey: 'b', tick: 201, events: [], frames: null })).toBe(true);
  });

  it('reads the odometer from recorded frames when present, identically at any sampling', () => {
    const frames = Array.from({ length: 20 }, (_, i) => ({ tick: 50 + i, athletes: [{ id: 'a', x: 0, y: i * 0.1, facing: 0, state: 'moving' as const, hasBall: false }], ball: { x: 0, y: 0, z: 0, phase: 'held' as const } }));
    const m1 = new AnimMemory();
    m1.sync({ playKey: 'r', tick: 60.5, events: [], frames });
    const m2 = new AnimMemory();
    for (const t of [50, 53.2, 57, 60.5]) m2.sync({ playKey: 'r', tick: t, events: [], frames });
    expect(m1.distance('a')).toBeCloseTo(1.05);
    expect(m2.distance('a')).toBeCloseTo(m1.distance('a'));
  });

  it('keeps counting past the last recorded frame (a live post-whistle settle) from the positions shown', () => {
    const frames = Array.from({ length: 10 }, (_, i) => ({ tick: i, athletes: [{ id: 'a', x: 0, y: i * 0.1, facing: 0, state: 'moving' as const, hasBall: false }], ball: { x: 0, y: 0, z: 0, phase: 'held' as const } }));
    const mem = new AnimMemory();
    let y = 0;
    for (let t = 0; t <= 9; t++) {
      mem.sync({ playKey: 'p', tick: t, events: [], frames });
      mem.observe('a', 0, (y = t * 0.1));
    }
    const atEnd = mem.distance('a');
    expect(atEnd).toBeCloseTo(0.9);
    // the settle: no more frames, the body keeps moving 0.05 yd a tick
    for (let t = 10; t <= 13; t++) {
      mem.sync({ playKey: 'p', tick: t, events: [], frames });
      mem.observe('a', 0, (y += 0.05));
      expect(mem.distance('a')).toBeCloseTo(atEnd + (t - 9) * 0.05);
    }
  });
});
