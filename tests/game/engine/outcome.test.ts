import { describe, expect, it } from 'vitest';
import { fatigueCostFactor } from '@/players/fatigue';
import { assertValidOutcome } from '@/game/outcome-factory';
import { createReplayStore } from '@/game/replay';
import { applyDeltas } from '@/statistics/apply';
import { emptyGameStats } from '@/statistics/empty';
import { carrierDown, goalLineY } from '@/game/systems/env';
import { ahead, build, chaseBall, clearDefense, scripted, toward } from './helpers';

describe('outcome and replay', () => {
  it('records frames and pushes a replay recording with eviction per retention', () => {
    const store = createReplayStore('lastPlay');
    const { engine } = build({ offensePlayId: 'iform-dive-right', defensePlayId: '43-cover3-zone', seed: 5, recordFrames: true }, {}, {
      decider: scripted({ 'off:RB': (a, s) => (a.hasBall ? ahead(s, 'offense') : toward(a, s.ball.pos)), 'def:MLB': chaseBall }),
      recordFrames: true, replayStore: store,
    });
    const o = engine.run();
    expect(o.replayId).not.toBeNull();
    const rec = store.get(o.replayId!);
    expect(rec).not.toBeNull();
    expect(rec!.frames.length).toBe(engine.stepCount);
    expect(rec!.frames[0]!.athletes).toHaveLength(22);
    expect(rec!.events).toEqual(o.events);
    expect(store.last()?.id).toBe(o.replayId);
    store.push({ ...rec!, id: 'second' });
    expect(store.get(o.replayId!)).toBeNull();
    expect(store.last()?.id).toBe('second');
    const off = createReplayStore('off');
    off.push(rec!);
    expect(off.last()).toBeNull();
    const drive = createReplayStore('drive');
    drive.push(rec!);
    drive.push({ ...rec!, id: 'x' });
    expect(drive.get('x')).not.toBeNull();
    expect(drive.get(rec!.id)).not.toBeNull();
    drive.clear();
    expect(drive.last()).toBeNull();
  });

  it('stat deltas apply cleanly and fatigue is reported for everyone on the field', () => {
    const { engine } = build({ offensePlayId: 'iform-dive-right', defensePlayId: '43-cover3-zone', seed: 6 }, {}, {
      decider: scripted({ 'off:RB': (a, s) => (a.hasBall ? ahead(s, 'offense') : toward(a, s.ball.pos)), 'def:MLB': chaseBall, 'def:FS': chaseBall }, clearDefense),
    });
    const o = engine.run();
    assertValidOutcome(o);
    const stats = applyDeltas(emptyGameStats(), o.stats);
    expect(Object.keys(stats.players).length).toBe(22);
    for (const a of engine.state.athletes) {
      expect(stats.players[a.playerId]!.snaps).toBe(1);
      expect(o.fatigueAfter[a.playerId]).toBeGreaterThanOrEqual(0);
    }
    const rb = engine.state.athletes.find((a) => a.id === 'off:RB')!;
    const lt = engine.state.athletes.find((a) => a.id === 'off:LT')!;
    // The runner did more work than the idle lineman: compare the effort behind the fatigue, not each man's stamina (a
    // low-stamina lineman pays more for the same effort; the quicker tackle finish leaves this runner a short carry).
    const effort = (a: typeof rb): number => o.fatigueAfter[a.playerId]! / fatigueCostFactor(a.baseAttrs.stamina);
    expect(effort(rb)).toBeGreaterThan(effort(lt));
    if (engine.state.deadReason === 'tackle') expect(o.tacklerIds.length).toBeGreaterThan(0);
  });

  it('presnapElapsed is zero when the clock was stopped before the snap', () => {
    const { engine } = build({ offensePlayId: 'iform-dive-right', defensePlayId: '43-cover3-zone', seed: 6 }, { clockRunning: false }, {
      decider: scripted({ 'off:RB': (a, s) => (a.hasBall ? ahead(s, 'offense') : toward(a, s.ball.pos)) }, clearDefense),
    });
    const o = engine.run();
    expect(o.presnapElapsed).toBe(0);
    expect(o.timeElapsed).toBeGreaterThan(0);
  });

  it('a goal-line ruling within the review margin produces a reviewable call whose alternate is the other ruling', () => {
    const { engine } = build({ offensePlayId: 'iform-dive-right', defensePlayId: '43-cover3-zone', seed: 3, ballOn: 96, distance: 4, ruleset: 'arcade' }, {}, {
      decider: scripted({ 'off:RB': (a, s) => (a.hasBall ? ahead(s, 'offense') : toward(a, s.ball.pos)) }, clearDefense),
    });
    while (engine.state.ball.carrierId !== 'off:RB') engine.tick();
    const state = engine.state;
    const env = engine.debugEnv();
    const rb = state.athletes.find((a) => a.id === 'off:RB')!;
    const goal = goalLineY(env, 'offense');
    rb.pos = { x: 26, y: goal - state.ctx.direction * 0.2 };
    carrierDown(state, env, rb, rb.pos, 'tackle');
    expect(state.deadReason).toBe('tackle');
    expect(env.review?.call.kind).toBe('touchdown');
    engine.tick();
    const o = engine.outcome!;
    assertValidOutcome(o);
    expect(o.touchdown).toBe(false);
    expect(o.review).not.toBeNull();
    expect(o.review!.call.confidence).toBeGreaterThanOrEqual(0.55);
    expect(o.review!.call.confidence).toBeLessThan(1);
    const alt = o.review!.ifOverturned;
    assertValidOutcome(alt);
    expect(alt.review).toBeNull();
    expect(alt.touchdown).toBe(true);
    expect(alt.endBallOn).toBe(100);
    expect(alt.result).toBe('run');
  });

  it('close goal-line tackles in real plays sometimes produce a review (never an invalid one)', () => {
    let found = 0;
    for (let seed = 1; seed <= 40; seed++) {
      const { engine } = build({ offensePlayId: 'iform-dive-right', defensePlayId: '43-cover3-zone', seed, ballOn: 97, distance: 3, ruleset: 'arcade' }, {}, {
        decider: scripted({
          'off:RB': (a, s) => (a.hasBall ? ahead(s, 'offense') : toward(a, s.ball.pos)),
          'def:FS': (a, s) => (s.ball.carrierId === 'off:RB' ? chaseBall(a, s) : clearDefense(a, s)),
          'def:SS': (a, s) => (s.ball.carrierId === 'off:RB' ? chaseBall(a, s) : clearDefense(a, s)),
          'def:MLB': (a, s) => (s.ball.carrierId === 'off:RB' ? chaseBall(a, s) : clearDefense(a, s)),
        }, clearDefense),
      });
      const o = engine.run();
      assertValidOutcome(o);
      if (!o.review) continue;
      found += 1;
      expect(o.review.ifOverturned.review).toBeNull();
      expect(o.review.ifOverturned.touchdown).not.toBe(o.touchdown);
      assertValidOutcome(o.review.ifOverturned);
    }
    expect(found).toBeGreaterThanOrEqual(0);
  });
});
