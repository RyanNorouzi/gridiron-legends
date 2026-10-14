import { describe, expect, it } from 'vitest';
import type { GameSetup } from '@/game/types';
import { createHeadlessServices } from '@/ui/franchise/context';
import {
  applyBase, buildCustomGameSetup, changeCustom, customGameItems, CustomGameScreen, defaultCustomChoice, type CustomGameChoice,
} from '@/ui/screens/custom-game';
import { quickGameLeague, sortedTeams } from '@/ui/screens/quick-game-setup';
import { makeInput } from '../../render/fake-ctx';
import { rcFor } from './helpers';

const league = quickGameLeague(7);
const teams = sortedTeams(league);
const abbrs = teams.map((t) => t.abbr);

describe('custom game model', () => {
  it('exposes every rule and copies it into the GameSetup', () => {
    let c: CustomGameChoice = defaultCustomChoice(teams);
    expect(customGameItems(c, (a) => a).map((i) => i.id)).toEqual([
      'awayAbbr', 'homeAbbr', 'away', 'home', 'difficulty', 'base', 'quarterMinutes', 'playClockSec', 'penalties', 'penaltyFrequency',
      'injuries', 'fatigue', 'overtime', 'challenges', 'twoMinuteWarning', 'weather', 'defenseMode', 'start',
    ]);
    c = changeCustom(c, 'quarterMinutes', 1, abbrs);
    c = changeCustom(c, 'playClockSec', -1, abbrs);
    c = changeCustom(c, 'penaltyFrequency', 2, abbrs);
    c = changeCustom(c, 'injuries', 1, abbrs);
    c = changeCustom(c, 'fatigue', 1, abbrs);
    c = changeCustom(c, 'overtime', 1, abbrs);
    c = changeCustom(c, 'challenges', 1, abbrs);
    c = changeCustom(c, 'twoMinuteWarning', 1, abbrs);
    c = changeCustom(c, 'weather', 3, abbrs);
    c = changeCustom(c, 'difficulty', 1, abbrs);
    c = { ...c, seed: 99 };
    const setup: GameSetup = buildCustomGameSetup(league, c);
    const r = setup.ruleset;
    expect(r.quarterLengthSec).toBe(c.quarterMinutes * 60);
    expect(r.playClockSec).toBe(c.playClockSec);
    expect(r.penalties).toBe(true);
    expect(r.penaltyFrequency).toBe(c.penaltyFrequency);
    expect(r.injuries).toBe(c.injuries);
    expect(r.fatigue).toBe(c.fatigue);
    expect(r.overtime).toBe(c.overtime);
    expect(r.challenges).toBe(c.challenges > 0);
    expect(r.challengesPerGame).toBe(c.challenges);
    expect(r.twoMinuteWarning).toBe(c.twoMinuteWarning);
    expect(setup.difficulty.id).toBe(c.difficulty);
    expect(setup.weather.type === c.weather || setup.stadium.roof === 'dome').toBe(true);
    expect(setup.controllers).toEqual({ home: 'human', away: 'ai' });
    expect(setup.userSide).toBe('home');
    expect(setup.home.team.abbr).toBe(c.homeAbbr);
    // 1-minute quarters get a short overtime too (H2-11), not the ruleset's default period.
    const short = buildCustomGameSetup(league, { ...c, quarterMinutes: 1 }).ruleset;
    expect(short.quarterLengthSec).toBe(60);
    expect(short.overtimeLengthSec).toBeLessThanOrEqual(90);
    const off = buildCustomGameSetup(league, changeCustom(c, 'penalties', 1, abbrs));
    expect(off.ruleset.penalties).toBe(false);
    expect(off.ruleset.penaltyFrequency).toBe(0);
  });

  it('keeps at most one human or watched side and resets rules from a base', () => {
    let c = defaultCustomChoice(teams);
    c = changeCustom(c, 'away', 1, abbrs);
    expect(c.away).toBe('watch');
    expect(c.home).toBe('ai');
    let s = buildCustomGameSetup(league, { ...c, seed: 3 });
    expect(s.userSide).toBe('away');
    expect(s.controllers).toEqual({ home: 'ai', away: 'watch' });
    c = changeCustom(c, 'away', 1, abbrs);
    expect(c.away).toBe('human');
    c = changeCustom(c, 'away', 1, abbrs);
    s = buildCustomGameSetup(league, { ...c, seed: 3 });
    expect(s.userSide).toBeNull();
    expect(s.controllers).toEqual({ home: 'ai', away: 'ai' });
    const arcade = applyBase(c, 'arcade');
    expect(arcade.penalties).toBe(false);
    expect(arcade.challenges).toBe(0);
    expect(changeCustom(c, 'base', 1, abbrs).base).toBe('arcade');
    const homeFirst = changeCustom({ ...c, homeAbbr: abbrs[0] ?? '', awayAbbr: abbrs[1] ?? '' }, 'homeAbbr', 1, abbrs);
    expect(homeFirst.homeAbbr).not.toBe(homeFirst.awayAbbr);
  });
});

describe('CustomGameScreen', () => {
  it('changes values with every input and starts the game', () => {
    for (const large of [false, true]) {
      const services = createHeadlessServices(large ? { textSize: 'large' } : {});
      const started: GameSetup[] = [];
      const screen = new CustomGameScreen({ league, seed: () => 1234, onStart: (setup) => started.push(setup) });
      services.stack.push(screen);
      screen.render(rcFor(services));
      const quarter = screen.list.items.findIndex((i) => i.id === 'quarterMinutes');
      screen.list.select(quarter);
      const before = screen.choice.quarterMinutes;
      services.stack.update(1 / 60, makeInput({ pressed: ['menuRight'] }));
      expect(screen.choice.quarterMinutes).toBeGreaterThan(before);
      services.stack.update(1 / 60, makeInput({ pressed: ['confirm'] }));
      screen.list.select(screen.list.items.findIndex((i) => i.id === 'start'));
      services.stack.update(1 / 60, makeInput({ pressed: ['confirm'] }));
      expect(started).toHaveLength(1);
      expect(started[0]?.seed).toBe(1234);
      expect(started[0]?.ruleset.quarterLengthSec).toBe(screen.choice.quarterMinutes * 60);
      screen.render(rcFor(services));
      services.stack.update(1 / 60, makeInput({ pressed: ['back'] }));
      expect(services.stack.size).toBe(0);
    }
  });
});
