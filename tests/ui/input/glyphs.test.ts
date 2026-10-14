import { describe, expect, it } from 'vitest';
import { actionGlyph, buttonGlyph, keyCodeGlyph, keyboardGlyphFor, mouseGlyphFor, GAMEPAD_GLYPHS, TOUCH_GLYPHS } from '@/ui/input/glyphs';
import { BUTTONS, loadDefaultProfile, rebind } from '@/ui/input/schemes';

describe('glyphs', () => {
  it('labels key codes', () => {
    expect(keyCodeGlyph('KeyW')).toBe('W');
    expect(keyCodeGlyph('Digit3')).toBe('3');
    expect(keyCodeGlyph('Numpad5')).toBe('Num 5');
    expect(keyCodeGlyph('Space')).toBe('Space');
    expect(keyCodeGlyph('ArrowUp')).toBe('↑');
    expect(keyCodeGlyph('ShiftLeft')).toBe('Shift');
    expect(keyCodeGlyph('Escape')).toBe('Esc');
    expect(keyCodeGlyph('F5')).toBe('F5');
    expect(keyCodeGlyph('Unidentified')).toBe('Unidentified');
  });

  it('has a label for every button on every device', () => {
    const map = loadDefaultProfile().deviceMap;
    for (const b of BUTTONS) {
      expect(GAMEPAD_GLYPHS[b].length).toBeGreaterThan(0);
      expect(TOUCH_GLYPHS[b].length).toBeGreaterThan(0);
      expect(buttonGlyph('keyboard', b, map).length).toBeGreaterThan(0);
      expect(buttonGlyph('mouse', b, map).length).toBeGreaterThan(0);
    }
    expect(keyboardGlyphFor({ KeyZ: 'a' }, 'b')).toBeNull();
    expect(mouseGlyphFor({ 2: 'b' }, 'b')).toBe('RMB');
    expect(mouseGlyphFor({ 2: 'b' }, 'a')).toBeNull();
  });

  it('picks the first bound button the device can produce', () => {
    const { scheme, deviceMap } = loadDefaultProfile();
    expect(actionGlyph('keyboard', 'back', scheme, deviceMap)).toBe('L');
    expect(actionGlyph('mouse', 'back', scheme, deviceMap)).toBe('RMB');
    expect(actionGlyph('gamepad', 'back', scheme, deviceMap)).toBe('B');
    expect(actionGlyph('touch', 'back', scheme, deviceMap)).toBe('Tap B');
    expect(actionGlyph('touch', 'switchPlayer', scheme, deviceMap)).toBe('Tap');
    expect(actionGlyph('touch', 'moveUp', scheme, deviceMap)).toBe('Stick ↑');
    const noKeys = rebind(scheme, 'confirm', ['a']);
    const map = { ...deviceMap, keyboard: { KeyW: 'up' as const } };
    expect(actionGlyph('keyboard', 'confirm', noKeys, map)).toBe('LMB');
    expect(actionGlyph('keyboard', 'sprint', noKeys, map)).toBe('RT');
    expect(actionGlyph('mouse', 'moveUp', scheme, deviceMap)).toBe('W');
  });
});
