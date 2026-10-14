/**
 * Contract-extension negotiation view-model (pure). The offer starts at the player's extension ask; the view
 * shows his ask, the current deal, the offer terms, its APY, the cap check (extensionCapIssue, the same rule
 * offerExtension applies), an interest meter, the state of the talks (round, his patience, a break-off), his
 * counter after a refusal and the per-preference breakdown (how much he cares about each factor and how well the
 * offer does on it). The interest meter is the staff's banded read (extension-talks.ts interestEstimate: noisy,
 * better with a better staff), never his exact bar, so the minimum acceptable offer cannot be found by probing
 * the meter; probing by submitting costs rounds and patience.
 */
import type { PlayerId, TeamId } from '@/core/ids';
import { contractApy, extend, leagueCapYear, MAX_CONTRACT_YEARS, minimumSalaryFor, type ContractTerms } from '@/franchise/contracts';
import {
  PREFERENCE_KEYS, extensionAsk, extensionCapIssue, preferenceBreakdown, preferenceWeights, type ContractAsk, type PreferenceKey,
} from '@/franchise/negotiation';
import { currentTalks, interestEstimate, offerExtension, patienceText, type InterestBand } from '@/franchise/extension-talks';
import type { League } from '@/franchise/types';
import { fullName, type ContractRole, type Player } from '@/players/types';
import type { CellValue } from '../kit/data-table';
import type { StepperSpec } from '../kit/dialog-models';
import { formatContract, formatMoney, humanize, type Tone, type ToneText } from '../kit/format';
import { done, moneyPrecise, refused, type ActionResult } from './common';

/** Display names of the preference factors. */
export const PREFERENCE_LABELS: Readonly<Record<PreferenceKey, string>> = Object.freeze({
  money: 'Money', playingTime: 'Playing time', winning: 'Winning', location: 'Location', coach: 'Coach', role: 'Role', chemistry: 'Chemistry',
});

/** Contract roles offered in the role picker, most prominent first. */
export const OFFER_ROLES: readonly ContractRole[] = ['franchise', 'starter', 'rotation', 'backup', 'developmental'];

/** Terms of an ask (drops apy/year). */
export const askTerms = (ask: ContractAsk): ContractTerms => ({ salary: ask.salary, years: ask.years, guaranteed: ask.guaranteed, signingBonus: ask.signingBonus, role: ask.role });

const context = (league: League, teamId: TeamId, playerId: PlayerId): { player: Player; ask: ContractAsk } | null => {
  const player = league.players[playerId];
  const team = league.teams[teamId];
  if (!player || !team || player.teamId !== teamId || !player.contract) return null;
  return { player, ask: extensionAsk(player, league, team, leagueCapYear(league)) };
};

/** The opening offer: exactly his ask. Null when he is not under contract with the team. */
export const openingOffer = (league: League, teamId: TeamId, playerId: PlayerId): ContractTerms | null => {
  const ctx = context(league, teamId, playerId);
  return ctx ? askTerms(ctx.ask) : null;
};

/** How an offer would land, as the staff reads it. */
export interface Interest {
  /** Band of the staff's read ('none' when he is not under contract, 'cap' over the cap, 'off' after a break-off). */
  band: InterestBand | 'cap' | 'off' | 'none';
  /** The staff's noisy read of the margin over his bar (not the exact bar). */
  estimate: number;
  /** Cap problem (the offer is refused before he sees it), or null. */
  capIssue: string | null;
  text: ToneText;
}

const BAND_TEXT: Readonly<Record<InterestBand, ToneText>> = {
  likely: { text: 'Likely to sign', tone: 'success' }, close: { text: 'Close', tone: 'warning' }, far: { text: 'Far apart', tone: 'danger' },
};

