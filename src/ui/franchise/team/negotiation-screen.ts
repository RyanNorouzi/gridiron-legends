/**
 * Contract-extension negotiation screen (pushed full-screen from the player card). Two sections on a tab bar
 * (U/O or tap): Offer — his ask, the current deal, the editable offer rows (Confirm/tap a term opens the
 * number stepper focused on it, Role opens a picker), APY, the cap check, the interest meter, his last answer
 * and counter, and the Submit / Match ask / Accept counter rows; Priorities — how much he cares about each
 * factor and how well the offer does on it. Start / Enter submits. Back closes. An accepted deal commits with
 * the 'signing' autosave reason and closes the screen; a refusal shows the cap reason or his counter, and a refusal
 * on merit commits the recorded round ('edit': the talks remember it, see franchise/extension-talks.ts).
 */
import type { PlayerId } from '@/core/ids';
import type { ContractTerms } from '@/franchise/contracts';
import type { InputState } from '../../input/types';
import { drawText } from '../../render/text';
import type { RenderContext, Screen, ScreenServices } from '../../screens/screen';
import { drawHintBar, type ButtonHint } from '../../widgets/panel';
import type { FranchiseContext } from '../context';
import { DataTable, type Column } from '../kit/data-table';
import { drawDataTable, fitCell } from '../kit/data-table-view';
import { ChoiceDialog, StepperDialog } from '../kit/dialogs';
import { formatMoney, humanize, type ToneText } from '../kit/format';
import { pressed } from '../kit/list';
import { TabBar, drawTabBar } from '../kit/tabbar';
import {
  OFFER_ROLES, appealTone, askTerms, buildNegotiation, offerFields, offerFromValues, offerSummary, openingOffer, submitExtension, validateOffer,
  type NegotiationView, type OfferLine, type PreferenceRow,
} from './negotiation-model';
import { hintRowHeight } from './tab-screen';

const offerColumns: Column<OfferLine>[] = [
  { key: 'label', label: 'Item', flex: 2, minWidth: 8, format: (l) => (l.heading ? { text: l.label, tone: 'accent' } : { text: l.label, tone: l.action ? 'normal' : 'dim' }) },
  { key: 'value', label: 'Value', flex: 3, minWidth: 8, format: (l) => l.value },
];

const prefColumns = (maxWeight: number): Column<PreferenceRow>[] => [
  { key: 'factor', label: 'FACTOR', flex: 2, minWidth: 6, format: (r) => r.label, sortValue: (r) => r.label, defaultDir: 'asc' },
  { key: 'cares', label: 'CARES', flex: 2, minWidth: 5, format: (r) => `${Math.round(r.weight * 100)}%`, sortValue: (r) => r.weight, bar: (r) => ({ value: r.weight * 100, max: Math.max(1, maxWeight * 100), tone: 'info' }) },
  { key: 'offer', label: 'OFFER', flex: 2, minWidth: 5, format: (r) => ({ text: String(Math.round(r.appeal * 100)), tone: appealTone(r.appeal) }), sortValue: (r) => r.appeal, bar: (r) => ({ value: r.appeal * 100, max: 100, tone: appealTone(r.appeal) }) },
];

const FIELD_INDEX: Readonly<Record<string, number>> = { salary: 0, years: 1, bonus: 2, guaranteed: 3 };

/** The extension negotiation screen. */
export class NegotiationScreen implements Screen {
  readonly id = 'team-negotiation';
  readonly bar = new TabBar([{ id: 'offer', label: 'Offer' }, { id: 'prefs', label: 'Priorities' }]);
  readonly offerTable: DataTable<OfferLine>;
  prefTable: DataTable<PreferenceRow>;
  private services: ScreenServices | null = null;
  private offerValue: ContractTerms | null;
  private counterValue: ContractTerms | null = null;
  private answer: ToneText | null = null;
  private viewValue: NegotiationView | null = null;

  constructor(private readonly fc: FranchiseContext, readonly playerId: PlayerId) {
    this.offerValue = openingOffer(fc.league(), fc.userTeamId, playerId);
    this.offerTable = new DataTable(offerColumns, [], { rowId: (l) => l.id, showHeader: false });
    this.prefTable = new DataTable(prefColumns(0.3), [], { rowId: (r) => r.key, initialSort: { key: 'cares' } });
    this.rebuild();
    this.offerTable.selectById('submit');
  }

  get view(): NegotiationView | null { return this.viewValue; }
  get offer(): ContractTerms | null { return this.offerValue; }
  get counter(): ContractTerms | null { return this.counterValue; }
  get section(): string { return this.bar.current?.id ?? 'offer'; }

  /** Rebuilds the view-model from the League and the current offer. */
  rebuild(): void {
    const offer = this.offerValue;
    this.viewValue = offer ? buildNegotiation(this.fc.league(), this.fc.userTeamId, this.playerId, offer, this.counterValue, this.answer) : null;
    this.offerTable.setRows(this.viewValue?.lines ?? []);
    const prefs = this.viewValue?.prefs ?? [];
    const maxWeight = prefs.reduce((m, r) => Math.max(m, r.weight), 0);
    const sort = this.prefTable.sortKey ? { key: this.prefTable.sortKey, dir: this.prefTable.sortDir } : null;
    this.prefTable = new DataTable(prefColumns(maxWeight), prefs, { rowId: (r) => r.key, initialSort: sort });
  }

  /** Replaces the offer. */
  setOffer(terms: ContractTerms): void {
    this.offerValue = terms;
    this.rebuild();
  }

