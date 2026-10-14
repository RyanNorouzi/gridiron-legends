import { describe, expect, it } from 'vitest';
import { TICK_DT } from '@/core/time';
import type { LivePlayFactory } from '@/game/engine-api';
import { makePenalty, outcomeAt } from '@/game/outcome-factory';
import type { PlayContext, PlayOutcome, ReplayFrame } from '@/game/play-types';
import { DeadBallMotion } from '@/ui/game/dead-ball-motion';
import { createGameSession } from '@/ui/game/session';
import type { GameSession } from '@/ui/game/session-types';
import { autoplay, baseScript, FakeLivePlay, makeSession, type Script } from './fixtures';

/** A fake live play that keeps settling for `settleTicks` ticks after its whistle (like PlayEngine.settle). */
class SettlingPlay extends FakeLivePlay {
  settles = 0;
  constructor(ctx: PlayContext, script: Script, opts: ConstructorParameters<typeof FakeLivePlay>[3], private readonly settleTicks = 60) {
    super(ctx, 4, script, opts);
  }
  settle(): boolean {
    if (!this.isDead || this.settles >= this.settleTicks) return false;
    this.settles += 1;
    return this.settles < this.settleTicks;
  }
  settleFrames(): ReplayFrame[] {
    return [];
  }
}

const human = { controllers: { home: 'human', away: 'ai' } as const, userSide: 'home' as const };

const sessionWith = (script: Script): { session: GameSession; plays: SettlingPlay[] } => {
  const base = makeSession({ setup: { ...human, seed: 7 }, script });
  const plays: SettlingPlay[] = [];
  const engine: LivePlayFactory = (ctx, opts) => {
    const p = new SettlingPlay(ctx, script, opts);
    plays.push(p);
    return p;
  };
  return { session: createGameSession(base.setup, { ...base.deps, engine }), plays };
};

/** Renders `seconds` of frames at 60 fps through a DeadBallMotion (as the game screen's render does). */
const render = (motion: DeadBallMotion, session: GameSession, clock: { t: number }, seconds: number): void => {
  for (let i = 0; i < Math.round(seconds * 60); i++) {
    clock.t += TICK_DT;
    motion.advance(session.displayPlay, clock.t, session.snapshot);
  }
};

describe('session: the dead play keeps settling behind prompts and cards', () => {
  it('settles through a penalty prompt and the post-play card, then hands over to the next snap', () => {
    let flagged = false;
    const script = (ctx: PlayContext): PlayOutcome => {
      if (ctx.special === 'none' && ctx.offense === 'home' && !flagged) {
        flagged = true;
        return outcomeAt(ctx.ballOn, { result: 'pass', yards: 6, timeElapsed: 6, penalties: [makePenalty('offsides')] }, 'home');
      }
      return baseScript(ctx);
    };
    const { session, plays } = sessionWith(script);
    autoplay(session, { until: (s) => s.stage.kind === 'penalty', coinToss: 'receive' });
    const dead = plays[plays.length - 1]!;
    expect(dead.isDead).toBe(true);
    expect(session.displayPlay).toBe(dead);
    const motion = new DeadBallMotion();
    const clock = { t: 100 };
    render(motion, session, clock, 0.25);
    const underPrompt = dead.settles;
    expect(underPrompt).toBeGreaterThan(8);
    expect(session.stage.kind).toBe('penalty');
    session.answerPenalty(true);
    expect(session.stage.kind).toBe('postPlay');
    expect(session.displayPlay).toBe(dead);
    render(motion, session, clock, 0.25);
    expect(dead.settles).toBeGreaterThan(underPrompt + 8);
    render(motion, session, clock, 2);
    // At rest: the settle stopped asking for more ticks.
    expect(dead.settles).toBe(60);
    expect(motion.settling).toBe(false);
    // The next snap shows the new play; the old one is never touched again.
    autoplay(session, { until: (s) => s.stage.kind === 'live' && s.live !== dead, coinToss: 'receive' });
    expect(session.displayPlay).not.toBe(dead);
    render(motion, session, clock, 0.25);
    expect(dead.settles).toBe(60);
  });

  it('keeps settling while the challenge window is open', () => {
    const script = (ctx: PlayContext): PlayOutcome => {
      if (ctx.special === 'none' && ctx.offense === 'home' && ctx.playIndex < 6) {
        const ruled = outcomeAt(ctx.ballOn, { result: 'incomplete', incomplete: true, timeElapsed: 6 }, 'home');
        const alt = outcomeAt(ctx.ballOn, { result: 'pass', yards: 25, firstDown: true, timeElapsed: 6 }, 'home');
        return { ...ruled, review: { call: { kind: 'catch', tick: 90, athleteId: 'off:WR1', confidence: 0.9 }, ifOverturned: alt } };
      }
      return baseScript(ctx);
    };
    const { session, plays } = sessionWith(script);
    autoplay(session, { until: (s) => s.stage.kind === 'postPlay' && s.stage.challenge !== null, coinToss: 'receive' });
    const dead = plays[plays.length - 1]!;
    expect(session.displayPlay).toBe(dead);
    const motion = new DeadBallMotion();
    const clock = { t: 5 };
    for (let i = 0; i < 30; i++) {
      session.update(TICK_DT);
      render(motion, session, clock, TICK_DT);
    }
    const stage = session.stage;
    expect(stage.kind === 'postPlay' && stage.challenge !== null).toBe(true);
    expect(dead.settles).toBeGreaterThan(20);
  });
});
