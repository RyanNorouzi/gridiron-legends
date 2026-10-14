/**
 * Free-agent detail (pushed full-screen from the free-agency tab) and the offer dialog.
 *
 * Overview: make / change an offer, the player card, bio, his ask of your team (playerAsk) and your offer's state.
 * Values: what he cares about (preferenceWeights, as shares with bars) and how your team scores on each at his ask
 * (preferenceBreakdown), plus the staff's banded read of an offer at his ask. The offer dialog is a kit StepperDialog
 * over salary / years / guarantee / bonus / role whose summary shows the staff's read of the terms (Likely / Close /
 * Far apart; never his exact bar) and the state of the talks (refused rounds, his patience, a walk-away).
 */
import type { PlayerId } from '@/core/ids';
import { contractApy } from '@/franchise/contracts';
import type { Player } from '@/players/types';
import type { InputState } from '../../input/types';
import type { Theme } from '../../theme';
import type { UiCtx } from '../../widgets/panel';
import type { FranchiseContext } from '../context';
import { StepperDialog } from '../kit/dialogs';
import { POSITION_NAMES, formatExperience, formatMoney, formatPercent, formatRating, humanize, type ToneText } from '../kit/format';
import type { Rect } from '../kit/list';
import { potentialVisibility } from '../kit/player-view';
import { InfoView, MarketScreen, actionRow, errorText, heading, info, sentence, type InfoRow, type MarketAction } from './common';
import { offerFields, offerProblem, placeOffer, preferenceView, termsFromValues, userPending, type PreferenceView } from './fa-model';

const pct = (v: number): string => formatPercent(v, 0);

/** Opens the offer stepper for a free agent (pre-filled with the current offer or his ask); `done` runs after a commit. */
export const openOfferDialog = (fc: FranchiseContext, playerId: PlayerId, done?: () => void): StepperDialog | null => {
  const league = fc.league();
  const user = fc.userTeamId;
  const player = league.players[playerId];
  if (!player) return null;
  const name = `${player.firstName} ${player.lastName}`;
  const ask = preferenceView(league, player, user).ask;
  const existing = userPending(league, user).current.find((o) => o.playerId === playerId);
  let memoKey = '';
  let memo: PreferenceView | null = null;
  const viewFor = (values: Record<string, number>): PreferenceView => {
    const key = JSON.stringify(values);
    if (!memo || key !== memoKey) {
      memo = preferenceView(fc.league(), player, user, termsFromValues(values));
      memoKey = key;
    }
    return memo;
  };
  const dialog = new StepperDialog(`Offer: ${name}`, `Asks ${formatMoney(ask.apy)}/yr for ${ask.years} yrs as ${humanize(ask.role)}`, offerFields(league, existing ?? ask), {
    confirmLabel: 'OFFER',
    summary: (v) => {
      const pv = viewFor(v);
      return `${formatMoney(contractApy(termsFromValues(v)))}/yr · staff read: ${pv.read.text.text}`;
    },
    validate: (v) => {
      const current = fc.league().players[playerId];
      const problem = current ? offerProblem(fc.league(), user, current, termsFromValues(v)) : 'unknown player';
      return problem ? sentence(problem) : null;
    },
    onResult: (v) => {
      if (!v) return;
      try {
        const before = fc.league();
        const next = placeOffer(before, user, playerId, termsFromValues(v));
        // Opening the market on the way (expired deals released) is a real transaction: autosave it.
        fc.commit(next, before.freeAgency ? 'edit' : 'signing');
        fc.toast(`Offer made to ${name} for round ${next.freeAgency?.round ?? 1}`);
        done?.();
      } catch (err) {
        fc.toast(sentence(errorText(err)));
      }
    },
  });
  fc.push(dialog);
  return dialog;
};

