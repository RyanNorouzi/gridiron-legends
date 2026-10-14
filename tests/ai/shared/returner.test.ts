import { describe, expect, it } from 'vitest';
import { TICK_DT } from '@/core/time';
import { dist } from '@/core/vec2';
import type { Athlete, PlayState } from '@/game/play-types';
import { decideIntent, getDecider } from '@/ai/index';
import { registerSpecialTeams, SPECIAL_TEAMS_KEYS } from '@/ai/special-teams';
import { bestReturnLane, chooseMove, coverageAtArrival, fieldPlan, returnBlockAssignment, returnBlockDecider, returnerDecider, wallSpot } from '@/ai/returner';

const returner = (a: Athlete, s: PlayState) => returnerDecider(a, s, TICK_DT);
const blocker = (a: Athlete, s: PlayState) => returnBlockDecider(a, s, TICK_DT);
import { CATCH_HEIGHT, predictLanding } from '@/physics/ball';
import { buildPlayState, type FixtureOptions } from '../../fixtures/play-state';
import { giveBall, goLive, place } from './helpers';

const punt = (o: FixtureOptions = {}) => {
  const f = buildPlayState({ offensePlayId: 'punt-standard', defensePlayId: 'puntReturn-middle', ballOn: 40, seed: 31, ...o });
  f.state.ctx.special = 'punt';
  return f;
};
const kickoff = (o: FixtureOptions = {}) => {
  const f = buildPlayState({ offensePlayId: 'kickoff-deep', defensePlayId: 'kickReturn-middle', ballOn: 35, seed: 32, ...o });
  f.state.ctx.special = 'kickoff';
  return f;
};

/** Puts a punt/kickoff in the air so it comes down at `y` (roughly under the returner's x). */
const ballComingDown = (f: ReturnType<typeof punt>, x: number, y: number, kind: 'punt' | 'kickoff' = 'punt'): void => {
  const b = f.state.ball;
  b.phase = 'inAir';
  b.kind = kind;
  b.carrierId = null;
  b.pos = { x, y: y - 6 };
  b.z = 6;
  b.vel = { x: 0, y: 7 };
  b.vz = -3;
  for (const a of f.state.athletes) a.hasBall = false;
};

