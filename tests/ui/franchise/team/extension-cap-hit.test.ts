import { describe, expect, it } from 'vitest';
import { contractApy, contractEndYear, extend, leagueCapYear, unamortizedBonus } from '@/franchise/contracts';
import { formatMoney } from '@/ui/franchise/kit/format';
import { buildNegotiation, extendedApy, openingOffer, submitExtension } from '@/ui/franchise/team/negotiation-model';
import { baseLeague, userId } from './helpers';

describe('extension preview shows the real cap hit (APP2-07)', () => {
  it('adds the old deal\'s unamortised bonus, matching what the signed contract costs', () => {
    const league = baseLeague();
    const team = userId(league);
    const year = leagueCapYear(league);
    const p = (league.teams[team]?.rosterIds ?? []).map((id) => league.players[id])
      .find((q) => q?.contract && q.contract.signingBonus > 0 && year <= contractEndYear(q.contract) && unamortizedBonus(q.contract, year) > 0);
    if (!p?.contract) throw new Error('no player with a live signing bonus');
    const offer = openingOffer(league, team, p.id);
    if (!offer) throw new Error('no offer');
    const hit = extendedApy(p, offer, year);
    const signedApy = contractApy(extend(p, offer, year).contract ?? offer);
    expect(hit).toBe(signedApy);
    expect(hit).toBeGreaterThan(contractApy(offer));
    const view = buildNegotiation(league, team, p.id, offer, null, null);
    const line = view?.lines.find((l) => l.id === 'caphit');
    const text = typeof line?.value === 'string' ? line.value : line?.value.text;
    expect(text).toContain(formatMoney(hit));
    expect(text).toMatch(/old bonus/);
    const r = submitExtension(league, team, p.id, offer);
    if (r.ok) expect(contractApy(r.league.players[p.id]?.contract ?? offer)).toBe(hit);
  });
});
