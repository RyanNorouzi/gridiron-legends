import { describe, expect, it } from 'vitest';
import { TICK_DT } from '@/core/time';
import type { Athlete, PlayState } from '@/game/play-types';
import { FIELD_WIDTH, MIDDLE_X } from '@/game/types';
import { coverageLaneX, gunnerDecider, holderDecider, kickCoverageDecider, kickKindFor, kickerDecider, longSnapperDecider, planKick, puntPlan, puntPowerFor } from '@/ai/kicker';

const kicker = (a: Athlete, s: PlayState) => kickerDecider(a, s, TICK_DT);
const holder = (a: Athlete, s: PlayState) => holderDecider(a, s, TICK_DT);
const snapper = (a: Athlete, s: PlayState) => longSnapperDecider(a, s, TICK_DT);
const gunner = (a: Athlete, s: PlayState) => gunnerDecider(a, s, TICK_DT);
const coverage = (a: Athlete, s: PlayState) => kickCoverageDecider(a, s, TICK_DT);
import { kickLaunched } from '@/ai/perception';
import { puntDistance } from '@/physics/kick';
import { buildPlayState, type FixtureOptions } from '../../fixtures/play-state';
import { advance, giveBall, goLive, place } from './helpers';

const punt = (o: FixtureOptions = {}) => {
  const f = buildPlayState({ offensePlayId: 'punt-standard', defensePlayId: 'puntReturn-middle', seed: 21, ...o });
  f.state.ctx.special = 'punt';
  return f;
};
const kickoff = (o: FixtureOptions = {}) => {
  const f = buildPlayState({ offensePlayId: 'kickoff-deep', defensePlayId: 'kickReturn-middle', ballOn: 35, seed: 22, ...o });
  f.state.ctx.special = 'kickoff';
  return f;
};
const fieldGoal = (o: FixtureOptions = {}) => {
  const f = buildPlayState({ offensePlayId: 'fieldGoal-standard', defensePlayId: 'fgBlock-middle', ballOn: 70, seed: 23, ...o });
  f.state.ctx.special = 'fieldGoal';
  return f;
};

describe('kick plans', () => {
  it('directional punt toward a sideline from the 40 on, straight boomer from deep', () => {
    const pin = punt({ ballOn: 62 });
    const p = pin.byRole('offense', 'P');
    const plan = puntPlan(p, pin.state);
    expect(Math.abs(plan.target.x - MIDDLE_X)).toBeGreaterThan(12);
    expect(plan.label).toContain('pin');
    // Pinned inside the 10, never into the end zone.
    expect(plan.target.y).toBeLessThanOrEqual(10 + 91 + 0.01);
    const deep = punt({ ballOn: 20 });
    const pd = deep.byRole('offense', 'P');
    const far = puntPlan(pd, deep.state);
    expect(Math.abs(far.target.x - MIDDLE_X)).toBeLessThan(5);
    expect(far.label).toContain('deep');
    expect(far.target.y).toBeGreaterThan(deep.state.losY + 30);
    expect(puntDistance(pd.attrs.kickPower, puntPowerFor(pd.attrs.kickPower, 46))).toBeCloseTo(46, 3);
  });

  it('kickoffs aim deep at a corner, squibs short, onside kicks short toward the bunched side, placement kicks at the posts', () => {
    const ko = kickoff();
    const k = ko.byRole('offense', 'K');
    const plan = planKick(k, ko.state, 'kickoff');
    expect(Math.abs(plan.target.x - MIDDLE_X)).toBeGreaterThan(15);
    expect(plan.target.y).toBeGreaterThan(100);
    expect(plan.power).toBeGreaterThan(0.4);
    expect(plan.accuracy).toBeGreaterThanOrEqual(0);
    expect(plan.accuracy).toBeLessThanOrEqual(1);
    const squib = kickoff({ offensePlayId: 'kickoff-squib' });
    const sq = planKick(squib.byRole('offense', 'K'), squib.state, 'kickoff');
    expect(sq.power).toBeLessThan(plan.power);
    expect(sq.target.y).toBeLessThan(plan.target.y);
    const on = kickoff({ offensePlayId: 'kickoff-onside' });
    on.state.ctx.special = 'onside';
    const onside = planKick(on.byRole('offense', 'K'), on.state, 'onside');
    expect(onside.target.y - on.state.losY).toBeCloseTo(14, 6);
    expect(onside.target.x).toBeGreaterThan(on.state.ctx.ballX);
    expect(onside.power).toBeLessThan(0.7);
    const fg = fieldGoal();
    const fgPlan = planKick(fg.byRole('offense', 'K'), fg.state, 'fieldGoal');
    expect(fgPlan.target).toEqual({ x: MIDDLE_X, y: 120 });
    expect(kickKindFor(fg.state)).toBe('fieldGoal');
    expect(kickKindFor(buildPlayState({ seed: 1 }).state)).toBeNull();
  });
});

