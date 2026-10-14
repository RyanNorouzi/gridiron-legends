/**
 * Dialog flows behind the player-card actions. Each flow opens the kit dialog it needs (number stepper for a
 * restructure, confirm for a release with its dead-money split, choice lists for tags and training focus),
 * applies the pure transform from player-actions.ts and commits through the FranchiseContext: contract moves
 * with the 'signing' autosave reason, flags and focus with 'edit'. `onChange` runs after every commit so the
 * calling screen can rebuild (dialogs pop before their callbacks, so resume() alone would be too early).
 */
import type { PlayerId } from '@/core/ids';
import type { League } from '@/franchise/types';
import type { AttributeKey } from '@/players/types';
import type { CommitReason, FranchiseContext } from '../context';
import type { Column } from '../kit/data-table';
import { ChoiceDialog, ConfirmDialog, StepperDialog } from '../kit/dialogs';
import { POSITION_NAMES, formatMoney, formatRating } from '../kit/format';
import { ATTR_ABBR, moneyPrecise, type ActionResult } from './common';
import type { ViewSpec } from './layout';
import { NegotiationScreen } from './negotiation-screen';
import {
  applyTag, compareKeys, compareRows, focusOptions, releaseCheck, releasePlayer, restructureCheck, restructurePlayer, restructurePreview,
  setTrainingFocus, tagOptions, toggleTradingBlock, type CompareRow, type PlayerActionId,
} from './player-actions';
import { TableScreen } from './tab-screen';

/** Commits a successful result and toasts its message; returns result.ok. */
export const commitResult = (fc: FranchiseContext, result: ActionResult, reason: CommitReason): boolean => {
  if (result.ok) fc.commit(result.league, reason);
  fc.toast(result.message);
  return result.ok;
};

/** Stepper spec for a restructure amount (whole 50K steps up to the convertible maximum). */
export const restructureField = (max: number): { id: string; label: string; min: number; max: number; step: number; bigStep: number; value: number; format: (v: number) => string } => {
  const min = Math.min(50_000, max);
  return { id: 'amount', label: 'Convert salary', min, max, step: 50_000, bigStep: 1_000_000, value: max, format: moneyPrecise };
};

/** Stepper summary of a restructure preview: this season's saving and the change to later cap hits. */
export const restructureSummary = (prev: { savings: number; years: { year: number; before: number; after: number }[] }): string => {
  const later = prev.years.slice(1).map((y) => y.after - y.before);
  const first = later[0];
  if (first === undefined) return `Saves ${formatMoney(prev.savings)} this season`;
  const same = later.every((d) => d === first);
  const change = (d: number): string => `${d > 0 ? '+' : d < 0 ? '-' : ''}${formatMoney(Math.abs(d))}`;
  return `Saves ${formatMoney(prev.savings)} now · later ${same ? `${change(first)}/yr` : later.map(change).join(', ')}`;
};

/** Columns of the position comparison. */
export const compareColumns = (keys: readonly AttributeKey[], wide: boolean): Column<CompareRow>[] => {
  const attrCols = (wide ? keys : keys.slice(0, 2)).map((k): Column<CompareRow> => ({
    key: k, label: ATTR_ABBR[k], width: 3, align: 'right', format: (r) => formatRating(r.attrs[k]), sortValue: (r) => r.attrs[k],
  }));
  return [
    { key: 'name', label: 'NAME', flex: 1, minWidth: 8, format: (r) => (r.self ? { text: `★ ${r.name}`, tone: 'accent' } : r.name), sortValue: (r) => r.name, defaultDir: 'asc' },
    ...(wide ? [{ key: 'age', label: 'AGE', width: 3, align: 'right', format: (r: CompareRow) => String(r.age), sortValue: (r: CompareRow) => r.age, defaultDir: 'asc' } as Column<CompareRow>] : []),
    { key: 'ovr', label: 'OVR', width: 3, align: 'right', format: (r) => formatRating(r.overall), sortValue: (r) => r.overall },
    ...(wide ? [{ key: 'pot', label: 'POT', width: 3, align: 'right', format: (r: CompareRow) => r.potential, sortValue: (r: CompareRow) => r.potentialSort } as Column<CompareRow>] : []),
    { key: 'dep', label: 'DEP', width: 3, align: 'right', format: (r) => (r.depth === null ? { text: '-', tone: 'dim' } : String(r.depth)), sortValue: (r) => r.depth, defaultDir: 'asc' },
    ...attrCols,
    ...(wide ? [{ key: 'hit', label: 'HIT', width: 6, align: 'right', format: (r: CompareRow) => formatMoney(r.apy), sortValue: (r: CompareRow) => r.apy } as Column<CompareRow>] : []),
  ];
};

