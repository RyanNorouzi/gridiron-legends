import { beforeAll, describe, expect, it } from 'vitest';
import type { PlayerId, TeamId } from '@/core/ids';
import { createLeague } from '@/franchise/league';
import type { DraftState, League } from '@/franchise/types';
import type { Player } from '@/players/types';
import { emptyPlayerStatLine } from '@/statistics/empty';
import { createFranchiseContext, createHeadlessServices, createTestFranchiseContext, deriveRng, HUB_GROUPS, TEST_CONTENT_RECT } from '@/ui/franchise/context';
import { TeamViewScreen } from '@/ui/franchise/league/team-view';
import { buildPlayerCard, cardSections, PlayerCardScreen, potentialVisibility } from '@/ui/franchise/player-card';
import { leagueTabs } from '@/ui/franchise/tabs-league';
import { marketTabs } from '@/ui/franchise/tabs-market';
import { teamTabs } from '@/ui/franchise/tabs-team';
import type { RenderContext } from '@/ui/screens/screen';
import { createFakeCtx, makeInput } from '../../render/fake-ctx';

let league: League;
let user: TeamId;
let mine: Player;
let theirs: Player;
let freeAgent: Player;

beforeAll(() => {
  league = createLeague({ seed: 21, userTeamAbbr: 'BOS' });
  user = league.userTeamId as TeamId;
  const other = Object.values(league.teams).find((t) => t.id !== user);
  if (!other) throw new Error('no other team');
  mine = league.players[league.teams[user]?.rosterIds.find((id) => league.players[id]?.position === 'QB') as PlayerId] as Player;
  theirs = league.players[other.rosterIds.find((id) => league.players[id]?.draft?.teamId !== user) as PlayerId] as Player;
  freeAgent = league.players[league.freeAgentIds[0] as PlayerId] as Player;
});

const rcFor = (fc: ReturnType<typeof createTestFranchiseContext>): RenderContext & { ctx: ReturnType<typeof createFakeCtx> } => ({
  ctx: createFakeCtx(), width: 480, height: 270, alpha: 1, theme: fc.services.theme, settings: fc.services.settings, camera: fc.services.camera, sprites: fc.services.sprites, time: 0,
});