describe('returner', () => {
  it('fair-catches a punt when the coverage will be on top of the catch, returns it when clear', () => {
    const f = punt();
    goLive(f.state, 'off:P');
    const pr = f.byRole('defense', 'PR');
    ballComingDown(f, pr.pos.x, pr.pos.y);
    const g1 = f.byRole('offense', 'G1');
    const g2 = f.byRole('offense', 'G2');
    place(f.state, g1, pr.pos.x + 3, pr.pos.y - 3, { x: 0, y: 6 });
    place(f.state, g2, pr.pos.x - 3, pr.pos.y - 2, { x: 0, y: 6 });
    const landing = predictLanding(f.state.ball, f.state.ctx.weather, CATCH_HEIGHT);
    expect(coverageAtArrival(f.state, landing.pos, 0.5)).toBeLessThan(5);
    expect(fieldPlan(pr, f.state, 'punt', landing)).toBe('fairCatch');
    const intent = returner(pr, f.state);
    expect(intent.action).toBe('fairCatch');
    expect(pr.ai.decision).toContain('fair catch');
    // Coverage far away: field it and go.
    place(f.state, g1, 5, f.state.losY + 5, { x: 0, y: 6 });
    place(f.state, g2, 48, f.state.losY + 5, { x: 0, y: 6 });
    expect(fieldPlan(pr, f.state, 'punt', landing)).toBe('return');
    const go = returner(pr, f.state);
    expect(go.action).toBeNull();
    expect(go.debug).toContain('field');
  });

  it('lets a punt inside the 10 die and a more aware returner judges the fair catch radius differently', () => {
    const f = punt({ ballOn: 45 });
    goLive(f.state, 'off:P');
    const pr = f.byRole('defense', 'PR');
    // Own goal line for the return team is at y = 110; a ball coming down inside the 5 (y ~ 106).
    place(f.state, pr, 26, 103);
    ballComingDown(f, 26, 107);
    const landing = predictLanding(f.state.ball, f.state.ctx.weather, CATCH_HEIGHT);
    expect(fieldPlan(pr, f.state, 'punt', landing)).toBe('letGo');
    const away = returner(pr, f.state);
    expect(away.debug).toContain('let it go');
    // Coverage at ~5.4 yd: an unaware returner still returns, an aware one signals.
    const g = punt();
    goLive(g.state, 'off:P');
    const pr2 = g.byRole('defense', 'PR');
    ballComingDown(g, pr2.pos.x, pr2.pos.y);
    const cov = g.byRole('offense', 'G1');
    const l2 = predictLanding(g.state.ball, g.state.ctx.weather, CATCH_HEIGHT);
    place(g.state, cov, l2.pos.x + 5.6, l2.pos.y);
    pr2.attrs.awareness = 5;
    const dull = fieldPlan(pr2, g.state, 'punt', l2);
    pr2.attrs.awareness = 99;
    const sharp = fieldPlan(pr2, g.state, 'punt', l2);
    expect(dull).toBe('return');
    expect(sharp).toBe('fairCatch');
  });

  it('kneels for a touchback on a kickoff caught 3+ yards deep, returns a shallow one when clear', () => {
    const f = kickoff();
    goLive(f.state, 'off:K');
    const kr = f.byRole('defense', 'KR');
    // Return team's own goal line is y = 110 (dir +1); 4 yd deep is y = 114.
    place(f.state, kr, 26, 114);
    ballComingDown(f, 26, 116, 'kickoff');
    const landing = predictLanding(f.state.ball, f.state.ctx.weather, CATCH_HEIGHT);
    expect(fieldPlan(kr, f.state, 'kickoff', landing)).toBe('kneel');
    expect(returner(kr, f.state).debug).toContain('kneel');
    giveBall(f.state, kr.id, 'kickoff');
    expect(returner(kr, f.state).action).toBe('kneel');
    // One yard deep with nobody near (a fresh kick, so the earlier plan is gone): bring it out.
    kr.ai.scratch['plan'] = 0;
    place(f.state, kr, 26, 111);
    for (const a of f.state.athletes) if (a.side === 'offense') place(f.state, a, a.pos.x, 60);
    const out = returner(kr, f.state);
    expect(out.action).not.toBe('kneel');
    expect(out.move.y).toBeLessThan(-0.5);
    expect(out.debug).toContain('lane');
  });

  it('returns toward the widest lane and uses moves on a closing tackler', () => {
    const f = kickoff();
    goLive(f.state, 'off:K');
    const kr = f.byRole('defense', 'KR');
    kr.attrs.vision = 90;
    giveBall(f.state, kr.id, 'kickoff');
    place(f.state, kr, 26, 100, { x: 0, y: -8 });
    const coverage = f.state.athletes.filter((a) => a.side === 'offense');
    // Stack the coverage on the left; the lane should open on the right.
    coverage.forEach((a, i) => place(f.state, a, 4 + i * 1.5, 88, { x: 0, y: 6 }));
    expect(bestReturnLane(kr, f.state)).toBeGreaterThan(26);
    coverage.forEach((a, i) => place(f.state, a, 50 - i * 1.5, 88, { x: 0, y: 6 }));
    expect(bestReturnLane(kr, f.state)).toBeLessThan(27);
    // Closing tackler within two yards: reach for a move.
    const tackler = coverage[0]!;
    place(f.state, tackler, 26, 98.2, { x: 0, y: 8 });
    kr.specialMoveCooldown = 0;
    const intent = returner(kr, f.state);
    expect(intent.action).not.toBeNull();
    expect(['juke', 'spin', 'stiffArm', 'hurdle', 'truck']).toContain(intent.action);
    expect(intent.targetId).toBe(tackler.id);
    kr.specialMoveCooldown = 1;
    expect(returner(kr, f.state).action).toBeNull();
    // Move choice follows build and ratings.
    kr.attrs.jumping = 90;
    tackler.state = 'diving';
    expect(chooseMove(kr, tackler)).toBe('hurdle');
    tackler.state = 'moving';
    kr.attrs.agility = 90;
    kr.attrs.balance = 40;
    kr.massLb = 180;
    expect(chooseMove(kr, tackler)).toBe('juke');
    kr.attrs.balance = 95;
    expect(chooseMove(kr, tackler)).toBe('spin');
  });

  it('a second returner leads the fielder and blockers each take a coverage man, then convoy once theirs is beaten', () => {
    const f = kickoff();
    goLive(f.state, 'off:K');
    const kr = f.byRole('defense', 'KR');
    const kr2 = f.byRole('defense', 'KR2');
    ballComingDown(f, kr.pos.x, kr.pos.y, 'kickoff');
    expect(returner(kr2, f.state).debug).toContain('lead block');
    const blockers = f.state.athletes.filter((a) => a.side === 'defense' && a.assignment.type === 'returnBlock');
    for (const b of blockers) blocker(b, f.state);
    const landing = predictLanding(f.state.ball, f.state.ctx.weather).pos;
    const spots = blockers.map((b) => wallSpot(b, f.state, landing, 'kickoff'));
    // Every wedge spot is in front of the catch (toward the kicking team) and they are spread out.
    for (const s of spots) expect(s.y).toBeLessThan(landing.y - 8);
    const xs = spots.map((s) => s.x).sort((a, b) => a - b);
    expect(xs[xs.length - 1]! - xs[0]!).toBeGreaterThan(10);
    // Kickoff returns are blocked man for man, counted across the field (owner-requested realistic returns; this used
    // to be a zone wedge): every blocker has his own coverage man and sets up between him and the ball.
    const l3 = f.byRole('defense', 'L3');
    const men = blockers.map((b) => returnBlockAssignment(b, f.state, landing.x)?.id);
    expect(new Set(men).size).toBe(blockers.length);
    expect(men.every((m) => m !== undefined)).toBe(true);
    const cov = f.state.athletes.find((a) => a.id === returnBlockAssignment(l3, f.state, landing.x)?.id)!;
    expect(blocker(l3, f.state).debug).toContain(`set on ${cov.role}`);
    place(f.state, cov, l3.pos.x, l3.pos.y + 1.2, { x: 0, y: 6 });
    const block = blocker(l3, f.state);
    expect(block.action).toBe('block');
    expect(block.targetId).toBe(cov.id);
    // Once the returner runs, a blocker whose man is already beaten (behind the returner) joins the convoy.
    giveBall(f.state, kr.id, 'kickoff');
    place(f.state, cov, kr.pos.x, kr.pos.y + f.state.ctx.direction * 4);
    expect(blocker(l3, f.state).debug).toContain('convoy');
  });

  it('punt blockers hold up rushers, then form a wall on the landing side', () => {
    const f = punt();
    goLive(f.state, 'off:P');
    const dt1 = f.byRole('defense', 'DT1');
    expect(blocker(dt1, f.state).debug).toContain('hold up');
    const pr = f.byRole('defense', 'PR');
    ballComingDown(f, 10, pr.pos.y);
    const landing = predictLanding(f.state.ball, f.state.ctx.weather).pos;
    const spot = wallSpot(dt1, f.state, landing, 'punt');
    expect(spot.x).toBeLessThan(26);
    expect(spot.y).toBeLessThan(landing.y);
    expect(dist(spot, landing)).toBeGreaterThan(8);
  });

  it('registers the special-teams deciders under their keys', () => {
    registerSpecialTeams();
    const f = punt();
    for (const key of SPECIAL_TEAMS_KEYS) expect(key.includes(':')).toBe(true);
    const pr = f.byRole('defense', 'PR');
    expect(getDecider(pr)).toBe(returnerDecider);
    expect(getDecider(f.byRole('offense', 'P'))).toBeDefined();
    expect(getDecider(f.byRole('offense', 'G1'))).toBeDefined();
    expect(decideIntent(pr, f.state, 1 / 60).debug).toContain('returner');
  });
});
