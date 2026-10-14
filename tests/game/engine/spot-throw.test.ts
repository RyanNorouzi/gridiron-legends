/**
 * Throws to a SPOT (the human's pull-back pass) on the real engine and receiver AI: the receiver running to the spot
 * is credited as the target and catches most of them, a spot on open grass is chased by the receiver nearest it,
 * user-control turns a throwSpot into a targetless throw intent, and the play is deterministic per seed.
 */
import { describe, expect, it } from 'vitest';
import { decideIntent } from '@/ai/index';
import { registerAll } from '@/ai/register';
import { breaksToSpot } from '@/ai/receiver';
import { vec2, type Vec2 } from '@/core/vec2';
import type { UserThrowSpot } from '@/game/engine-api';
import { createPlayEngine, type PlayEngine } from '@/game/play-engine';
import type { PlayState, UserPlayInput } from '@/game/play-types';
import { spotThrowReceiver } from '@/game/systems/passing';
import { userControl } from '@/game/user-control';
import { buildPlayState } from '../../fixtures/play-state';
import { clearDefense } from './helpers';

registerAll();

const input = (o: Partial<UserPlayInput & UserThrowSpot> = {}): UserPlayInput & UserThrowSpot => ({
  move: vec2(0, 0), sprint: false, strafe: false, throwTo: null, throwType: null, juke: false, spin: false, stiffArm: false,
  hurdle: false, dive: false, slide: false, throwAway: false, snap: false, audible: null, defAudible: null, switchPlayer: false,
  switchToId: null, hitStick: false, strip: false, tackle: false, jumpSwat: false, kickPress: false, fairCatch: false, pitch: false, ...o,
});

/**
 * Human QB on shotgun-mesh (real offensive AI, defense cleared away unless `defense`): after `wait` live ticks the
 * user throws to where `spot(state)` says.
 */
const runSpotThrow = (seed: number, spot: (s: PlayState) => Vec2, wait = 70, defense = false): PlayEngine => {
  const f = buildPlayState({ offensePlayId: 'shotgun-mesh', defensePlayId: '43-cover3-zone', seed, ballOn: 30, ruleset: 'arcade', userSide: 'home', controlRole: 'QB' });
  const e = createPlayEngine(f.state.ctx, {
    registries: f.registry,
    decider: (a, s, dt) => (a.side === 'defense' && !defense ? clearDefense(a, s) : decideIntent(a, s, dt)),
  }) as PlayEngine;
  for (let t = 0; e.state.phase === 'presnap' && t < 600; t++) e.tick({ home: input({ snap: true }) });
  let thrown = false;
  for (let live = 0; !e.isDead && live < 900; live++) {
    const throwNow = !thrown && live === wait;
    if (throwNow) thrown = true;
    e.tick({ home: throwNow ? input({ throwSpot: spot(e.state), throwType: 'touch' }) : input() });
  }
  return e;
};

/** Where WR2 (a go route) will be in about a second. */
const aheadOfWr2 = (s: PlayState): Vec2 => {
  const wr = s.athletes.find((a) => a.id === 'off:WR2')!;
  return vec2(wr.pos.x + wr.vel.x * 1.1, wr.pos.y + wr.vel.y * 1.1 + s.ctx.direction * 1.5);
};

