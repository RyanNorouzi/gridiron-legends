import { describe, expect, it } from 'vitest';
import { buildDrillScenario, DEFAULT_DRILL_OPTIONS, DrillRep, getDrill } from '@/game/practice';
import type { SnapshotBuffer } from '@/ui/game/interp';
import { PracticePlayView } from '@/ui/screens/practice-view';
import { makeInput } from '../render/fake-ctx';
import { makeUi } from './fixtures';

const bufferOf = (view: PracticePlayView): SnapshotBuffer => (view as unknown as { buffer: SnapshotBuffer }).buffer;

describe('practice view after the whistle', () => {
  it('keeps the dead rep settling and ends the interpolation on the resting frame', () => {
    const ui = makeUi();
    const view = new PracticePlayView();
    view.attach(ui.services);
    const rep = new DrillRep(buildDrillScenario(getDrill('running'), { ...DEFAULT_DRILL_OPTIONS, difficulty: 'rookie' }, 31, 0));
    view.setRep(rep);
    view.step(makeInput({ pressed: ['snap'] }), ui.services);
    for (let t = 0; t < 2400 && !rep.finished; t++) view.step(makeInput({ axis: { x: 0.2, y: -1 }, down: ['sprint'] }), ui.services);
    expect(rep.finished).toBe(true);
    expect(rep.play.isDead).toBe(true);
    // The settle runs on the view's fixed steps once the rep is over (at most 1.5 s = 90 ticks).
    for (let t = 0; t < 120; t++) view.step(makeInput(), ui.services);
    expect(rep.state.athletes.every((a) => a.vel.x === 0 && a.vel.y === 0)).toBe(true);
    const buf = bufferOf(view);
    for (const a of rep.state.athletes) {
      const cur = buf.current?.athletes.get(a.id);
      const prev = buf.prev?.athletes.get(a.id);
      expect(cur, a.id).toEqual({ x: a.pos.x, y: a.pos.y, facing: a.facing });
      // Nothing interpolates any more: the scene is still, not stuck one step short of rest.
      expect(prev, a.id).toEqual(cur);
    }
  });
});
