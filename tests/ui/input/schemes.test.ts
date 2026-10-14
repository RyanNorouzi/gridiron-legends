import { describe, expect, it } from 'vitest';
import {
  ACTIONS, BUTTONS, actionsFor, isAction, isButton, keysFor, loadDefaultProfile, profileFromSettings, profileToSettings,
  rebind, schemeToSettings, settingsToKeyboardMap, settingsToScheme, validateDeviceMap, validateKeyboardMap, validateScheme,
} from '@/ui/input/schemes';
import { DEFAULT_SETTINGS } from '@/core/settings';

describe('default control profile', () => {
  it('validates and binds at least one button to every action', () => {
    const profile = loadDefaultProfile();
    expect(profile.version).toBe(1);
    expect(ACTIONS.length).toBeGreaterThan(50);
    for (const action of ACTIONS) {
      expect(profile.scheme[action].length, action).toBeGreaterThan(0);
      for (const b of profile.scheme[action]) expect(isButton(b), `${action}: ${b}`).toBe(true);
    }
    expect(Object.keys(profile.scheme).sort()).toEqual([...ACTIONS].sort());
  });

  it('has the documented headline bindings', () => {
    const { scheme, deviceMap } = loadDefaultProfile();
    expect(scheme.confirm).toEqual(['a']);
    expect(scheme.snap).toEqual(['a']);
    expect(scheme.throw1).toEqual(['a']);
    expect(scheme.throw2).toEqual(['b']);
    expect(scheme.throw5).toEqual(['rb']);
    expect(scheme.sprint).toEqual(['rt']);
    expect(scheme.dive).toEqual(['lt']);
    expect(scheme.switchPlayer).toEqual(['b']);
    expect(scheme.tackle).toEqual(['a']);
    expect(scheme.hitStick).toEqual(['rb']);
    expect(scheme.strip).toEqual(['x']);
    expect(scheme.jumpSwat).toEqual(['y']);
    expect(scheme.strafe).toEqual(['lt']);
    expect(scheme.kick).toEqual(['a']);
    expect(scheme.pause).toEqual(['start']);
    expect(scheme.back).toContain('select');
    expect(scheme.moveUp).toEqual(['up']);
    expect(scheme.moveDown).toEqual(['down']);
    expect(scheme.moveLeft).toEqual(['left']);
    expect(scheme.moveRight).toEqual(['right']);
    expect(deviceMap.keyboard['KeyW']).toBe('up');
    expect(deviceMap.keyboard['ArrowDown']).toBe('down');
    expect(deviceMap.keyboard['Space']).toBe('a');
    expect(deviceMap.keyboard['ShiftLeft']).toBe('rt');
    expect(deviceMap.keyboard['Enter']).toBe('start');
    expect(deviceMap.keyboard['Escape']).toBe('select');
    expect([deviceMap.keyboard['Digit1'], deviceMap.keyboard['Digit2'], deviceMap.keyboard['Digit3'], deviceMap.keyboard['Digit4'], deviceMap.keyboard['Digit5']])
      .toEqual(['a', 'b', 'x', 'y', 'rb']);
    expect(deviceMap.mouse[0]).toBe('a');
    expect(deviceMap.mouse[2]).toBe('b');
    expect(deviceMap.gamepadDeadzone).toBeGreaterThan(0);
    expect(deviceMap.gamepadDeadzone).toBeLessThan(1);
  });

  it('every scheme button is reachable from the keyboard map', () => {
    const { scheme, deviceMap } = loadDefaultProfile();
    const reachable = new Set(Object.values(deviceMap.keyboard));
    for (const action of ACTIONS) {
      expect(scheme[action].some((b) => reachable.has(b)), `${action} unreachable on keyboard`).toBe(true);
    }
  });

  it('returns an independent copy each call', () => {
    const a = loadDefaultProfile();
    a.scheme.confirm.push('y');
    a.deviceMap.keyboard['KeyZ'] = 'a';
    const b = loadDefaultProfile();
    expect(b.scheme.confirm).toEqual(['a']);
    expect(b.deviceMap.keyboard['KeyZ']).toBeUndefined();
  });
});

