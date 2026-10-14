import { describe, expect, it, vi } from 'vitest';
import { defaultCoach, type CoachHooks } from '@/game/rules';
import { getDifficulty } from '@/game/rulesets';
import type { GameState } from '@/game/types';
import { aiCoachHooks } from '@/ui/game/playcaller-ai';
import { coachHooksFor, createDefaultPlaycaller } from '@/ui/game/playcaller';
import { GameScreen } from '@/ui/screens/game';
import { PlayCallScreen } from '@/ui/screens/playcall';
import { PromptScreen } from '@/ui/screens/watch';
import { makeInput } from '../render/fake-ctx';
import { makeSetup } from '../../game/fixtures';
import { autoplay, makeSession, makeUi } from './fixtures';

const human = { controllers: { home: 'human', away: 'ai' } as const, userSide: 'home' as const };

describe('NO HUDDLE on the offensive play call', () => {
  it('the showPlayArt button toggles it on scrimmage downs and the call carries hurryUp', () => {
    const f = makeSession({ setup: { ...human, seed: 7 } });
    autoplay(f.session, { until: (s) => s.stage.kind === 'playcall' && s.stage.request.unit === 'offense' && s.stage.request.situation.kind === 'scrimmage', coinToss: 'receive' });
    const stage = f.session.stage;
    if (stage.kind !== 'playcall') throw new Error('expected playcall');
    const ui = makeUi();
    const onCall = vi.fn();
    const screen = new PlayCallScreen(stage.request, f.session.registry, { onCall });
    ui.stack.push(screen);
    expect(screen.canHurryUp).toBe(true);
    expect(screen.hurryUp).toBe(false);
    screen.update(1 / 60, makeInput({ pressed: ['showPlayArt'] }), ui.services);
    expect(screen.hurryUp).toBe(true);
    screen.render(ui.rc);
    screen.activate('pass-curl');
    expect(onCall).toHaveBeenCalledWith({ offensivePlayId: 'pass-curl', hurryUp: true });
  });

  it('is not offered on kickoffs and never sent when off', () => {
    const f = makeSession({ setup: { ...human, seed: 7 } });
    autoplay(f.session, { until: (s) => s.stage.kind === 'playcall' && s.stage.request.unit === 'offense' && s.stage.request.situation.kind === 'kickoff', coinToss: 'kick' });
    const stage = f.session.stage;
    if (stage.kind !== 'playcall') throw new Error('expected playcall');
    const onCall = vi.fn();
    const screen = new PlayCallScreen(stage.request, f.session.registry, { onCall, defaultHurryUp: true });
    expect(screen.canHurryUp).toBe(false);
    expect(screen.toggleHurryUp()).toBe(false);
    expect(screen.hurryUp).toBe(false);
    screen.activate('special:kickoff');
    expect(onCall.mock.calls[0]?.[0]).not.toHaveProperty('hurryUp');
  });

  it('GameScreen keeps NO HUDDLE on for the next snap of the drive and the engine gets the hurry-up context', () => {
    const ui = makeUi();
    const f = makeSession({ setup: { ...human, seed: 7 } });
    const screen = new GameScreen(f.session, { onQuit: vi.fn(), onPlayAgain: vi.fn() });
    ui.stack.push(screen);
    const step = (): void => ui.stack.update(1 / 60, makeInput());
    const nextOffenseCall = (): PlayCallScreen => {
      for (let i = 0; i < 2000; i++) {
        const top = ui.stack.top;
        if (top instanceof PromptScreen) {
          const ids = top.list.items.map((it) => it.id);
          top.choose(ids.includes('receive') ? 'receive' : ids[0] ?? '');
        } else if (top instanceof PlayCallScreen) {
          if (top.request.unit === 'offense' && top.request.situation.kind === 'scrimmage') return top;
          top.activate(top.list.items.find((it) => it.id !== '__control')?.id ?? '');
        } else if (f.session.stage.kind === 'postPlay') ui.stack.update(1 / 60, makeInput({ pressed: ['confirm'] }));
        step();
      }
      throw new Error('no offensive play call');
    };
    const first = nextOffenseCall();
    first.update(1 / 60, makeInput({ pressed: ['showPlayArt'] }), ui.services);
    first.activate('run-inside');
    expect(f.plays[f.plays.length - 1]?.ctx.hurryUp).toBe(true);
    // play the snap out, then the next offensive call on the same drive starts with NO HUDDLE on
    const second = nextOffenseCall();
    if (second.request.side === first.request.side) expect(second.hurryUp).toBe(true);
  });
});