describe('kicking-team deciders', () => {
  it('the punter fields the snap, steps and kicks with the plan; kicks at once under pressure', () => {
    const f = punt({ ballOn: 62 });
    const p = f.byRole('offense', 'P');
    goLive(f.state, p.id);
    let intent = kicker(p, f.state);
    expect(intent.action).toBeNull();
    expect(intent.debug).toContain('step');
    advance(f.state, 20);
    intent = kicker(p, f.state);
    expect(intent.action).toBe('kick');
    expect(intent.kickTarget).not.toBeNull();
    expect(Math.abs((intent.kickTarget?.x ?? MIDDLE_X) - MIDDLE_X)).toBeGreaterThan(12);
    expect(intent.kickPower).toBeGreaterThan(0);
    expect(intent.kickAccuracy).toBeGreaterThanOrEqual(0);
    expect(p.ai.decision).toContain('pin');
    // Pressure: a rusher in his face makes him kick right away.
    const g = punt({ ballOn: 30 });
    const p2 = g.byRole('offense', 'P');
    goLive(g.state, p2.id);
    const rusher = g.byRole('defense', 'DE1');
    place(g.state, rusher, p2.pos.x + 1, p2.pos.y + 1.2, { x: 0, y: -5 });
    expect(kicker(p2, g.state).action).toBe('kick');
  });

  it('the kickoff kicker sets, then calls the kick while going to the tee and strikes', () => {
    const f = kickoff();
    const k = f.byRole('offense', 'K');
    expect(kicker(k, f.state).action).toBeNull();
    f.state.tick = 120;
    const start = kicker(k, f.state);
    expect(start.action).toBe('kick');
    expect(start.kickPower).toBeGreaterThan(0);
    expect(start.kickTarget?.y).toBeGreaterThan(100);
    goLive(f.state, 'off:K');
    f.state.ball.phase = 'presnap';
    f.state.ball.carrierId = null;
    k.hasBall = false;
    f.state.ball.pos = { x: f.state.ctx.ballX, y: f.state.losY };
    const approach = kicker(k, f.state);
    expect(approach.move.y).toBeGreaterThan(0.9);
    expect(approach.sprint).toBe(true);
    expect(approach.action).toBe('kick');
    place(f.state, k, f.state.ctx.ballX, f.state.losY - 1.2);
    const strike = kicker(k, f.state);
    expect(strike.action).toBe('kick');
    expect(strike.kickTarget?.y).toBeGreaterThan(100);
  });

  it('after the kick the kicker honours the 10-yard rule on a loose kickoff, then chases it', () => {
    const f = kickoff();
    const k = f.byRole('offense', 'K');
    goLive(f.state, 'off:K');
    f.state.ball.phase = 'loose';
    f.state.ball.kind = 'kickoff';
    f.state.ball.carrierId = null;
    f.state.ball.pos = { x: 26, y: f.state.losY + 6 };
    f.state.ball.z = 0;
    f.state.ball.vz = 0;
    f.state.ball.vel = { x: 0, y: 3 };
    for (const a of f.state.athletes) a.hasBall = false;
    place(f.state, k, 26, f.state.losY + 4);
    const wait = kicker(k, f.state);
    expect(wait.debug).toContain('wait 10 yd');
    expect(wait.action).toBeNull();
    f.state.ball.pos = { x: 26, y: f.state.losY + 12 };
    expect(kicker(k, f.state).debug).toContain('loose ball');
  });

  it('long snapper snaps to the holder/punter, the holder fields it, the kicker strikes off the hold', () => {
    const f = fieldGoal();
    const ls = f.byRole('offense', 'LS');
    const h = f.byRole('offense', 'H');
    const k = f.byRole('offense', 'K');
    expect(snapper(ls, f.state).action).toBeNull();
    expect(holder(h, f.state).action).toBeNull();
    f.state.tick = 120;
    const snap = snapper(ls, f.state);
    expect(snap.action).toBe('snap');
    expect(snap.targetId).toBe(h.id);
    expect(holder(h, f.state).action).toBe('snap');
    goLive(f.state, ls.id);
    f.state.ball.phase = 'inAir';
    f.state.ball.carrierId = null;
    f.state.ball.pos = { x: h.pos.x, y: h.pos.y + 3 };
    f.state.ball.z = 1;
    f.state.ball.vel = { x: 0, y: -8 };
    f.state.ball.vz = 0.5;
    expect(holder(h, f.state).debug).toContain('field snap');
    expect(kicker(k, f.state).debug).toContain('wait');
    giveBall(f.state, h.id, 'snap');
    expect(holder(h, f.state).debug).toContain('hold');
    const approach = kicker(k, f.state);
    expect(approach.action).toBeNull();
    expect(approach.debug).toContain('approach');
    place(f.state, k, h.pos.x - 1, h.pos.y - 1.2);
    const strike = kicker(k, f.state);
    expect(strike.action).toBe('kick');
    expect(strike.targetId).toBe(h.id);
    expect(strike.kickTarget).toEqual({ x: MIDDLE_X, y: 120 });
    // The punt snapper targets the punter.
    const pf = punt();
    expect(kicker(pf.byRole('offense', 'P'), pf.state).action).toBeNull();
    pf.state.tick = 200;
    expect(snapper(pf.byRole('offense', 'LS'), pf.state).targetId).toBe('off:P');
    expect(kicker(pf.byRole('offense', 'P'), pf.state).action).toBe('snap');
  });

  it('coverage men hold lanes across the width, protect before a punt and converge on a committed returner', () => {
    const f = punt({ ballOn: 40 });
    goLive(f.state, 'off:P');
    const unit = f.state.athletes.filter((a) => a.side === 'offense' && a.assignment.type === 'kickCoverage');
    for (const a of unit) coverage(a, f.state);
    const lanes = unit.map((a) => coverageLaneX(a, f.state)).sort((a, b) => a - b);
    expect(lanes[0]).toBeGreaterThan(4);
    expect(lanes[lanes.length - 1]).toBeLessThan(FIELD_WIDTH - 4);
    for (let i = 1; i < lanes.length; i++) expect(lanes[i]! - lanes[i - 1]!).toBeGreaterThan(3);
    const lt = f.byRole('offense', 'LT');
    expect(coverage(lt, f.state).debug).toContain('protect');
    const rusher = f.byRole('defense', 'DE1');
    place(f.state, rusher, lt.pos.x, lt.pos.y + 1.5, { x: 0, y: -4 });
    expect(coverage(lt, f.state).action).toBe('block');
    // Ball away: run the lane.
    f.state.ball.phase = 'inAir';
    f.state.ball.kind = 'punt';
    f.state.ball.carrierId = null;
    f.state.ball.pos = { x: 26, y: f.state.losY + 20 };
    f.state.ball.z = 10;
    f.state.ball.vel = { x: 0, y: 12 };
    f.state.ball.vz = 2;
    for (const a of f.state.athletes) a.hasBall = false;
    expect(kickLaunched(f.state)).toBe(true);
    const lane = coverage(lt, f.state);
    expect(lane.debug).toContain('lane');
    expect(lane.move.y).toBeGreaterThan(0.3);
    expect(lane.sprint).toBe(true);
    // Returner has the ball and is running: pursue.
    const pr = f.byRole('defense', 'PR');
    giveBall(f.state, pr.id, 'punt');
    place(f.state, pr, 26, f.state.losY + 30, { x: 0, y: -8 });
    place(f.state, lt, 26, f.state.losY + 20);
    const chase = coverage(lt, f.state);
    expect(chase.debug).toContain('coverage');
    expect(chase.move.y).toBeGreaterThan(0.3);
  });

  it('a kickoff safety attacks a returner who is coming at him instead of running for his own goal line ahead of him', () => {
    const f = kickoff();
    goLive(f.state, 'off:K', 'kickoff');
    const dir = f.state.ctx.direction;
    const unit = f.state.athletes.filter((a) => a.side === 'offense' && a.assignment.type === 'kickCoverage').sort((a, b) => a.pos.x - b.pos.x);
    for (const a of unit) coverage(a, f.state); // alignment memorised
    const safety = unit[1]!;
    const kr = f.byRole('defense', 'KR');
    giveBall(f.state, kr.id, 'kickoff');
    const catchY = f.state.losY + dir * 60;
    place(f.state, kr, 20, catchY, { x: 0, y: -dir * 9 });
    place(f.state, safety, 20, catchY - dir * 30);
    coverage(safety, f.state); // sees the catch
    // The returner has broken through the wall and is 8.5 yd from the safety, at full speed.
    place(f.state, kr, 20, catchY - dir * 20, { x: 0, y: -dir * 9 });
    place(f.state, safety, 20, catchY - dir * 28.5);
    f.state.time += 2;
    const it = coverage(safety, f.state);
    expect(dir * it.move.y, it.debug).toBeGreaterThan(0.3);
  });

  it('gunners release down the sideline and converge on the landing point', () => {
    const f = punt();
    goLive(f.state, 'off:P');
    const g1 = f.byRole('offense', 'G1');
    const release = gunner(g1, f.state);
    expect(release.move.y).toBeGreaterThan(0.5);
    expect(release.debug).toContain('release');
    f.state.ball.phase = 'inAir';
    f.state.ball.kind = 'punt';
    f.state.ball.carrierId = null;
    f.state.ball.pos = { x: g1.pos.x, y: g1.pos.y + 8 };
    f.state.ball.z = 3;
    f.state.ball.vel = { x: 0, y: 4 };
    f.state.ball.vz = -1;
    for (const a of f.state.athletes) a.hasBall = false;
    const converge = gunner(g1, f.state);
    expect(converge.debug).toContain('converge');
    f.state.events.push({ type: 'fairCatch', tick: f.state.tick, by: 'def:PR' });
    expect(gunner(g1, f.state).debug).toContain('fair catch');
  });
});

