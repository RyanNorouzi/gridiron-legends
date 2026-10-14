import { beforeAll, describe, expect, it } from 'vitest';
import type { PlayerId, TeamId } from '@/core/ids';
import { rankAvailable } from '@/franchise/draft-board';
import { DRAFT_CONFIG } from '@/franchise/prospects';
import type { DraftState, League } from '@/franchise/types';
import { ChoiceDialog, ConfirmDialog, StepperDialog } from '@/ui/franchise/kit/dialogs';
import { formatRatingRange } from '@/ui/franchise/kit/format';
import { ProspectScreen } from '@/ui/franchise/market/prospect-detail';
import {
  EMPTY_PLAN, PUBLIC_PLAYER_FIELDS, applyPlan, boardAdd, interviewNow, investNow, boardFromGrades, boardRemove, boardRows, boardShift, maxPlanPoints, planCost, prospectRows,
  quickPlan, scoutingBadge, scoutingOpen, scoutingStatus, togglePlanInterview, withPlanPoints,
} from '@/ui/franchise/market/scouting-model';
import { ScoutingScreen } from '@/ui/franchise/market/scouting-screen';
import { centre, contextFor, guardedLeague, mount, press, rcFor, regularSeasonLeague, scrambledTruth, tap } from './fixtures';

let league: League;
let draft: DraftState;
let user: TeamId;

beforeAll(() => {
  league = regularSeasonLeague();
  draft = league.draft as DraftState;
  user = league.userTeamId as TeamId;
});

const top = (n: number): PlayerId[] => rankAvailable(draft, user, { limit: n }).map((e) => e.prospectId);

