/**
 * Prospect report (pushed full-screen from the scouting tab or the draft room). Everything shown comes from the
 * user team's ScoutingReport plus the prospect's public facts (see scouting-model.ts): Report (actions, bio,
 * consensus, ranges, grade, confidence, points invested, development read, interview findings, red flags),
 * Ratings (the scouts' attribute estimates), Combine (combine and pro-day drills) and Notes.
 * Scouting mode can invest points (kit StepperDialog), interview and edit the board; draft mode can draft him when
 * the user is on the clock.
 */
import type { PlayerId, TeamId } from '@/core/ids';
import { DRAFT_CONFIG } from '@/franchise/prospects';
import type { CombineResults, DraftState, Prospect } from '@/franchise/types';
import type { InputState } from '../../input/types';
import type { Theme } from '../../theme';
import type { UiCtx } from '../../widgets/panel';
import type { FranchiseContext } from '../context';
import { StepperDialog } from '../kit/dialogs';
import { formatHeight, formatPercent, formatWeight, humanize, ordinal, type ToneText } from '../kit/format';
import type { Rect } from '../kit/list';
import { InfoView, MarketScreen, TEXT_COLUMNS, actionRow, heading, info, type InfoRow, type MarketAction } from './common';
import { EMPTY_PLAN, boardAdd, boardRemove, interviewNow, investNow, maxPlanPoints, prospectRow, publicProspect, scoutingOpen, type ProspectRow } from './scouting-model';

/** Drill labels and formatting, in display order. */
export const DRILLS: readonly { key: keyof CombineResults; label: string; format(v: number): string }[] = [
  { key: 'fortyYard', label: '40-yard dash', format: (v) => `${v.toFixed(2)}s` },
  { key: 'benchReps', label: 'Bench press', format: (v) => `${Math.round(v)} reps` },
  { key: 'vertical', label: 'Vertical jump', format: (v) => `${v.toFixed(1)} in` },
  { key: 'broadJump', label: 'Broad jump', format: (v) => `${Math.round(v)} in` },
  { key: 'shuttle', label: 'Short shuttle', format: (v) => `${v.toFixed(2)}s` },
  { key: 'threeCone', label: '3-cone drill', format: (v) => `${v.toFixed(2)}s` },
];

/** Combine rows: the combine number and, when he ran one, the pro-day number. */
export const combineRows = (p: Pick<Prospect, 'combine' | 'proDay'>): InfoRow[] =>
  DRILLS.map((d) => {
    const pro = p.proDay?.[d.key];
    return info(`drill:${d.key}`, d.label, pro === undefined ? d.format(p.combine[d.key]) : `${d.format(p.combine[d.key])} · pro day ${d.format(pro)}`);
  });

/** Lookup of a prospect in the pool. */
const findProspect = (draft: DraftState, id: PlayerId): Prospect | undefined => draft.prospects.find((p) => p.player.id === id);

/** The user's view of one prospect (null when he is no longer in the pool). */
export const reportView = (draft: DraftState, teamId: TeamId, id: PlayerId): ProspectRow | null => {
  const p = findProspect(draft, id);
  if (!p) return null;
  const board = draft.userBoard.indexOf(id);
  return prospectRow(p, draft.reports[teamId]?.[id] ?? null, draft.scouting[teamId]?.invested[id] ?? 0, board >= 0 ? board + 1 : null, EMPTY_PLAN);
};

/** Report section rows (after the action rows). */
export const reportRows = (row: ProspectRow): InfoRow[] => {
  const r = row.report;
  const traits = !row.interviewed ? { text: 'Not interviewed', tone: 'dim' as const }
    : row.traits.length ? row.traits.map(humanize).join(', ') : { text: 'No concerns', tone: 'success' as const };
  return [
    info('college', 'College', row.college),
    info('bio', 'Bio', `Age ${row.age} · ${formatHeight(row.heightIn)} · ${formatWeight(row.weightLb)}`),
    info('consensus', 'Consensus', `${row.consensusRank ? `${ordinal(row.consensusRank)} overall · ` : ''}projected round ${row.projectedRound}`),
    heading('report-h', 'Your scouts'),
    info('ovr', 'Overall range', row.overall),
    info('pot', 'Potential range', row.potential),
    info('grade', 'Grade', { text: row.grade, tone: row.gradeRank <= 2 ? 'success' : row.gradeRank <= 6 ? 'normal' : 'warning' }),
    info('conf', 'Confidence', formatPercent(row.confidence, 0), { value: row.confidence * 99, tone: 'info' }),
    info('invested', 'Points invested', `${row.invested} of ${DRAFT_CONFIG.scouting.maxInvestedPerProspect}`, { value: (row.invested / DRAFT_CONFIG.scouting.maxInvestedPerProspect) * 99, tone: 'info' }),
    info('dev', 'Development', r?.devTraitEstimate ? humanize(r.devTraitEstimate) : { text: 'Unknown - scout him more', tone: 'dim' }),
    info('traits', 'Interview', traits),
    info('flags', 'Red flags', row.redFlags.length ? { text: row.redFlags.map(humanize).join(', '), tone: 'danger' } : { text: 'None found', tone: 'dim' }),
  ];
};

/** Attribute estimates, best first. */
export const ratingRows = (row: ProspectRow): InfoRow[] =>
  Object.entries(row.report?.attributeEstimates ?? {})
    .filter((e): e is [string, number] => typeof e[1] === 'number')
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([key, v]) => info(`attr:${key}`, humanize(key), String(v), { value: v }));

