import { describe, expect, it } from 'vitest';
import { idleIntent } from '@/game/engine-api';
import type { Athlete, PlayState } from '@/game/play-types';
import { canCatchForwardPass, resolvePassArrival } from '@/game/systems/pass-arrival';
import { emit } from '@/game/systems/env';
import { build, emptyInput } from './helpers';

/** Snaps a shotgun play with everyone idle, then hangs a descending forward pass right on top of `onId`. */
const passOnto = (seed: number, onId: string, tippedBy: string | null = null) => {
  const { engine } = build({ offensePlayId: 'shotgun-mesh', defensePlayId: '43-cover3-zone', seed, ruleset: 'arcade', userSide: 'home', controlRole: 'QB' }, {}, {
    decider: () => idleIntent('idle'),
  });
  engine.tick({ home: { ...emptyInput(), snap: true } });
  for (let i = 0; i < 90 && engine.state.phase !== 'live'; i++) engine.tick({ home: { ...emptyInput(), snap: true } });
  const s: PlayState = engine.state;
  const env = engine.debugEnv();
  const on = s.athletes.find((a) => a.id === onId) as Athlete;
  const qb = s.athletes.find((a) => a.id === 'off:QB') as Athlete;
  for (const a of s.athletes) { a.hasBall = false; if (a.id !== onId) a.pos = { x: a.pos.x, y: a.pos.y - s.ctx.direction * 15 }; }
  s.ball = {
    ...s.ball, phase: 'inAir', kind: 'pass', pos: { ...on.pos }, z: 1.2, vel: { x: 0, y: 0.5 }, vz: -2, carrierId: null, throwerId: qb.id,
    targetId: 'off:WR2', targetPos: { ...on.pos }, throwType: 'touch', launchTick: s.tick - 30, landingTick: s.tick + 5, lastTouchedId: qb.id, isTipped: false,
  };
  if (tippedBy) {
    s.ball.isTipped = true;
    s.ball.kind = 'tip';
    s.ball.lastTouchedId = tippedBy;
    emit(s, { type: 'tipped', tick: s.tick, by: tippedBy });
  }
  for (let i = 0; i < 20 && s.ball.phase === 'inAir' && s.phase === 'live'; i++) resolvePassArrival(s, env);
  return s;
};

describe('eligible receivers', () => {
  it('ineligible offensive players cannot catch an untouched forward pass; anyone can after a defender touches it', () => {
    const base = { position: 'C', side: 'offense', eligible: false } as unknown as Athlete;
    expect(canCatchForwardPass(base, false)).toBe(false);
    expect(canCatchForwardPass(base, true)).toBe(true);
    expect(canCatchForwardPass({ ...base, eligible: true }, false)).toBe(true);
    expect(canCatchForwardPass({ ...base, side: 'defense' }, false)).toBe(true);
  });

  it('a centre with an untouched pass dropping onto him never catches it; an eligible back in the same spot does', () => {
    let backCatches = 0;
    for (let seed = 1; seed <= 8; seed++) {
      const s = passOnto(seed, 'off:C');
      expect(s.events.some((e) => e.type === 'catch' && e.receiver === 'off:C')).toBe(false);
      expect(s.ball.carrierId).not.toBe('off:C');
      const rb = passOnto(seed, 'off:RB');
      if (rb.events.some((e) => e.type === 'catch' && e.receiver === 'off:RB')) backCatches += 1;
    }
    expect(backCatches).toBeGreaterThan(0);
  });

  it('once a defender has tipped the ball, a lineman may catch it', () => {
    let lineCatches = 0;
    for (let seed = 1; seed <= 8; seed++) {
      const s = passOnto(seed, 'off:C', 'def:DT1');
      if (s.events.some((e) => e.type === 'catch' && e.receiver === 'off:C')) lineCatches += 1;
    }
    expect(lineCatches).toBeGreaterThan(0);
  });
});
