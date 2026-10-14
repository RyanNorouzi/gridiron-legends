import { describe, expect, it } from 'vitest';
import type { PlayerId } from '@/core/ids';
import { createRng } from '@/core/rng';
import type { Player } from '@/players/types';
import { validateLeague } from '@/save/serialize';
import type { DraftPick } from '@/teams/types';
import type { League, TradeAsset } from '@/franchise/types';
import { capHit, leagueCapYear } from '@/franchise/contracts';
import { rosterErrors } from '@/franchise/roster';
import { aiTradeProposals } from '@/franchise/gm/roster-ai';
import { isUntouchable } from '@/franchise/gm/valuation';
import { aiEvaluateTrade } from '@/franchise/gm';
import {
  createTradeOffer, evaluateTrade, executeTrade, expireTrades, proposeTrade, respondToTrade, runAiTradeActivity, tradeCapPreview,
  tradeWindowOpen,
} from '@/franchise/trades';
import { atPhase, buildLeague, rosterOf, teamByAbbr, teamsSorted, withPlayer, withTeam } from './helpers';

/** Week 5; the user's team gets $40M of carryover room so value, not the cap, decides the value tests. */
const setup = (): { league: League; userId: DraftPick['ownerTeamId']; partnerId: DraftPick['ownerTeamId'] } => {
  const base = buildLeague({ seed: 13, userTeamAbbr: 'BOS', phase: 'regularSeason', week: 5 });
  const user = teamByAbbr(base, 'BOS');
  const league = withTeam(base, { ...user, finances: { ...user.finances, capCarryover: 40_000_000 } });
  const partnerId = teamsSorted(league).find((t) => t.id !== user.id)!.id;
  return { league, userId: user.id, partnerId };
};

const pickOf = (league: League, teamId: DraftPick['ownerTeamId'], round: number, year = 2026): TradeAsset =>
  ({ kind: 'pick', pick: league.teams[teamId]!.picks.find((p) => p.round === round && p.year === year)! });
const playerAsset = (p: Player): TradeAsset => ({ kind: 'player', playerId: p.id });

/** A solid starter the partner will part with for the right price. */
const tradeTarget = (league: League, teamId: DraftPick['ownerTeamId']): Player =>
  rosterOf(league, teamId).find((p) => p.overall >= 72 && p.overall < 84 && p.age <= 29 && !isUntouchable(p, 2026, league.settings) && p.position !== 'K' && p.position !== 'P')!;

describe('trade window', () => {
  it('is open through the deadline week and in the offseason, closed after it and in the playoffs', () => {
    const { league } = setup();
    expect(tradeWindowOpen({ ...league, season: { ...league.season, week: 9 } })).toBe(true);
    expect(tradeWindowOpen({ ...league, season: { ...league.season, week: 10 } })).toBe(false);
    expect(tradeWindowOpen(atPhase(league, 'playoffs', 1))).toBe(false);
    expect(tradeWindowOpen(atPhase(league, 'draft'))).toBe(true);
    expect(tradeWindowOpen(atPhase(league, 'preseason', 1))).toBe(true);
  });

  it('closes trades in week 10 with a window reason and expires pending offers', () => {
    const { league, userId, partnerId } = setup();
    const offer = createTradeOffer(league, userId, partnerId, [pickOf(league, userId, 1)], [playerAsset(rosterOf(league, partnerId)[40]!)]);
    const week10 = { ...league, season: { ...league.season, week: 10 } };
    const ev = evaluateTrade(week10, offer);
    expect(ev.accepted).toBe(false);
    expect(ev.reason).toMatch(/^window: the trade deadline passed after week 9/);
    const pending = { ...week10, pendingTrades: [offer] };
    expect(expireTrades(pending).pendingTrades[0]!.status).toBe('withdrawn');
    expect(runAiTradeActivity(pending, createRng(1)).pendingTrades[0]!.status).toBe('withdrawn');
  });
});

