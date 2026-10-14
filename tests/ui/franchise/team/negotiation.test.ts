import { describe, expect, it } from 'vitest';
import type { PlayerId } from '@/core/ids';
import { contractApy, leagueCapYear, minimumSalaryFor, type ContractTerms } from '@/franchise/contracts';
import type { League } from '@/franchise/types';
import type { Player } from '@/players/types';
import { ChoiceDialog, StepperDialog } from '@/ui/franchise/kit/dialogs';
import {
  OFFER_ROLES, PREFERENCE_LABELS, appealTone, askTerms, buildNegotiation, offerFields, offerFromValues, offerInterest, offerSummary, openingOffer,
  preferenceRows, submitExtension, validateOffer,
} from '@/ui/franchise/team/negotiation-model';
import { NegotiationScreen } from '@/ui/franchise/team/negotiation-screen';
import { baseLeague, mount, press, rcFor, topAs, userId, userPlayer } from './helpers';

const lowOffer = (league: League, p: Player): ContractTerms => ({ salary: minimumSalaryFor(p.experience, league.settings), years: 1, guaranteed: 0, signingBonus: 0, role: 'developmental' });
const rich = (offer: ContractTerms): ContractTerms => ({ ...offer, salary: Math.round(offer.salary * 1.3), guaranteed: offer.salary * offer.years });

/** A starter whose counter he would then sign. */
const counterCase = (league: League): { p: Player; counter: ContractTerms } => {
  const team = userId(league);
  for (const id of league.teams[team]?.rosterIds ?? []) {
    const p = league.players[id];
    if (!p?.contract || p.overall < 60) continue;
    const r = submitExtension(league, team, p.id, lowOffer(league, p));
    if (r.counter && submitExtension(league, team, p.id, r.counter).ok) return { p, counter: r.counter };
  }
  throw new Error('no counter case');
};

const brokeLeague = (league: League): League => {
  const team = league.teams[userId(league)];
  if (!team) throw new Error('team');
  const y = leagueCapYear(league);
  return { ...league, teams: { ...league.teams, [team.id]: { ...team, finances: { ...team.finances, deadMoney: { [y]: league.settings.salaryCap * 2, [y + 1]: league.settings.salaryCap * 2 } } } } };
};

