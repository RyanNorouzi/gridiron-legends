/**
 * The team tabs hosted by the real franchise hub: the hub keeps Start / Enter (Advance), Back and U/O, so the
 * tab menu must open with TAB_MENU_ACTIONS (LT / keyboard C) or a tap on its button, and tab commits must land
 * in the hub's League (no stale snapshot).
 */
import { describe, expect, it } from 'vitest';
import { fallbackSimulator } from '@/franchise/sim-fallback';
import { createHeadlessServices } from '@/ui/franchise/context';
import { FranchiseHubScreen } from '@/ui/franchise/hub';
import { ChoiceDialog, ConfirmDialog } from '@/ui/franchise/kit/dialogs';
import { teamTabs } from '@/ui/franchise/tabs-team';
import { TAB_MENU_ACTIONS } from '@/ui/franchise/team/tab-screen';
import type { Action } from '@/ui/input/types';
import { createFakeCtx, makeInput, pointerAt } from '../../render/fake-ctx';
import { baseLeague, userId } from './helpers';

const openHub = (): { hub: FranchiseHubScreen; services: ReturnType<typeof createHeadlessServices>; press: (...a: Action[]) => void } => {
  const services = createHeadlessServices();
  const hub = new FranchiseHubScreen({ league: baseLeague(), mode: 'season', simulator: fallbackSimulator, onExit: () => undefined, tabs: teamTabs });
  services.stack.push(hub);
  const press = (...a: Action[]): void => services.stack.update(1 / 60, makeInput({ pressed: a }));
  return { hub, services, press };
};

const topChoice = (services: ReturnType<typeof createHeadlessServices>): ChoiceDialog => {
  const top = services.stack.top;
  if (!(top instanceof ChoiceDialog)) throw new Error(`top screen is ${top?.id ?? 'none'}`);
  return top;
};

describe('team tabs hosted by the hub', () => {
  it('opens the tab menu with LT / C while Start / Enter stays the hub Advance menu', () => {
    expect(TAB_MENU_ACTIONS).toContain('callTimeout');
    const { hub, services, press } = openHub();
    expect(hub.selectTab('team-depth')).toBe(true);
    press('pause');
    expect(topChoice(services).title).toBe('Advance');
    press('back');
    expect(services.stack.top).toBe(hub);
    press('callTimeout');
    const menu = topChoice(services);
    expect(menu.title).toBe('Depth chart');
    expect(menu.list.items.map((i) => i.id)).toEqual(['auto', 'add', 'issues']);
    const before = hub.league;
    menu.choose('auto');
    const confirm = services.stack.top;
    if (!(confirm instanceof ConfirmDialog)) throw new Error('auto depth asks first');
    confirm.choose(true);
    expect(hub.league).not.toBe(before);
    expect(hub.league.teams[userId(before)]?.depthChart).not.toBe(before.teams[userId(before)]?.depthChart);
  });

  it('opens the tab menu with a tap on its button (touch / mouse)', () => {
    const { hub, services } = openHub();
    expect(hub.selectTab('team-playbook')).toBe(true);
    hub.render({ ctx: createFakeCtx(), width: 480, height: 270, alpha: 1, theme: services.theme, settings: services.settings, camera: services.camera, sprites: services.sprites, time: 0 });
    const r = hub.contentRect();
    services.stack.update(1 / 60, makeInput({ pointer: pointerAt(r.x + r.w - 4, r.y + 4, true) }));
    expect(topChoice(services).title).toBe('Offense');
  });
});
