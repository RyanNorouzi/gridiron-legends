/**
 * Draft-room AI. Every decision reads the team's OWN scouting reports (never the prospect's true
 * ratings) plus public facts (position, age, consensus rank) and the team's own roster:
 *  - aiBoard / aiPick: report midpoint value + age + positional value + roster need + positional
 *    scarcity - uncertainty penalty (teams prefer players they know) + dev-trait read - red flags +
 *    a little noise (occasionally a lot: reaches and gut calls).
 *  - aiScoutingPlan / aiAllocateScouting: spend the weekly budget on prospects projected near the
 *    team's likely picks, weighted by need and positional value, and interview the top targets.
 *  - pickUndrafted: best remaining prospect worth a camp invite after the draft.
 * Roster needs come from gm/needs (see draftNeeds).
 */
import type { Rng } from '@/core/rng';
import type { PlayerId, TeamId } from '@/core/ids';
import { clamp } from '@/core/math';
import { POSITIONS, isSpecialist } from '@/players/types';
import type { Position } from '@/players/types';
import { ROSTER_COMPOSITION } from '@/teams/depth-chart';
import type { DraftState, League, Prospect, ScoutingReport } from '@/franchise/types';
import { DRAFT_CONFIG, ageValueBonus, positionValueBonus } from '@/franchise/prospects';
import type { DraftConfig } from '@/franchise/prospects';
import { applyScoutingPlan, scoutingEntry } from '@/franchise/scouting';
import type { ScoutingPlan } from '@/franchise/scouting';
import { indexPicks, pickId, teamDraftOrder } from '@/franchise/draft-order';
import { teamNeeds } from '@/franchise/gm/needs';
import type { TeamDirection } from '@/franchise/gm/needs';

/** Need-multiplier dampening per player already carried above the 53-man composition at a position. */
const OVERSTOCK_STEP = 0.08;
/** Overall-vs-potential weight shift for contending (+) and rebuilding (-) teams. */
const DIRECTION_TILT = 0.1;

/** A team's draft needs: a per-position value multiplier (1 = neutral) and its GM direction. */
export interface DraftNeeds {
  multipliers: Record<Position, number>;
  direction: TeamDirection;
}

/**
 * Draft needs from gm/needs (starter quality, depth, age, expiring deals): multiplier 0.85 + 0.6 x need,
 * damped for positions already stocked beyond the roster composition (so a class does not pile up at
 * one spot), clamped to 0.7 .. 1.35.
 */
export const draftNeeds = (league: League, teamId: TeamId): DraftNeeds => {
  const team = league.teams[teamId];
  if (!team) throw new Error(`draftNeeds: unknown team '${teamId}'`);
  const needs = teamNeeds(league, team);
  const multipliers = {} as Record<Position, number>;
  for (const pos of POSITIONS) {
    const n = needs.positions[pos];
    const over = Math.max(0, n.depthCount - ROSTER_COMPOSITION[pos]);
    multipliers[pos] = clamp(0.85 + 0.6 * n.need - OVERSTOCK_STEP * over, 0.7, 1.35);
  }
  return { multipliers, direction: needs.direction };
};

/** One prospect on an AI board. */
export interface AiBoardEntry {
  prospectId: PlayerId;
  /** Full decision value (ranking key). */
  value: number;
  /** The team's scouted estimate alone (report value, or the public projection without a report). */
  estimate: number;
}

/** Options for aiBoard. */
export interface AiBoardOptions {
  /** Round being picked in (gates specialists); default: the draft's current round, else 1. */
  round?: number;
  /** Add decision noise (default true). */
  noise?: boolean;
  cfg?: DraftConfig;
}

/**
 * Scouted value of a prospect from a report (contenders lean on current ability, rebuilders on the
 * ceiling), or from the public projection when there is no report.
 */
export const scoutedEstimate = (prospect: Prospect, report: ScoutingReport | null, direction: TeamDirection = 'retool', cfg: DraftConfig = DRAFT_CONFIG): number => {
  if (!report) return 78 - 4.5 * (prospect.projectedRound - 1);
  const tilt = direction === 'contend' ? DIRECTION_TILT : direction === 'rebuild' ? -DIRECTION_TILT : 0;
  const midO = (report.overallRange[0] + report.overallRange[1]) / 2;
  const midP = (report.potentialRange[0] + report.potentialRange[1]) / 2;
  return (cfg.value.overallWeight + tilt) * midO + (cfg.value.potentialWeight - tilt) * midP;
};

