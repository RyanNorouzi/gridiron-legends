import { describe, expect, it } from 'vitest';
import { outcomeAt } from '@/game/outcome-factory';
import type { PenaltyInfo } from '@/game/play-events';
import type { PlayOutcome } from '@/game/play-types';
import type { PlayLogEntry } from '@/game/types';
import { highlightKind, scoredTouchdown } from '@/ui/game/highlights';
import { resultText, summaryFor } from '@/ui/game/session-flow';
import { makeSetup } from '../../game/fixtures';

const opi: PenaltyInfo = {
  foul: 'passInterferenceOffense', side: 'offense', yards: 10, playerId: null, automaticFirstDown: false, lossOfDown: false,
  enforcement: 'previousSpot', spotBallOn: null, deadBall: false, replayDown: true, accepted: true,
};

const entry = (o: Partial<PlayOutcome>): PlayLogEntry => ({
  index: 3, quarter: 2, clock: 400, possession: 'home', down: 2, distance: 10, ballOn: 78, ballX: 26, offensivePlayId: null, defensivePlayId: null,
  outcome: outcomeAt(78, { result: 'pass', yards: 22, timeElapsed: 5, ...o }, 'home'), scoreAfter: { home: 18, away: 21 }, review: null,
});

describe('a touchdown wiped out by an accepted foul (H2-10)', () => {
  it('is not headlined, captioned or kept as a touchdown', () => {
    const e = entry({ touchdown: true, penalties: [opi], playByPlay: ['TOUCHDOWN M. Robbins!'] });
    expect(scoredTouchdown(e.outcome)).toBe(false);
    expect(resultText(e.outcome)).toMatch(/^NO TOUCHDOWN · FLAG/);
    expect(highlightKind(e.outcome)).toBeNull();
    const summary = summaryFor(makeSetup(), e, 'none', false);
    expect(summary.resultText).not.toBe('TOUCHDOWN');
    expect(summary.pbp.join(' ')).toMatch(/wiped out/);
    expect(summary.pbp.join(' ')).not.toMatch(/TOUCHDOWN/);
    expect(summary.bigPlay).toBe(false);
  });

  it('a declined foul leaves the touchdown standing', () => {
    const e = entry({ touchdown: true, penalties: [{ ...opi, accepted: false }] });
    expect(scoredTouchdown(e.outcome)).toBe(true);
    expect(resultText(e.outcome)).toBe('TOUCHDOWN');
    expect(highlightKind(e.outcome)).toBe('touchdown');
  });
});
