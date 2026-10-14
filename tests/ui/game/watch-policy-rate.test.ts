import { describe, expect, it } from 'vitest';
import type { GameState } from '@/game/types';
import { createWatchPolicy, twoMinuteWindow } from '@/ui/game/watch-policy';
import { makeSetup, situation } from '../../game/fixtures';
import { autoplay, makeSession } from './fixtures';

const drive = (startBallOn: number): GameState['drive'] => ({ possession: 'away', startBallOn, startQuarter: 2, startClock: 500, plays: 3, yards: 10, result: null });

describe('watch mode does not nag (H2-19)', () => {
  it('asks at most once per drive, and the two-minute drill once per half, scaled to the quarter length', () => {
    const setup = makeSetup({ ruleset: { quarterLengthSec: 120 } });
    const policy = createWatchPolicy();
    const base = { possession: 'away' as const, down: 3, distance: 6, ballOn: 40, drive: drive(25), clock: { quarter: 2, secondsRemaining: 90, running: false, playClock: 40, playClockRunning: false } };
    expect(twoMinuteWindow(120)).toBe(30);
    expect(twoMinuteWindow(900)).toBe(120);
    // 1:30 left of a 2-minute quarter is not the two-minute drill; third down prompts once for the drive.
    expect(policy.shouldPrompt(situation(setup, base), 'home')?.reason).toBe('thirdDown');
    expect(policy.shouldPrompt(situation(setup, { ...base, down: 4 }), 'home')).toBeNull();
    expect(policy.shouldPrompt(situation(setup, { ...base, ballOn: 85, down: 3 }), 'home')).toBeNull();
    // Inside the scaled window: one two-minute prompt for the half.
    const late = { ...base, down: 1, clock: { ...base.clock, secondsRemaining: 25 } };
    expect(policy.shouldPrompt(situation(setup, late), 'home')?.reason).toBe('twoMinute');
    expect(policy.shouldPrompt(situation(setup, { ...late, clock: { ...late.clock, secondsRemaining: 15 } }), 'home')).toBeNull();
    // A new drive may ask again.
    expect(policy.shouldPrompt(situation(setup, { ...base, drive: drive(70) }), 'home')?.reason).toBe('thirdDown');
  });

  it('a short-quarter watch game raises far fewer prompts than plays', () => {
    const f = makeSession({ setup: { controllers: { home: 'watch', away: 'ai' }, userSide: 'home', seed: 9, ruleset: { quarterLengthSec: 120 } }, settings: { defenseMode: 'watch' } });
    let prompts = 0;
    autoplay(f.session, { until: (s) => { if (s.stage.kind === 'watchPrompt') prompts++; return s.stage.kind === 'final'; }, watch: false, maxSteps: 60000 });
    const plays = f.session.state.playLog.length;
    expect(plays).toBeGreaterThan(10);
    expect(prompts).toBeLessThanOrEqual(Math.ceil(plays / 3));
  });
});