describe('kick coverage against return blocks', () => {
  it('a coverage man tied up by a return blocker fights off the block onto a returner coming by, not one far away', () => {
    const f = kickoff();
    goLive(f.state, 'off:K', 'kickoff');
    const dir = f.state.ctx.direction;
    const unit = f.state.athletes.filter((a) => a.side === 'offense' && a.assignment.type === 'kickCoverage');
    for (const a of unit) coverage(a, f.state);
    const man = unit[4]!;
    const blocker = f.state.athletes.find((a) => a.side === 'defense' && a.assignment.type === 'returnBlock')!;
    const kr = f.byRole('defense', 'KR');
    giveBall(f.state, kr.id, 'kickoff');
    place(f.state, man, 26, f.state.losY + dir * 40);
    place(f.state, blocker, 26, f.state.losY + dir * 40.9);
    man.state = 'engaged';
    man.engagedWith = blocker.id;
    blocker.state = 'engaged';
    blocker.engagedWith = man.id;
    // Returner right by him: come off the block onto the ball.
    place(f.state, kr, 28.5, f.state.losY + dir * 42, { x: 0, y: -dir * 8 });
    const shed = coverage(man, f.state);
    expect(shed.action).toBe('shed');
    expect(shed.targetId).toBe(kr.id);
    // Returner still 15 yards off: he plays on as before (no shed toward the ball yet).
    place(f.state, kr, 26, f.state.losY + dir * 55, { x: 0, y: -dir * 8 });
    expect(coverage(man, f.state).action).not.toBe('shed');
  });
});
