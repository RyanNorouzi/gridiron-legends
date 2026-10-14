import { describe, expect, it, vi } from 'vitest';
import { createGameState } from '@/game/game-state';
import { generateLeagueEntities } from '@/teams/league-generator';
import { LEAGUE_SALARY_CAP, LEAGUE_YEAR, QuickGameSetupScreen, buildQuickGameSetup, portraitFacing, sortedTeams, type QuickGameChoice } from '@/ui/screens/quick-game-setup';
import { makeInput } from '../render/fake-ctx';
import { makeUi } from './fixtures';

const league = generateLeagueEntities(3, { year: LEAGUE_YEAR, salaryCap: LEAGUE_SALARY_CAP });
const teams = sortedTeams(league);
const choice = (over: Partial<QuickGameChoice> = {}): QuickGameChoice => ({
  homeAbbr: teams[0]!.abbr, awayAbbr: teams[1]!.abbr, side: 'home', difficulty: 'pro', ruleset: 'simulation', quarterMinutes: 5, weather: 'auto', defenseMode: 'control', seed: 42, ...over,
});

describe('buildQuickGameSetup', () => {
  it('builds a valid setup with full rosters, resolved playbooks, stadium and weather', () => {
    const setup = buildQuickGameSetup(league, choice());
    expect(Object.keys(setup.home.players)).toHaveLength(53);
    expect(Object.keys(setup.away.players)).toHaveLength(53);
    expect(setup.home.team.rosterIds.every((id) => setup.home.players[id] !== undefined)).toBe(true);
    for (const side of ['home', 'away'] as const) {
      const concepts = new Set(setup[side].offensePlays.map((p) => p.concept));
      expect(concepts.has('kickoff')).toBe(true);
      expect(concepts.has('punt')).toBe(true);
      expect(concepts.has('fieldGoal')).toBe(true);
      expect(concepts.has('extraPoint')).toBe(true);
      expect(setup[side].offensePlays.length).toBeGreaterThan(20);
      expect(setup[side].defensePlays.some((p) => p.tags.includes('kickReturn'))).toBe(true);
      expect(setup[side].headCoach?.role).toBe('HC');
    }
    expect(setup.stadium.id).toBe(setup.home.team.stadiumId);
    expect(setup.ruleset.quarterLengthSec).toBe(300);
    expect(setup.difficulty.id).toBe('pro');
    expect(setup.userSide).toBe('home');
    expect(setup.controllers).toEqual({ home: 'human', away: 'ai' });
    expect(setup.seed).toBe(42);
    expect(() => createGameState(setup)).not.toThrow();
    expect(buildQuickGameSetup(league, choice()).id).toBe(setup.id);
  });

  it('supports away, watch, arcade rules, explicit weather and rejects bad choices', () => {
    const away = buildQuickGameSetup(league, choice({ side: 'away', ruleset: 'arcade', quarterMinutes: 2 }));
    expect(away.controllers).toEqual({ home: 'ai', away: 'human' });
    expect(away.ruleset.mode).toBe('arcade');
    expect(away.ruleset.quarterLengthSec).toBe(120);
    const watch = buildQuickGameSetup(league, choice({ side: 'watch' }));
    expect(watch.controllers.home).toBe('watch');
    expect(watch.userSide).toBe('home');
    expect(() => createGameState(watch)).not.toThrow();
    const outdoor = teams.find((t) => league.stadiums[t.stadiumId]?.roof === 'open')!;
    const snow = buildQuickGameSetup(league, choice({ homeAbbr: outdoor.abbr, awayAbbr: outdoor.abbr === teams[1]!.abbr ? teams[2]!.abbr : teams[1]!.abbr, weather: 'snow' }));
    expect(snow.weather.type).toBe('snow');
    const dome = teams.find((t) => league.stadiums[t.stadiumId]?.roof === 'dome');
    if (dome) expect(buildQuickGameSetup(league, choice({ homeAbbr: dome.abbr, awayAbbr: dome.abbr === teams[0]!.abbr ? teams[1]!.abbr : teams[0]!.abbr, weather: 'snow' })).weather.type).toBe('clear');
    expect(() => buildQuickGameSetup(league, choice({ awayAbbr: teams[0]!.abbr }))).toThrow(/differ/);
    expect(() => buildQuickGameSetup(league, choice({ awayAbbr: 'ZZZ' }))).toThrow(/unknown team/);
  });
});