describe('FranchiseContext', () => {
  it('records commits, toasts, pushes, pops and open requests', () => {
    const fc = createTestFranchiseContext(league);
    expect(fc.userTeamId).toBe(user);
    const next = { ...league, name: 'Renamed' };
    fc.commit(next, 'signing');
    expect(fc.league()).toBe(next);
    expect(fc.commits).toEqual([{ league: next, reason: 'signing' }]);
    fc.toast('Hello');
    expect(fc.toasts).toEqual(['Hello']);
    fc.openPlayer(mine.id);
    fc.openTeam(user);
    expect(fc.openedPlayers).toEqual([mine.id]);
    expect(fc.openedTeams).toEqual([user]);
    expect(fc.stack.size).toBe(0);
    const card = new PlayerCardScreen(fc, mine.id);
    fc.push(card);
    expect(fc.pushed).toEqual([card]);
    expect(fc.stack.top).toBe(card);
    fc.pop();
    expect(fc.pops()).toBe(1);
    expect(fc.stack.size).toBe(0);
    expect(() => fc.commit(null as unknown as League, 'edit')).toThrow();
    expect(fc.contentRect()).toEqual(TEST_CONTENT_RECT);
    expect(createTestFranchiseContext(league, { contentRect: { x: 1, y: 2, w: 3, h: 4 } }).contentRect()).toEqual({ x: 1, y: 2, w: 3, h: 4 });
  });
  it('forks deterministic RNGs without touching the league state', () => {
    const a = createTestFranchiseContext(league);
    const b = createTestFranchiseContext(league);
    const a1 = a.rng('trade').next();
    const a2 = a.rng('trade').next();
    expect(a1).not.toBe(a2);
    expect(b.rng('trade').next()).toBe(a1);
    expect(a.rng('other').next()).not.toBe(deriveRng(league, 'trade', 2).next());
    expect(deriveRng(league, 'x', 0).next()).toBe(deriveRng(league, 'x', 0).next());
    expect(a.league().rngState).toEqual(league.rngState);
  });
  it('production context opens the player card and the team page by default and toasts unknown teams', () => {
    const services = createHeadlessServices();
    const toasts: string[] = [];
    services.toast = (m) => toasts.push(m);
    let current = league;
    const reasons: string[] = [];
    const fc = createFranchiseContext({ services, getLeague: () => current, setLeague: (l) => { current = l; }, onCommit: (_l, r) => reasons.push(r) });
    fc.openPlayer(mine.id);
    expect(services.stack.top).toBeInstanceOf(PlayerCardScreen);
    fc.openTeam(user);
    expect(services.stack.top).toBeInstanceOf(TeamViewScreen);
    expect((services.stack.top as TeamViewScreen).teamId).toBe(user);
    fc.openTeam('nope' as TeamId);
    expect(toasts).toEqual(['Unknown team']);
    fc.commit({ ...league }, 'edit');
    expect(reasons).toEqual(['edit']);
    expect(fc.contentRect()).toEqual({ x: 0, y: 0, w: 480, h: 270 });
    expect(() => createFranchiseContext({ services, getLeague: () => ({ ...league, userTeamId: null }), setLeague: () => undefined })).toThrow();
  });
  it('ships typed, grouped tab lists for the chains with unique ids', () => {
    const groups = [['team', teamTabs], ['market', marketTabs], ['league', leagueTabs]] as const;
    for (const [group, tabs] of groups) {
      expect(tabs.length).toBeGreaterThan(0);
      expect(tabs.every((t) => t.group === group)).toBe(true);
    }
    const ids = groups.flatMap(([, tabs]) => tabs.map((t) => t.id));
    expect(new Set(ids).size).toBe(ids.length);
    expect(HUB_GROUPS).toEqual(['home', 'team', 'market', 'league']);
  });
});