describe('scouting view-models read reports, never the ground truth', () => {
  it('builds every scouting view from reports and public facts only (ground-truth reads throw)', () => {
    const guarded = guardedLeague(league);
    const d = guarded.draft as DraftState;
    expect(() => d.prospects[0]?.player.overall).toThrow(/ground truth/);
    expect(() => d.prospects[0]?.player.potential).toThrow(/ground truth/);
    const rows = prospectRows(d, user);
    expect(rows).toHaveLength(d.prospects.length);
    expect(() => boardRows(boardFromGrades(guarded, user).draft as DraftState, user)).not.toThrow();
    expect(() => scoutingStatus(guarded, user, quickPlan(d, user))).not.toThrow();
    const fc = contextFor(guarded);
    const screen = mount(fc, new ScoutingScreen(fc));
    for (const s of ['prospects', 'combine', 'board', 'plan']) {
      screen.showSection(s);
      screen.render(rcFor(fc));
      expect(() => screen.actions()).not.toThrow();
    }
    const prospect = new ProspectScreen(fc, rows[0]?.id as PlayerId, { mode: 'scouting' });
    fc.push(prospect);
    for (const s of ['report', 'ratings', 'combine', 'notes']) {
      prospect.showSection(s);
      prospect.render(rcFor(fc));
    }
    expect(prospect.view?.report).toBe(d.reports[user]?.[rows[0]?.id as PlayerId]);
    expect(PUBLIC_PLAYER_FIELDS).not.toContain('overall');
  });

  it('mirrors the user team reports exactly and ignores the hidden truth', () => {
    const rows = prospectRows(draft, user);
    const reports = draft.reports[user] ?? {};
    for (const r of rows) {
      const rep = reports[r.id];
      if (!rep) throw new Error(`no report for ${r.id}`);
      expect(r.report).toBe(rep);
      expect(r.overall.text).toBe(formatRatingRange(rep.overallRange[0], rep.overallRange[1]).text);
      expect(r.potential.text).toBe(formatRatingRange(rep.potentialRange[0], rep.potentialRange[1]).text);
      expect(r.grade).toBe(rep.grade);
      expect(r.confidence).toBe(rep.confidence);
      expect(r.invested).toBe(draft.scouting[user]?.invested[r.id] ?? 0);
    }
    const scrambled = prospectRows(scrambledTruth(league).draft as DraftState, user);
    expect(JSON.stringify(scrambled.map(({ report, ...rest }) => ({ ...rest, grade: report?.grade }))))
      .toBe(JSON.stringify(rows.map(({ report, ...rest }) => ({ ...rest, grade: report?.grade }))));
  });

  it('plans points and interviews within the budget and applies them atomically', () => {
    const status = scoutingStatus(league, user);
    expect(status.open).toBe(true);
    expect(status.points).toBeGreaterThan(DRAFT_CONFIG.scouting.interviewCost);
    expect(scoutingBadge(league)).toBe(String(Math.floor(status.points)));
    const [a, b] = top(2) as [PlayerId, PlayerId];
    let plan = withPlanPoints(EMPTY_PLAN, a, 10);
    plan = togglePlanInterview(draft, user, plan, b);
    expect(planCost(plan)).toBe(10 + DRAFT_CONFIG.scouting.interviewCost);
    expect(maxPlanPoints(draft, user, plan, a)).toBe(Math.min(DRAFT_CONFIG.scouting.maxInvestedPerProspect, Math.floor(status.points - DRAFT_CONFIG.scouting.interviewCost)));
    expect(togglePlanInterview(draft, user, plan, b).interviews.has(b)).toBe(false);
    const before = draft.reports[user]?.[a];
    const next = applyPlan(league, user, plan);
    const nd = next.draft as DraftState;
    expect(nd.scouting[user]?.pointsAvailable).toBeCloseTo(status.points - planCost(plan), 6);
    expect(nd.scouting[user]?.invested[a]).toBe((draft.scouting[user]?.invested[a] ?? 0) + 10);
    expect(nd.reports[user]?.[b]?.interviewed).toBe(true);
    expect(nd.reports[user]?.[a]?.confidence).toBeGreaterThanOrEqual(before?.confidence ?? 0);
    expect(() => togglePlanInterview(nd, user, EMPTY_PLAN, b)).toThrow(/already/);
    expect(() => applyPlan(league, user, withPlanPoints(EMPTY_PLAN, a, status.points + 50))).toThrow();
    const quick = quickPlan(draft, user);
    expect(planCost(quick)).toBeLessThanOrEqual(status.points);
    expect(planCost(quick)).toBeGreaterThan(0);
    expect(quick.invest.size).toBeLessThanOrEqual(8);
  });

  it('refuses to spend scouting points once scouting has closed (the engine does not check the phase)', () => {
    const [a] = top(1) as [PlayerId];
    const closed: League = { ...league, season: { ...league.season, phase: 'draft' } };
    expect(scoutingOpen(closed)).toBe(false);
    expect(() => applyPlan(closed, user, withPlanPoints(EMPTY_PLAN, a, 5))).toThrow(/closed/);
    expect(() => investNow(closed, user, a, 5)).toThrow(/closed/);
    expect(() => interviewNow(closed, user, a)).toThrow(/closed/);
    expect(investNow(league, user, a, 5).draft?.scouting[user]?.invested[a]).toBe((draft.scouting[user]?.invested[a] ?? 0) + 5);
    const fc = contextFor(closed);
    const report = new ProspectScreen(fc, a, { mode: 'scouting' });
    fc.push(report);
    report.runAction('invest');
    expect(fc.stack.top).toBe(report);
    expect(fc.commits).toHaveLength(0);
    report.runAction('interview');
    expect(fc.commits).toHaveLength(0);
    expect(fc.toasts.length).toBeGreaterThan(0);
  });

  it('edits the draft board', () => {
    const [a, b, c] = top(3) as [PlayerId, PlayerId, PlayerId];
    let l = boardAdd(boardAdd(boardAdd(league, a), b), c);
    expect(l.draft?.userBoard).toEqual([a, b, c]);
    l = boardShift(l, c, 'top');
    expect(l.draft?.userBoard).toEqual([c, a, b]);
    l = boardShift(l, c, 1);
    expect(l.draft?.userBoard).toEqual([a, c, b]);
    l = boardShift(l, a, 'bottom');
    expect(l.draft?.userBoard).toEqual([c, b, a]);
    l = boardRemove(l, b);
    expect(boardRows(l.draft as DraftState, user).map((r) => [r.id, r.boardRank])).toEqual([[c, 1], [a, 2]]);
    expect(() => boardShift(l, b, 1)).toThrow();
    expect(boardFromGrades(league, user).draft?.userBoard).toEqual(top(64));
  });
});