/** Options of the prospect screen. */
export interface ProspectScreenOptions {
  mode: 'scouting' | 'draft';
  /** Draft mode: drafts the prospect (the draft room checks the clock). */
  onDraft?(id: PlayerId): void;
  /** Draft mode: whether the user is on the clock. */
  canDraft?(): boolean;
}

/** Full-screen prospect report. */
export class ProspectScreen extends MarketScreen {
  readonly id = 'market-prospect';
  readonly info = new InfoView();
  readonly notes = new InfoView(TEXT_COLUMNS, 'No notes');
  private rowValue: ProspectRow | null = null;

  constructor(fc: FranchiseContext, readonly prospectId: PlayerId, private readonly opts: ProspectScreenOptions) {
    super(fc, [{ id: 'report', label: 'Report' }, { id: 'ratings', label: 'Ratings' }, { id: 'combine', label: 'Combine' }, { id: 'notes', label: 'Notes' }], true);
    this.refresh();
  }

  /** The user's view of the prospect (null once he left the pool). */
  get view(): ProspectRow | null { return this.rowValue; }

  protected title(): string {
    const r = this.rowValue;
    return r ? `${r.name} · ${r.position} · ${r.college}` : 'Prospect';
  }

  private actionRows(): InfoRow[] {
    const r = this.rowValue;
    if (!r) return [];
    const rows: InfoRow[] = [];
    if (this.opts.mode === 'draft') {
      if (this.opts.canDraft?.()) rows.push(actionRow('draft', 'Draft him'));
    } else if (scoutingOpen(this.fc.league())) {
      rows.push(actionRow('invest', 'Scout him', 'spend points'));
      if (!r.interviewed) rows.push(actionRow('interview', 'Interview him', `${DRAFT_CONFIG.scouting.interviewCost} pts`));
    }
    rows.push(actionRow(r.boardRank ? 'board-remove' : 'board-add', r.boardRank ? `Remove from board (#${r.boardRank})` : 'Add to your board'));
    return rows;
  }

  refresh(): void {
    const draft = this.fc.league().draft;
    this.rowValue = draft ? reportView(draft, this.fc.userTeamId, this.prospectId) : null;
    const r = this.rowValue;
    if (!r || !draft) {
      this.info.setRows([]);
      this.notes.setRows([]);
      return;
    }
    const prospect = findProspect(draft, this.prospectId) as Prospect;
    const rows = this.section === 'ratings' ? ratingRows(r) : this.section === 'combine' ? combineRows(publicProspect(prospect)) : [...this.actionRows(), ...reportRows(r)];
    this.info.setRows(rows);
    this.notes.setRows((r.report?.notes ?? []).map((text, i) => info(`n${i}`, '', text)));
  }

  protected override onSectionChange(): void { this.refresh(); }

  status(): ToneText {
    const r = this.rowValue;
    if (!r) return { text: 'No longer available', tone: 'warning' };
    return { text: `Grade ${r.grade} · OVR ${r.overall.text} · POT ${r.potential.text} · ${formatPercent(r.confidence, 0)} sure`, tone: 'normal' };
  }

  actions(): MarketAction[] {
    return [...this.actionRows().map((r) => ({ id: r.action as string, label: r.label })), { id: 'close', label: 'Back' }];
  }

  runAction(id: string): void {
    const league = this.fc.league();
    const user = this.fc.userTeamId;
    switch (id) {
      case 'draft':
        this.opts.onDraft?.(this.prospectId);
        return;
      case 'invest': {
        if (!scoutingOpen(league)) return this.fc.toast('Scouting is closed');
        const draft = league.draft;
        const max = draft ? maxPlanPoints(draft, user, EMPTY_PLAN, this.prospectId) : 0;
        if (max <= 0) return this.fc.toast('No scouting points to spend on him');
        this.fc.push(new StepperDialog('Scout him', `Points to spend (you have ${Math.floor(draft?.scouting[user]?.pointsAvailable ?? 0)})`,
          [{ id: 'points', label: 'Points', min: 1, max, step: 1, bigStep: 10, value: Math.min(max, 10) }], {
            confirmLabel: 'SCOUT',
            onResult: (v) => {
              if (v) this.attempt(() => this.commit(investNow(this.fc.league(), user, this.prospectId, v.points ?? 0), 'edit', 'Report updated'));
            },
          }));
        return;
      }
      case 'interview':
        this.attempt(() => this.commit(interviewNow(league, user, this.prospectId), 'edit', 'Interview done'));
        return;
      case 'board-add':
        this.attempt(() => this.commit(boardAdd(league, this.prospectId), 'edit', 'Added to your board'));
        return;
      case 'board-remove':
        this.attempt(() => this.commit(boardRemove(league, this.prospectId), 'edit', 'Removed from your board'));
        return;
      case 'close':
        this.close();
        return;
      default:
    }
  }

  protected updateBody(dt: number, input: InputState): void {
    const ev = (this.section === 'notes' ? this.notes : this.info).table.update(dt, input);
    if (ev?.type === 'back') this.close();
    else if (ev?.type === 'activate' && ev.row.action) this.runAction(ev.row.action);
  }

  protected renderBody(ctx: UiCtx, theme: Theme, body: Rect): void {
    (this.section === 'notes' ? this.notes : this.info).draw(ctx, theme, body);
  }
}