const currentRound = (draft: DraftState): number => draft.order[draft.currentPickIndex]?.round ?? 1;

/**
 * The team's full draft board, best first. Deterministic for a given rng; `noise: false` gives the
 * pure valuation.
 */
export const aiBoard = (league: League, draft: DraftState, teamId: TeamId, rng: Rng, opts: AiBoardOptions = {}): AiBoardEntry[] => {
  const cfg = opts.cfg ?? DRAFT_CONFIG;
  const ai = cfg.ai;
  const reports = draft.reports[teamId] ?? {};
  const { multipliers: needs, direction } = draftNeeds(league, teamId);
  const round = opts.round ?? currentRound(draft);
  const noisy = opts.noise ?? true;
  const sd = noisy ? (rng.chance(ai.reachChance) ? ai.reachSd : ai.noiseSd) : 0;
  const rows = draft.prospects.map((p) => {
    const report = reports[p.player.id] ?? null;
    return { p, report, estimate: scoutedEstimate(p, report, direction, cfg) };
  });
  const byPosition = new Map<Position, number[]>();
  for (const r of rows) byPosition.set(r.p.player.position, [...(byPosition.get(r.p.player.position) ?? []), r.estimate]);
  const out: AiBoardEntry[] = rows.map(({ p, report, estimate }) => {
    const pos = p.player.position;
    const rivals = (byPosition.get(pos) ?? []).filter((e) => e >= estimate - 3).length - 1;
    const scarcity = ai.scarcityWeight * Math.max(0, 3 - rivals) / 3;
    const width = report ? ((report.overallRange[1] - report.overallRange[0]) + (report.potentialRange[1] - report.potentialRange[0])) / 2 : 30;
    const dev = report?.devTraitEstimate ? ai.devTraitBonus[report.devTraitEstimate] : 0;
    const flags = (report?.redFlags.length ?? 0) * ai.redFlagPenalty;
    const specialist = isSpecialist(pos) && round < cfg.specialistMinRound ? ai.specialistPenalty : 0;
    const value = estimate + ageValueBonus(p.player.age, cfg) + positionValueBonus(pos, cfg) + (needs[pos] - 1) * ai.needWeight
      + scarcity - ai.riskAversion * width + dev - flags - specialist + (sd > 0 ? rng.gaussian(0, sd) : 0);
    return { prospectId: p.player.id, value, estimate };
  });
  out.sort((a, b) => b.value - a.value || (a.prospectId < b.prospectId ? -1 : 1));
  return out;
};

/** The AI's selection for `teamId` at the current pick. Throws when the pool is empty. */
export const aiPick = (league: League, draft: DraftState, teamId: TeamId, rng: Rng, cfg: DraftConfig = DRAFT_CONFIG): PlayerId => {
  const top = aiBoard(league, draft, teamId, rng, { cfg })[0];
  if (!top) throw new Error('aiPick: the draft pool is empty');
  return top.prospectId;
};

/**
 * UDFA choice after the draft: the team's best remaining prospect whose scouted estimate clears the
 * camp-invite bar, or null.
 */
export const pickUndrafted = (league: League, draft: DraftState, teamId: TeamId, rng: Rng, cfg: DraftConfig = DRAFT_CONFIG): PlayerId | null => {
  const board = aiBoard(league, draft, teamId, rng, { cfg, round: Number.MAX_SAFE_INTEGER });
  return board.find((e) => e.estimate >= cfg.udfa.minValue)?.prospectId ?? null;
};

/* ------------------------------------------------------------- scouting */

/**
 * Overall slots (1-based) of the team's first three picks: from the resolved order when the draft has
 * one, otherwise projected from the current standings (a traded-in pick uses its original team's slot).
 */
