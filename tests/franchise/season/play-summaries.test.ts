import { describe, expect, it } from 'vitest';
import { createLeague } from '@/franchise/league';
import { compactPlayLog, describeOutcome } from '@/franchise/play-text';
import { advanceLeagueWeek } from '@/franchise/season-loop';
import { fallbackSimulator } from '@/franchise/sim-fallback';
import type { GameSimulator } from '@/franchise/sim-seam';
import { outcomeAt } from '@/game/outcome-factory';
import type { PlayLogEntry } from '@/game/types';
import { buildBoxScore } from '@/ui/franchise/league/boxscore-model';

const entry = (index: number, over: Partial<PlayLogEntry['outcome']> = {}): PlayLogEntry => ({
  index, quarter: 1, clock: 900 - index * 30, possession: 'home', down: 1, distance: 10, ballOn: 25 + index, ballX: 26.65,
  offensivePlayId: null, defensivePlayId: null, outcome: outcomeAt(25 + index, { result: 'run', yards: 4.4, timeElapsed: 30, ...over }, 'home'),
  scoreAfter: { home: 0, away: 0 }, review: null,
});

describe('compact play-by-play', () => {
  it('describes applied outcomes with rounded yards and names', () => {
    const name = (id: string | null): string | null => (id ? 'J. Doe' : null);
    expect(describeOutcome(outcomeAt(30, { result: 'run', yards: 4.4, ballCarrierId: 'p1' as never }, 'home'), name)).toBe('J. Doe run, 4 yds');
    expect(describeOutcome(outcomeAt(70, { result: 'fieldGoal', kickMade: true, kickDistance: 44.2188 }, 'home'), name)).toBe('44-yd Field goal good');
    expect(describeOutcome(outcomeAt(30, { result: 'pass', yards: 12, touchdown: true }, 'home'), () => null)).toBe('Pass to receiver, 12 yds, TD');
  });

  it('is stored for every AI-vs-AI game of a week and shown in its box score', () => {
    const league = createLeague({ seed: 3, userTeamAbbr: 'BOS' });
    const withLog: GameSimulator = (setup, opts) => ({ ...fallbackSimulator(setup, opts), playLog: [entry(0), entry(1, { firstDown: true })] });
    const next = advanceLeagueWeek(league, { simulator: withLog }).league;
    const played = next.season.schedule.filter((g) => g.result !== null);
    expect(played.length).toBeGreaterThan(1);
    const aiGame = played.find((g) => g.home !== next.userTeamId && g.away !== next.userTeamId)!;
    expect(aiGame.result?.playLogId).toBeNull();
    expect(next.playSummaries?.[aiGame.id]).toHaveLength(2);
    const box = buildBoxScore(next, aiGame.id);
    expect(box?.plays).toHaveLength(2);
    expect(box?.plays?.[1]?.text).toContain('1st down');
    const userGame = played.find((g) => g.home === next.userTeamId || g.away === next.userTeamId);
    if (userGame) expect(next.playSummaries?.[userGame.id]).toBeUndefined();
    expect(compactPlayLog([entry(0)], { home: { players: {} } as never, away: { players: {} } as never })[0]).toMatchObject({ q: 1, p: 'home', b: 25, k: 0 });
  });
});
