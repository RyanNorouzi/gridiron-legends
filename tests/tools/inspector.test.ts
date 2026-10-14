import { describe, expect, it } from 'vitest';
import { outcomeAt } from '@/game/outcome-factory';
import { buildInspectorRows, downText, formatClock, gameRows, outcomeSummary, paginate, playRows, yardLine } from '@/tools/inspector';
import { makeSetup, situation } from '../game/fixtures';

const makeGameState = () => situation(makeSetup({ seed: 3 }));
import { buildPlayState } from '../fixtures/play-state';

describe('inspector', () => {
  it('formats the helpers', () => {
    expect(formatClock(0)).toBe('0:00');
    expect(formatClock(65.2)).toBe('1:06');
    expect(yardLine(25)).toBe('OWN 25');
    expect(yardLine(70)).toBe('OPP 30');
    expect(yardLine(50)).toBe('50');
    expect(yardLine(-4)).toBe('OWN 0');
    expect(downText(3, 7, 40)).toBe('3RD & 7');
    expect(downText(1, 10, 95)).toBe('1ST & GOAL');
    expect(outcomeSummary(outcomeAt(75, { result: 'pass', yards: 25, touchdown: true, firstDown: true }))).toBe('PASS +25 TD FD');
    expect(outcomeSummary(outcomeAt(30, { result: 'interception', turnover: true, turnoverType: 'interception' }))).toBe('INTERCEPTION +0 TO INTERCEPTION');
  });

  it('summarises the game state', () => {
    const s = makeGameState();
    s.score = { home: 21, away: 14 };
    s.down = 3;
    s.distance = 7;
    s.ballOn = 62;
    s.timeouts = { home: 2, away: 1 };
    s.pendingDecision = { side: 'home', kind: 'challengeWindow', deadlineSec: 4.5 };
    s.lastOutcome = outcomeAt(55, { result: 'run', yards: 7 });
    const rows = gameRows(s, { names: { home: 'HAW', away: 'WOL' } });
    const v = (label: string): string | undefined => rows.find((r) => r.label === label)?.value;
    expect(v('SCORE')).toBe('WOL 14 - HAW 21');
    expect(v('DOWN')).toBe('3RD & 7');
    expect(v('BALL ON')).toContain('OPP 38');
    expect(v('TIMEOUTS')).toBe('HAW 2 WOL 1');
    expect(v('PENDING')).toBe('CHALLENGEWINDOW HAW 4.5S');
    expect(v('LAST PLAY')).toBe('RUN +7');
    expect(v('CLOCK')).toMatch(/^Q\d \d+:\d\d (RUN|STOP) PC \d+$/);
    expect(rows.every((r) => r.section === 'game')).toBe(true);
  });

  it('summarises the play state, dev notes and queued commands', () => {
    const f = buildPlayState({ seed: 2, userSide: 'home', controlRole: 'QB' });
    f.state.debug.dev = 't3 teleport off:QB';
    const rows = playRows(f.state, { pendingCommands: [{ type: 'forceTurnover' }] });
    const v = (label: string): string | undefined => rows.find((r) => r.label === label)?.value;
    expect(v('PHASE')).toBe('PRESNAP');
    expect(v('DEAD')).toBe('-');
    expect(v('CONTROLLED')).toBe('HOME off:QB');
    expect(v('BALL')).toMatch(/^PRESNAP /);
    expect(v('DEV')).toBe('t3 teleport off:QB');
    expect(v('QUEUED')).toBe('forceTurnover');
    expect(v('PLAY CALL')).toContain('shotgun-mesh');
    expect(playRows(null)).toEqual([{ section: 'play', label: 'PLAY', value: 'NONE' }]);
  });

  it('pages rows and clamps the page', () => {
    const rows = buildInspectorRows(makeGameState(), buildPlayState({ seed: 1 }).state);
    expect(rows.length).toBeGreaterThan(20);
    const p0 = paginate(rows, 8, 0);
    expect(p0.rows).toEqual(rows.slice(0, 8));
    expect(p0.pageCount).toBe(Math.ceil(rows.length / 8));
    const last = paginate(rows, 8, 99);
    expect(last.page).toBe(p0.pageCount - 1);
    expect(last.rows.length).toBeGreaterThan(0);
    expect(paginate(rows, 8, -3).page).toBe(0);
    expect(paginate([], 0, 0)).toEqual({ rows: [], page: 0, pageCount: 1 });
  });
});
