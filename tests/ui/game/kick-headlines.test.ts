/**
 * The kick headline agrees with how the kick ended: a touchback, fair catch or kick out of bounds is never shown
 * as a return, and a return tackled at zero is not a touchback.
 */
import { describe, expect, it } from 'vitest';
import type { AthleteId } from '@/game/play-events';
import { outcomeAt } from '@/game/outcome-factory';
import type { PlayOutcome } from '@/game/play-types';
import { resultText } from '@/ui/game/session-flow';

const by: AthleteId = 'returner';
const kick = (result: 'kickoff' | 'punt', over: Partial<PlayOutcome>): PlayOutcome => outcomeAt(35, { result, kickDistance: 44, returnYards: 0, events: [], ...over });

describe('kick headlines', () => {
  it('kickoffs', () => {
    expect(resultText(kick('kickoff', { events: [{ type: 'touchback', tick: 90 }] }))).toBe('KICKOFF · TOUCHBACK');
    expect(resultText(kick('kickoff', { events: [{ type: 'fairCatch', tick: 90, by }] }))).toBe('KICKOFF · FAIR CATCH');
    expect(resultText(kick('kickoff', { events: [{ type: 'outOfBounds', tick: 90, athlete: null, ballOn: 60 }] }))).toBe('KICKOFF · OUT OF BOUNDS');
    expect(resultText(kick('kickoff', { returnYards: 23 }))).toBe('KICKOFF · RETURN +23');
    expect(resultText(kick('kickoff', { returnYards: -2 }))).toBe('KICKOFF · RETURN -2');
    expect(resultText(kick('kickoff', {}))).toBe('KICKOFF · NO RETURN');
    expect(resultText(kick('kickoff', { turnover: true }))).toBe('KICKOFF · RECOVERED');
  });
  it('punts', () => {
    expect(resultText(kick('punt', { events: [{ type: 'touchback', tick: 90 }] }))).toBe('PUNT 44 YDS · TOUCHBACK');
    expect(resultText(kick('punt', { events: [{ type: 'fairCatch', tick: 90, by }] }))).toBe('PUNT 44 YDS · FAIR CATCH');
    expect(resultText(kick('punt', { returnYards: 8 }))).toBe('PUNT 44 YDS · RETURN +8');
    expect(resultText(kick('punt', {}))).toBe('PUNT 44 YDS');
  });
  it('place kicks tell a miss from a try that never got off', () => {
    expect(resultText(outcomeAt(75, { result: 'fieldGoal', kickMade: true, kickDistance: 42.4 }))).toBe('FIELD GOAL GOOD · 42 YDS');
    expect(resultText(outcomeAt(75, { result: 'fieldGoal', kickMade: false }))).toBe('FIELD GOAL NO GOOD');
    expect(resultText(outcomeAt(75, { result: 'fieldGoal', kickMade: null }))).toBe('FIELD GOAL TRY STOPPED');
    expect(resultText(outcomeAt(85, { result: 'extraPoint', kickMade: false }))).toBe('EXTRA POINT NO GOOD');
    expect(resultText(outcomeAt(85, { result: 'extraPoint', kickMade: null }))).toBe('EXTRA POINT TRY STOPPED');
  });
});
