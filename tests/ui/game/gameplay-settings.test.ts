import { describe, expect, it } from 'vitest';
import { getDifficulty } from '@/game/rulesets';
import { createMemoryStorage } from '@/save/storage';
import { createGameplayStore, defaultGameplay, gameplayRules, parseGameplay, tunedDifficulty } from '@/ui/gameplay-prefs';
import { buildQuickGameSetup, quickGameLeague, QuickGameSetupScreen } from '@/ui/screens/quick-game-setup';
import { CAMERA_LABELS, SettingsScreen } from '@/ui/screens/settings';
import { DifficultyTuningScreen } from '@/ui/screens/difficulty-tuning';
import { makeInput } from '../render/fake-ctx';
import { makeUi } from './fixtures';

describe('gameplay preferences', () => {
  it('parse leniently and round-trip through the store', async () => {
    expect(parseGameplay({ ruleset: 'bogus', difficulty: 'nope', quarterMinutes: 7, tweaks: { passAssist: 9, aiReaction: 'x' } })).toEqual({ ...defaultGameplay(), tweaks: { passAssist: 2 } });
    const store = createGameplayStore(createMemoryStorage());
    const prefs = { ...defaultGameplay(), ruleset: 'arcade' as const, difficulty: 'legend' as const, penalties: false, tweaks: { aiSmarts: -1 } };
    await store.save(prefs);
    expect(await store.load()).toEqual(prefs);
  });

  it('tune individual difficulty knobs away from the preset', () => {
    const pro = getDifficulty('pro');
    const tuned = tunedDifficulty(pro, { passAssist: 2, aiReaction: 1 });
    expect(tuned.userPassAssist).toBeCloseTo(0.8, 5);
    expect(tuned.aiReactionDelay).toBeCloseTo(0.24, 5);
    expect(tuned.pursuitQuality).toBe(pro.pursuitQuality);
    expect(tuned.name).toBe('Pro (Custom)');
    expect(tunedDifficulty(pro, {}).name).toBe('Pro');
    const { ruleset, difficulty } = gameplayRules({ ...defaultGameplay(), ruleset: 'arcade', quarterMinutes: 3, penalties: false, injuries: false, tweaks: { tackleAssist: -2 } });
    expect(ruleset.mode).toBe('arcade');
    expect(ruleset.quarterLengthSec).toBe(180);
    expect(ruleset.penalties).toBe(false);
    expect(ruleset.injuries).toBe(false);
    expect(difficulty.userTackleAssist).toBeCloseTo(0.2, 5);
  });

  it('the Settings screen edits them, and quick games start from them', () => {
    const ui = makeUi();
    const gameplay = defaultGameplay();
    let saved = 0;
    ui.services.gameplay = gameplay;
    ui.services.persistGameplay = () => { saved++; };
    const screen = new SettingsScreen(ui.settings);
    ui.stack.push(screen);
    screen.change('gp:ruleset', 1);
    screen.change('gp:difficulty', 1);
    screen.change('gp:penalties', 1);
    expect(gameplay).toMatchObject({ ruleset: 'arcade', difficulty: 'allPro', penalties: false });
    expect(saved).toBe(3);
    screen.activate('tuning');
    const tuning = ui.stack.top;
    if (!(tuning instanceof DifficultyTuningScreen)) throw new Error('expected the tuning screen');
    tuning.change('passAssist', 1);
    tuning.render(ui.rc);
    expect(gameplay.tweaks.passAssist).toBe(1);
    ui.stack.update(1 / 60, makeInput({ pressed: ['back'] }));
    expect(screen.list.items.find((i) => i.id === 'gp:difficulty')?.value).toBe('ALL-PRO (CUSTOM)');
    screen.change('animations', 1);
    screen.change('playbookComplexity', 1);
    expect(ui.settings.animations).toBe(false);
    expect(ui.settings.playbookComplexity).toBe('advanced');
    // Camera values read as words, never the raw enum id.
    screen.change('camera:watch', 1);
    screen.change('camera:watch', 1);
    screen.change('camera:watch', 1);
    expect(screen.list.items.find((i) => i.id === 'camera:watch')?.value).toBe('FOLLOW PLAYER');
    expect(Object.values(CAMERA_LABELS)).not.toContain('PLAYERFOLLOW');

    const setupScreen = new QuickGameSetupScreen({ onStart: () => undefined, league: quickGameLeague(7) });
    ui.stack.push(setupScreen);
    expect(setupScreen.choice).toMatchObject({ ruleset: 'arcade', difficulty: 'allPro' });
    const setup = buildQuickGameSetup(quickGameLeague(7), { ...setupScreen.choice, homeAbbr: setupScreen.choice.homeAbbr, awayAbbr: setupScreen.choice.awayAbbr });
    expect(setup.ruleset.penalties).toBe(false);
    expect(setup.difficulty.userPassAssist).toBeGreaterThan(getDifficulty('allPro').userPassAssist);
  });

  it('setup screens start with the start button from any row, and confirm on a value row only changes it', () => {
    const ui = makeUi();
    let started = 0;
    const screen = new QuickGameSetupScreen({ onStart: () => { started++; }, league: quickGameLeague(7), seed: () => 3 });
    ui.stack.push(screen);
    const home = screen.choice.homeAbbr;
    ui.stack.update(1 / 60, makeInput({ pressed: ['confirm'] }));
    expect(started).toBe(0);
    expect(screen.choice.homeAbbr).not.toBe(home);
    ui.stack.update(1 / 60, makeInput({ pressed: ['pause'] }));
    expect(started).toBe(1);
  });
});