/** ViewSpec of the position comparison for `playerId`. */
export const compareSpec = (fc: FranchiseContext, playerId: PlayerId): ViewSpec<CompareRow> => {
  const me = fc.league().players[playerId];
  const keys = me ? compareKeys(me) : [];
  return {
    id: 'compare', label: 'Compare',
    columns: (wide) => compareColumns(keys, wide),
    rows: () => compareRows(fc.league(), fc.userTeamId, playerId),
    rowId: (r) => r.id,
    initialSort: { key: 'dep', dir: 'asc' },
    emptyText: 'No teammates at this position',
    detail: (r) => keys.map((k) => `${ATTR_ABBR[k]} ${r.attrs[k]}`).join(' · '),
    activate: (r) => fc.openPlayer(r.id),
  };
};

const restructureFlow = (fc: FranchiseContext, playerId: PlayerId, onChange: () => void): void => {
  const check = restructureCheck(fc.league(), fc.userTeamId, playerId);
  if (!check.ok) {
    fc.toast(check.reason ?? 'Cannot restructure');
    return;
  }
  fc.push(new StepperDialog('Restructure', 'Convert salary into a prorated signing bonus', [restructureField(check.max)], {
    summary: (v) => restructureSummary(restructurePreview(fc.league(), playerId, v.amount ?? 0)),
    confirmLabel: 'CONVERT',
    onResult: (v) => {
      if (!v) return;
      commitResult(fc, restructurePlayer(fc.league(), fc.userTeamId, playerId, v.amount ?? 0), 'signing');
      onChange();
    },
  }));
};

const releaseFlow = (fc: FranchiseContext, playerId: PlayerId, onChange: () => void): void => {
  const check = releaseCheck(fc.league(), fc.userTeamId, playerId);
  if (!check.ok) {
    fc.toast(check.reason ?? 'Cannot release');
    return;
  }
  const name = fc.league().players[playerId];
  const split = `Dead money ${formatMoney(check.deadThisYear)} this year${check.deadNextYear > 0 ? `, ${formatMoney(check.deadNextYear)} next year` : ''}. Cap savings ${formatMoney(check.capSavings)}.`;
  const message = `${name ? `${name.firstName} ${name.lastName}` : 'He'} goes to free agency. ${split}${check.warning ? ` ${check.warning}.` : ''}`;
  fc.push(new ConfirmDialog('Release player?', message, {
    yesLabel: 'Release', noLabel: 'Keep', defaultNo: true,
    onResult: (yes) => {
      if (!yes) return;
      commitResult(fc, releasePlayer(fc.league(), fc.userTeamId, playerId), 'signing');
      onChange();
    },
  }));
};

const tagFlow = (fc: FranchiseContext, playerId: PlayerId, onChange: () => void): void => {
  const options = tagOptions(fc.league(), fc.userTeamId, playerId);
  const first = options.find((o) => !o.ok);
  if (options.every((o) => !o.ok) && first) {
    fc.toast(first.reason ?? 'Cannot tag');
    return;
  }
  fc.push(new ChoiceDialog('Apply a tag', 'One-year, fully guaranteed deal', options.map((o) => ({
    id: o.kind, label: `${o.label} ${formatMoney(o.salary)}`, subLabel: o.reason ?? undefined, disabled: !o.ok,
  })), (id) => {
    const kind = options.find((o) => o.kind === id)?.kind;
    if (!kind) return;
    commitResult(fc, applyTag(fc.league(), fc.userTeamId, playerId, kind), 'signing');
    onChange();
  }));
};

const focusFlow = (fc: FranchiseContext, playerId: PlayerId, onChange: () => void): void => {
  const p = fc.league().players[playerId];
  if (!p) return;
  const current = p.trainingFocus ?? 'balanced';
  fc.push(new ChoiceDialog('Training focus', 'Extra development for one rating', focusOptions(p).map((o) => ({
    id: o.id, label: o.value === null ? o.label : `${o.label} (${o.value})`, subLabel: o.id === current ? 'current' : undefined,
  })), (id) => {
    if (!id) return;
    const option = focusOptions(p).find((o) => o.id === id);
    if (!option) return;
    commitResult(fc, setTrainingFocus(fc.league(), fc.userTeamId, playerId, option.id === 'balanced' ? null : option.id), 'edit');
    onChange();
  }, { maxVisible: 7 }));
};

/** Runs a card action for a player on the user's roster. */
export const runPlayerAction = (fc: FranchiseContext, playerId: PlayerId, action: PlayerActionId, onChange: () => void = () => undefined): void => {
  const league: League = fc.league();
  switch (action) {
    case 'extend': fc.push(new NegotiationScreen(fc, playerId)); break;
    case 'restructure': restructureFlow(fc, playerId, onChange); break;
    case 'release': releaseFlow(fc, playerId, onChange); break;
    case 'tag': tagFlow(fc, playerId, onChange); break;
    case 'block':
      commitResult(fc, toggleTradingBlock(league, fc.userTeamId, playerId), 'edit');
      onChange();
      break;
    case 'focus': focusFlow(fc, playerId, onChange); break;
    case 'compare': {
      const p = league.players[playerId];
      fc.push(new TableScreen(fc, `Compare ${p?.position ?? ''}s`, compareSpec(fc, playerId), { subtitle: p ? `${p.firstName} ${p.lastName} vs every ${POSITION_NAMES[p.position]} on the roster` : undefined }));
      break;
    }
    default: break;
  }
};
