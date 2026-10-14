import { describe, expect, it } from 'vitest';
import {
  FIRST_MOVE_DELAY, pileBreakMove, pileOverride, pilePushIntent, pileTacklerIntent, SIDELINE_DRIVE, wrappedCarrierIntent,
} from '@/ai/pile';
import { chooseTackle, GANG_RADIUS } from '@/ai/tackling';
import { vec2 } from '@/core/vec2';
import { idleIntent } from '@/game/engine-api';
import { getDifficulty } from '@/game/rulesets';
import type { Athlete, PlayState } from '@/game/play-types';
import { FIELD_WIDTH } from '@/game/types';
import { buildPlayState } from '../../fixtures/play-state';

/**
 * ai/pile.ts: decisions only while a tackle struggle is on (the engine moves the bodies). A held runner churns and
 * picks break moves by his ratings, the men hanging on drive him back (or out), a second man punches at a loose ball,
 * and a free teammate pushes the pile.
 */

interface Scene { state: PlayState; rb: Athlete; lb: Athlete; ss: Athlete; wr: Athlete; dir: 1 | -1 }

const scene = (x = 26): Scene => {
  const { state } = buildPlayState({ offensePlayId: 'iform-dive-right', defensePlayId: '43-cover3-zone', seed: 5 });
  state.phase = 'live';
  const get = (id: string): Athlete => state.athletes.find((a) => a.id === id)!;
  const dir = state.ctx.direction;
  for (const a of state.athletes) {
    a.state = 'moving';
    a.hasBall = false;
    a.pos = vec2(a.side === 'offense' ? 50 : 3, 100);
  }
  const rb = get('off:RB');
  const lb = get('def:MLB');
  const ss = get('def:SS');
  const wr = get('off:WR1');
  rb.pos = vec2(x, 50);
  rb.hasBall = true;
  rb.state = 'wrapped';
  state.ball.phase = 'held';
  state.ball.carrierId = rb.id;
  lb.pos = vec2(x, 50 + dir * 0.9);
  lb.state = 'wrapping';
  ss.pos = vec2(x + 5, 50);
  wr.pos = vec2(x, 50 - dir * 1.2);
  return { state, rb, lb, ss, wr, dir };
};

const setAttrs = (a: Athlete, attrs: Partial<Athlete['attrs']>): void => {
  Object.assign(a.attrs, attrs);
  Object.assign(a.baseAttrs, attrs);
};

describe('the men hanging on', () => {
  it('drive the runner back toward the offense goal, holding the tackle', () => {
    const { state, lb, dir } = scene();
    const it0 = pileTacklerIntent(lb, state);
    expect(it0.move.y * dir).toBeLessThan(-0.9);
    expect(it0.sprint).toBe(true);
    expect(it0.action).toBe('tackle');
  });

  it('near the sideline a heads-up tackler drives him out of bounds', () => {
    const { state, lb } = scene(1.5);
    expect(1.5).toBeLessThan(SIDELINE_DRIVE);
    setAttrs(lb, { awareness: 99 });
    state.ctx.difficulty = getDifficulty('legend');
    expect(pileTacklerIntent(lb, state).move.x).toBeLessThan(-0.5);
    const far = scene(FIELD_WIDTH - 1.5);
    setAttrs(far.lb, { awareness: 99 });
    far.state.ctx.difficulty = getDifficulty('legend');
    expect(pileTacklerIntent(far.lb, far.state).move.x).toBeGreaterThan(0.5);
  });

  it('a second man punches at a loose ball, never at a secure one, and the first man just holds', () => {
    const loose = scene();
    setAttrs(loose.rb, { carrying: 1 });
    loose.ss.state = 'wrapping';
    loose.ss.pos = vec2(loose.rb.pos.x + 0.9, loose.rb.pos.y);
    expect(pileTacklerIntent(loose.ss, loose.state).action).toBe('strip');
    const secure = scene();
    setAttrs(secure.rb, { carrying: 99 });
    secure.ss.state = 'wrapping';
    expect(pileTacklerIntent(secure.ss, secure.state).action).toBe('tackle');
    // Alone on him: the grip comes first.
    const alone = scene();
    setAttrs(alone.rb, { carrying: 1 });
    expect(pileTacklerIntent(alone.lb, alone.state).action).toBe('tackle');
  });
});