describe('evaluateTrade', () => {
  it('rejects a lopsided offer with an actionable counter the user can accept', () => {
    const { league, userId, partnerId } = setup();
    const target = tradeTarget(league, partnerId);
    const offer = createTradeOffer(league, userId, partnerId, [pickOf(league, userId, 7)], [playerAsset(target)]);
    const ev = evaluateTrade(league, offer);
    expect(ev.accepted).toBe(false);
    expect(ev.reason).toMatch(/^value/);
    expect(ev.valueGiven).toBeGreaterThan(ev.valueReceived * 3);
    expect(ev.counterOffer).not.toBeNull();
    expect(ev.counterSuggestion).toMatch(/^Add /);
    const counter = ev.counterOffer!;
    expect(counter.fromAssets.length).toBeGreaterThan(offer.fromAssets.length);
    expect(counter.initiatedBy).toBe(partnerId);
    expect(evaluateTrade(league, counter).accepted).toBe(true);

    const proposed = proposeTrade(league, offer);
    expect(proposed.league.pendingTrades.find((t) => t.id === offer.id)!.status).toBe('countered');
    expect(proposed.league.pendingTrades.find((t) => t.id === counter.id)!.status).toBe('pending');
    const done = respondToTrade(proposed.league, counter.id, true);
    expect(done.players[target.id]!.teamId).toBe(userId);
    expect(done.pendingTrades.find((t) => t.id === counter.id)!.status).toBe('accepted');
    expect(rosterErrors(done)).toEqual([]);
    expect(() => validateLeague(done)).not.toThrow();
    const declined = respondToTrade(proposed.league, counter.id, false);
    expect(declined.pendingTrades.find((t) => t.id === counter.id)!.status).toBe('rejected');
    expect(() => respondToTrade(declined, counter.id, true)).toThrow(/no pending trade/);
  });

  it('still counters when the cheapest qualifying asset would break the AI cap', () => {
    const { league: l0, userId, partnerId } = setup();
    const seventh = pickOf(l0, userId, 7) as { kind: 'pick'; pick: DraftPick };
    const league = withTeam(l0, { ...l0.teams[userId]!, picks: [seventh.pick] });
    const target = rosterOf(league, partnerId).filter((p) => p.position === 'WR')[2]!;
    const offer = createTradeOffer(league, userId, partnerId, [seventh], [playerAsset(target)]);
    const year = leagueCapYear(league);
    expect(evaluateTrade(league, offer, { counter: false }).reason).toMatch(/^value/);
    const with1 = (p: Player) => ({ ...offer, fromAssets: [seventh, playerAsset(p)] });
    const singles = rosterOf(league, userId)
      .map((p) => ({ p, ev: evaluateTrade(league, with1(p), { counter: false }), hit: capHit(p.contract, year) }))
      .filter((x) => x.ev.accepted).sort((a, b) => a.ev.valueReceived - b.ev.valueReceived);
    const first = singles[0]!;
    const later = singles.slice(1, 8).find((x) => x.hit < first.hit);
    expect(later).toBeDefined();
    // Squeeze the partner so the cheapest single overshoots its cap while `later` still fits.
    const room = tradeCapPreview(league, with1(later!.p))[partnerId]!;
    const partner = league.teams[partnerId]!;
    const squeeze = room - (first.hit - later!.hit) / 2;
    const tight = withTeam(league, { ...partner, finances: { ...partner.finances, deadMoney: { ...partner.finances.deadMoney, [year]: (partner.finances.deadMoney[year] ?? 0) + squeeze } } });
    expect(evaluateTrade(tight, with1(first.p), { counter: false }).reason).toMatch(/^cap/);
    const ev = evaluateTrade(tight, offer);
    expect(ev.counterOffer).not.toBeNull();
    expect(evaluateTrade(tight, ev.counterOffer!).accepted).toBe(true);
  });

  it('accepts a fair offer and executes it: picks change owners, rosters stay consistent', () => {
    const base = setup();
    const backup = rosterOf(base.league, base.partnerId).filter((p) => p.position === 'WR')[4]!;
    const firstPick = pickOf(base.league, base.userId, 1) as { kind: 'pick'; pick: DraftPick };
    const draft = { year: 2026, order: [firstPick.pick], currentPickIndex: 0, prospects: [], selections: [], reports: {}, scouting: {}, userBoard: [], complete: false };
    const league = { ...base.league, draft };
    const offer = createTradeOffer(league, base.userId, base.partnerId, [firstPick], [playerAsset(backup)]);
    const ev = aiEvaluateTrade(league, offer);
    expect(ev.accepted).toBe(true);
    expect(ev.reason).toMatch(/^accepted/);
    const moved: string[] = [];
    const after = executeTrade(league, offer, { onPlayerMoved: (p) => moved.push(p.id), onPickMoved: (pk) => moved.push(pk.id) });
    expect(moved.sort()).toEqual([backup.id, firstPick.pick.id].sort());
    expect(after.players[backup.id]!.teamId).toBe(base.userId);
    expect(after.players[backup.id]!.contract).toEqual(backup.contract);
    expect(after.players[backup.id]!.morale.morale).toBeLessThan(backup.morale.morale);
    expect(after.teams[base.userId]!.picks.some((p) => p.id === firstPick.pick.id)).toBe(false);
    const received = after.teams[base.partnerId]!.picks.find((p) => p.id === firstPick.pick.id)!;
    expect(received.ownerTeamId).toBe(base.partnerId);
    expect(received.originalTeamId).toBe(base.userId);
    expect(after.draft!.order[0]!.ownerTeamId).toBe(base.partnerId);
    expect(after.pendingTrades).toEqual([{ ...offer, status: 'accepted' }]);
    expect(rosterErrors(after)).toEqual([]);
    expect(() => validateLeague(after)).not.toThrow();
    expect(() => executeTrade(after, offer)).toThrow(/does not own|is not on/);
    // the league passed in is untouched
    expect(league.teams[base.userId]!.picks.some((p) => p.id === firstPick.pick.id)).toBe(true);
  });

  it('moves picks without hooks (proposeTrade, respondToTrade and AI-to-AI trades pass none)', () => {
    const base = setup();
    const backup = rosterOf(base.league, base.partnerId).filter((p) => p.position === 'WR')[4]!;
    const firstPick = pickOf(base.league, base.userId, 1) as { kind: 'pick'; pick: DraftPick };
    const offer = createTradeOffer(base.league, base.userId, base.partnerId, [firstPick], [playerAsset(backup)]);
    const after = executeTrade(base.league, offer);
    expect(after.teams[base.userId]!.picks.some((p) => p.id === firstPick.pick.id)).toBe(false);
    expect(after.teams[base.partnerId]!.picks.find((p) => p.id === firstPick.pick.id)?.ownerTeamId).toBe(base.partnerId);
    expect(() => validateLeague(after)).not.toThrow();
  });

  it('rejects a cap-infeasible trade with a cap reason', () => {
    const { league: base, userId, partnerId } = setup();
    const year = leagueCapYear(base);
    const pricey = rosterOf(base, userId).sort((a, b) => capHit(b.contract, year) - capHit(a.contract, year))[0]!;
    const partner = base.teams[partnerId]!;
    const league = withTeam(base, { ...partner, finances: { ...partner.finances, deadMoney: { [year]: base.settings.salaryCap } } });
    const offer = createTradeOffer(league, userId, partnerId, [playerAsset(pricey)], [pickOf(league, partnerId, 7)]);
    const ev = evaluateTrade(league, offer);
    expect(ev.accepted).toBe(false);
    expect(ev.reason).toMatch(new RegExp(`^cap: ${partner.abbr} would be \\$[\\d,]+ over the cap`));
    expect(ev.counterOffer).toBeNull();
    expect(tradeCapPreview(league, offer)[partnerId]).toBeLessThan(0);
  });

  it('protects untouchables, roster limits and ownership', () => {
    const { league: base, userId, partnerId } = setup();
    const starter = rosterOf(base, partnerId).find((p) => p.position === 'QB')!;
    const league = withPlayer(base, { ...starter, overall: 93, age: 26 });
    const ask = evaluateTrade(league, createTradeOffer(league, userId, partnerId, [pickOf(league, userId, 2)], [playerAsset(league.players[starter.id]!)]));
    expect(ask.reason).toMatch(/^untouchable/);
    expect(ask.counterSuggestion).toMatch(/not available/);
    const four = rosterOf(base, userId).slice(20, 24).map(playerAsset);
    const crowd = evaluateTrade(base, createTradeOffer(base, userId, partnerId, four, [pickOf(base, partnerId, 7)]));
    expect(crowd.reason).toMatch(/^roster: .* would carry 57 players \(limit 53\)/);
    const stolen = evaluateTrade(base, createTradeOffer(base, userId, partnerId, [pickOf(base, partnerId, 1)], []));
    expect(stolen.reason).toMatch(/^invalid: .* does not own pick/);
    expect(evaluateTrade(base, createTradeOffer(base, userId, userId, [], [])).reason).toMatch(/^invalid/);
    const user = base.teams[userId]!;
    const stale = { id: 'dp_2025_1_old', year: 2025, round: 1, originalTeamId: userId, ownerTeamId: userId, overall: null };
    const withStale = withTeam(base, { ...user, picks: [...user.picks, stale] });
    const past = evaluateTrade(withStale, createTradeOffer(withStale, userId, partnerId, [{ kind: 'pick', pick: stale }], []));
    expect(past.reason).toMatch(/^invalid: .* past draft/);
  });

  it('an AI team never trades away its only kicker, even for a big overpay', () => {
    const { league, userId, partnerId } = setup();
    const kickers = rosterOf(league, partnerId).filter((p) => p.position === 'K');
    expect(kickers).toHaveLength(1);
    const overpay = [pickOf(league, userId, 1), pickOf(league, userId, 2)];
    const ev = evaluateTrade(league, createTradeOffer(league, userId, partnerId, overpay, [playerAsset(kickers[0]!)]));
    expect(ev.accepted).toBe(false);
    expect(ev.reason).toMatch(/^depth: .* without enough at K/);
    // a kicker coming back in the same deal keeps the position staffed
    const userKicker = rosterOf(league, userId).find((p) => p.position === 'K')!;
    const swap = evaluateTrade(league, createTradeOffer(league, userId, partnerId, [...overpay, playerAsset(userKicker)], [playerAsset(kickers[0]!)]));
    expect(swap.reason).not.toMatch(/^depth/);
  });
});

