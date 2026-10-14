/**
 * Market group tabs of the franchise hub (see HubTab in ./context.ts). Each shows only when it applies:
 * - Trades: while the trade window is open (tradeWindowStatus) or offers to the user still wait; badge = offers.
 * - Free Agency: the free-agency phase; badge = the bidding round, or "!" when a counter waits.
 * - Scouting: from the start of the regular season until the draft starts (this year's class open, no order yet,
 *   not the draft phase); badge = scouting points in the bank.
 * - Draft: the draft phase; badge "!" while the user is on the clock.
 * The screens live in ./market/.
 */
import type { HubTab } from './context';
import { draftBadge } from './market/draft-model';
import { DraftRoomScreen } from './market/draft-screen';
import { faBadge } from './market/fa-model';
import { FreeAgencyScreen } from './market/fa-screen';
import { scoutingBadge, scoutingOpen } from './market/scouting-model';
import { ScoutingScreen } from './market/scouting-screen';
import { tradeBadge, tradesTabAvailable } from './market/trade-model';
import { TradesScreen } from './market/trades-screen';

/** Hub tabs contributed by the market chain (group 'market'). */
export const marketTabs: HubTab[] = [
  { id: 'market-trades', label: 'Trades', group: 'market', available: tradesTabAvailable, badge: tradeBadge, create: (fc) => new TradesScreen(fc) },
  { id: 'market-free-agency', label: 'Free Agency', group: 'market', available: (l) => l.season.phase === 'freeAgency', badge: faBadge, create: (fc) => new FreeAgencyScreen(fc) },
  { id: 'market-scouting', label: 'Scouting', group: 'market', available: scoutingOpen, badge: scoutingBadge, create: (fc) => new ScoutingScreen(fc) },
  { id: 'market-draft', label: 'Draft', group: 'market', available: (l) => l.season.phase === 'draft', badge: draftBadge, create: (fc) => new DraftRoomScreen(fc) },
];