describe('the held runner', () => {
  it('keeps churning upfield and tries a break move once he has been held a moment', () => {
    const { state, rb, dir } = scene();
    const first = wrappedCarrierIntent(rb, state, idleIntent('base'));
    expect(first.move.y * dir).toBeGreaterThan(0.9);
    expect(first.sprint).toBe(true);
    expect(first.action).toBeNull();
    let tried: string | null = null;
    for (let i = 1; i <= 60 && !tried; i++) {
      state.tick += 1;
      state.time += 1 / 60;
      tried = wrappedCarrierIntent(rb, state, idleIntent('base')).action;
      if (tried) expect(i / 60).toBeGreaterThanOrEqual(FIRST_MOVE_DELAY - 1e-9);
    }
    expect(['juke', 'spin', 'stiffArm', 'truck']).toContain(tried);
  });

  it('a throw or pitch he already decided on stands (in the grasp)', () => {
    const { state, rb } = scene();
    const base = { ...idleIntent('throw'), action: 'throw' as const, targetId: 'off:WR1' };
    expect(wrappedCarrierIntent(rb, state, base)).toBe(base);
  });

  it('picks the move that suits him: a bruiser lowers the shoulder, a scatback jukes or spins', () => {
    const a = scene();
    setAttrs(a.rb, { strength: 97, agility: 45, balance: 80, vision: 99, awareness: 99 });
    a.rb.massLb = 245;
    expect(['truck', 'stiffArm']).toContain(pileBreakMove(a.rb, a.state, [a.lb]));
    const b = scene();
    setAttrs(b.rb, { strength: 40, agility: 99, balance: 80, vision: 99, awareness: 99 });
    b.rb.massLb = 180;
    expect(['juke', 'spin']).toContain(pileBreakMove(b.rb, b.state, [b.lb]));
  });

  it('protecting a late lead he never risks a move', () => {
    const { state, rb } = scene();
    state.ctx.quarter = 4;
    state.ctx.clockRemaining = 60;
    state.ctx.scoreDiff = 7;
    for (let i = 0; i < 120; i++) {
      state.tick += 1;
      state.time += 1 / 60;
      expect(wrappedCarrierIntent(rb, state, idleIntent('base')).action).toBeNull();
    }
  });
});

describe('teammates and the rest of the field', () => {
  it('a free teammate right behind the pile pushes it upfield; one far away carries on', () => {
    const { state, wr, dir } = scene();
    setAttrs(wr, { awareness: 90 });
    const push = pilePushIntent(wr, state);
    expect(push).not.toBeNull();
    expect(push!.move.y * dir).toBeGreaterThan(0.9);
    wr.pos = vec2(wr.pos.x + 10, wr.pos.y);
    expect(pilePushIntent(wr, state)).toBeNull();
  });

  it('with no struggle on, nobody is overridden', () => {
    const { state, rb, lb, wr } = scene();
    rb.state = 'moving';
    lb.state = 'moving';
    const base = idleIntent('assignment');
    for (const a of [rb, lb, wr]) expect(pileOverride(a, state, () => base)).toBe(base);
  });

  it('a free defender near a held runner piles on: a gang tackle, even when he is past plain wrap range', () => {
    const { state, rb, lb, ss, dir } = scene();
    // The man holding him grabbed on from a dive and is still sliding in (not yet at a helper's distance), and the
    // first contact was a while ago: only the struggle itself says this runner is a pile to join.
    lb.pos = vec2(rb.pos.x, rb.pos.y + dir * 1.5);
    rb.contactTimer = 1.5;
    ss.pos = vec2(rb.pos.x + GANG_RADIUS * 0.8, rb.pos.y);
    ss.vel = vec2(-3, 0);
    ss.facing = Math.PI;
    const choice = chooseTackle(ss, rb, state);
    expect(choice.kind).toBe('gang');
    // Nobody overrides his own decision to come and join (only the men already hanging on are pile-driven).
    const base = idleIntent('pursue');
    expect(pileOverride(ss, state, () => base)).toBe(base);
  });
});
