import { describe, expect, it } from 'vitest';
import type { PlayEvent } from '@/game/play-events';
import { AnimMemory } from '@/ui/render/anim-memory';
import type { Look } from '@/ui/render/anim';
import type { LookAthlete, LookContext, PlacedAthlete } from '@/ui/render/anim-select';
import { coreCues } from '@/ui/render/figures/look-core';

const athlete = (over: Partial<LookAthlete> = {}): LookAthlete => ({
  id: 'off:WR1', side: 'offense', position: 'WR', role: 'WR1', state: 'moving', stateTimer: 0, hasBall: false, vx: 0, vy: 0, topSpeed: 8, facing: 0, ...over,
});
const place = (a: LookAthlete, wx: number, wy: number): PlacedAthlete => ({ a, x: wy * 22, y: wx * 22, wx, wy, dir: { x: 1, y: 0 }, body: { x: 1, y: 0 } });
const ctxOf = (placed: PlacedAthlete[], mem: AnimMemory, over: Partial<LookContext> = {}): LookContext => ({
  mem, presnap: false, tier: 1, animate: true, ball: { x: 26, y: 40, phase: 'held', carrierId: null }, losY: 40, snapX: 26, placed,
  byId: new Map(placed.map((p) => [p.a.id, p])), ...over,
});
const at = (tick: number, events: PlayEvent[]): AnimMemory => {
  const mem = new AnimMemory();
  mem.sync({ playKey: 'p', tick, events, frames: null });
  return mem;
};
const cur = (entries: [string, Look['clip']][]): Map<string, Look> => new Map(entries.map(([id, clip]) => [id, { clip, frame: 0, facing: 'e', dx: 0, dy: 0 }]));

