import { describe, expect, it } from 'vitest';
import { createGameSession } from '@/ui/game/session';
import { resumeState } from '@/ui/game/session-flow';
import { autoplay, makeSession } from './fixtures';

const human = { controllers: { home: 'human', away: 'ai' } as const, userSide: 'home' as const };

describe('resuming a saved game', () => {
  it('continues from the saved state (score, clock, log) instead of a new kickoff', () => {
    const f = makeSession({ setup: { ...human, seed: 7 } });
    autoplay(f.session, { until: (s) => s.state.playLog.length >= 6 && s.stage.kind === 'live', coinToss: 'receive' });
    // Saved mid-play: the play in progress is rolled back to the snap before it.
    const saved = structuredClone(f.session.state);
    expect(saved.phase).toBe('presnap');
    const rolled = resumeState(saved, f.setup);
    expect(rolled.phase).not.toBe('presnap');
    const b = createGameSession(f.setup, { ...f.deps, initialState: saved });
    b.start();
    expect(b.state.playLog).toHaveLength(saved.playLog.length);
    expect(b.state.score).toEqual(saved.score);
    expect(b.state.clock.quarter).toBe(saved.clock.quarter);
    expect(['coinToss', 'pregame']).not.toContain(b.stage.kind);
    autoplay(b, { until: (s) => s.stage.kind === 'final' });
    expect(b.state.phase).toBe('final');
    expect(b.state.playLog.length).toBeGreaterThan(saved.playLog.length);
  });
});
