/**
 * SKIP during a watched live play, over the real engine: the play on the field is finished (not re-rolled from the
 * snap), so the card, the spot, the displayed frame and the HUD clock all agree.
 */
import { describe, expect, it } from 'vitest';
import type { GameSetup } from '@/game/types';
import { quickSetup } from '@/simulation/game-sim';
import { defaultSettings } from '@/save/settings-store';
import { generateLeagueEntities } from '@/teams/league-generator';
import { buildHudData } from '@/ui/game/hud';
import { recordingFor } from '@/ui/game/postplay-controls';
import { createDefaultSessionDeps } from '@/ui/game/session-defaults';
import { createGameSession } from '@/ui/game/session';
import { autoplay } from './fixtures';

const palettes = { home: { primary: '#224488' }, away: { primary: '#aa2222' } } as unknown as Parameters<typeof buildHudData>[2]['palettes'];

describe('skipping a watched live play (real engine)', () => {
  it('finishes the play on the field and keeps card, spot, frame and clock consistent', () => {
    const entities = generateLeagueEntities(2026, { year: 2026, salaryCap: 250_000_000 });
    const base = quickSetup(entities, 'BOS', 'NYC', { rulesetId: 'simulation', seed: 3001, userSide: 'home', controllers: { home: 'watch', away: 'ai' } });
    const setup: GameSetup = { ...base, ruleset: { ...base.ruleset, quarterLengthSec: 300 } };
    const deps = createDefaultSessionDeps({ settings: { ...defaultSettings(), simSpeed: 1 } }, setup);
    const session = createGameSession(setup, deps);
    autoplay(session, { until: (s) => s.stage.kind === 'live' && s.stage.meta.ctx.special === 'none' });
    const stage = session.stage;
    if (stage.kind !== 'live') throw new Error('expected a live scrimmage play');
    for (let i = 0; i < 400 && stage.play.state.phase !== 'live'; i++) session.tick();
    for (let i = 0; i < 60 && !stage.play.isDead; i++) session.tick();
    expect(stage.play.isDead).toBe(false);
    const before = session.state.playLog.length;
    session.skipPlay();
    const card = session.stage;
    if (card.kind !== 'postPlay') throw new Error('expected the post-play card');
    expect(session.state.playLog.length).toBe(before + 1);
    expect(stage.play.isDead).toBe(true);
    expect(card.summary.outcome.endBallOn).toBeCloseTo(stage.play.outcome?.endBallOn ?? Number.NaN, 6);
    expect(session.displayPlay).toBe(stage.play);
    // It was really played: not marked simulated, and its recording (replay / highlight) belongs to the card.
    expect(card.summary.simulated).toBe(false);
    expect(recordingFor(card.summary, session.lastReplay())).not.toBeNull();
    const hud = buildHudData(session.state, setup, { play: session.displayPlay?.state ?? null, palettes });
    const secs = session.state.clock.secondsRemaining;
    expect(hud.clock).toBe(buildHudData(session.state, setup, { play: null, palettes }).clock);
    expect(secs).toBeGreaterThan(0);
  }, 60_000);
});
