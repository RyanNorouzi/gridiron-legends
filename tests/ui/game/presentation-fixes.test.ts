import { describe, expect, it, vi } from 'vitest';
import type { PenaltyInfo } from '@/game/play-events';
import { outcomeAt } from '@/game/outcome-factory';
import type { PlayContext, PlayOutcome } from '@/game/play-types';
import { cleanPbpLine, generatedPbp, penaltyAcceptText, playCaption } from '@/ui/game/session-flow';
import { nullifyingFoul } from '@/ui/game/highlights';
import { GameScreen } from '@/ui/screens/game';
import { PromptScreen } from '@/ui/screens/watch';
import { fitHints } from '@/ui/widgets/panel';
import { createTheme } from '@/ui/theme';
import { defaultSettings } from '@/save/settings-store';
import { makeInput } from '../render/fake-ctx';
import { autoplay, baseScript, makeSession, makeUi } from './fixtures';

const human = { controllers: { home: 'human', away: 'ai' } as const, userSide: 'home' as const };

const dpi = (over: Partial<PenaltyInfo> = {}): PenaltyInfo => ({
  foul: 'passInterferenceDefense', side: 'defense', yards: 0, playerId: null, automaticFirstDown: true, lossOfDown: false,
  enforcement: 'spotOfFoul', spotBallOn: 88, deadBall: false, replayDown: true, accepted: false, ...over,
});

describe('penalty accept wording', () => {
  it('a spot foul with an automatic first down names the spot and never also says "replay the down"', () => {
    const text = penaltyAcceptText(dpi());
    expect(text).toBe('ball placed at the OPP 12, the spot of the foul, automatic first down');
    expect(text).not.toContain('0 yards');
    expect(text).not.toContain('replay');
  });

  it('keeps the yardage and down wording for ordinary fouls', () => {
    expect(penaltyAcceptText(dpi({ foul: 'holdingOffense', side: 'offense', yards: 10, automaticFirstDown: false, enforcement: 'previousSpot', spotBallOn: null })))
      .toBe('10 yards from the previous spot, replay the down');
    expect(penaltyAcceptText(dpi({ foul: 'intentionalGrounding', side: 'offense', yards: 10, automaticFirstDown: false, lossOfDown: true, spotBallOn: 30 })))
      .toBe('10 yards from the spot of the foul (OWN 30), loss of down');
  });

  it('a kick-return foul keeps the ball with the receivers and adds to the play instead of wiping it out', () => {
    const hold = dpi({ foul: 'holdingOffense', side: 'defense', yards: 10, automaticFirstDown: false, replayDown: false, spotBallOn: 70, accepted: true });
    expect(penaltyAcceptText(hold, false, true)).toBe('10 yards from the spot of the foul (OPP 30), receiving team keeps the ball');
    const o = outcomeAt(35, { result: 'kickoff', kickDistance: 60, returnYards: 30, endBallOn: 65, penalties: [hold] });
    expect(nullifyingFoul(o)).toBeNull();
    expect(nullifyingFoul({ ...o, result: 'run' })).not.toBeNull();
  });
});