describe('negotiation model', () => {
  it('opens at his ask and shows the staff\'s banded read of an offer (never his exact bar)', () => {
    const league = baseLeague();
    const team = userId(league);
    const p = userPlayer(league, 'QB');
    const offer = openingOffer(league, team, p.id);
    if (!offer) throw new Error('offer');
    const view = buildNegotiation(league, team, p.id, offer, null, null);
    expect(view && askTerms(view.ask)).toEqual(offer);
    const generous = rich(offer);
    const likely = offerInterest(league, team, p.id, generous);
    expect(likely.text.text).toBe('Likely to sign');
    expect(submitExtension(league, team, p.id, generous).ok).toBe(true);
    const low = offerInterest(league, team, p.id, lowOffer(league, p));
    expect(low.estimate).toBeLessThan(likely.estimate);
    expect(['Close', 'Far apart', 'Likely to sign']).toContain(low.text.text);
    // A refusal is a recorded round: the talks line moves on (a player who turns the low offer down).
    const { p: q } = counterCase(league);
    const qOffer = openingOffer(league, team, q.id) as ContractTerms;
    expect(buildNegotiation(league, team, q.id, qOffer, null, null)?.lines.find((l) => l.id === 'talks')?.value).toMatchObject({ text: expect.stringMatching(/^Opening offer · /) });
    const refusedLow = submitExtension(league, team, q.id, lowOffer(league, q));
    expect(refusedLow.ok).toBe(false);
    const talks = buildNegotiation(refusedLow.league, team, q.id, qOffer, null, null)?.lines.find((l) => l.id === 'talks')?.value as { text: string };
    expect(talks.text).toMatch(/^Round 2 · /);
    const prefs = preferenceRows(league, team, p.id, offer);
    expect(prefs.map((r) => r.label)).toEqual(Object.values(PREFERENCE_LABELS));
    expect(prefs.reduce((s, r) => s + r.weight, 0)).toBeCloseTo(1, 6);
    expect(prefs.every((r) => r.appeal >= 0 && r.appeal <= 1)).toBe(true);
    expect(appealTone(0.9)).toBe('success');
    expect(appealTone(0.1)).toBe('danger');
    expect(openingOffer(league, team, 'p_missing' as PlayerId)).toBeNull();
    expect(offerInterest(league, team, 'p_missing' as PlayerId, offer).text.text).toBe('Not under contract');
  });
  it('signs accepted deals, refuses over the cap with the reason and counters low offers', () => {
    const league = baseLeague();
    const team = userId(league);
    const p = userPlayer(league, 'QB');
    const offer = openingOffer(league, team, p.id) as ContractTerms;
    const yes = submitExtension(league, team, p.id, rich(offer));
    expect(yes.league.players[p.id]?.contract?.signedYear).toBe(leagueCapYear(league));
    expect(yes.message).toContain('signed');
    const broke = brokeLeague(league);
    const capped = submitExtension(broke, team, p.id, rich(offer));
    expect(capped.ok).toBe(false);
    expect(capped.reason).toMatch(/^Refused: cap: /);
    expect(capped.counter).toBeNull();
    expect(offerInterest(broke, team, p.id, rich(offer)).text).toEqual({ text: 'Over the cap', tone: 'danger' });
    const { p: q, counter } = counterCase(league);
    const no = submitExtension(league, team, q.id, lowOffer(league, q));
    expect(no.ok).toBe(false);
    expect(no.counter).toEqual(counter);
    expect(no.message).toContain(`${q.firstName} ${q.lastName} wants`);
    expect(submitExtension(league, team, q.id, { ...offer, guaranteed: offer.salary * offer.years + 1 }).ok).toBe(false);
    expect(submitExtension(league, team, 'p_missing' as PlayerId, offer).ok).toBe(false);
    for (const bad of [{ ...offer, years: 0 }, { ...offer, years: 8 }, { ...offer, years: 2.5 }, { ...offer, salary: -1 }, { ...offer, signingBonus: Number.NaN }]) {
      const r = submitExtension(league, team, q.id, bad);
      expect(r.ok).toBe(false);
      expect(r.league).toBe(league);
    }
  });
  it('maps stepper values to terms and validates them', () => {
    const league = baseLeague();
    const p = userPlayer(league, 'QB');
    const offer = openingOffer(league, userId(league), p.id) as ContractTerms;
    const fields = offerFields(league, p, offer);
    expect(fields.map((f) => f.id)).toEqual(['salary', 'years', 'bonus', 'guaranteed']);
    expect(fields[0]?.min).toBe(minimumSalaryFor(p.experience, league.settings));
    const terms = offerFromValues({ salary: 5e6, years: 3, bonus: 3e6, guaranteed: 4e6 }, 'starter');
    expect(terms).toEqual({ salary: 5e6, years: 3, signingBonus: 3e6, guaranteed: 4e6, role: 'starter' });
    expect(validateOffer({ salary: 1e6, years: 2, guaranteed: 3e6 })).toContain('exceeds');
    expect(validateOffer({ salary: 1e6, years: 2, guaranteed: 2e6 })).toBeNull();
    expect(offerSummary({ salary: 5e6, years: 3, bonus: 3e6 }, 6e6)).toBe('APY $6.0M · ask $6.0M');
    expect(OFFER_ROLES).toHaveLength(5);
  });
});