/** Interest in `offer` (Likely / Close / Far apart from the staff's read, the cap problem, or broken-off talks). */
export const offerInterest = (league: League, teamId: TeamId, playerId: PlayerId, offer: ContractTerms): Interest => {
  const ctx = context(league, teamId, playerId);
  const read = ctx ? interestEstimate(league, teamId, playerId, offer) : null;
  if (!ctx || !read) return { band: 'none', estimate: 0, capIssue: null, text: { text: 'Not under contract', tone: 'dim' } };
  const capIssue = extensionCapIssue(league, teamId, ctx.player, offer, leagueCapYear(league));
  if (capIssue) return { band: 'cap', estimate: read.estimate, capIssue, text: { text: 'Over the cap', tone: 'danger' } };
  if (read.talks.brokenOff) return { band: 'off', estimate: read.estimate, capIssue, text: { text: 'Not talking', tone: 'danger' } };
  return { band: read.band, estimate: read.estimate, capIssue, text: BAND_TEXT[read.band] };
};

/** State of the talks: "Round 2 · Wearing thin" (null when he is not under contract). */
export const talksLine = (league: League, teamId: TeamId, playerId: PlayerId): ToneText | null => {
  const t = context(league, teamId, playerId) ? currentTalks(league, playerId, teamId) : null;
  if (!t) return null;
  const tone = t.brokenOff || t.patience < 0.35 ? 'danger' : t.patience < 0.7 ? 'warning' : 'success';
  return { text: `${t.rounds === 0 ? 'Opening offer' : `Round ${t.rounds + 1}`} · ${patienceText(t)}`, tone };
};

/** One factor of the preference breakdown. */
export interface PreferenceRow {
  key: PreferenceKey;
  label: string;
  /** Share of his decision this factor carries (0..1, sums to 1). */
  weight: number;
  /** How well the offer does on it (0..1). */
  appeal: number;
}

/** Per-factor weight and appeal of `offer`. */
export const preferenceRows = (league: League, teamId: TeamId, playerId: PlayerId, offer: ContractTerms): PreferenceRow[] => {
  const ctx = context(league, teamId, playerId);
  const team = league.teams[teamId];
  if (!ctx || !team) return [];
  const parts = preferenceBreakdown(ctx.player, team, offer, league, { ask: ctx.ask });
  const w = preferenceWeights(ctx.player.preferences);
  const total = PREFERENCE_KEYS.reduce((s, k) => s + w[k], 0) || 1;
  return PREFERENCE_KEYS.map((key) => ({ key, label: PREFERENCE_LABELS[key], weight: w[key] / total, appeal: parts[key] }));
};

/** Tone of an appeal value. */
export const appealTone = (appeal: number): Tone => (appeal >= 0.7 ? 'success' : appeal >= 0.4 ? 'normal' : appeal >= 0.2 ? 'warning' : 'danger');

/** Stepper fields for the offer (salary, years, bonus, guaranteed). */
export const offerFields = (league: League, player: Player, offer: ContractTerms): StepperSpec[] => {
  const cap = league.settings.salaryCap;
  const minSalary = minimumSalaryFor(player.experience, league.settings);
  const salaryMax = Math.max(Math.round(cap * 0.35), offer.salary * 2, minSalary + 1_000_000);
  const bonusMax = Math.max(Math.round(cap * 0.3), offer.signingBonus * 2, 1_000_000);
  const gtdMax = Math.max(salaryMax * MAX_CONTRACT_YEARS, offer.guaranteed);
  return [
    { id: 'salary', label: 'Salary / yr', min: minSalary, max: salaryMax, step: 50_000, bigStep: 1_000_000, value: offer.salary, format: moneyPrecise },
    { id: 'years', label: 'Years', min: 1, max: MAX_CONTRACT_YEARS, step: 1, bigStep: 2, value: offer.years },
    { id: 'bonus', label: 'Signing bonus', min: 0, max: bonusMax, step: 100_000, bigStep: 1_000_000, value: offer.signingBonus, format: moneyPrecise },
    { id: 'guaranteed', label: 'Guaranteed', min: 0, max: gtdMax, step: 100_000, bigStep: 1_000_000, value: offer.guaranteed, format: moneyPrecise },
  ];
};

