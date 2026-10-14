import { describe, expect, it } from 'vitest';
import type { PlayEvent, TackleKind } from '@/game/play-events';
import { clipTiming, MAX_RENDER_OFFSET } from '@/ui/render/anim';
import { HITSTOP_SECONDS, TACKLE_CHOREO } from '@/ui/render/figures/contact-events';
import { contactCuesOf } from '@/ui/render/figures/contact-effects';
import { GET_UP_DELAY } from '@/ui/render/figures/contact-install';
import { athlete, frameAt, memory, place } from './contact-fixture';

const RB = 'off:RB';
const LB = 'def:MLB';
const carrier = (state: 'falling' | 'wrapped' | 'moving' | 'down' = 'falling') => athlete({ id: RB, position: 'RB', role: 'RB', state, hasBall: true, engagedWith: null, vy: 5 });
const tackler = (state: 'falling' | 'wrapping' | 'stumbling' | 'moving' | 'down' = 'falling', id = LB) => athlete({ id, side: 'defense', position: 'MLB', role: 'MLB', state, engagedWith: null, facing: -Math.PI / 2 });
const tackle = (kind: TackleKind, assists: string[] = []): PlayEvent => ({ type: 'tackle', tick: 500, tackler: LB, carrier: RB, kind, assists });
const ball = { x: 26, y: 50, phase: 'held' as const, carrierId: RB };

describe('tackles by kind', () => {
  it('pairs each tackle kind with its tackler and carrier clips (head on: the carrier falls back)', () => {
    for (const kind of Object.keys(TACKLE_CHOREO) as TackleKind[]) {
      // carrier running up the field (+y = screen right); the tackler meets him from in front
      const placed = [place(carrier(), 26, 50), place(tackler(), 26, 51)];
      const l = frameAt(memory(), 512, placed, [tackle(kind)], { ball });
      expect(l.get(RB)?.clip, kind).toBe(TACKLE_CHOREO[kind].carrierHeadOn);
      expect(l.get(LB)?.clip, kind).toBe(TACKLE_CHOREO[kind].tackler);
      expect(Math.abs(l.get(LB)?.dx ?? 99)).toBeLessThanOrEqual(MAX_RENDER_OFFSET);
    }
  });

  it('drops a carrier hit from behind forward, and keeps that side for the rest of the fall', () => {
    const mem = memory();
    const placed = [place(carrier(), 26, 50), place(tackler(), 26, 49)];
    expect(frameAt(mem, 506, placed, [tackle('wrap')], { ball }).get(RB)?.clip).toBe('tackledFwd');
    // the bodies slide past each other while falling: the side does not flip
    const moved = [place(carrier(), 26, 50), place(tackler(), 26, 51)];
    expect(frameAt(mem, 520, moved, [tackle('wrap')], { ball }).get(RB)?.clip).toBe('tackledFwd');
  });

  it('freezes a hit stick at the impact (hitstop), throws the carrier back and cues the impact flash', () => {
    const mem = memory();
    const placed = [place(carrier(), 26, 50), place(tackler(), 26, 51)];
    const ev = [tackle('hitStick'), { type: 'hitStick', tick: 500, by: LB, on: RB } as PlayEvent];
    const f0 = frameAt(mem, 500, placed, ev, { ball }).get(RB);
    const fStop = frameAt(mem, 500 + HITSTOP_SECONDS * 60, placed, ev, { ball }).get(RB);
    expect(fStop?.frame).toBe(f0?.frame);
    expect(frameAt(mem, 500 + HITSTOP_SECONDS * 60, placed, ev, { ball }).get(LB)?.clip).toBe('bigHit');
    expect(contactCuesOf(mem).some((c) => c.kind === 'impactFlash')).toBe(true);
    const later = frameAt(mem, 515, placed, ev, { ball }).get(RB);
    expect(later?.clip).toBe('blownUp');
    // blown backward: away from the hitter (who is screen-right of him)
    expect(later?.dx ?? 0).toBeLessThan(0);
  });

  it('stacks gang-tackle assists onto the pile in arrival order and buries a carrier under two', () => {
    const assists = ['def:OLB1', 'def:SS'];
    const placed = [place(carrier(), 26, 50), place(tackler(), 26, 51), place(tackler('falling', 'def:OLB1'), 25.4, 50.5), place(tackler('falling', 'def:SS'), 26.5, 49.6)];
    const l = frameAt(memory(), 540, placed, [tackle('gang', assists)], { ball });
    expect(l.get('def:OLB1')?.clip).toBe('pileOn');
    expect(l.get('def:SS')?.clip).toBe('pileOn');
    expect((l.get('def:SS')?.layer ?? 0)).toBeGreaterThan(l.get('def:OLB1')?.layer ?? 0);
    expect(l.get(RB)?.clip).toBe('buried');
  });

  it('lifts a tackler over the carrier only within the render-offset clamp, so he never floats off the tackle', () => {
    for (const [wx, onTop] of [[25.1, false], [25.8, true]] as const) {
      // tackler north of the carrier (screen above him): 0.9 yd is too far to sort over him, 0.2 yd is not
      const placed = [place(carrier(), 26, 50), place(tackler(), wx, 50)];
      const at = placed[1] as (typeof placed)[number];
      const l = frameAt(memory(), 530, placed, [tackle('wrap')], { ball }).get(LB);
      expect(l?.clip).toBe('wrap');
      expect(Math.abs(l?.dy ?? 99), `wx ${wx}`).toBeLessThanOrEqual(MAX_RENDER_OFFSET);
      // drawn position = feet + dy - lift: within the clamp, and the far tackler is still pulled toward the carrier
      const drawn = (l?.dy ?? 0) - (l?.lift ?? 0);
      expect(Math.abs(drawn), `wx ${wx}`).toBeLessThanOrEqual(MAX_RENDER_OFFSET);
      if (!onTop) expect(drawn, `wx ${wx}`).toBeGreaterThan(0);
      const sortsOver = at.y + (l?.dy ?? 0) > (placed[0] as (typeof placed)[number]).y;
      expect(sortsOver, `wx ${wx}`).toBe(onTop);
      expect((l?.lift ?? 0) > 0, `wx ${wx}`).toBe(onTop);
    }
  });

  it('keeps a diving carrier on the ground when the tackle lands (no pop back up to a standing fall)', () => {
    const mem = memory();
    const diving = [place(athlete({ id: RB, position: 'RB', role: 'RB', state: 'diving', hasBall: true, engagedWith: null, vy: 5 }), 26, 50), place(tackler('moving'), 25, 50)];
    for (let t = 470; t < 500; t += 2) frameAt(mem, t, diving, [], { ball });
    const before = frameAt(mem, 499, diving, [], { ball }).get(RB);
    expect(before && clipTiming(before.clip).lying).toBe(true);
    const placed = [place(carrier(), 26, 50), place(tackler(), 25.2, 50)];
    for (let t = 500; t < 540; t += 3) {
      const l = frameAt(mem, t, placed, [tackle('openField')], { ball }).get(RB);
      expect(l?.clip, `tick ${t}`).toBe(before?.clip);
      expect(l?.frame ?? 0, `tick ${t}`).toBeGreaterThanOrEqual(before?.frame ?? 0);
    }
  });

  it('runs the wrap-and-drag struggle: the carrier churns, the tackler hangs on at his hip', () => {
    const ev: PlayEvent[] = [{ type: 'wrapUp', tick: 400, tackler: LB, carrier: RB, kind: 'wrap' }];
    const placed = [place(carrier('wrapped'), 26, 50), place(tackler('wrapping'), 26, 51)];
    const l = frameAt(memory(), 440, placed, ev, { ball });
    expect(l.get(RB)?.clip).toBe('struggle');
    expect(l.get(LB)?.clip).toBe('hangOn');
    expect(l.get(LB)?.facing).toBe('w');
    expect(Math.abs(l.get(LB)?.dx ?? 99)).toBeLessThanOrEqual(6);
    expect(l.get(LB)?.dx ?? 0).toBeLessThan(0);
  });
});