describe('coach hook adapters forward the no-huddle hook', () => {
  // The AI coach reads its side's difficulty (clock management) from the controllers and the game's profile.
  const state = {
    clock: { quarter: 4, secondsRemaining: 90 }, score: { home: 7, away: 14 }, overtime: null, controllers: { home: 'ai', away: 'ai' }, difficulty: getDifficulty('pro'),
  } as unknown as GameState;

  it('coachHooksFor routes hurryUp through the per-side coach', () => {
    const setup = makeSetup();
    const perSide = (side: 'home' | 'away'): Partial<CoachHooks> => ({ hurryUp: () => side === 'home' });
    const hooks = coachHooksFor(createDefaultPlaycaller(), setup, perSide);
    expect(hooks.hurryUp?.(state, 'home')).toBe(true);
    expect(hooks.hurryUp?.(state, 'away')).toBe(false);
    // without per-side hooks the default two-minute rule applies (trailing late in Q4)
    expect(coachHooksFor(createDefaultPlaycaller(), setup).hurryUp?.(state, 'home')).toBe(defaultCoach.hurryUp?.(state, 'home'));
    expect(defaultCoach.hurryUp?.(state, 'home')).toBe(true);
  });

  it('aiCoachHooks exposes each coach\'s hurry-up call', () => {
    const hooks = aiCoachHooks(makeSetup());
    expect(typeof hooks.hurryUp).toBe('function');
    expect(hooks.hurryUp?.(state, 'home')).toBe(true);
  });
});

describe('the coach pick on 4th down', () => {
  it('is the punt on 4th & long deep in your own end and the field goal in range, marked on the SPECIAL tab', async () => {
    const { buildPlaycallRequest } = await import('@/ui/game/session-flow');
    const { situation } = await import('../../game/fixtures');
    const { createRng } = await import('@/core/rng');
    const f = makeSession({ setup: { ...human, seed: 7 } });
    const setup = f.setup;
    const clock = { quarter: 1, secondsRemaining: 200, running: false, playClock: 40, playClockRunning: false };
    const deep = situation(setup, { possession: 'home', down: 4, distance: 16, ballOn: 19, clock });
    const req = buildPlaycallRequest(deep, setup, 'home', createDefaultPlaycaller(), f.session.registry, createRng(1));
    expect(req.suggestion).toBe('special:punt');
    // out of range: neither the field goal nor its fake is offered
    expect(req.special.map((o) => o.id)).not.toEqual(expect.arrayContaining(['fieldGoal']));
    expect(req.special.map((o) => o.id)).not.toContain('fakeFieldGoal');
    const screen = new PlayCallScreen(req, f.session.registry, { onCall: vi.fn() });
    expect(screen.tab.id).toBe('__special');
    expect(screen.list.selected?.id).toBe('special:punt');
    expect(screen.list.selected?.label.startsWith('★')).toBe(true);
    const close = situation(setup, { possession: 'home', down: 4, distance: 8, ballOn: 80, clock });
    expect(buildPlaycallRequest(close, setup, 'home', createDefaultPlaycaller(), f.session.registry, createRng(1)).suggestion).toBe('special:fieldGoal');
    const third = situation(setup, { possession: 'home', down: 3, distance: 16, ballOn: 19, clock });
    expect(buildPlaycallRequest(third, setup, 'home', createDefaultPlaycaller(), f.session.registry, createRng(1)).suggestion).not.toMatch(/^special:/);
  });
});
