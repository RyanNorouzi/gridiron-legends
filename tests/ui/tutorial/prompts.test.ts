import { describe, expect, it } from 'vitest';
import { createNullInput } from '@/ui/app';
import type { Action, InputManager, InputState } from '@/ui/input/types';
import { formatPrompt, isPromptToken, moveGlyph, promptTokens } from '@/ui/tutorial/prompts';
import { TUTORIAL_STEPS } from '@/ui/tutorial/steps';
import { makeInput } from '../render/fake-ctx';

/** An injected InputManager whose glyphs name the device and action, e.g. "pad:snap". */
const inputOn = (device: InputState['lastDevice'], table: Partial<Record<Action, string>> = {}): InputManager => {
  const state = makeInput({ device });
  return { ...createNullInput(), state: () => state, glyph: (a) => table[a] ?? `${device}:${a}` };
};

describe('tutorial prompt glyphs', () => {
  it('substitutes each {action} with the glyph from the injected InputManager', () => {
    const pad = inputOn('gamepad', { snap: 'A', throw1: 'A', throw2: 'B' });
    expect(formatPrompt('Press {snap} to snap, {throw1} for the primary.', pad)).toBe('Press [A] to snap, [A] for the primary.');
    const keys = inputOn('keyboard', { snap: 'Space' });
    expect(formatPrompt('Press {snap}', keys)).toBe('Press [Space]');
    const touch = inputOn('touch', { tackle: 'Tap A' });
    expect(formatPrompt('{tackle} to wrap up', touch)).toBe('[Tap A] to wrap up');
    expect(formatPrompt('{notAnAction} stays', pad)).toBe('{notAnAction} stays');
  });

  it('{move} names the movement control for the device', () => {
    const letters: Partial<Record<Action, string>> = { moveUp: 'W', moveLeft: 'A', moveDown: 'S', moveRight: 'D' };
    expect(formatPrompt('Move with {move}', inputOn('keyboard', letters))).toBe('Move with [WASD]');
    expect(formatPrompt('Move with {move}', inputOn('gamepad'))).toBe('Move with [L-STICK]');
    expect(formatPrompt('Move with {move}', inputOn('touch'))).toBe('Move with [STICK]');
    expect(moveGlyph('keyboard', (a) => (a === 'moveUp' ? 'Up' : 'X'))).toBe('Up X X X');
  });

  it('every token used by the tutorial script is a real action (or move)', () => {
    const texts = TUTORIAL_STEPS.flatMap((s) => (s.kind === 'interactive' ? [...s.lines, s.retry, s.success] : s.pages.flatMap((p) => [p.heading, ...p.lines])));
    const tokens = texts.flatMap(promptTokens);
    expect(tokens.length).toBeGreaterThan(20);
    for (const t of tokens) expect(isPromptToken(t), t).toBe(true);
    expect(tokens).toEqual(expect.arrayContaining(['move', 'snap', 'throw1', 'jumpSwat', 'tackle', 'switchPlayer', 'callTimeout', 'showPlayArt']));
  });
});