describe('contact one-shots and get-ups', () => {
  it('whiffs a missed tackle, shrugs off a broken one, chops a strip and reaches for the loose ball', () => {
    const placed = [place(carrier('moving'), 26, 50), place(tackler('stumbling'), 26, 51)];
    const missed: PlayEvent = { type: 'missedTackle', tick: 600, defender: LB, carrier: RB };
    expect(frameAt(memory(), 606, placed, [missed], { ball }).get(LB)?.clip).toBe('whiff');
    const broken: PlayEvent = { type: 'brokenTackle', tick: 600, defender: LB, carrier: RB, move: 'stiffArm' };
    expect(frameAt(memory(), 606, placed, [broken], { ball }).get(LB)?.clip).toBe('shrugged');
    const fumble: PlayEvent = { type: 'fumble', tick: 600, carrier: RB, forcedBy: LB, ballOn: 30, forward: false };
    const f = frameAt(memory(), 604, placed, [fumble], { ball: { ...ball, phase: 'loose', carrierId: null } });
    expect(f.get(LB)?.clip).toBe('stripChop');
    expect(f.get(RB)?.clip).toBe('fumbleReach');
    const rec: PlayEvent = { type: 'recovery', tick: 600, by: LB, side: 'defense', ballOn: 30, advanced: true };
    expect(frameAt(memory(), 604, placed, [rec], { ball }).get(LB)?.clip).toBe('scoopUp');
  });

  it('gets bodies up after the whistle in a staggered order, the ball carrier last', () => {
    const mem = memory();
    const events: PlayEvent[] = [tackle('wrap'), { type: 'whistle', tick: 530, reason: 'tackle' }];
    const placed = [place(carrier('down'), 26, 50), place(tackler('down'), 26, 51)];
    const dead = { ...ball, phase: 'dead' as const };
    const early = frameAt(mem, 560, placed, events, { ball: dead });
    expect(clipTiming(early.get(RB)?.clip ?? 'idle').lying).toBe(true);
    const t = 530 + (GET_UP_DELAY + 0.5) * 60;
    const mid = frameAt(mem, t, placed, events, { ball: dead });
    expect(mid.get(LB)?.clip === 'getUp' || mid.get(LB)?.clip === 'idle').toBe(true);
    expect(clipTiming(mid.get(RB)?.clip ?? 'idle').lying).toBe(true);
    const late = frameAt(mem, 530 + (GET_UP_DELAY + 3) * 60, placed, events, { ball: dead });
    expect(late.get(RB)?.clip).toBe('idle');
    expect(late.get(LB)?.clip).toBe('idle');
  });
});
