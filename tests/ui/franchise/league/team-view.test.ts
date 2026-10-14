import { describe, expect, it } from 'vitest';
import type { TeamId } from '@/core/ids';
import { fallbackSimulator } from '@/franchise/sim-fallback';
import type { League } from '@/franchise/types';
import { createHeadlessServices, createFranchiseContext } from '@/ui/franchise/context';
import { createHomeTabs, HomeTabScreen } from '@/ui/franchise/home-tab';
import { FranchiseHubScreen } from '@/ui/franchise/hub';
import { TeamViewScreen, scheduleColumns } from '@/ui/franchise/league/team-view';
import { teamHeader } from '@/ui/franchise/league/teams-model';
import { makeInput } from '../../render/fake-ctx';
import { centre, midSeasonLeague, mount, press, render, tapAt, userOf } from './helpers';

const otherTeam = (league: League): TeamId => {
  const id = (Object.keys(league.teams) as TeamId[]).find((t) => t !== league.userTeamId);
  if (!id) throw new Error('no other team');
  return id;
};

describe('unified team view', () => {
  it('shows the division rank and market in the header', () => {
    const league = midSeasonLeague();
    const h = teamHeader(league, otherTeam(league));
    expect(h?.subtitle).toMatch(/ (1st|2nd|3rd|4th) · OVR/);
    expect(h?.market).toMatch(/ market$/);
    const t = league.teams[otherTeam(league)];
    expect(h?.shortTitle).toBe(`${t?.name} (${t?.abbr})`);
  });

  it('has a schedule view that opens opponents, plus roster/ratings/staff/finances/history', () => {
    for (const textSize of ['normal', 'large'] as const) {
      const league = midSeasonLeague();
      const { fc } = mount(league, (c) => new TeamViewScreen(c, otherTeam(league)), { settings: { textSize } });
      const page = fc.stack.top as TeamViewScreen;
      expect(page.header()?.title).toContain(league.teams[otherTeam(league)]?.abbr);
      render(fc);
      press(fc, 'confirm');
      expect(fc.openedPlayers).toEqual([page.rosterTable?.selected?.id]);
      press(fc, 'menuTabRight');
      expect(page.view).toBe('schedule');
      expect(page.scheduleTable?.columns.map((c) => c.key)).toEqual(scheduleColumns(textSize === 'normal').map((c) => c.key));
      const ctx = render(fc);
      expect(ctx.fills.filter((f) => f.x < -1 || f.y < -1 || f.x + f.w > 481 || f.y + f.h > 271)).toEqual([]);
      const game = page.scheduleTable?.rows.findIndex((r) => r.opponentId !== null) ?? -1;
      expect(game).toBeGreaterThanOrEqual(0);
      page.scheduleTable?.select(game);
      press(fc, 'confirm');
      expect(fc.openedTeams).toEqual([page.scheduleTable?.rows[game]?.opponentId]);
      // Touch: the CLOSE button of the title row.
      const close = page.lastLayout?.close;
      if (!close) throw new Error('no close button');
      const c = centre(close);
      tapAt(fc, c.x, c.y);
      expect(fc.stack.top).not.toBe(page);
    }
  });

  it('is what the default context, the hub scout link and the league tabs open', () => {
    const league = midSeasonLeague();
    const services = createHeadlessServices();
    const fc = createFranchiseContext({ services, getLeague: () => league, setLeague: () => undefined });
    fc.openTeam(otherTeam(league));
    expect(services.stack.top).toBeInstanceOf(TeamViewScreen);
    fc.openTeam('nope' as TeamId);
    expect((services.stack.top as TeamViewScreen).teamId).toBe(otherTeam(league));

    const s2 = createHeadlessServices();
    let hub: FranchiseHubScreen | null = null;
    hub = new FranchiseHubScreen({ league, onExit: () => undefined, simulator: fallbackSimulator, tabs: createHomeTabs(() => hub) });
    s2.stack.push(hub);
    const home = (hub as unknown as { hosted: Map<string, { screen: HomeTabScreen }> }).hosted.get('home')?.screen;
    expect(home).toBeInstanceOf(HomeTabScreen);
    const scout = home?.list.items.findIndex((i) => i.id === 'opponent') ?? -1;
    expect(scout).toBeGreaterThan(0);
    home?.list.select(scout);
    s2.stack.update(1 / 60, makeInput({ pressed: ['confirm'] }));
    const top = s2.stack.top;
    expect(top).toBeInstanceOf(TeamViewScreen);
    const card = home?.card;
    expect((top as TeamViewScreen).teamId).toBe(card?.userSide === 'home' ? card.away.teamId : card?.home.teamId);
    expect((top as TeamViewScreen).teamId).not.toBe(userOf(league));
    s2.stack.update(1 / 60, makeInput({ pressed: ['back'] }));
    expect(s2.stack.top).toBe(hub);
  });
});
