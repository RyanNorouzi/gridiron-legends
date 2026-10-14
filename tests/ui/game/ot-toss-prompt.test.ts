import { describe, expect, it } from 'vitest';
import type { GameSession, SessionStage } from '@/ui/game/session-types';
import { situationSummary } from '@/ui/game/session-flow';
import { promptForStage } from '@/ui/screens/stage-prompts';
import { makeSession } from './fixtures';

describe('overtime coin toss (H2-09)', () => {
  const stage: SessionStage = { kind: 'coinToss', side: 'home' };

  it('the pregame toss offers DEFER and names the stadium', () => {
    const f = makeSession({ setup: { controllers: { home: 'human', away: 'ai' }, userSide: 'home', seed: 3 } });
    const p = promptForStage(stage, f.session, 5);
    expect(p?.choices.map((c) => c.id)).toEqual(['receive', 'kick', 'defer']);
    expect(p?.lines?.[0]).toMatch(/attendance/);
  });

  it('the overtime toss drops DEFER and the pregame text; the HUD shows OVERTIME, not the old spot', () => {
    const f = makeSession({ setup: { controllers: { home: 'human', away: 'ai' }, userSide: 'home', seed: 3 } });
    const state = { ...f.session.state, overtime: { period: 1, possessions: { home: 0, away: 0 }, firstPossessionResult: null, suddenDeath: false }, clock: { ...f.session.state.clock, quarter: 5 }, score: { home: 17, away: 17 }, phase: 'coinToss' as const };
    const session = { setup: f.session.setup, state } as unknown as GameSession;
    const p = promptForStage(stage, session, 5);
    expect(p?.title).toBe('OVERTIME TOSS');
    expect(p?.choices.map((c) => c.id)).toEqual(['receive', 'kick']);
    expect(p?.lines?.join(' ')).not.toMatch(/attendance/i);
    expect(p?.lines?.join(' ')).toMatch(/17-17/);
    expect(situationSummary({ ...state, down: 1, distance: 10, ballOn: 45 })).toBe('OVERTIME');
  });
});