  /** Opens the number stepper for the offer, focused on `field`. */
  editTerms(field = 'salary'): StepperDialog | null {
    const offer = this.offerValue;
    const player = this.fc.league().players[this.playerId];
    const view = this.viewValue;
    if (!offer || !player || !view) return null;
    const dialog = new StepperDialog('Offer terms', `He asks ${formatMoney(view.ask.apy)}/yr for ${view.ask.years}y`, offerFields(this.fc.league(), player, offer), {
      summary: (v) => offerSummary(v, view.ask.apy),
      validate: validateOffer,
      confirmLabel: 'SET',
      onResult: (values) => {
        if (values) this.setOffer(offerFromValues(values, offer.role));
      },
    });
    dialog.model.setFocus(FIELD_INDEX[field] ?? 0);
    this.fc.push(dialog);
    return dialog;
  }

  /** Opens the role picker. */
  pickRole(): ChoiceDialog | null {
    const offer = this.offerValue;
    if (!offer) return null;
    const dialog = new ChoiceDialog('Offer role', 'The role you promise him', OFFER_ROLES.map((r) => ({ id: r, label: humanize(r), subLabel: r === offer.role ? 'current' : undefined })), (id) => {
      const role = OFFER_ROLES.find((r) => r === id);
      if (role && this.offerValue) this.setOffer({ ...this.offerValue, role });
    });
    this.fc.push(dialog);
    return dialog;
  }

  /** Sets the offer to his ask. */
  matchAsk(): void {
    if (this.viewValue) this.setOffer(askTerms(this.viewValue.ask));
  }

  /** Submits `terms` (default the offer): commits and closes on yes, records the answer on no. */
  submit(terms: ContractTerms | null = this.offerValue): boolean {
    if (!terms) return false;
    const out = submitExtension(this.fc.league(), this.fc.userTeamId, this.playerId, terms);
    this.fc.toast(out.message);
    if (out.ok) {
      this.fc.commit(out.league, 'signing');
      this.fc.pop();
      return true;
    }
    if (out.league !== this.fc.league()) this.fc.commit(out.league, 'edit');
    this.counterValue = out.counter;
    this.answer = { text: out.message, tone: 'danger' };
    this.rebuild();
    if (this.counterValue) this.offerTable.selectById('counter');
    return false;
  }

  private act(line: OfferLine): void {
    switch (line.action) {
      case 'salary': case 'years': case 'bonus': case 'guaranteed': this.editTerms(line.action); break;
      case 'role': this.pickRole(); break;
      case 'match': this.matchAsk(); break;
      case 'counter': this.submit(this.counterValue); break;
      case 'submit': this.submit(); break;
      default: break;
    }
  }

  enter(services: ScreenServices): void { this.services = services; }
  exit(): void { this.services = null; }
  resume(): void { this.rebuild(); }

  update(dt: number, input: InputState): void {
    if (this.bar.update(dt, input)) return;
    if (!this.viewValue) {
      if (pressed(input, ['back', 'confirm']) || input.pointer?.justDown) this.fc.pop();
      return;
    }
    if (pressed(input, ['pause'])) {
      this.submit();
      return;
    }
    if (this.section === 'prefs') {
      if (this.prefTable.update(dt, input)?.type === 'back') this.fc.pop();
      return;
    }
    const ev = this.offerTable.update(dt, input);
    if (ev?.type === 'back') this.fc.pop();
    else if (ev?.type === 'activate') this.act(ev.row);
  }

  /** Key hints for the current device. */
  hints(): ButtonHint[] {
    const g = (a: Parameters<ScreenServices['input']['glyph']>[0]): string => this.services?.input.glyph(a) ?? '?';
    return [
      { glyph: `${g('menuTabLeft')} ${g('menuTabRight')}`, label: 'Section' },
      { glyph: g('confirm'), label: 'Edit' },
      { glyph: g('pause'), label: 'Submit' },
      { glyph: g('back'), label: 'Back' },
    ];
  }

  render(rc: RenderContext): void {
    const theme = this.services?.theme ?? rc.theme;
    const { ctx, width, height } = rc;
    const c = theme.colors;
    const size = theme.textScale;
    const lh = theme.lineHeight;
    const pad = theme.pad;
    ctx.fillStyle = c.bg;
    ctx.fillRect(0, 0, width, height);
    ctx.fillStyle = c.panel;
    ctx.fillRect(0, 0, width, lh * 2 + theme.gap);
    const v = this.viewValue;
    drawText(ctx, fitCell(v?.title ?? 'Negotiation', width - pad * 2, size), pad, theme.gap, { color: c.accent, size });
    drawText(ctx, fitCell(v ? v.subtitle : 'He is not under contract with your team', width - pad * 2, size), pad, theme.gap + lh, { color: c.textDim, size });
    const tabY = lh * 2 + theme.gap;
    const tabH = TabBar.height(theme);
    drawTabBar(ctx, theme, this.bar, { x: 0, y: tabY, w: width, h: tabH });
    const hintH = hintRowHeight(theme) + theme.gap;
    const top = tabY + tabH + theme.gap;
    const rect = { x: pad, y: top, w: width - pad * 2, h: height - top - hintH - theme.gap };
    if (v) {
      if (this.section === 'prefs') drawDataTable(ctx, theme, this.prefTable, rect);
      else drawDataTable(ctx, theme, this.offerTable, rect);
    }
    drawHintBar(ctx, theme, this.hints(), width, height - hintH);
  }
}
