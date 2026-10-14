import { describe, expect, it } from 'vitest';
import { clearDeciders, decideIntent, getDecider } from '@/ai/index';
import { isRegistered, registerAll } from '@/ai/register';
import { buildPlayState } from '../../fixtures/play-state';

describe('registerAll', () => {
  it('registers the special-teams keys, is idempotent and reports registration', () => {
    clearDeciders();
    const f = buildPlayState({ offensePlayId: 'kickoff-deep', defensePlayId: 'kickReturn-middle', ballOn: 35 });
    f.state.ctx.special = 'kickoff';
    expect(getDecider(f.byRole('defense', 'KR'))).toBeUndefined();
    expect(decideIntent(f.byRole('defense', 'KR'), f.state, 1 / 60).debug).toBe('no-ai');
    registerAll();
    expect(isRegistered()).toBe(true);
    const first = getDecider(f.byRole('defense', 'KR'));
    expect(first).toBeDefined();
    registerAll();
    expect(getDecider(f.byRole('defense', 'KR'))).toBe(first);
    expect(getDecider(f.byRole('offense', 'K'))).toBeDefined();
    expect(getDecider(f.byRole('offense', 'KC1'))).toBeDefined();
    expect(decideIntent(f.byRole('defense', 'L1'), f.state, 1 / 60).debug).toContain('wedge');
  });
});