describe('throws to a spot', () => {
  it('user-control turns a throwSpot into a targetless throw at that point', () => {
    const f = buildPlayState({ userSide: 'home', controlRole: 'QB' });
    const qb = f.byRole('offense', 'QB');
    f.state.phase = 'live';
    qb.hasBall = true;
    f.state.ball.carrierId = qb.id;
    f.state.ball.phase = 'held';
    const intent = userControl(qb, input({ throwSpot: vec2(20, 60), throwType: 'lob' }), f.state, { receiverSlots: [] });
    expect(intent.action).toBe('throw');
    expect(intent.targetId).toBeNull();
    expect(intent.throwTarget).toEqual(vec2(20, 60));
    expect(intent.throwType).toBe('lob');
  });

  it('the receiver running to the spot is its target and catches most of them', () => {
    let catches = 0;
    for (let seed = 1; seed <= 10; seed++) {
      const e = runSpotThrow(seed, aheadOfWr2);
      const t = e.state.events.find((ev) => ev.type === 'throw');
      expect(t, `seed ${seed}`).toBeTruthy();
      if (t?.type === 'throw') expect(t.target).toBe('off:WR2');
      const c = e.state.events.find((ev) => ev.type === 'catch');
      if (c?.type === 'catch' && c.receiver === 'off:WR2') catches += 1;
    }
    expect(catches).toBeGreaterThanOrEqual(7);
  });

  it('is deterministic per seed', () => {
    const a = runSpotThrow(4, aheadOfWr2, 70, true);
    const b = runSpotThrow(4, aheadOfWr2, 70, true);
    expect(b.state.events).toEqual(a.state.events);
    expect(b.outcome).toEqual(a.outcome);
  });

  it('nobody near the spot: no receiver is credited, and the receiver nearest the landing point breaks for it', () => {
    const f = buildPlayState({ userSide: 'home', controlRole: 'QB' });
    const qb = f.byRole('offense', 'QB');
    const far = vec2(qb.pos.x, qb.pos.y + f.state.ctx.direction * 55);
    expect(spotThrowReceiver(f.state, qb, far, 'lob')).toBeNull();
    const wr = f.byRole('offense', 'WR2');
    const near = vec2(wr.pos.x, wr.pos.y + f.state.ctx.direction * 6);
    expect(spotThrowReceiver(f.state, qb, near, 'touch')?.id).toBe('off:WR2');
    // A ball in the air with no target, landing near WR2: he (and only he) breaks for it.
    const s = f.state;
    s.phase = 'live';
    Object.assign(s.ball, {
      phase: 'inAir', kind: 'pass', targetId: null, throwType: 'touch', isTipped: false, throwerId: qb.id,
      pos: vec2(near.x, near.y - s.ctx.direction * 2), z: 2, vel: vec2(0, s.ctx.direction * 8), vz: -1,
    });
    expect(breaksToSpot(wr, s)).toBe(true);
    const others = s.athletes.filter((a) => a.side === 'offense' && a.eligible && a.id !== wr.id);
    expect(others.some((a) => breaksToSpot(a, s))).toBe(false);
    s.ball.throwType = 'throwAway';
    expect(breaksToSpot(wr, s)).toBe(false);
  });

  it('a man staying in to block is never the target and never keeps a route runner from breaking for the ball', () => {
    const f = buildPlayState({ userSide: 'home', controlRole: 'QB' });
    const s = f.state;
    const qb = f.byRole('offense', 'QB');
    const rb = f.byRole('offense', 'RB');
    const wr = f.byRole('offense', 'WR3');
    // The back stays in to block right beside the spot; the slot receiver is a few yards farther off it.
    const spot = vec2(wr.pos.x + 5, wr.pos.y + s.ctx.direction * 3);
    rb.pos = vec2(spot.x - 1, spot.y);
    rb.assignment = { type: 'passBlock' };
    expect(spotThrowReceiver(s, qb, spot, 'bullet')?.id).toBe(wr.id);
    rb.assignment = { type: 'route', route: 'flat' };
    expect(spotThrowReceiver(s, qb, spot, 'bullet')?.id).toBe(rb.id);
    // Engaged in a block (a chip) he cannot get to it either.
    rb.state = 'engaged';
    expect(spotThrowReceiver(s, qb, spot, 'bullet')?.id).toBe(wr.id);
    rb.state = 'moving';
    rb.assignment = { type: 'passBlock' };
    s.phase = 'live';
    Object.assign(s.ball, {
      phase: 'inAir', kind: 'pass', targetId: null, throwType: 'bullet', isTipped: false, throwerId: qb.id,
      pos: vec2(spot.x, spot.y - s.ctx.direction * 2), z: 1.8, vel: vec2(0, s.ctx.direction * 14), vz: -0.5,
    });
    expect(breaksToSpot(wr, s)).toBe(true);
    expect(breaksToSpot(rb, s)).toBe(false);
  });

  it('a deep lead on a receiver streaking up the field is his, however far ahead of him it lands', () => {
    const f = buildPlayState({ offensePlayId: 'shotgun-fourVerts', userSide: 'home', controlRole: 'QB' });
    const s = f.state;
    const d = s.ctx.direction;
    const qb = f.byRole('offense', 'QB');
    const wr = f.byRole('offense', 'WR1');
    wr.pos = vec2(wr.pos.x, s.losY + d * 15);
    wr.vel = vec2(0, d * 9);
    // 22 yd in front of him (37 past the line): out of the old fixed 14-yd claim radius, well inside his reach.
    const spot = vec2(wr.pos.x + 1, wr.pos.y + d * 22);
    expect(spotThrowReceiver(s, qb, spot, 'lob')?.id).toBe(wr.id);
    // Standing still that far from it he cannot get there in time: nobody's ball.
    for (const a of s.athletes) a.vel = vec2(0, 0);
    wr.pos = vec2(wr.pos.x, s.losY + d * 2);
    expect(spotThrowReceiver(s, qb, vec2(wr.pos.x, s.losY + d * 60), 'lob')).toBeNull();
  });

  it('a deep ball led to a streaking receiver in the real engine is thrown to him: no throw-away, no grounding', () => {
    const deepLead = (s: PlayState): Vec2 => {
      const wr = s.athletes.find((a) => a.id === 'off:WR2')!;
      return vec2(wr.pos.x + wr.vel.x * 2.2, wr.pos.y + wr.vel.y * 2.2 + s.ctx.direction * 6);
    };
    let targeted = 0;
    for (let seed = 1; seed <= 6; seed++) {
      const e = runSpotThrow(seed, deepLead, 90);
      const t = e.state.events.find((ev) => ev.type === 'throw');
      if (t?.type === 'throw' && t.target === 'off:WR2' && t.throwType !== 'throwAway') targeted += 1;
      expect(e.outcome?.penalties.some((p) => p.foul === 'intentionalGrounding') ?? false, `seed ${seed}`).toBe(false);
    }
    expect(targeted).toBe(6);
  });
});