describe('AI trades', () => {
  it('AI proposals are offers their partners accept, and AI activity keeps the league consistent', () => {
    const league = buildLeague({ seed: 17, phase: 'regularSeason', week: 4 });
    const evaluate = (l: League, o: Parameters<typeof evaluateTrade>[1]) => evaluateTrade(l, o);
    let proposals = 0;
    for (const team of teamsSorted(league).slice(0, 12)) {
      const offers = aiTradeProposals(league, team.id, createRng(team.id), evaluate);
      expect(offers.length).toBeLessThanOrEqual(2);
      for (const o of offers) {
        expect(o.fromTeam).toBe(team.id);
        expect(evaluateTrade(league, o).accepted).toBe(true);
      }
      proposals += offers.length;
    }
    expect(proposals).toBeGreaterThan(0);
    const a = runAiTradeActivity(league, createRng(9), { activity: 1, maxTrades: 3 });
    const b = runAiTradeActivity(league, createRng(9), { activity: 1, maxTrades: 3 });
    expect(a.pendingTrades.filter((t) => t.status === 'accepted').length).toBeGreaterThan(0);
    expect(a.pendingTrades).toEqual(b.pendingTrades);
    expect(rosterErrors(a)).toEqual([]);
    expect(() => validateLeague(a)).not.toThrow();
  });

  it('AI offers to the user wait in pendingTrades until the user answers', () => {
    const { league } = setup();
    const withOffers = runAiTradeActivity(league, createRng(5), { activity: 0, offersToUser: 1 });
    const pending = withOffers.pendingTrades.filter((t) => t.status === 'pending');
    expect(pending).toHaveLength(1);
    const offer = pending[0]!;
    expect(offer.toTeam).toBe(league.userTeamId);
    expect(offer.initiatedBy).toBe(offer.fromTeam);
    const incoming = offer.fromAssets.find((x) => x.kind === 'player') ?? offer.fromAssets[0]!;
    const done = respondToTrade(withOffers, offer.id, true);
    if (incoming.kind === 'player') expect(done.players[incoming.playerId as PlayerId]!.teamId).toBe(league.userTeamId);
    expect(done.pendingTrades.find((t) => t.id === offer.id)!.status).toBe('accepted');
    expect(rosterErrors(done)).toEqual([]);
  });
});
