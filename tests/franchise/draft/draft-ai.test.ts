import { describe, expect, it } from 'vitest';
import { createRng } from '@/core/rng';
import type { PlayerId, TeamId } from '@/core/ids';
import type { DraftState, League, ScoutingReport } from '@/franchise/types';
import { DRAFT_CONFIG, trueProspectValue } from '@/franchise/prospects';
import { applyScoutingPlan, grantScoutingPoints, scoutingEntry } from '@/franchise/scouting';
import { aiBoard, aiPick, aiScoutingPlan, draftNeeds, pickUndrafted, projectedPickSlots } from '@/franchise/draft-ai';
import { createDraftState, startDraft } from '@/franchise/draft';
import { makeLeague, teamIds, withRecords } from './helpers';

const league = startDraft(withRecords(makeLeague(41), createRng(2)), createRng(4));
const draft = league.draft as DraftState;
const [A, B] = teamIds(league) as [TeamId, TeamId];
const rank = (board: readonly { prospectId: PlayerId }[], id: PlayerId): number => board.findIndex((e) => e.prospectId === id);

describe('draft needs', () => {
  it('rises where the roster is empty and falls where it is overstocked', () => {
    const base = draftNeeds(league, A);
    const team = league.teams[A]!;
    const qbs = team.rosterIds.filter((id) => league.players[id]!.position === 'QB');
    const noQb: League = { ...league, teams: { ...league.teams, [A]: { ...team, rosterIds: team.rosterIds.filter((id) => !qbs.includes(id)) } } };
    expect(draftNeeds(noQb, A).multipliers.QB).toBeGreaterThan(base.multipliers.QB);
    const otherWrs = Object.values(league.players).filter((p) => p.position === 'WR' && p.teamId !== A).slice(0, 6).map((p) => p.id);
    const stacked: League = { ...league, teams: { ...league.teams, [A]: { ...team, rosterIds: [...team.rosterIds, ...otherWrs] } } };
    expect(draftNeeds(stacked, A).multipliers.WR).toBeLessThan(base.multipliers.WR);
    for (const m of Object.values(base.multipliers)) {
      expect(m).toBeGreaterThanOrEqual(0.7);
      expect(m).toBeLessThanOrEqual(1.35);
    }
    expect(() => draftNeeds(league, 't_nope' as TeamId)).toThrow(/unknown team/);
  });
});

describe('AI boards read the team\'s own reports, not the truth', () => {
  it('is unchanged when the hidden ratings change', () => {
    const lied: DraftState = { ...draft, prospects: draft.prospects.map((p) => ({ ...p, player: { ...p.player, overall: 40, potential: 45, devTrait: 'bust' as const } })) };
    const ids = (d: DraftState) => aiBoard(league, d, A, createRng(1), { noise: false }).map((e) => e.prospectId);
    expect(ids(lied)).toEqual(ids(draft));
  });

  it('drafts a truly bad prospect when its own (wrong) report loves him', () => {
    const worst = [...draft.prospects].filter((p) => p.player.position === 'WR').sort((a, b) => trueProspectValue(a.player) - trueProspectValue(b.player))[0]!;
    const id = worst.player.id;
    const glowing: ScoutingReport = { ...draft.reports[A]![id]!, overallRange: [84, 88], potentialRange: [95, 99], redFlags: [], devTraitEstimate: 'superstar' };
    const fooled: DraftState = { ...draft, reports: { ...draft.reports, [A]: { ...draft.reports[A]!, [id]: glowing } } };
    expect(aiPick(league, fooled, A, createRng(3))).toBe(id);
    expect(aiPick(league, fooled, B, createRng(3))).not.toBe(id);
  });

  it('penalises red flags and keeps specialists out of the early rounds', () => {
    const top = aiBoard(league, draft, A, createRng(1), { noise: false })[0]!;
    const flagged: DraftState = {
      ...draft,
      reports: { ...draft.reports, [A]: { ...draft.reports[A]!, [top.prospectId]: { ...draft.reports[A]![top.prospectId]!, redFlags: ['lazy', 'hotHeaded'] } } },
    };
    const after = aiBoard(league, flagged, A, createRng(1), { noise: false }).find((e) => e.prospectId === top.prospectId)!;
    expect(top.value - after.value).toBeCloseTo(2 * DRAFT_CONFIG.ai.redFlagPenalty);
    const isSpec = (id: PlayerId): boolean => ['K', 'P'].includes(draft.prospects.find((p) => p.player.id === id)!.player.position);
    const early = aiBoard(league, draft, A, createRng(1), { noise: false, round: 1 });
    expect(early.slice(0, 64).some((e) => isSpec(e.prospectId))).toBe(false);
    const late = aiBoard(league, draft, A, createRng(1), { noise: false, round: 7 });
    expect(late.findIndex((e) => isSpec(e.prospectId))).toBeLessThan(early.findIndex((e) => isSpec(e.prospectId)));
  });

  it('is deterministic per rng and adds only small noise', () => {
    const one = aiBoard(league, draft, A, createRng(5));
    expect(aiBoard(league, draft, A, createRng(5))).toEqual(one);
    const clean = aiBoard(league, draft, A, createRng(5), { noise: false });
    expect(rank(clean, one[0]!.prospectId)).toBeLessThan(15);
  });
});