describe('QuickGameSetupScreen', () => {
  it('shows every option row at once in large text (compact matchup header) and keeps HOME / AWAY labels', () => {
    const ui = makeUi({ textSize: 'large' });
    const screen = new QuickGameSetupScreen({ onStart: vi.fn(), league, seed: () => 99 });
    ui.stack.push(screen);
    screen.render(ui.rc);
    // Before: the team cards left room for two of the nine rows. Now all nine fit (0 = no scrolling).
    expect(screen.list.maxVisible).toBe(0);
    expect(screen.list.items).toHaveLength(9);
    // Every row is on screen (hit-testable) above the hint bar.
    const rowAt = new Map<number, number>();
    for (let y = 0; y < ui.rc.height; y++) {
      const i = screen.list.hitTest(ui.rc.width / 2, y);
      if (i >= 0 && !rowAt.has(i)) rowAt.set(i, y);
    }
    expect([...rowAt.keys()].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    expect(rowAt.get(8)! + ui.rc.theme.lineHeight).toBeLessThanOrEqual(ui.rc.height - ui.rc.theme.glyphH - 4);
    const home = screen.list.items.find((i) => i.id === 'home');
    expect(home?.value).toBe(`${teams[0]!.name.toUpperCase()} (${teams[0]!.overall})`);
    const normal = makeUi();
    const wide = new QuickGameSetupScreen({ onStart: vi.fn(), league, seed: () => 99 });
    normal.stack.push(wide);
    wide.render(normal.rc);
    expect(wide.list.maxVisible).toBe(0);
    expect(wide.list.items.find((i) => i.id === 'home')?.value).toContain(teams[0]!.city.toUpperCase());
  });

  it('cycles fields, keeps the teams distinct and starts with a full setup', () => {
    const onStart = vi.fn();
    const ui = makeUi();
    const screen = new QuickGameSetupScreen({ onStart, league, seed: () => 99, mode: 'watch' });
    ui.stack.push(screen);
    expect(screen.choice.side).toBe('watch');
    expect(screen.choice.homeAbbr).toBe(teams[0]!.abbr);
    screen.change('home', 1);
    expect(screen.choice.homeAbbr).toBe(teams[1]!.abbr);
    expect(screen.choice.awayAbbr).not.toBe(screen.choice.homeAbbr);
    screen.change('side', 1);
    expect(screen.choice.side).toBe('home');
    screen.change('quarter', -1);
    expect(screen.choice.quarterMinutes).toBe(3);
    screen.change('difficulty', 1);
    expect(screen.choice.difficulty).toBe('allPro');
    screen.change('defense', 1);
    expect(screen.choice.defenseMode).toBe('watch');
    screen.update(1 / 60, makeInput({ pressed: ['menuUp'] }), ui.services);
    expect(screen.list.selected?.id).toBe('start');
    screen.update(1 / 60, makeInput({ pressed: ['confirm'] }), ui.services);
    expect(onStart).toHaveBeenCalledTimes(1);
    const setup = onStart.mock.calls[0]![0];
    expect(setup.seed).toBe(99);
    expect(setup.home.team.abbr).toBe(teams[1]!.abbr);
    expect(setup.ruleset.quarterLengthSec).toBe(180);
    expect(ui.settings.defenseMode).toBe('watch');
    screen.render(ui.rc);
    expect(ui.ctx.fills.length).toBeGreaterThan(200);
    screen.update(1 / 60, makeInput({ pressed: ['back'] }), ui.services);
    expect(ui.stack.size).toBe(0);
  });
});

describe('overtime length follows the quarter length (H2-11)', () => {
  it('scales the overtime period with the chosen quarters, keeping the ruleset ratio', async () => {
    const { withQuarterLength } = await import('@/ui/gameplay-prefs');
    const { getRuleset } = await import('@/game/rulesets');
    const sim = getRuleset('simulation');
    const one = withQuarterLength(sim, 1);
    expect(one.quarterLengthSec).toBe(60);
    expect(one.overtimeLengthSec).toBe(Math.round((60 * sim.overtimeLengthSec) / sim.quarterLengthSec));
    expect(one.overtimeLengthSec).toBeLessThan(sim.overtimeLengthSec);
    expect(withQuarterLength(sim, sim.quarterLengthSec / 60).overtimeLengthSec).toBe(sim.overtimeLengthSec);
  });
});

describe('team card helmets', () => {
  it('turn the two helmets toward each other (away card on the left looks right)', () => {
    expect(portraitFacing('AWAY')).toBe('se');
    expect(portraitFacing('HOME')).toBe('sw');
  });
});