/** Terms from stepper values plus the chosen role. */
export const offerFromValues = (values: Record<string, number>, role: ContractRole): ContractTerms => ({
  salary: Math.round(values.salary ?? 0), years: Math.round(values.years ?? 1), signingBonus: Math.round(values.bonus ?? 0), guaranteed: Math.round(values.guaranteed ?? 0), role,
});

/** Error for impossible terms, or null. */
export const validateOffer = (values: Record<string, number>): string | null => {
  const total = (values.salary ?? 0) * (values.years ?? 1);
  if ((values.guaranteed ?? 0) > total) return `Guarantee exceeds total salary (${formatMoney(total)})`;
  return null;
};

/** Stepper summary: APY of the values against his ask. */
export const offerSummary = (values: Record<string, number>, askApy: number): string => {
  const years = Math.max(1, values.years ?? 1);
  const apy = (values.salary ?? 0) + (values.bonus ?? 0) / years;
  return `APY ${formatMoney(apy)} · ask ${formatMoney(askApy)}`;
};

/** Outcome of a submitted offer. */
export interface ExtensionOutcome extends ActionResult {
  /** His counter terms after a refusal on merit (null when accepted or refused over the cap). */
  counter: ContractTerms | null;
}

/**
 * Submits the offer through extension-talks.ts offerExtension (terms validated first: 1..MAX_CONTRACT_YEARS whole
 * years, non-negative money, guarantee within total salary). A refusal on merit still returns a changed League (the
 * round is recorded, or he broke off talks): callers must commit it.
 */
export const submitExtension = (league: League, teamId: TeamId, playerId: PlayerId, offer: ContractTerms): ExtensionOutcome => {
  const p = league.players[playerId];
  if (!p || p.teamId !== teamId || !p.contract) return { ...refused(league, 'He is not under contract with your team'), counter: null };
  if (!Number.isInteger(offer.years) || offer.years < 1 || offer.years > MAX_CONTRACT_YEARS) return { ...refused(league, `Offer 1-${MAX_CONTRACT_YEARS} years`), counter: null };
  if ([offer.salary, offer.signingBonus, offer.guaranteed].some((v) => !Number.isFinite(v) || v < 0)) return { ...refused(league, 'Invalid offer terms'), counter: null };
  if (offer.guaranteed > offer.salary * offer.years) return { ...refused(league, 'Guarantee exceeds total salary'), counter: null };
  const r = offerExtension(league, teamId, playerId, offer);
  if (r.accepted) {
    const signed = r.league.players[playerId]?.contract ?? null;
    return { ...done(r.league, `${fullName(p)} signed: ${formatContract(signed)}`), counter: null };
  }
  if (r.reason) return { ...refused(r.league, `Refused: ${r.reason}`), counter: null };
  const counter = r.counter;
  return { ...refused(r.league, counter ? `${fullName(p)} wants ${formatMoney(contractApy(counter))}/yr for ${counter.years}y` : `${fullName(p)} said no`), counter };
};

/** Row ids of the offer section that do something on Confirm. */
export type OfferAction = 'salary' | 'years' | 'bonus' | 'guaranteed' | 'role' | 'match' | 'counter' | 'submit';

/** One row of the offer section. */
export interface OfferLine {
  id: string;
  label: string;
  value: CellValue;
  heading?: boolean;
  action?: OfferAction;
}

/**
 * The signed deal's real yearly cap hit: an extension carries the old deal's unamortised bonus into the new one
 * (contracts.ts extend), so the cap hit can exceed the offer's own APY.
 */
export const extendedApy = (player: Player, offer: ContractTerms, year: number): number => {
  try {
    const c = extend(player, offer, year).contract;
    return c ? contractApy(c) : contractApy(offer);
  } catch {
    return contractApy(offer);
  }
};

