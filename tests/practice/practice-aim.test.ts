import { describe, expect, it, vi } from 'vitest';
import { registerAll } from '@/ai/register';
import { DEFAULT_DRILL_OPTIONS, getDrill } from '@/game/practice';
import { PracticeGameScreen } from '@/ui/screens/practice-game';
import { makeInput } from '../ui/render/fake-ctx';
import { makeUi } from '../ui/game/fixtures';

const aimCalls = vi.hoisted(() => [] as unknown[][]);
vi.mock('@/ui/game/throw-aim-view', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/ui/game/throw-aim-view')>();
  return { ...real, renderThrowAim: (...args: unknown[]) => { aimCalls.push(args); } };
});

registerAll();

/** Practice drills draw the pull-back throw aim over the field, as the game and the tutorial do. */
describe('practice throw aim', () => {
  it('the practice game screen draws the throw-aim preview for the rep and the user side', () => {
    const ui = makeUi();
    const game = new PracticeGameScreen(getDrill('passRoutes'), { ...DEFAULT_DRILL_OPTIONS }, { onChangeDrill: () => undefined, onQuit: () => undefined, seed: 9 });
    ui.stack.push(game);
    ui.stack.update(1 / 60, makeInput({ pressed: ['snap'] }));
    for (let i = 0; i < 3; i++) ui.stack.update(1 / 60, makeInput());
    aimCalls.length = 0;
    game.render(ui.rc);
    expect(aimCalls).toHaveLength(1);
    const [, , , state, side] = aimCalls[0] as unknown[];
    expect(state).toBe(game.view.rep?.state);
    expect(side).toBe(game.view.rep?.scenario.userSide);
  });
});
