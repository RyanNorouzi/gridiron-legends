import { describe, expect, it } from 'vitest';
import type { PlayContext, PlayOutcome } from '@/game/play-types';
import { outcomeAt } from '@/game/outcome-factory';
import { REVIEW_HOLD_SECONDS } from '@/ui/game/session';
import { autoplay, baseScript, makeSession } from './fixtures';

const human = { controllers: { home: 'human', away: 'ai' } as const, userSide: 'home' as const };

describe('a challenge ruling stays on screen (H2-15)', () => {
  it('an upheld call holds the card, says the call stands and costs the timeout before the next play call', () => {
    const script = (ctx: PlayContext): PlayOutcome => {
      if (ctx.special === 'none' && ctx.offense === 'home' && ctx.playIndex < 6) {
        const ruled = outcomeAt(ctx.ballOn, { result: 'incomplete', incomplete: true, timeElapsed: 6 }, 'home');
        const alt = outcomeAt(ctx.ballOn, { result: 'pass', yards: 25, firstDown: true, timeElapsed: 6 }, 'home');
        // Confidence 1: the review always upholds the ruling.
        return { ...ruled, review: { call: { kind: 'catch', tick: 90, athleteId: 'off:WR1', confidence: 1 }, ifOverturned: alt } };
      }
      return baseScript(ctx);
    };
    const f = makeSession({ setup: { ...human, seed: 7 }, script });
    autoplay(f.session, { until: (s) => s.stage.kind === 'postPlay' && s.stage.challenge !== null, coinToss: 'receive' });
    const timeouts = f.session.state.timeouts.home;
    expect(f.session.challenge()).toBe(true);
    const held = f.session.stage;
    if (held.kind !== 'postPlay') throw new Error(`expected the ruling card, got ${held.kind}`);
    expect(held.challenge).toBeNull();
    expect(held.summary.resultText).toMatch(/^CALL STANDS · INCOMPLETE/);
    expect(held.remaining).toBe(REVIEW_HOLD_SECONDS);
    expect(f.session.state.timeouts.home).toBe(timeouts - 1);
    expect(f.events.some((e) => e.type === 'banner' && e.text === 'CALL STANDS')).toBe(true);
    f.session.update(REVIEW_HOLD_SECONDS / 2);
    expect(f.session.stage.kind).toBe('postPlay');
    f.session.update(REVIEW_HOLD_SECONDS);
    expect(f.session.stage.kind).not.toBe('postPlay');
  });
});