export const projectedPickSlots = (league: League, draft: DraftState): ((teamId: TeamId) => number[]) => {
  if (draft.order.length > 0) {
    const where = indexPicks(league.teams);
    const pending = draft.order.slice(draft.currentPickIndex);
    return (teamId) => pending
      .filter((p) => (where.get(p.id)?.holder ?? p.ownerTeamId) === teamId)
      .map((p) => p.overall ?? 0).filter((n) => n > 0).slice(0, 3);
  }
  const order = teamDraftOrder(league);
  const perRound = Math.max(1, order.length);
  const slotOf = new Map<string, number>();
  for (let round = 1; round <= league.settings.draftRounds; round++) {
    order.forEach((tid, i) => slotOf.set(pickId(draft.year, round, tid), (round - 1) * perRound + i + 1));
  }
  return (teamId) => (league.teams[teamId]?.picks ?? [])
    .filter((p) => p.year === draft.year)
    .map((p) => slotOf.get(p.id) ?? 0).filter((n) => n > 0)
    .sort((a, b) => a - b).slice(0, 3);
};

/**
 * This week's scouting plan for an AI team: candidates are weighted by how close their public
 * consensus rank sits to the team's likely picks, by need and by positional value (with a little
 * jitter); the top tiers get investment up to tier caps in chunks, and the top targets that have been
 * studied are interviewed. Never spends more than the team has.
 */
export const aiScoutingPlan = (league: League, draft: DraftState, teamId: TeamId, rng: Rng, cfg: DraftConfig = DRAFT_CONFIG): ScoutingPlan => {
  const ai = cfg.ai;
  const s = cfg.scouting;
  const entry = scoutingEntry(draft, teamId);
  const reports = draft.reports[teamId] ?? {};
  let points = Math.floor(entry.pointsAvailable);
  const invest = new Map<PlayerId, number>();
  const interviews: PlayerId[] = [];
  if (points <= 0 || draft.prospects.length === 0) return { invest, interviews };
  const needs = draftNeeds(league, teamId).multipliers;
  const found = projectedPickSlots(league, draft)(teamId);
  const perRound = Math.max(1, Object.keys(league.teams).length);
  const slots = found.length > 0 ? found : [perRound * 2];
  const candidates = draft.prospects.map((p) => {
    const rank = p.consensusRank ?? (p.projectedRound - 0.5) * perRound;
    const fit = slots.reduce((sum, slot) => sum + Math.exp(-Math.abs(rank - slot) / ai.windowWidth), 0);
    const weight = fit * needs[p.player.position] * cfg.positionValue[p.player.position] * rng.range(0.85, 1.15);
    return { id: p.player.id, weight };
  }).sort((a, b) => b.weight - a.weight || (a.id < b.id ? -1 : 1));

  const invested = (id: PlayerId): number => (entry.invested[id] ?? 0) + (invest.get(id) ?? 0);
  const targets: { id: PlayerId; cap: number }[] = [];
  let offset = 0;
  for (const tier of ai.scoutTiers) {
    for (const c of candidates.slice(offset, offset + tier.count)) targets.push({ id: c.id, cap: Math.min(tier.cap, s.maxInvestedPerProspect) });
    offset += tier.count;
  }
  for (const t of targets.slice(0, ai.interviewTargets)) {
    if (points < s.interviewCost || reports[t.id]?.interviewed || invested(t.id) < 20) continue;
    interviews.push(t.id);
    points -= s.interviewCost;
  }
  let progress = true;
  while (points > 0 && progress) {
    progress = false;
    for (const t of targets) {
      const amount = Math.min(ai.scoutChunk, t.cap - invested(t.id), points);
      if (amount <= 0) continue;
      invest.set(t.id, (invest.get(t.id) ?? 0) + amount);
      points -= amount;
      progress = true;
      if (points <= 0) break;
    }
  }
  return { invest, interviews };
};

/** Runs aiScoutingPlan and applies it to the draft state. */
export const aiAllocateScouting = (league: League, draft: DraftState, teamId: TeamId, rng: Rng, cfg: DraftConfig = DRAFT_CONFIG): DraftState => {
  const plan = aiScoutingPlan(league, draft, teamId, rng, cfg);
  if (plan.invest.size === 0 && plan.interviews.length === 0) return draft;
  return applyScoutingPlan(draft, teamId, plan, cfg);
};
