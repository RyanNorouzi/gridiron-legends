import { describe, expect, it } from 'vitest';
import { vec2 } from '@/core/vec2';
import { idleIntent } from '@/game/engine-api';
import type { PlayEvent } from '@/game/play-events';
import { emptyObservation, goalStatus, StepTracker, type StepObservation } from '@/ui/tutorial/goals';
import type { TutorialGoal } from '@/ui/tutorial/steps';
import { buildPlayState } from '../../fixtures/play-state';

const obs = (events: PlayEvent[], o: Partial<StepObservation> = {}): StepObservation => ({ ...emptyObservation('home'), events, userIds: ['off:QB'], primaryId: 'off:WR2', ...o });
const status = (goal: TutorialGoal, o: StepObservation) => goalStatus(goal, o);
const throwTo = (target: string, thrower = 'off:QB'): PlayEvent => ({ type: 'throw', tick: 70, thrower, target, throwType: 'touch', airYards: 8, difficulty: 0.2 });

describe('tutorial goals advance on the right events only', () => {
  it('throw to the primary: done for the primary, failed for anyone else, pending before the throw', () => {
    const g: TutorialGoal = { kind: 'throwToPrimary' };
    expect(status(g, obs([{ type: 'snap', tick: 1 }]))).toBe('pending');
    expect(status(g, obs([throwTo('off:WR2')]))).toBe('done');
    expect(status(g, obs([throwTo('off:WR1')]))).toBe('failed');
    // A throw by someone the user never controlled does not count.
    expect(status(g, obs([throwTo('off:WR2', 'off:RB')]))).toBe('pending');
    expect(status(g, obs([], { over: true }))).toBe('failed');
  });

  it('move / gain yards need the distance', () => {
    expect(status({ kind: 'moveYards', yards: 10 }, obs([], { travel: 9.5 }))).toBe('pending');
    expect(status({ kind: 'moveYards', yards: 10 }, obs([], { travel: 10.2 }))).toBe('done');
    expect(status({ kind: 'gainYards', yards: 5 }, obs([], { carrierGain: 4, over: true }))).toBe('failed');
    expect(status({ kind: 'gainYards', yards: 5 }, obs([], { carrierGain: 5.5 }))).toBe('done');
  });

  it('catch, tackle, switch and play-the-ball goals', () => {
    const me = { userIds: ['def:FS'], userSide: 'home' as const };
    expect(status({ kind: 'catchBall' }, obs([{ type: 'catch', tick: 90, receiver: 'off:QB', contested: false, catchKind: 'possession', ballOn: 40 }]))).toBe('done');
    expect(status({ kind: 'catchBall' }, obs([{ type: 'incomplete', tick: 90, reason: 'drop', target: 'off:QB', defender: null }]))).toBe('failed');
    const tackle = (tackler: string): PlayEvent => ({ type: 'tackle', tick: 90, tackler, carrier: 'off:RB', kind: 'wrap', assists: [] });
    expect(status({ kind: 'makeTackle' }, obs([tackle('def:FS')], me))).toBe('done');
    expect(status({ kind: 'makeTackle' }, obs([tackle('def:MLB')], me))).toBe('pending');
    expect(status({ kind: 'makeTackle' }, obs([tackle('def:MLB')], { ...me, over: true }))).toBe('failed');
    expect(status({ kind: 'switchPlayer' }, obs([{ type: 'switchPlayer', tick: 5, to: 'def:SS', side: 'home' }], me))).toBe('done');
    expect(status({ kind: 'switchPlayer' }, obs([{ type: 'switchPlayer', tick: 5, to: 'off:RB', side: 'away' }], me))).toBe('pending');
    expect(status({ kind: 'playTheBall' }, obs([], { ...me, playedBall: true }))).toBe('done');
    expect(status({ kind: 'playTheBall' }, obs([{ type: 'incomplete', tick: 90, reason: 'defended', target: 'off:WR2', defender: 'def:FS' }], me))).toBe('done');
    expect(status({ kind: 'playTheBall' }, obs([{ type: 'catch', tick: 90, receiver: 'off:WR2', contested: false, catchKind: 'possession', ballOn: 40 }], me))).toBe('failed');
    expect(status({ kind: 'playTheBall' }, obs([throwTo('off:WR2')], me))).toBe('pending');
  });
});

describe('StepTracker', () => {
  it('accumulates travel, the carrier gain and a jump/swat while the pass is in the air', () => {
    const f = buildPlayState({ userSide: 'home', controlRole: 'QB', seed: 2 });
    const s = f.state;
    const tracker = new StepTracker('home', 'off:WR2');
    const qb = f.byRole('offense', 'QB');
    tracker.observe(s);
    qb.pos = vec2(qb.pos.x + 3, qb.pos.y);
    tracker.observe(s);
    qb.pos = vec2(qb.pos.x, qb.pos.y + 4);
    let o = tracker.observe(s);
    expect(o.travel).toBeCloseTo(7);
    expect(o.userIds).toEqual(['off:QB']);
    // The QB carries the ball 6 yards past the line.
    s.ball.phase = 'held';
    s.ball.carrierId = qb.id;
    qb.pos = vec2(qb.pos.x, s.losY + 6);
    s.ball.pos = vec2(qb.pos.x, qb.pos.y);
    o = tracker.observe(s);
    expect(o.carrierGain).toBeCloseTo(6);
    expect(o.playedBall).toBe(false);
    s.ball.phase = 'inAir';
    s.ball.kind = 'pass';
    s.intents[qb.id] = { ...idleIntent(), action: 'jump' };
    expect(tracker.observe(s).playedBall).toBe(true);
    expect(tracker.observe(s, true).over).toBe(true);
  });
});