describe('core look cues (chain A)', () => {
  it('plays catchDive for a diving catch, drop for the target and swat for the defender', () => {
    const wr = place(athlete(), 20, 50);
    const cb = place(athlete({ id: 'def:CB1', side: 'defense', position: 'CB', role: 'CB1' }), 21, 50);
    const dive = coreCues(ctxOf([wr], at(62, [{ type: 'catch', tick: 60, receiver: wr.a.id, contested: false, catchKind: 'diving', ballOn: 50 }])), cur([[wr.a.id, 'catchChest']]));
    expect(dive.get(wr.a.id)?.clip).toBe('catchDive');
    const inc: PlayEvent = { type: 'incomplete', tick: 60, reason: 'drop', target: wr.a.id, defender: cb.a.id };
    const dropped = coreCues(ctxOf([wr, cb], at(63, [inc])), cur([[wr.a.id, 'jog'], [cb.a.id, 'run']]));
    expect(dropped.get(wr.a.id)?.clip).toBe('drop');
    const defended = coreCues(ctxOf([wr, cb], at(63, [{ ...inc, reason: 'defended' }])), cur([[wr.a.id, 'jog'], [cb.a.id, 'run']]));
    expect(defended.get(cb.a.id)?.clip).toBe('swat');
    // long after the event nothing is left
    expect(coreCues(ctxOf([wr, cb], at(400, [inc])), cur([[wr.a.id, 'jog']])).size).toBe(0);
  });

  it('never overrides contact or ground looks', () => {
    const wr = place(athlete(), 20, 50);
    const inc: PlayEvent = { type: 'incomplete', tick: 60, reason: 'drop', target: wr.a.id, defender: null };
    for (const clip of ['wrap', 'handFight', 'tackledBack', 'down'] as const) expect(coreCues(ctxOf([wr], at(63, [inc])), cur([[wr.a.id, clip]])).has(wr.a.id)).toBe(false);
  });

  it('raises the hands for an arriving pass and waits in the returner stance', () => {
    const wr = place(athlete({ vy: 6 }), 20, 50);
    const thr: PlayEvent = { type: 'throw', tick: 30, thrower: 'off:QB', target: wr.a.id, throwType: 'bullet', airYards: 12, difficulty: 0.3 };
    const near = coreCues(ctxOf([wr], at(50, [thr]), { ball: { x: 20.5, y: 51, phase: 'inAir', carrierId: null } }), cur([[wr.a.id, 'run']]));
    expect(near.get(wr.a.id)?.clip).toBe('reachOut');
    const far = coreCues(ctxOf([wr], at(50, [thr]), { ball: { x: 20, y: 70, phase: 'inAir', carrierId: null } }), cur([[wr.a.id, 'run']]));
    expect(far.has(wr.a.id)).toBe(false);
    const kr = place(athlete({ id: 'def:KR1', side: 'defense', position: 'RB', role: 'KR1' }), 26, 95);
    expect(coreCues(ctxOf([kr], at(5, []), { presnap: true }), cur([[kr.a.id, 'stance2']])).get(kr.a.id)?.clip).toBe('returnerReady');
  });

  it('kneels the holder and bends the long snapper over the ball on a field goal', () => {
    const snapper = place(athlete({ id: 'off:C', position: 'C', role: 'C' }), 26, 40.6);
    const holder = place(athlete({ id: 'off:H', position: 'QB', role: 'H' }), 26, 47);
    const kicker = place(athlete({ id: 'off:K', position: 'K', role: 'K' }), 25, 49.5);
    const placed = [snapper, holder, kicker];
    const pre = coreCues(ctxOf(placed, at(5, []), { presnap: true }), cur([[snapper.a.id, 'snapStance'], [holder.a.id, 'stance2'], [kicker.a.id, 'idle']]));
    expect(pre.get(holder.a.id)?.clip).toBe('holdPlace');
    expect(pre.get(holder.a.id)?.frame).toBe(0);
    expect(pre.get(snapper.a.id)?.clip).toBe('longSnap');
    const snap: PlayEvent = { type: 'snap', tick: 10 };
    const caught = coreCues(ctxOf(placed, at(40, [snap]), { ball: { x: 26, y: 47, phase: 'held', carrierId: holder.a.id } }), cur([[holder.a.id, 'idle'], [snapper.a.id, 'snap']]));
    expect(caught.get(holder.a.id)?.frame).toBe(2);
    expect(caught.has(kicker.a.id)).toBe(false);
  });

  it('sets the pocket quarterback feet with the ball up instead of an idle with the ball at the hip', () => {
    const qb = place(athlete({ id: 'off:QB', position: 'QB', role: 'QB', state: 'idle', hasBall: true }), 26, 33);
    const rb = place(athlete({ id: 'off:RB', position: 'RB', role: 'RB', state: 'idle', hasBall: true }), 22, 45);
    const snap: PlayEvent = { type: 'snap', tick: 10 };
    const live = coreCues(ctxOf([qb, rb], at(120, [snap])), cur([[qb.a.id, 'idle'], [rb.a.id, 'idle']]));
    expect(live.get(qb.a.id)?.clip).toBe('setFeet');
    expect(live.get(rb.a.id)?.clip).toBe('carryHigh');
    // not before the snap, not while moving, not without the ball
    expect(coreCues(ctxOf([qb], at(5, []), { presnap: true }), cur([[qb.a.id, 'idle']])).has(qb.a.id)).toBe(false);
    expect(coreCues(ctxOf([qb], at(120, [snap])), cur([[qb.a.id, 'dropback']])).has(qb.a.id)).toBe(false);
    const empty = place(athlete({ id: 'off:QB', position: 'QB', role: 'QB', state: 'idle', hasBall: false }), 26, 33);
    expect(coreCues(ctxOf([empty], at(120, [snap])), cur([[empty.a.id, 'idle']])).has(empty.a.id)).toBe(false);
  });

  it('pumps a fist after a first down; after a touchdown the other side is dejected and teammates high-five', () => {
    const rb = place(athlete({ id: 'off:RB', position: 'RB', role: 'RB' }), 20, 60);
    const fd = coreCues(ctxOf([rb], at(70, [{ type: 'firstDown', tick: 66 }]), { ball: { x: 20, y: 60, phase: 'dead', carrierId: rb.a.id } }), cur([[rb.a.id, 'idle']]));
    expect(fd.get(rb.a.id)?.clip).toBe('fistPump');
    const lb = place(athlete({ id: 'def:MLB', side: 'defense', position: 'MLB', role: 'MLB' }), 22, 62);
    const te = place(athlete({ id: 'off:TE', position: 'TE', role: 'TE' }), 30, 90);
    const wr = place(athlete({ id: 'off:WR2', position: 'WR', role: 'WR2' }), 30.8, 90.4);
    const td: PlayEvent = { type: 'touchdown', tick: 60, scorer: 'off:RB', side: 'offense' };
    const ctx = ctxOf([rb, lb, te, wr], at(60 + 60 * 1.2, [td]), { ball: { x: 20, y: 100, phase: 'dead', carrierId: rb.a.id } });
    const after = coreCues(ctx, cur([[rb.a.id, 'celebrateLeap'], [lb.a.id, 'idle'], [te.a.id, 'idle'], [wr.a.id, 'idle']]));
    expect(after.get(lb.a.id)?.clip).toBe('dejected');
    expect(after.has(rb.a.id)).toBe(false);
    const five = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0].map((dt) => coreCues(ctxOf([te, wr], at(60 + 60 * (1.4 + dt), [td]), { ball: { x: 0, y: 0, phase: 'dead', carrierId: null } }), cur([[te.a.id, 'idle'], [wr.a.id, 'idle']])).get(te.a.id)?.clip);
    expect(five).toContain('highFive');
  });

  it('is a pure function of the scene and events (replay seeks rebuild the same looks)', () => {
    const wr = place(athlete(), 20, 50);
    const events: PlayEvent[] = [{ type: 'incomplete', tick: 60, reason: 'drop', target: wr.a.id, defender: null }];
    const a = coreCues(ctxOf([wr], at(64, events)), cur([[wr.a.id, 'jog']]));
    const b = coreCues(ctxOf([wr], at(64, events)), cur([[wr.a.id, 'jog']]));
    expect([...a]).toEqual([...b]);
  });
});