const capHitLine = (player: Player, offer: ContractTerms, year: number, apy: number): OfferLine => {
  const hit = extendedApy(player, offer, year);
  const extra = hit - apy;
  return { id: 'caphit', label: 'Cap hit / yr', value: extra > 0 ? { text: `${formatMoney(hit)} (+${formatMoney(extra)} old bonus)`, tone: 'warning' } : formatMoney(hit) };
};

/** Everything the negotiation screen shows for the current offer. */
export interface NegotiationView {
  playerId: PlayerId;
  title: string;
  subtitle: string;
  ask: ContractAsk;
  offer: ContractTerms;
  interest: Interest;
  lines: OfferLine[];
  prefs: PreferenceRow[];
}

/** Builds the negotiation view; null when he is not under contract with the team. */
export const buildNegotiation = (
  league: League, teamId: TeamId, playerId: PlayerId, offer: ContractTerms, counter: ContractTerms | null, lastAnswer: ToneText | null,
): NegotiationView | null => {
  const ctx = context(league, teamId, playerId);
  if (!ctx) return null;
  const { player, ask } = ctx;
  const interest = offerInterest(league, teamId, playerId, offer);
  const apy = contractApy(offer);
  const lines: OfferLine[] = [
    { id: 'h-ask', label: 'His position', value: '', heading: true },
    { id: 'ask', label: 'Asking', value: { text: formatContract({ ...askTerms(ask), yearsRemaining: ask.years, signedYear: ask.year, restructured: false, tag: null }), tone: 'info' }, action: 'match' },
    { id: 'current', label: 'Current deal', value: formatContract(player.contract, { remaining: true }) },
    { id: 'h-offer', label: 'Your offer', value: '', heading: true },
    { id: 'salary', label: 'Salary / yr', value: moneyPrecise(offer.salary), action: 'salary' },
    { id: 'years', label: 'Years', value: String(offer.years), action: 'years' },
    { id: 'bonus', label: 'Signing bonus', value: moneyPrecise(offer.signingBonus), action: 'bonus' },
    { id: 'guaranteed', label: 'Guaranteed', value: moneyPrecise(offer.guaranteed), action: 'guaranteed' },
    { id: 'role', label: 'Role', value: humanize(offer.role), action: 'role' },
    { id: 'apy', label: 'APY (new money)', value: { text: `${formatMoney(apy)} (${apy >= ask.apy ? '+' : '-'}${formatMoney(Math.abs(apy - ask.apy))} vs ask)`, tone: apy >= ask.apy ? 'success' : 'warning' } },
    capHitLine(player, offer, leagueCapYear(league), apy),
    { id: 'cap', label: 'Cap check', value: interest.capIssue ? { text: interest.capIssue, tone: 'danger' } : { text: 'Fits under the cap', tone: 'success' } },
    { id: 'interest', label: 'Interest (staff read)', value: interest.text },
  ];
  const talks = talksLine(league, teamId, playerId);
  if (talks) lines.push({ id: 'talks', label: 'Talks', value: talks });
  if (lastAnswer) lines.push({ id: 'answer', label: 'Last answer', value: lastAnswer });
  if (counter) lines.push({ id: 'counter', label: '▶ Accept his counter', value: { text: formatContract({ ...counter, yearsRemaining: counter.years, signedYear: ask.year, restructured: false, tag: null }), tone: 'accent' }, action: 'counter' });
  lines.push({ id: 'submit', label: '▶ Submit offer', value: { text: interest.text.text, tone: interest.text.tone }, action: 'submit' });
  lines.push({ id: 'match', label: '▶ Match his ask', value: { text: `${formatMoney(ask.apy)}/yr`, tone: 'info' }, action: 'match' });
  const pos = `${player.position} · Age ${player.age} · OVR ${player.overall}`;
  return {
    playerId, title: `Extend ${fullName(player)}`, subtitle: pos, ask, offer, interest, lines, prefs: preferenceRows(league, teamId, playerId, offer),
  };
};