describe('NegotiationScreen', () => {
  it('edits terms through the stepper, picks a role, and submits with Start', () => {
    const league = baseLeague();
    const p = userPlayer(league, 'QB');
    const { fc, screen } = mount(league, (f) => new NegotiationScreen(f, p.id));
    const rc = rcFor(fc);
    screen.render(rc);
    expect(screen.offerTable.selected?.id).toBe('submit');
    expect(screen.view?.lines.map((l) => l.id)).toEqual(expect.arrayContaining(['ask', 'salary', 'years', 'bonus', 'guaranteed', 'role', 'apy', 'cap', 'interest', 'submit', 'match']));
    screen.offerTable.selectById('years');
    press(fc, 'confirm');
    const stepper = topAs(fc, StepperDialog);
    expect(stepper.model.focused.id).toBe('years');
    stepper.render(rc);
    press(fc, 'menuRight');
    const years = stepper.model.value('years');
    press(fc, 'confirm');
    expect(screen.offer?.years).toBe(years);
    screen.offerTable.selectById('role');
    press(fc, 'confirm');
    topAs(fc, ChoiceDialog).choose('backup');
    expect(screen.offer?.role).toBe('backup');
    screen.matchAsk();
    expect(screen.offer).toEqual(askTerms(screen.view?.ask ?? (null as never)));
    press(fc, 'menuTabRight');
    expect(screen.section).toBe('prefs');
    screen.render(rc);
    press(fc, 'menuRight');
    press(fc, 'menuTabLeft');
    const offer = screen.offer as ContractTerms;
    screen.setOffer(rich(offer));
    press(fc, 'pause');
    expect(fc.commits.at(-1)?.reason).toBe('signing');
    expect(fc.pops()).toBe(1);
    expect(fc.league().players[p.id]?.contract?.salary).toBe(rich(offer).salary);
  });
  it('shows his counter after a refusal and signs it from the counter row', () => {
    const league = baseLeague();
    const { p, counter } = counterCase(league);
    const { fc, screen } = mount(league, (f) => new NegotiationScreen(f, p.id));
    screen.setOffer(lowOffer(league, p));
    expect(screen.submit()).toBe(false);
    expect(screen.counter).toEqual(counter);
    expect(screen.offerTable.selected?.id).toBe('counter');
    expect(screen.view?.lines.find((l) => l.id === 'answer')).toBeDefined();
    // The refused round is committed ('edit') so the talks remember it.
    expect(fc.commits.map((c) => c.reason)).toEqual(['edit']);
    press(fc, 'confirm');
    expect(fc.commits.map((c) => c.reason)).toEqual(['edit', 'signing']);
    const signed = fc.league().players[p.id]?.contract;
    expect(signed?.years).toBe(counter.years);
    expect(signed?.salary).toBe(counter.salary);
    expect(contractApy(signed as never)).toBeGreaterThanOrEqual(contractApy(counter));
  });
  it('shows the cap reason, renders in large text and handles players without a deal', () => {
    const league = brokeLeague(baseLeague());
    const p = userPlayer(league, 'QB');
    const { fc, screen } = mount(league, (f) => new NegotiationScreen(f, p.id), { settings: { textSize: 'large' } });
    screen.render(rcFor(fc));
    expect(screen.view?.lines.find((l) => l.id === 'cap')?.value).toMatchObject({ tone: 'danger' });
    screen.submit();
    expect(fc.toasts.at(-1)).toMatch(/^Refused: cap/);
    expect(screen.counter).toBeNull();
    expect(screen.hints().map((h) => h.label)).toEqual(['Section', 'Edit', 'Submit', 'Back']);
    press(fc, 'back');
    expect(fc.pops()).toBe(1);
    const fa = league.freeAgentIds[0] as PlayerId;
    const none = mount(league, (f) => new NegotiationScreen(f, fa));
    expect(none.screen.view).toBeNull();
    expect(none.screen.editTerms()).toBeNull();
    expect(none.screen.pickRole()).toBeNull();
    expect(none.screen.submit()).toBe(false);
    none.screen.render(rcFor(none.fc));
    press(none.fc, 'confirm');
    expect(none.fc.pops()).toBe(1);
  });
});
