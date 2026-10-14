import { describe, expect, it } from 'vitest';
import { deadBallOutcome, makePenalty } from '@/game/outcome-factory';
import { controllerAt } from './fixtures';

const accepted = (p: ReturnType<typeof makePenalty>) => ({ ...p, accepted: true });

describe('fouled tries are re-snapped from the walked-off spot', () => {
  it('a delay of game on a two-point try moves the next try back 5 yards', () => {
    const c = controllerAt({ possession: 'home', patPending: 'home', ballOn: 85, phase: 'pat' });
    const ctx = c.beginPlay('run-inside', 'cover3');
    expect(ctx.ballOn).toBe(98);
    c.completePlay(deadBallOutcome(98, accepted(makePenalty('delayOfGame'))));
    expect(c.state.patPending).toBe('home');
    const next = c.beginPlay('run-inside', 'cover3');
    expect(next.ballOn).toBe(93);
  });

  it('the walked-off offset carries over when the team switches to a kick', () => {
    const c = controllerAt({ possession: 'home', patPending: 'home', ballOn: 85, phase: 'pat' });
    c.beginPlay('run-inside', 'cover3');
    c.completePlay(deadBallOutcome(98, accepted(makePenalty('delayOfGame'))));
    expect(c.beginPlay('xp', 'cover3').ballOn).toBe(80);
  });

  it('the walked-off try spot survives a save and resume between the tries', () => {
    const c = controllerAt({ possession: 'home', patPending: 'home', ballOn: 85, phase: 'pat' });
    c.beginPlay('run-inside', 'cover3');
    c.completePlay(deadBallOutcome(98, accepted(makePenalty('delayOfGame'))));
    const resumed = controllerAt(structuredClone(c.state));
    expect(resumed.beginPlay('run-inside', 'cover3').ballOn).toBe(93);
  });

  it('an unfouled try after a touchdown still starts from the default spot', () => {
    const c = controllerAt({ possession: 'home', patPending: 'home', ballOn: 85, phase: 'pat' });
    expect(c.beginPlay('xp', 'cover3').ballOn).toBe(85);
  });
});
