import { describe, expect, it } from 'vitest';
import { validateLeague } from '@/franchise/league';
import { createTestFranchiseContext } from '@/ui/franchise/context';
import { LeagueRulesScreen } from '@/ui/franchise/shell/league-rules-screen';
import { choiceFromLeague, withGameRules } from '@/ui/franchise/shell/league-setup-model';
import { leagueAt, rcFor } from './helpers';

describe('league rules after creation', () => {
  it('switch play style, difficulty and rule switches of a running league', () => {
    const league = leagueAt(91, 'regularSeason');
    const fc = createTestFranchiseContext(league);
    const screen = new LeagueRulesScreen(fc);
    fc.push(screen);
    const before = choiceFromLeague(league.settings);
    expect(screen.list.items.map((i) => i.id)).toEqual(['difficulty', 'ruleset', 'quarter', 'penalties', 'challenges', 'injuries', 'fatigue', 'weather', 'save', 'back']);
    screen.change('ruleset', 1);
    screen.change('difficulty', -1);
    screen.change('injuries', 1);
    screen.change('cap', 1); // not editable here: ignored
    screen.render(rcFor(fc.services));
    screen.save();
    const after = fc.league().settings;
    expect(fc.commits.at(-1)?.reason).toBe('settings');
    expect(after.ruleset.mode).not.toBe(league.settings.ruleset.mode);
    expect(after.difficulty.id).not.toBe(before.difficulty);
    expect(after.injuriesEnabled).toBe(!before.injuries);
    expect(after.ruleset.injuries).toBe(after.injuriesEnabled);
    expect(after.salaryCap).toBe(league.settings.salaryCap);
    expect(after.playoff).toEqual(league.settings.playoff);
    expect(validateLeague(fc.league())).toEqual([]);
  });

  it('keeps a custom-tuned difficulty while its preset is unchanged', () => {
    const league = leagueAt(91, 'regularSeason');
    const tuned = { ...league, settings: { ...league.settings, difficulty: { ...league.settings.difficulty, name: 'Pro (Custom)', userPassAssist: 0.9 } } };
    const same = withGameRules(tuned, choiceFromLeague(tuned.settings));
    expect(same.settings.difficulty.userPassAssist).toBe(0.9);
  });
});