/** Overview rows of a free agent for the user's team. */
export const faOverviewRows = (fc: FranchiseContext, player: Player): InfoRow[] => {
  const league = fc.league();
  const user = fc.userTeamId;
  const view = preferenceView(league, player, user);
  const ask = view.ask;
  const pending = userPending(league, user);
  const current = pending.current.find((o) => o.playerId === player.id);
  const counter = pending.counters.find((o) => o.playerId === player.id);
  const offerText: ToneText = counter ? { text: `He countered at ${formatMoney(contractApy(counter))}/yr - see My Offers`, tone: 'warning' }
    : current ? { text: `${formatMoney(contractApy(current))}/yr for ${current.years} yrs (round ${current.round})`, tone: 'info' } : { text: 'None', tone: 'dim' };
  const free = player.teamId === null;
  return [
    ...(free ? [actionRow('offer', current ? 'Change offer' : 'Make offer')] : []),
    actionRow('card', 'Player card'),
    info('pos', 'Position', POSITION_NAMES[player.position]),
    info('age', 'Age', `${player.age} · ${formatExperience(player.experience)}`),
    info('ovr', 'Overall', formatRating(player.overall)),
    info('pot', 'Potential', potentialVisibility(league, player, user).text),
    info('ask', 'Asks your team', `${formatMoney(ask.apy)}/yr · ${ask.years} yrs · ${humanize(ask.role)}`),
    info('terms', 'Ask terms', `Salary ${formatMoney(ask.salary)} · gtd ${formatMoney(ask.guaranteed)} · bonus ${formatMoney(ask.signingBonus)}`),
    info('offer-state', 'Your offer', free ? offerText : { text: 'Signed', tone: 'success' }),
    info('read', 'Staff read at his ask', view.read.text),
    info('talks', 'Talks with you', view.talks.text),
    info('patience', 'Market patience', { text: view.patience >= 0.5 ? 'Will wait for the right deal' : view.patience >= 0.2 ? 'Getting ready to sign' : 'Wants to sign now', tone: 'normal' }),
  ];
};

/** "What he values" rows: preference shares and your team's appeal on each. */
export const faValueRows = (view: PreferenceView): InfoRow[] => {
  const maxShare = Math.max(...view.lines.map((l) => l.share), 0.01);
  return [
    heading('values-h', 'What he values most'),
    ...view.lines.map((l) => info(`w:${l.key}`, l.label, pct(l.share), { value: (l.share / maxShare) * 99, tone: 'info' })),
    heading('appeal-h', 'Your team on each (at his ask)'),
    ...view.lines.map((l) => info(`a:${l.key}`, l.label, pct(l.appeal), { value: l.appeal * 99 })),
    info('read', 'Staff read at his ask', view.read.text),
  ];
};

/** Full-screen free-agent detail. */
export class FaDetailScreen extends MarketScreen {
  readonly id = 'market-fa-detail';
  readonly info = new InfoView();

  constructor(fc: FranchiseContext, readonly playerId: PlayerId) {
    super(fc, [{ id: 'overview', label: 'Overview' }, { id: 'values', label: 'What He Values' }], true);
    this.refresh();
  }

  private player(): Player | null { return this.fc.league().players[this.playerId] ?? null; }

  protected title(): string {
    const p = this.player();
    return p ? `${p.firstName} ${p.lastName} · ${p.position} · ${p.age}` : 'Free agent';
  }

  refresh(): void {
    const p = this.player();
    if (!p) return this.info.setRows([]);
    this.info.setRows(this.section === 'values' ? faValueRows(preferenceView(this.fc.league(), p, this.fc.userTeamId)) : faOverviewRows(this.fc, p));
  }

  protected override onSectionChange(): void { this.refresh(); }

  status(): ToneText {
    const p = this.player();
    if (!p) return { text: 'Player not found', tone: 'danger' };
    if (p.teamId !== null) return { text: 'No longer a free agent', tone: 'warning' };
    const fa = this.fc.league().freeAgency;
    return { text: fa ? `Free agency round ${Math.min(fa.round, fa.maxRounds)} of ${fa.maxRounds}` : 'Free agency has not opened yet', tone: 'dim' };
  }

  actions(): MarketAction[] {
    const p = this.player();
    return [
      { id: 'offer', label: 'Make offer', disabledReason: p && p.teamId === null ? null : 'not a free agent' },
      { id: 'card', label: 'Player card' },
      { id: 'close', label: 'Back' },
    ];
  }

  runAction(id: string): void {
    if (id === 'offer') openOfferDialog(this.fc, this.playerId, () => this.refresh());
    else if (id === 'card') this.fc.openPlayer(this.playerId);
    else if (id === 'close') this.close();
  }

  protected updateBody(dt: number, input: InputState): void {
    const ev = this.info.table.update(dt, input);
    if (ev?.type === 'back') this.close();
    else if (ev?.type === 'activate' && ev.row.action) this.runAction(ev.row.action);
  }

  protected renderBody(ctx: UiCtx, theme: Theme, body: Rect): void {
    this.info.draw(ctx, theme, body);
  }
}
