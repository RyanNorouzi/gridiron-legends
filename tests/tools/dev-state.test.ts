import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '@/core/settings';
import {
  browserLocationSearch, cheatTags, createDevState, cycleOverlays, hasDevQuery, hooksFor, isDevModeEnabled, OVERLAY_CYCLE, OVERLAY_KINDS,
  overlayCycleIndex, overlayLabel, setCheat, setDevEnabled, setOverlays, syncHooks, toggleCheat, toggleOverlay,
} from '@/tools/dev-state';
import type { DevHooks } from '@/game/engine-api';

describe('developer mode gate', () => {
  it('is off by default and only turns on through the setting or ?dev=1', () => {
    expect(isDevModeEnabled(DEFAULT_SETTINGS, '')).toBe(false);
    expect(isDevModeEnabled(null, null)).toBe(false);
    expect(isDevModeEnabled({ devMode: true }, '')).toBe(true);
    expect(isDevModeEnabled({ devMode: false }, '?dev=1')).toBe(true);
    expect(isDevModeEnabled(DEFAULT_SETTINGS, '?team=4&dev=1&x=2')).toBe(true);
    for (const q of ['?dev=0', '?dev', '?dev=true', '?devmode=1', '?xdev=1', 'dev', '?a=dev=1']) expect(isDevModeEnabled(DEFAULT_SETTINGS, q)).toBe(false);
    expect(hasDevQuery('dev=1')).toBe(true);
  });

  it('reads an empty query string outside a browser', () => {
    expect(browserLocationSearch()).toBe('');
  });
});

describe('dev state reducers', () => {
  it('toggles overlays and cheats immutably', () => {
    const s0 = createDevState(true);
    const s1 = toggleOverlay(s0, 'routes');
    expect(s0.overlays.size).toBe(0);
    expect([...s1.overlays]).toEqual(['routes']);
    expect(toggleOverlay(s1, 'routes').overlays.size).toBe(0);
    const s2 = toggleCheat(s1, 'godMode');
    expect(s2.cheats.godMode).toBe(true);
    expect(s1.cheats.godMode).toBe(false);
    expect(setCheat(s2, 'godMode', true)).toBe(s2);
    expect(cheatTags(toggleCheat(toggleCheat(s2, 'freezeAi'), 'fastSim'))).toEqual(['GOD', 'FREEZE', 'FAST SIM']);
  });

  it('cycles off -> each overlay -> all -> off, and a custom mix back to off', () => {
    let s = createDevState(true);
    const seen: string[] = [overlayLabel(s)];
    for (let i = 0; i < OVERLAY_CYCLE.length; i++) {
      s = cycleOverlays(s);
      seen.push(overlayLabel(s));
    }
    expect(seen).toEqual(['OFF', 'HITBOXES', 'PLAYER IDS', 'ROUTES', 'COVERAGE', 'AI DECISIONS', 'ATTRIBUTES', 'BALL PATH', 'ALL', 'OFF']);
    const custom = setOverlays(createDevState(true), ['ids', 'ball']);
    expect(overlayCycleIndex(custom)).toBe(-1);
    expect(overlayLabel(custom)).toBe('CUSTOM (2)');
    expect(cycleOverlays(custom).overlays.size).toBe(0);
    expect(OVERLAY_CYCLE[OVERLAY_CYCLE.length - 1]).toEqual(OVERLAY_KINDS);
  });

  it('a disabled state ignores every change and yields inert hooks', () => {
    const off = createDevState(false);
    expect(toggleOverlay(off, 'hitboxes')).toBe(off);
    expect(cycleOverlays(off)).toBe(off);
    expect(toggleCheat(off, 'godMode')).toBe(off);
    expect(setOverlays(off, OVERLAY_KINDS)).toBe(off);
    expect(hooksFor(off, 'home')).toEqual({ godMode: false, infiniteStamina: false, freezeAi: false, side: 'home' });
    const on = toggleCheat(toggleOverlay(createDevState(true), 'ids'), 'infiniteStamina');
    const disabled = setDevEnabled(on, false);
    expect(disabled.enabled).toBe(false);
    expect(disabled.overlays.size).toBe(0);
    expect(disabled.cheats.infiniteStamina).toBe(false);
  });

  it('syncs flags into a shared hooks object and clears its inbox when disabled', () => {
    const hooks: DevHooks = {};
    const s = toggleCheat(toggleCheat(createDevState(true), 'godMode'), 'freezeAi');
    syncHooks(hooks, s, 'away');
    expect(hooks).toMatchObject({ godMode: true, freezeAi: true, infiniteStamina: false, side: 'away', commands: [] });
    hooks.commands?.push({ type: 'forceTurnover' });
    syncHooks(hooks, toggleCheat(s, 'godMode'), 'away');
    expect(hooks.godMode).toBe(false);
    expect(hooks.commands).toHaveLength(1);
    syncHooks(hooks, setDevEnabled(s, false));
    expect(hooks.commands).toHaveLength(0);
    expect(hooks.freezeAi).toBe(false);
  });
});
