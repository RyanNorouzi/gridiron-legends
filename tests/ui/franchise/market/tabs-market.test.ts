import { beforeAll, describe, expect, it } from 'vitest';
import type { TeamId } from '@/core/ids';
import { createTradeOffer } from '@/franchise/trades';
import type { League } from '@/franchise/types';
import type { HubTab } from '@/ui/franchise/context';
import { DraftRoomScreen } from '@/ui/franchise/market/draft-screen';
import { ensureMarketOpen } from '@/ui/franchise/market/fa-model';
import { FreeAgencyScreen } from '@/ui/franchise/market/fa-screen';
import { ScoutingScreen } from '@/ui/franchise/market/scouting-screen';
import { TradesScreen } from '@/ui/franchise/market/trades-screen';
import { marketTabs } from '@/ui/franchise/tabs-market';
import { contextFor, draftLeague, freeAgencyLeague, rcFor, regularSeasonLeague } from './fixtures';

let regular: League;
let fa: League;
let draft: League;

beforeAll(() => {
  regular = regularSeasonLeague();
  fa = freeAgencyLeague();
  draft = draftLeague();
}, 60_000);

const tab = (id: string): HubTab => {
  const t = marketTabs.find((x) => x.id === id);
  if (!t) throw new Error(`missing tab ${id}`);
  return t;
};

const shown = (league: League): string[] => marketTabs.filter((t) => t.available?.(league) ?? true).map((t) => t.id);

describe('market hub tabs', () => {
  it('registers four market tabs with unique ids', () => {
    expect(marketTabs.map((t) => t.id)).toEqual(['market-trades', 'market-free-agency', 'market-scouting', 'market-draft']);
    expect(marketTabs.every((t) => t.group === 'market')).toBe(true);
    expect(marketTabs.map((t) => t.label)).toEqual(['Trades', 'Free Agency', 'Scouting', 'Draft']);
  });

  it('shows each tab only in the phases where it applies', () => {
    expect(shown(regular)).toEqual(['market-trades', 'market-scouting']);
    expect(shown(fa)).toEqual(['market-trades', 'market-free-agency', 'market-scouting']);
    expect(shown(draft)).toEqual(['market-trades', 'market-draft']);
    const playoffs: League = { ...regular, pendingTrades: [], season: { ...regular.season, phase: 'playoffs', week: 1 } };
    expect(shown(playoffs)).toEqual(['market-scouting']);
    const user = regular.userTeamId as TeamId;
    const other = (Object.keys(regular.teams) as TeamId[]).find((id) => id !== user) as TeamId;
    const pick = regular.teams[user]?.picks[0];
    const theirs = regular.teams[other]?.rosterIds[5];
    if (!pick || !theirs) throw new Error('setup');
    const offer = createTradeOffer(playoffs, other, user, [{ kind: 'player', playerId: theirs }], [{ kind: 'pick', pick }], other);
    expect(shown({ ...playoffs, pendingTrades: [offer] })).toContain('market-trades');
    expect(tab('market-trades').badge?.({ ...playoffs, pendingTrades: [offer] })).toBe('1');
  });

  it('badges the scouting bank, the free-agency round and the clock', () => {
    const points = Math.floor(regular.draft?.scouting[regular.userTeamId as TeamId]?.pointsAvailable ?? 0);
    expect(tab('market-scouting').badge?.(regular)).toBe(String(points));
    expect(tab('market-free-agency').badge?.(fa)).toBeNull();
    expect(tab('market-free-agency').badge?.(ensureMarketOpen(fa))).toBe('R1');
    expect(tab('market-draft').badge?.(draft)).toBeNull();
    expect(tab('market-trades').badge?.({ ...regular, pendingTrades: [] })).toBeNull();
  });

  it('creates screens that draw only inside the hub content area, at both text sizes', () => {
    const cases: [string, League, new (...args: never[]) => unknown][] = [
      ['market-trades', regular, TradesScreen], ['market-free-agency', fa, FreeAgencyScreen],
      ['market-scouting', regular, ScoutingScreen], ['market-draft', draft, DraftRoomScreen],
    ];
    for (const large of [false, true]) {
      for (const [id, league, type] of cases) {
        const fc = contextFor(league, large);
        const screen = tab(id).create(fc);
        expect(screen).toBeInstanceOf(type);
        screen.enter(fc.services);
        const rc = rcFor(fc);
        screen.render(rc);
        const area = fc.contentRect();
        const outside = rc.ctx.fills.filter((f) => f.x < area.x || f.y < area.y || f.x + f.w > area.x + area.w + 0.5 || f.y + f.h > area.y + area.h + 0.5);
        expect(outside, `${id} large=${large}`).toEqual([]);
      }
    }
  });
});