describe('play-by-play text', () => {
  it('rounds raw decimals and spells out camelCase identifiers', () => {
    expect(cleanPbpLine('44.218837173389105-yard fieldGoal is GOOD')).toBe('44-yard field goal is GOOD');
    expect(cleanPbpLine('Ball dead at the BAL 21 (kickMade), no gain.')).toBe('Ball dead at the BAL 21 (kick good), no gain.');
  });

  it('the post-play caption describes the play, not just "First down."', () => {
    const script = (ctx: PlayContext): PlayOutcome => (ctx.special === 'none'
      ? outcomeAt(ctx.ballOn, { result: 'run', yards: 12, firstDown: true, timeElapsed: 6, playByPlay: ['1st & 10 — run', 'Tackled, gain of 12.', 'First down.'] }, ctx.offense)
      : baseScript(ctx));
    const f = makeSession({ setup: { ...human, seed: 7 }, script });
    autoplay(f.session, { until: (s) => s.stage.kind === 'postPlay' && s.stage.summary.outcome.result === 'run', coinToss: 'receive' });
    const stage = f.session.stage;
    if (stage.kind !== 'postPlay') throw new Error('expected postPlay');
    const caption = playCaption(f.setup, stage.summary);
    expect(caption).not.toBe('First down.');
    expect(caption).toMatch(/12 yards, first down\.$/);
  });

  it('a play wiped out by an accepted foul says so instead of reading as a real turnover', () => {
    const f = makeSession({ setup: { ...human, seed: 7 } });
    autoplay(f.session, { until: (s) => s.stage.kind === 'postPlay' && s.stage.summary.outcome.result !== 'kickoff', coinToss: 'receive' });
    const stage = f.session.stage;
    if (stage.kind !== 'postPlay') throw new Error('expected postPlay');
    const e = stage.summary.entry;
    const rough = dpi({ foul: 'roughingPasser', yards: 15, enforcement: 'previousSpot', spotBallOn: null, replayDown: false, accepted: true });
    const wiped = generatedPbp(f.setup, { ...e, outcome: { ...e.outcome, result: 'interception', turnover: false, firstDown: true, penalties: [rough] } });
    const def = f.setup[e.possession === 'home' ? 'away' : 'home'].team.abbr;
    expect(wiped).toMatch(new RegExp(`intercepted.*, wiped out by roughing the passer on ${def}, first down\\.$`, 'i'));
    const late = generatedPbp(f.setup, { ...e, outcome: { ...e.outcome, penalties: [{ ...rough, foul: 'unnecessaryRoughness', enforcement: 'endOfPlay' }] } });
    expect(late).toContain(`plus unnecessary roughness on ${def}`);
  });
});

describe('game screen banners and caption', () => {
  it('drops banners left over from the previous play at the next snap', () => {
    const ui = makeUi();
    const f = makeSession({ setup: { ...human, seed: 7 } });
    const screen = new GameScreen(f.session, { onQuit: vi.fn(), onPlayAgain: vi.fn() });
    ui.stack.push(screen);
    autoplay(f.session, { until: (s) => s.stage.kind === 'postPlay' && s.stage.summary.outcome.result !== 'kickoff', coinToss: 'receive' });
    screen.bannerQueue.push({ text: 'SACK', sub: '-4 YDS', tone: 'bad' });
    screen.bannerQueue.push({ text: 'FIRST DOWN', sub: 'HOM', tone: 'good' });
    expect(screen.caption).toMatch(/^\(|: /);
    autoplay(f.session, { until: (s) => s.stage.kind === 'live' });
    expect(screen.bannerQueue.current).toBeNull();
  });

  it('watch mode prompts answer themselves after a countdown', () => {
    const onChoose = vi.fn();
    const prompt = new PromptScreen({ title: '3RD & 7', choices: [{ id: 'yes', label: 'YES' }, { id: 'simulate', label: 'SIMULATE' }], timeoutChoice: 'simulate', timeoutSeconds: 1, onChoose });
    const ui = makeUi();
    ui.stack.push(prompt);
    for (let i = 0; i < 30; i++) ui.stack.update(1 / 60, makeInput());
    expect(onChoose).not.toHaveBeenCalled();
    expect(prompt.remaining).toBeGreaterThan(0);
    for (let i = 0; i < 40; i++) ui.stack.update(1 / 60, makeInput());
    expect(onChoose).toHaveBeenCalledWith('simulate');
  });
});

describe('large text hint bars', () => {
  it('drop trailing hints instead of running off the left edge', () => {
    const theme = createTheme({ ...defaultSettings(), textSize: 'large' });
    const hints = [
      { glyph: 'SPACE', label: 'CALL' }, { glyph: 'Q E', label: 'TABS' }, { glyph: 'C', label: 'TIMEOUT' }, { glyph: '★', label: 'COACH PICK' }, { glyph: 'J', label: 'ASSIGN' },
    ];
    const shown = fitHints(theme, hints, 480);
    expect(shown.length).toBeGreaterThan(0);
    expect(shown.length).toBeLessThan(hints.length);
    expect(shown[0]?.label).toBe('CALL');
  });
});