describe('scouting investment changes where a team ranks a prospect', () => {
  it('a team that scouted a prospect heavily ranks him higher than a team that did not (over seeds)', () => {
    let wins = 0;
    let cases = 0;
    let rankGain = 0;
    for (const seed of [51, 52, 53, 54, 55, 56]) {
      const lg = withRecords(makeLeague(seed), createRng(seed));
      let d = createDraftState(lg, createRng(seed + 1));
      const [x, y] = teamIds(lg) as [TeamId, TeamId];
      const band = [...d.prospects].sort((a, b) => (a.consensusRank ?? 0) - (b.consensusRank ?? 0)).slice(10, 70);
      const forX = band.filter((_, i) => i % 6 === 0).map((p) => p.player.id);
      const forY = band.filter((_, i) => i % 6 === 3).map((p) => p.player.id);
      d = grantScoutingPoints(grantScoutingPoints(d, x, 2000, 60), y, 2000, 60);
      d = applyScoutingPlan(d, x, { invest: new Map(forX.map((id) => [id, 100])), interviews: [] });
      d = applyScoutingPlan(d, y, { invest: new Map(forY.map((id) => [id, 100])), interviews: [] });
      const bx = aiBoard(lg, d, x, createRng(1), { noise: false });
      const by = aiBoard(lg, d, y, createRng(1), { noise: false });
      for (const id of forX) { cases += 1; rankGain += rank(by, id) - rank(bx, id); if (rank(bx, id) < rank(by, id)) wins += 1; }
      for (const id of forY) { cases += 1; rankGain += rank(bx, id) - rank(by, id); if (rank(by, id) < rank(bx, id)) wins += 1; }
    }
    expect(cases).toBe(120);
    expect(wins / cases).toBeGreaterThan(0.65);
    expect(rankGain / cases).toBeGreaterThan(5);
  });
});

describe('AI scouting allocation', () => {
  const lg = withRecords(makeLeague(61), createRng(6));
  const fresh = createDraftState(lg, createRng(7));
  const slots = projectedPickSlots(lg, fresh);
  const byPick = teamIds(lg).sort((a, b) => slots(a)[0]! - slots(b)[0]!);
  const first = byPick[0]!;
  const last = byPick[31]!;

  it('projects each team\'s first picks from the standings before the order exists', () => {
    expect(slots(first)).toEqual([1, 33, 65]);
    expect(slots(last)).toEqual([32, 64, 96]);
    const started = startDraft(lg, createRng(8));
    const resolved = projectedPickSlots(started, started.draft!);
    for (const t of teamIds(started)) expect(resolved(t)).toHaveLength(3);
  });

  it('spends what it has, on prospects projected near its own picks', () => {
    // Each team opens the class with its department's budget (draft.ts classScoutingBudget) on top of the grant.
    const budget = 120 + scoutingEntry(fresh, first).pointsAvailable;
    let d = grantScoutingPoints(grantScoutingPoints(fresh, first, 120, 60), last, 120, 60);
    const planFirst = aiScoutingPlan(lg, d, first, createRng(1));
    const planLast = aiScoutingPlan(lg, d, last, createRng(1));
    const spent = (p: typeof planFirst): number => [...p.invest.values()].reduce((s, v) => s + v, 0) + p.interviews.length * DRAFT_CONFIG.scouting.interviewCost;
    expect(spent(planFirst)).toBeLessThanOrEqual(budget);
    expect(spent(planFirst)).toBeGreaterThan(budget - 20);
    const meanRank = (p: typeof planFirst): number => {
      const ids = [...p.invest.keys()];
      return ids.reduce((s, id) => s + (d.prospects.find((x) => x.player.id === id)!.consensusRank ?? 0), 0) / ids.length;
    };
    expect(meanRank(planFirst)).toBeLessThan(meanRank(planLast));
    d = applyScoutingPlan(d, first, planFirst);
    expect(scoutingEntry(d, first).pointsAvailable).toBe(budget - spent(planFirst));
  });

  it('interviews only prospects it has already studied, and never overspends over many weeks', () => {
    let d = fresh;
    for (let week = 0; week < 8; week++) {
      d = grantScoutingPoints(d, first, 30, 60);
      const plan = aiScoutingPlan(lg, d, first, createRng(week));
      for (const id of plan.interviews) expect(scoutingEntry(d, first).invested[id] ?? 0).toBeGreaterThanOrEqual(20);
      d = applyScoutingPlan(d, first, plan);
      expect(scoutingEntry(d, first).pointsAvailable).toBeGreaterThanOrEqual(0);
    }
    const interviewed = Object.values(d.reports[first]!).filter((r) => r.interviewed);
    expect(interviewed.length).toBeGreaterThan(0);
    const invested = Object.values(scoutingEntry(d, first).invested);
    expect(Math.max(...invested)).toBeLessThanOrEqual(DRAFT_CONFIG.scouting.maxInvestedPerProspect);
  });
});

describe('undrafted choices', () => {
  it('returns an available prospect above the camp bar, or null when nobody clears it', () => {
    const id = pickUndrafted(league, draft, A, createRng(1));
    expect(draft.prospects.some((p) => p.player.id === id)).toBe(true);
    const picky = { ...DRAFT_CONFIG, udfa: { ...DRAFT_CONFIG.udfa, minValue: 99 } };
    expect(pickUndrafted(league, draft, A, createRng(1), picky)).toBeNull();
    expect(() => aiPick(league, { ...draft, prospects: [] }, A, createRng(1))).toThrow(/empty/);
  });
});