describe('player card view-model', () => {
  it('builds a complete card for a rostered user player', () => {
    const v = buildPlayerCard(league, mine.id, user);
    if (!v) throw new Error('card');
    expect(v.name).toBe(`${mine.firstName} ${mine.lastName}`);
    expect(v.jersey).toBe(`#${mine.jerseyNumber}`);
    expect(v.positionName).toBe('Quarterback');
    expect(v.status).toBe('active');
    expect(v.overall.text).toBe(String(mine.overall));
    expect(v.potentialMode).toBe('exact');
    expect(v.potential.text).toBe(String(mine.potential));
    expect(v.ratings).toHaveLength(25);
    expect(v.ratings[0]?.importance).toBe('primary');
    expect(v.ratings.map((r) => r.key)).toContain('throwAccuracy');
    expect(v.statGroups).toEqual(['passing', 'rushing']);
    expect(v.statRows[v.statRows.length - 1]?.total).toBe(true);
    const ids = v.overview.map((l) => l.id);
    for (const id of ['team', 'age', 'size', 'draft', 'health', 'morale', 'traits', 'dev']) expect(ids).toContain(id);
    expect(ids).toContain(mine.contract ? 'contract' : 'asking');
    expect(v.history.some((l) => l.id === 'h-prog')).toBe(true);
    expect(cardSections(v).map((t) => t.id)).toEqual(['overview', 'ratings', 'stats:passing', 'stats:rushing', 'history']);
  });
  it('hides potential from other teams unless scouted, and handles free agents and unknown ids', () => {
    expect(potentialVisibility(league, theirs, user).mode).toBe('hidden');
    const hidden = buildPlayerCard(league, theirs.id, user);
    expect(hidden?.potential).toEqual({ text: '?', tone: 'dim' });
    expect(hidden?.overview.some((l) => l.id === 'dev')).toBe(false);
    const draft: DraftState = {
      year: league.year, order: [], currentPickIndex: 0, prospects: [], selections: [], scouting: {}, userBoard: [], complete: false,
      reports: { [user]: { [theirs.id]: { prospectId: theirs.id, overallRange: [60, 70], potentialRange: [70, 78], grade: 'B', confidence: 0.5, attributeEstimates: {}, devTraitEstimate: null, traitsRevealed: [], notes: [], interviewed: false, redFlags: [] } } } as DraftState['reports'],
    };
    const scouted = { ...league, draft };
    expect(potentialVisibility(scouted, theirs, user)).toEqual({ mode: 'range', text: { text: '70-78', tone: 'info' } });
    expect(potentialVisibility(league, { ...theirs, draft: { year: 2020, round: 1, pick: 3, overall: 3, teamId: user } }, user).mode).toBe('exact');
    const fa = buildPlayerCard(league, freeAgent.id, user);
    expect(fa?.status).toBe('freeAgent');
    expect(fa?.teamLabel).toBe('Free Agent');
    expect(buildPlayerCard(league, 'p_missing' as PlayerId, user)).toBeNull();
  });
  it('includes the current season and career totals in the stats rows', () => {
    const line = { ...emptyPlayerStatLine(), gamesPlayed: 3, passing: { ...emptyPlayerStatLine().passing, attempts: 90, completions: 60, yards: 700, touchdowns: 5 } };
    const withStats: League = { ...league, season: { ...league.season, stats: { ...league.season.stats, [mine.id]: line } } };
    const v = buildPlayerCard(withStats, mine.id, user);
    const current = v?.statRows.find((r) => r.year === `${league.season.year}*`);
    expect(current?.line.passing.yards).toBe(700);
    expect(v?.statRows.find((r) => r.total)?.line.passing.yards).toBe(700);
  });
});

describe('PlayerCardScreen', () => {
  it('renders, switches sections, sorts ratings and closes on back', () => {
    const fc = createTestFranchiseContext(league);
    const card = new PlayerCardScreen(fc, mine.id);
    fc.push(card);
    const rc = rcFor(fc);
    card.render(rc);
    expect(rc.ctx.fills.length).toBeGreaterThan(200);
    expect(card.section).toBe('overview');
    fc.tick(makeInput({ pressed: ['menuTabRight'] }));
    expect(card.section).toBe('ratings');
    fc.tick(makeInput({ pressed: ['menuRight'] }));
    expect(card.table?.sortKey).toBe('attr');
    fc.tick(makeInput({ pressed: ['menuTabRight'] }));
    expect(card.section).toBe('stats:passing');
    card.render(rc);
    expect(card.showSection('overview')).toBe(true);
    const teamRow = card.table?.rows.findIndex((r) => 'id' in r && r.id === 'team') ?? -1;
    card.table?.select(teamRow);
    fc.tick(makeInput({ pressed: ['confirm'] }));
    expect(fc.openedTeams).toEqual([user]);
    fc.tick(makeInput({ pressed: ['back'] }));
    expect(fc.pops()).toBe(1);
    expect(fc.stack.size).toBe(0);
  });
  it('renders in large-text mode and for a missing player', () => {
    const fc = createTestFranchiseContext(league, { settings: { textSize: 'large' } });
    const card = new PlayerCardScreen(fc, theirs.id, { section: 'history' });
    fc.push(card);
    expect(card.section).toBe('history');
    const rc = rcFor(fc);
    card.render(rc);
    expect(card.table?.visibleRows).toBeGreaterThan(2);
    const missing = new PlayerCardScreen(fc, 'p_missing' as PlayerId);
    fc.push(missing);
    missing.render(rc);
    fc.tick(makeInput({ pressed: ['back'] }));
    expect(fc.stack.top).toBe(card);
  });
});