describe('validateScheme', () => {
  it('rejects unknown actions and buttons with descriptive issues', () => {
    const base = loadDefaultProfile().scheme;
    const result = validateScheme({ ...schemeToSettings(base), fly: ['a'], juke: ['zz'] });
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.includes('unknown action "fly"'))).toBe(true);
    expect(result.issues.some((i) => i.includes('juke') && i.includes('"zz"'))).toBe(true);
  });

  it('reports missing actions when there is no fallback, and fills them from one', () => {
    const partial = { confirm: ['a'] };
    const strict = validateScheme(partial);
    expect(strict.ok).toBe(false);
    expect(strict.scheme).toBeNull();
    expect(strict.issues.filter((i) => i.endsWith('missing')).length).toBe(ACTIONS.length - 1);
    const lenient = validateScheme(partial, loadDefaultProfile().scheme);
    expect(lenient.ok).toBe(true);
    expect(lenient.scheme?.confirm).toEqual(['a']);
    expect(lenient.scheme?.tackle).toEqual(['a']);
  });

  it('rejects empty lists and non-array values, dedupes buttons', () => {
    const base = loadDefaultProfile().scheme;
    const result = validateScheme({ ...schemeToSettings(base), juke: [], spin: 'x', dive: ['lt', 'lt', 'a'] });
    expect(result.ok).toBe(false);
    expect(result.issues).toContain('action "juke": no buttons bound');
    expect(result.issues).toContain('action "spin": expected an array of buttons');
    expect(result.scheme).toBeNull();
    const withFallback = validateScheme({ ...schemeToSettings(base), dive: ['lt', 'lt', 'a'] }, base);
    expect(withFallback.scheme?.dive).toEqual(['lt', 'a']);
  });

  it('accepts a complete valid scheme', () => {
    const base = loadDefaultProfile().scheme;
    const result = validateScheme(schemeToSettings(base));
    expect(result.ok).toBe(true);
    expect(result.issues).toEqual([]);
    expect(result.scheme).toEqual(base);
  });
});

describe('settings bridge', () => {
  it('round-trips a scheme through Settings.bindings', () => {
    const base = loadDefaultProfile().scheme;
    const changed = rebind(base, 'juke', ['y', 'lb']);
    expect(settingsToScheme(schemeToSettings(changed))).toEqual(changed);
  });

  it('settingsToScheme is lenient: bad entries fall back to the default', () => {
    const scheme = settingsToScheme({ juke: ['nope'], sprint: ['lb'], bogus: ['a'] });
    expect(scheme.juke).toEqual(['b']);
    expect(scheme.sprint).toEqual(['lb']);
    expect(Object.keys(scheme).length).toBe(ACTIONS.length);
  });

  it('empty DEFAULT_SETTINGS produce the default profile', () => {
    const profile = profileFromSettings(DEFAULT_SETTINGS);
    expect(profile).toEqual(loadDefaultProfile());
  });

  it('profileToSettings / profileFromSettings round-trip custom keys', () => {
    const profile = loadDefaultProfile();
    profile.deviceMap.keyboard = { KeyZ: 'a', KeyX: 'b', ArrowUp: 'up' };
    profile.scheme = rebind(profile.scheme, 'snap', ['x']);
    const restored = profileFromSettings(profileToSettings(profile));
    expect(restored.scheme.snap).toEqual(['x']);
    expect(restored.deviceMap.keyboard).toEqual({ KeyZ: 'a', KeyX: 'b', ArrowUp: 'up' });
    expect(restored.deviceMap.mouse).toEqual(profile.deviceMap.mouse);
  });

  it('settingsToKeyboardMap drops invalid keys and falls back when empty', () => {
    expect(settingsToKeyboardMap({ KeyZ: 'a', KeyQ: 'nope' })).toEqual({ KeyZ: 'a' });
    expect(settingsToKeyboardMap({})).toEqual(loadDefaultProfile().deviceMap.keyboard);
    expect(validateKeyboardMap({ '': 'a', KeyA: 'zz' }).issues.length).toBe(2);
  });
});

describe('validateDeviceMap', () => {
  it('accepts numeric-string mouse keys and rejects bad shapes', () => {
    const good = validateDeviceMap({ keyboard: { KeyA: 'a' }, mouse: { '0': 'a', 2: 'b' }, gamepadDeadzone: 0.1 });
    expect(good.ok).toBe(true);
    expect(good.map?.mouse).toEqual({ 0: 'a', 2: 'b' });
    const bad = validateDeviceMap({ keyboard: 5, mouse: { 7: 'a', 1: 'zz' }, gamepadDeadzone: 1.5 });
    expect(bad.ok).toBe(false);
    expect(bad.map).toBeNull();
    expect(bad.issues.length).toBe(4);
    expect(validateDeviceMap(null).ok).toBe(false);
  });
});

describe('rebind and lookups', () => {
  it('returns a new scheme without mutating the input', () => {
    const base = loadDefaultProfile().scheme;
    const next = rebind(base, 'sprint', ['lb', 'lb', 'rt']);
    expect(next.sprint).toEqual(['lb', 'rt']);
    expect(base.sprint).toEqual(['rt']);
    expect(() => rebind(base, 'sprint', [])).toThrow(/at least one button/);
  });

  it('actionsFor / keysFor / guards', () => {
    const { scheme, deviceMap } = loadDefaultProfile();
    expect(actionsFor(scheme, 'rt')).toEqual(['sprint', 'defSprint']);
    expect(keysFor(deviceMap.keyboard, 'up')).toEqual(['KeyW', 'ArrowUp']);
    expect(isAction('juke')).toBe(true);
    expect(isAction('constructor')).toBe(false);
    expect(isAction(3)).toBe(false);
    expect(isButton('l3')).toBe(true);
    expect(isButton('toString')).toBe(false);
    expect(BUTTONS.length).toBe(16);
  });
});
