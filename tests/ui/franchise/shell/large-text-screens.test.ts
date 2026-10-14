/** Large text on the Playoffs-mode bracket and the hub Overview: seeds, title and actions stay whole (APP2-06). */
import { describe, expect, it, vi } from 'vitest';

const log: string[] = [];
vi.mock('@/ui/render/text', async (orig) => {
  const m = await orig<typeof import('@/ui/render/text')>();
  return { ...m, drawText: (...a: Parameters<typeof m.drawText>) => { log.push(String(a[1])); return m.drawText(...a); } };
});

import { fallbackSimulator } from '@/franchise/sim-fallback';
import { createHeadlessServices } from '@/ui/franchise/context';
import { FranchiseHubScreen, defaultHubTabs } from '@/ui/franchise/hub';
import { PlayoffsModeScreen } from '@/ui/franchise/playoffs-mode';
import { regularSeasonLeague } from '../market/fixtures';
import { leagueAt, rcFor } from './helpers';

const cut = (texts: readonly string[]): string[] => texts.filter((t) => t.endsWith('...'));

describe('large text keeps key franchise screens readable', () => {
  it('Playoffs-mode bracket: whole seeds and title', () => {
    const services = createHeadlessServices({ textSize: 'large' });
    services.stack.push(new PlayoffsModeScreen({ league: leagueAt(102, 'playoffs'), onExit: () => undefined, simulator: fallbackSimulator }));
    log.length = 0;
    services.stack.render(rcFor(services));
    expect(log).toEqual(expect.arrayContaining(['#1 WAS', '#2 CHI', '#7 NYC']));
    expect(log.some((t) => t.startsWith('2026 PLAYOFFS') || t.startsWith('2026 -'))).toBe(true);
    expect(cut(log)).toEqual([]);
  });

  it('hub Overview: the next-game line and the actions are not cut', () => {
    const services = createHeadlessServices({ textSize: 'large' });
    const hub = new FranchiseHubScreen({ league: regularSeasonLeague(), onExit: () => undefined, simulator: fallbackSimulator, tabs: defaultHubTabs() });
    services.stack.push(hub);
    hub.selectTab('home-overview');
    log.length = 0;
    services.stack.render(rcFor(services));
    expect(log).toContain('Play Week 2 at NYC');
    expect(log.some((t) => t.startsWith('at NYC') && t.includes('OVR'))).toBe(true);
    expect(cut(log)).toEqual([]);
  });
});