describe('ScoutingScreen', () => {
  it('plans, applies and opens reports from the keyboard', () => {
    const fc = contextFor(league);
    const screen = mount(fc, new ScoutingScreen(fc));
    expect(screen.status().text).toMatch(/^Points \d+ \(\+\d+\/wk\)/);
    const first = screen.prospects.selected;
    if (!first) throw new Error('no selection');
    screen.runAction('plan-points');
    const stepper = fc.stack.top as StepperDialog;
    expect(stepper).toBeInstanceOf(StepperDialog);
    stepper.submit();
    expect(screen.plan.invest.get(first.id)).toBe(10);
    screen.runAction('plan-interview');
    expect(screen.plan.interviews.has(first.id)).toBe(true);
    expect(screen.prospects.rows.find((r) => r.id === first.id)?.plannedInterview).toBe(true);
    expect(screen.bar.tabs.find((t) => t.id === 'plan')?.badge).toBe('2');
    const points = screen.scouting.points;
    screen.runAction('apply');
    expect(fc.commits.at(-1)?.reason).toBe('edit');
    expect(screen.plan.invest.size).toBe(0);
    expect(screen.scouting.points).toBeCloseTo(points - 10 - DRAFT_CONFIG.scouting.interviewCost, 6);
    expect(screen.prospects.rows.find((r) => r.id === first.id)?.interviewed).toBe(true);
    screen.update(1 / 60, press('confirm'));
    const report = fc.stack.top as ProspectScreen;
    expect(report).toBeInstanceOf(ProspectScreen);
    report.render(rcFor(fc));
    expect(report.info.rows.map((r) => r.id)).toEqual(expect.arrayContaining(['invest', 'board-add', 'ovr', 'pot', 'grade', 'conf', 'traits']));
    report.runAction('invest');
    (fc.stack.top as StepperDialog).submit();
    expect(fc.toasts.at(-1)).toBe('Report updated');
    report.runAction('board-add');
    expect(fc.league().draft?.userBoard).toContain(report.prospectId);
  });

  it('builds the board and moves prospects with X + Up/Down or a tap menu', () => {
    const fc = contextFor(league);
    const screen = mount(fc, new ScoutingScreen(fc, { section: 'board' }));
    screen.runAction('board-grades');
    expect(screen.board.rows).toHaveLength(64);
    const [first, second] = screen.board.rows.map((r) => r.id);
    screen.update(1 / 60, press('showPlayArt'));
    expect(screen.movingOnBoard).toBe(true);
    expect(screen.status().text).toContain('Moving');
    screen.update(1 / 60, press('menuDown'));
    expect(fc.league().draft?.userBoard.slice(0, 2)).toEqual([second, first]);
    expect(screen.board.selected?.id).toBe(first);
    screen.update(1 / 60, press('confirm'));
    expect(screen.movingOnBoard).toBe(false);
    screen.render(rcFor(fc));
    const row = screen.board.hitMap?.rows[1];
    if (!row) throw new Error('no geometry');
    tap((i) => screen.update(1 / 60, i), ...centre(row.rect));
    const dialog = fc.stack.top as ChoiceDialog;
    expect(dialog).toBeInstanceOf(ChoiceDialog);
    dialog.choose('board-top');
    expect(fc.league().draft?.userBoard[0]).toBe(first);
    const board = fc.league().draft?.userBoard;
    screen.runAction('board-grades');
    const confirm = fc.stack.top as ConfirmDialog;
    expect(confirm).toBeInstanceOf(ConfirmDialog);
    confirm.choose(false);
    expect(fc.league().draft?.userBoard).toBe(board);
  });

  it('filters by position, quick-plans and stays readable in large text', () => {
    const fc = contextFor(league, true);
    const screen = mount(fc, new ScoutingScreen(fc));
    expect(screen.prospects.columns.map((c) => c.key)).toEqual(['name', 'pos', 'ovr', 'pot', 'grd']);
    screen.runAction('filter');
    const dialog = fc.stack.top as ChoiceDialog;
    dialog.choose(String(1));
    expect(screen.position).toBe('QB');
    expect(screen.prospects.rows.every((r) => r.position === 'QB')).toBe(true);
    screen.runAction('quick');
    expect(screen.section).toBe('plan');
    expect(screen.planTable.rows.length).toBeGreaterThan(0);
    screen.render(rcFor(fc));
    const body = screen.frameLayout?.body;
    for (const r of screen.planTable.hitMap?.rows ?? []) expect(r.rect.y + r.rect.h).toBeLessThanOrEqual((body?.y ?? 0) + (body?.h ?? 0));
    expect(scoutingOpen({ ...league, season: { ...league.season, phase: 'draft' } })).toBe(false);
  });
});
