import { describe, expect, it } from 'vitest';
import type { PlayerId } from '@/core/ids';
import { createRng } from '@/core/rng';
import type { League, TradeOffer } from '@/franchise/types';
import { leagueCapYear } from '@/franchise/contracts';
import { evaluateTrade, executeTrade, runAiTradeActivity } from '@/franchise/trades';
import { aiTradeProposals } from '@/franchise/gm/roster-ai';
import { teamNeeds } from '@/franchise/gm/needs';
import { isUntouchable } from '@/franchise/gm/valuation';
import { BLOCK_TUNING, aiBlockCandidates, blockDemand, isOnTradeBlock, refreshAiTradeBlocks, tradeBlockOf, withoutTradeBlock } from '@/franchise/gm/trade-block';
import { ensureClub, withClub } from '@/franchise/rivalries';
import { buildLeague, teamByAbbr, withTeam } from './helpers';

const base = buildLeague({ seed: 13, userTeamAbbr: 'BOS', phase: 'regularSeason', week: 5 });
const user = teamByAbbr(base, 'BOS');
const list = (league: League, ids: readonly PlayerId[]): League =>
  withClub(league, { playerFlags: { ...ensureClub(league).playerFlags, ...Object.fromEntries(ids.map((id) => [id, ['tradeBlock' as const]])) } });

describe('trading block', () => {
  it('AI teams list a couple of spare, non-cornerstone players; the user\'s block is his own', () => {
    const userListed = list(base, [user.rosterIds[5]!]);
    const l = refreshAiTradeBlocks(userListed);
    const year = leagueCapYear(l);
    let listedTeams = 0;
    for (const t of Object.values(l.teams)) {
      const block = tradeBlockOf(l, t.id);
      if (t.id === user.id) {
        expect(block).toEqual([user.rosterIds[5]]);
        continue;
      }
      expect(block.length).toBeLessThanOrEqual(BLOCK_TUNING.maxPerAiTeam);
      expect(new Set(block)).toEqual(new Set(aiBlockCandidates(l, t)));
      for (const id of block) expect(isUntouchable(l.players[id]!, year, l.settings)).toBe(false);
      if (block.length > 0) listedTeams++;
    }
    expect(listedTeams).toBeGreaterThan(10);
    expect(refreshAiTradeBlocks(l)).toBe(l);
  });

  it('AI proposals go after players on the user\'s block first', () => {
    let plain = 0;
    let listed = 0;
    for (const t of Object.values(base.teams)) {
      if (t.id === user.id) continue;
      const needs = teamNeeds(base, t);
      const league = withTeam(base, { ...t, finances: { ...t.finances, capCarryover: 60_000_000 } });
      const positions = needs.ranked.filter((p) => needs.positions[p].need >= 0.3).slice(0, 3);
      const fits = user.rosterIds.map((id) => base.players[id]!).filter((p) => positions.includes(p.position) && p.overall >= needs.positions[p.position].weakestStarter + 2);
      if (fits.length < 2) continue;
      const pick = fits[fits.length - 1]!;
      const targets = (l: League): boolean => aiTradeProposals(l, t.id, createRng(t.id), (x, o) => evaluateTrade(x, o), { partnerIds: [user.id], includeUserTeam: true, max: 1 })
        .some((o) => o.toAssets.some((a) => a.kind === 'player' && a.playerId === pick.id));
      if (targets(league)) plain++;
      if (targets(list(league, [pick.id]))) listed++;
    }
    expect(listed).toBeGreaterThanOrEqual(plain + 3);
  });

  it('an AI team asks less for a player it has listed', () => {
    const ai = Object.values(base.teams).find((t) => t.id !== user.id && aiBlockCandidates(base, t).length > 0)!;
    const target = aiBlockCandidates(base, ai)[0]!;
    const offer: TradeOffer = {
      id: 'tb1', fromTeam: user.id, toTeam: ai.id, fromAssets: [], toAssets: [{ kind: 'player', playerId: target }], status: 'pending', year: base.year, week: 5, initiatedBy: user.id,
    };
    const unlisted = evaluateTrade(base, offer, { counter: false });
    const listedEval = evaluateTrade(list(base, [target]), offer, { counter: false });
    expect(listedEval.valueGiven).toBeLessThan(unlisted.valueGiven);
    expect(listedEval.valueGiven).toBeGreaterThanOrEqual(Math.floor(unlisted.valueGiven * BLOCK_TUNING.sellDiscount) - 1);
  });

  it('runAiTradeActivity re-lists AI blocks and sends offers from teams that want the user\'s listed players', () => {
    const out = runAiTradeActivity(base, createRng(3), { activity: 0, offersToUser: 1 });
    const aiListed = Object.values(out.teams).filter((t) => t.id !== user.id && tradeBlockOf(out, t.id).length > 0);
    expect(aiListed.length).toBeGreaterThan(10);
    expect(Object.values(out.teams).reduce((n, t) => n + blockDemand(out, t), 0)).toBeGreaterThan(0);
    // List user players that other teams need, and the pending offer comes for one of them more often than not.
    let hits = 0;
    let offers = 0;
    for (let seed = 1; seed <= 6; seed++) {
      const ranked = user.rosterIds.map((id) => base.players[id]!).filter((p) => !isUntouchable(p, leagueCapYear(base), base.settings)).sort((a, b) => b.overall - a.overall);
      const shop = ranked.slice(seed, seed + 3).map((p) => p.id);
      const r = runAiTradeActivity(list(base, shop), createRng(seed), { activity: 0, offersToUser: 1 });
      const pending = r.pendingTrades.filter((t) => t.status === 'pending' && t.toTeam === user.id);
      offers += pending.length;
      if (pending.some((t) => t.toAssets.some((a) => a.kind === 'player' && shop.includes(a.playerId)))) hits++;
      for (const id of shop) expect(isOnTradeBlock(r, id)).toBe(true);
    }
    expect(offers).toBeGreaterThan(0);
    expect(hits).toBeGreaterThan(0);
  });

  it('a traded or released player is off the block: an AI listing never lands on the user\'s block', () => {
    const l = refreshAiTradeBlocks(base);
    const ai = Object.values(l.teams).find((t) => t.id !== user.id && tradeBlockOf(l, t.id).length > 0)!;
    const target = tradeBlockOf(l, ai.id)[0]!;
    const offer: TradeOffer = {
      id: 'tb2', fromTeam: ai.id, toTeam: user.id, fromAssets: [{ kind: 'player', playerId: target }], toAssets: [], status: 'pending', year: l.year, week: 5, initiatedBy: ai.id,
    };
    const after = executeTrade(l, offer);
    expect(after.players[target]!.teamId).toBe(user.id);
    expect(isOnTradeBlock(after, target)).toBe(false);
    expect(tradeBlockOf(after, user.id)).not.toContain(target);
    expect(isOnTradeBlock(l, target)).toBe(true); // the input League is untouched
    expect(withoutTradeBlock(after, [target])).toBe(after);
    // A listed player who became a free agent is dropped at the next refresh.
    const team = l.teams[ai.id]!;
    const freed: League = {
      ...l, players: { ...l.players, [target]: { ...l.players[target]!, teamId: null } }, freeAgentIds: [...l.freeAgentIds, target],
      teams: { ...l.teams, [ai.id]: { ...team, rosterIds: team.rosterIds.filter((id) => id !== target) } },
    };
    expect(isOnTradeBlock(refreshAiTradeBlocks(freed), target)).toBe(false);
  });
});
