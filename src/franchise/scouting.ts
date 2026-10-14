/**
 * Imperfect-information scouting. Every team sees each prospect through its own ScoutingReport:
 * overall/potential RANGES whose width shrinks with the points the team invested and with the
 * quality of its scouting department (never to zero), attribute estimates that blend noisy film
 * study with what the combine numbers imply, a dev-trait read that appears only after heavy
 * investment (and is sometimes wrong), and personality traits / red flags revealed only by an
 * interview. A small per-team, per-position-group bias persists all year, so even an exhaustively
 * scouted prospect is never known exactly.
 *
 * The analytics department (facilities.ts scoutingAccuracy, 0..0.14 by level, stored per team as
 * DraftState.scouting[team].accuracy) takes that share off both the estimation error and the persistent bias, so
 * its reports are tighter, more often right and more confident.
 *
 * Reports are deterministic: a (draft seed, team, prospect) triple always yields the same noise
 * draws (drawn in a fixed order), so a team's view evolves smoothly as its investment grows instead of
 * re-rolling each refresh. Pure: DraftState in, new DraftState out.
 */
import { createRng } from '@/core/rng';
import type { Rng } from '@/core/rng';
import type { PlayerId, TeamId } from '@/core/ids';
import { clamp, clamp01, lerp, round } from '@/core/math';
import { clampRating, positionWeights } from '@/players/attributes';
import { ATTRIBUTE_KEYS, PERSONALITY_TRAITS, POSITION_GROUP } from '@/players/types';
import type { AttributeKey, AttributeSet, DevTrait, PersonalityTrait, Position } from '@/players/types';
import type { Coach, Team } from '@/teams/types';
import type { DraftState, Prospect, ScoutingReport } from '@/franchise/types';
import { bestDrillResults, combineImpliedAttrs, drillHighlights } from '@/franchise/combine';
import { DRAFT_CONFIG, blendValue } from '@/franchise/prospects';
import type { DraftConfig } from '@/franchise/prospects';

/** Coaches as a League-style record or a plain list. */
export type CoachSource = Readonly<Record<string, Coach>> | readonly Coach[];

/** Personality traits that teams treat as red flags when an interview reveals them. */
export const RED_FLAG_TRAITS: readonly PersonalityTrait[] = ['hotHeaded', 'injuryProne', 'lazy'];
/** Attributes the combine measures (always estimated, whatever the position). */
export const MEASURABLE_ATTRIBUTES: readonly AttributeKey[] = ['speed', 'acceleration', 'strength', 'agility', 'jumping'];
const DEV_ORDER: readonly DevTrait[] = ['bust', 'normal', 'quick', 'star', 'superstar'];

const TRAIT_NOTES: Readonly<Record<PersonalityTrait, string>> = {
  leader: 'Interview: natural leader, commands the room',
  teamPlayer: 'Interview: selfless, team-first attitude',
  competitive: 'Interview: fierce competitor',
  quiet: 'Interview: reserved, lets his play talk',
  hotHeaded: 'Red flag: loses his temper under pressure',
  injuryProne: 'Red flag: medical staff flagged durability concerns',
  workhorse: 'Interview: tireless worker, first in the building',
  lazy: 'Red flag: questions about his work ethic',
  mentor: 'Interview: already helps teammates develop',
};

/* ------------------------------------------------------------ departments */

const coachList = (coaches: CoachSource): readonly Coach[] =>
  Array.isArray(coaches) ? (coaches as readonly Coach[]) : Object.values(coaches as Readonly<Record<string, Coach>>);

/** Best scouting rating on the team's staff: a dedicated Scout, else 60% of the best staff eye, else the fallback. */
export const scoutRating = (team: Pick<Team, 'id' | 'staffIds'>, coaches: CoachSource, cfg: DraftConfig = DRAFT_CONFIG): number => {
  const ids = new Set<string>(team.staffIds);
  const staff = coachList(coaches).filter((c) => ids.has(c.id) || c.teamId === team.id);
  const scouts = staff.filter((c) => c.role === 'Scout');
  if (scouts.length > 0) return Math.max(...scouts.map((c) => c.ratings.scouting));
  if (staff.length > 0) return Math.max(cfg.scouting.fallbackScoutRating, 0.6 * Math.max(...staff.map((c) => c.ratings.scouting)));
  return cfg.scouting.fallbackScoutRating;
};

/** Weekly scouting budget: base + Scout rating + scouting facility level + analytics facility level. */
export const scoutingPointsPerWeek = (team: Pick<Team, 'id' | 'staffIds' | 'facilities'>, coaches: CoachSource, cfg: DraftConfig = DRAFT_CONFIG): number => {
  const s = cfg.scouting;
  const raw = s.basePointsPerWeek + scoutRating(team, coaches, cfg) / s.scoutRatingDivisor
    + team.facilities.scouting * s.facilityScoutingPoints + team.facilities.analytics * s.facilityAnalyticsPoints;
  return Math.max(1, Math.round(raw));
};

/** 1..99 quality of the department's evaluations: Scout rating nudged by scouting and analytics facilities. */
export const scoutQualityFor = (team: Pick<Team, 'id' | 'staffIds' | 'facilities'>, coaches: CoachSource, cfg: DraftConfig = DRAFT_CONFIG): number =>
  clampRating(scoutRating(team, coaches, cfg) + (team.facilities.scouting - 3) * 3 + (team.facilities.analytics - 3) * 2);

/* ---------------------------------------------------------------- reports */

/** Standard deviation (overall points) of a report's per-prospect estimation error. */
export const reportSigma = (invested: number, scoutQuality: number, cfg: DraftConfig = DRAFT_CONFIG): number => {
  const s = cfg.scouting;
  const inv = clamp(invested, 0, s.maxInvestedPerProspect);
  const q = clamp01((scoutQuality - 1) / 98);
  return (s.sigmaMin + (s.sigmaMax - s.sigmaMin) * Math.exp(-inv / s.sigmaDecay)) * lerp(s.qualityFactor[0], s.qualityFactor[1], q);
};

/** Persistent evaluation bias (overall points) of one team's scouts for one position group in a draft year. */
export const teamBias = (seed: number, teamId: TeamId, position: Position, cfg: DraftConfig = DRAFT_CONFIG): number =>
  createRng(`bias:${seed}:${teamId}:${POSITION_GROUP[position]}`).gaussian(0, cfg.scouting.biasSd);

/** The stable noise source for one team's view of one prospect. */
export const reportRng = (seed: number, teamId: TeamId, prospectId: PlayerId): Rng => createRng(`report:${seed}:${teamId}:${prospectId}`);

/** Letter grade for a blended value on the 1..99 scale (thresholds from the JSON). */
export const gradeForValue = (value: number, cfg: DraftConfig = DRAFT_CONFIG): string =>
  (cfg.grades.find((g) => value >= g.min) ?? cfg.grades[cfg.grades.length - 1])?.grade ?? 'F';

const mid = (r: readonly [number, number]): number => (r[0] + r[1]) / 2;

/** Value a report implies (blend of the range midpoints; no age/position/need terms). */
export const reportValue = (report: Pick<ScoutingReport, 'overallRange' | 'potentialRange'>, cfg: DraftConfig = DRAFT_CONFIG): number =>
  blendValue(mid(report.overallRange), mid(report.potentialRange), cfg);

/** Integer range around `center` with half-width `hw`, inside 1..99 and at least 2 points wide. */
const toRange = (center: number, hw: number): [number, number] => {
  let lo = clampRating(Math.round(center - hw));
  let hi = clampRating(Math.round(center + hw));
  if (hi - lo < 2) {
    if (hi >= 98) lo = hi - 2;
    else hi = Math.min(99, lo + 2);
  }
  return [Math.max(1, lo), hi];
};

const neighbourTrait = (trait: DevTrait, u: number): DevTrait => {
  const i = DEV_ORDER.indexOf(trait);
  const step = u < 0.5 ? -1 : 1;
  const j = i + step < 0 || i + step >= DEV_ORDER.length ? i - step : i + step;
  return DEV_ORDER[j] ?? trait;
};

const investmentNote = (invested: number): string =>
  invested <= 0 ? 'Film only: no dedicated scouting yet'
    : invested < 25 ? 'Preliminary evaluation'
      : invested < 60 ? 'Solid evaluation from multiple visits'
        : 'Exhaustively scouted';

/** What the published drills say about a prospect (identical for every team, so computed once per Prospect object). */
interface DrillView {
  implied: Partial<AttributeSet>;
  highlights: string[];
}
const drillViews = new WeakMap<Prospect, DrillView>();
const drillView = (prospect: Prospect): DrillView => {
  const cached = drillViews.get(prospect);
  if (cached) return cached;
  const best = bestDrillResults(prospect);
  const view = { implied: combineImpliedAttrs(best, prospect.player.weightLb), highlights: drillHighlights(best) };
  drillViews.set(prospect, view);
  return view;
};

/** Extra knobs for generateReport. */
export interface ReportOptions {
  /** Persistent team bias in overall points (see teamBias). Default 0. */
  bias?: number;
  /** Analytics accuracy 0..0.5: the share taken off the error and the bias (facilities.ts scoutingAccuracy). Default 0. */
  accuracy?: number;
  cfg?: DraftConfig;
}

/**
 * One team's scouting report on a prospect. `rng` should be the stable reportRng for the
 * (draft, team, prospect) triple; every draw happens up front in a fixed order, so the same rng and
 * a higher `invested` yields a tighter view of the same underlying noise. Ranges are sized from the
 * uncertainty the scouts know about (their own noise plus the typical bias), so the truth lands
 * inside roughly 90% of the time: not always.
 */
export const generateReport = (
  rng: Rng, prospect: Prospect, invested: number, scoutQuality: number, interviewed: boolean, opts: ReportOptions = {},
): ScoutingReport => {
  const cfg = opts.cfg ?? DRAFT_CONFIG;
  const s = cfg.scouting;
  const p = prospect.player;
  const inv = clamp(invested, 0, s.maxInvestedPerProspect);
  const q = clamp01((scoutQuality - 1) / 98);
  const zOvr = rng.gaussian();
  const zPotRaw = rng.gaussian();
  const zAttr = ATTRIBUTE_KEYS.map(() => rng.gaussian());
  const uDevCorrect = rng.next();
  const uDevDir = rng.next();
  const traitDraws = PERSONALITY_TRAITS.map(() => rng.next());
  const uSecondTrait = rng.next();

  const sharpen = 1 - clamp(opts.accuracy ?? 0, 0, 0.5);
  const bias = (opts.bias ?? 0) * sharpen;
  const sigma = reportSigma(inv, scoutQuality, cfg) * sharpen;
  const overallRange = toRange(p.overall + bias + sigma * zOvr, s.rangeZ * Math.hypot(sigma, s.biasSd * sharpen));
  const sigmaPot = sigma * s.potentialSigmaScale + s.potentialSigmaFloor;
  const zPot = 0.5 * zOvr + Math.sqrt(0.75) * zPotRaw;
  const rawPot = toRange(p.potential + bias + sigmaPot * zPot, s.rangeZ * Math.hypot(sigmaPot, s.biasSd * sharpen));
  const potentialRange: [number, number] = [Math.max(rawPot[0], overallRange[0]), Math.max(rawPot[1], overallRange[1])];

  const { implied, highlights } = drillView(prospect);
  const weights = positionWeights(p.position);
  const sigmaAttr = sigma * s.attributeSigmaScale + s.attributeSigmaFloor;
  const attributeEstimates: Partial<AttributeSet> = {};
  ATTRIBUTE_KEYS.forEach((key, i) => {
    if ((weights[key] ?? 0) <= 0 && !MEASURABLE_ATTRIBUTES.includes(key)) return;
    const film = p.attrs[key] + bias * 0.5 + sigmaAttr * (zAttr[i] ?? 0);
    const measured = implied[key];
    attributeEstimates[key] = clampRating(measured === undefined ? film : lerp(film, measured, s.combineWeight));
  });

  const revealAt = lerp(s.devRevealInvest[0], s.devRevealInvest[1], q);
  let devTraitEstimate: DevTrait | null = null;
  if (inv >= revealAt) {
    const accuracy = clamp01(lerp(s.devAccuracy[0], s.devAccuracy[1], q) + 0.1 * clamp01((inv - revealAt) / 30));
    devTraitEstimate = uDevCorrect < accuracy ? p.devTrait : neighbourTrait(p.devTrait, uDevDir);
  }

  let traitsRevealed: PersonalityTrait[] = [];
  if (interviewed && p.traits.length > 0) {
    const detect = lerp(s.redFlagDetection[0], s.redFlagDetection[1], q);
    const draw = (t: PersonalityTrait): number => traitDraws[PERSONALITY_TRAITS.indexOf(t)] ?? 0.5;
    const priority = (t: PersonalityTrait): number => (RED_FLAG_TRAITS.includes(t) && draw(t) < detect ? 0 : 1) + draw(t);
    const count = uSecondTrait < lerp(s.interviewSecondTraitChance[0], s.interviewSecondTraitChance[1], q) ? 2 : 1;
    traitsRevealed = [...p.traits].sort((a, b) => priority(a) - priority(b)).slice(0, count);
  }
  const redFlags = traitsRevealed.filter((t) => RED_FLAG_TRAITS.includes(t));

  const notes: string[] = [investmentNote(inv), ...highlights];
  if (prospect.proDay && Object.keys(prospect.proDay).length > 0) notes.push('Posted improved numbers at his pro day');
  const upside = mid(potentialRange) - mid(overallRange);
  if (upside >= 15) notes.push('Raw, high-ceiling prospect');
  else if (upside <= 5) notes.push('Pro-ready, limited ceiling');
  if (devTraitEstimate === 'star' || devTraitEstimate === 'superstar') notes.push('Scouts rave about how quickly he improves');
  else if (devTraitEstimate === 'bust') notes.push('Concern he has already peaked');
  if (interviewed) {
    if (traitsRevealed.length === 0) notes.push('Interview raised no character concerns');
    for (const t of traitsRevealed) notes.push(TRAIT_NOTES[t]);
  }

  return {
    prospectId: p.id,
    overallRange,
    potentialRange,
    grade: gradeForValue(blendValue(mid(overallRange), mid(potentialRange), cfg), cfg),
    confidence: round(clamp01(1 - sigma / (s.sigmaMax * s.qualityFactor[0])), 2),
    attributeEstimates,
    devTraitEstimate,
    traitsRevealed,
    notes,
    interviewed,
    redFlags,
  };
};

/* ------------------------------------------------------------ draft state */

type ScoutingEntry = DraftState['scouting'][TeamId];

const DEFAULT_SCOUT_QUALITY = 50;

/** Stable seed used for report noise and team bias (falls back to the year on older saves). */
export const draftSeed = (draft: Pick<DraftState, 'seed' | 'year'>): number => draft.seed ?? draft.year;

/** The team's scouting ledger (empty when the team has not been granted points yet). */
export const scoutingEntry = (draft: DraftState, teamId: TeamId): ScoutingEntry =>
  draft.scouting[teamId] ?? { pointsAvailable: 0, invested: {} };

const findProspect = (draft: DraftState, prospectId: PlayerId, fn: string): Prospect => {
  const prospect = draft.prospects.find((p) => p.player.id === prospectId);
  if (!prospect) throw new Error(`${fn}: prospect '${prospectId}' is not in the draft pool`);
  return prospect;
};

/** Rebuilds one team's report on one prospect from the stored investment, quality and interview flag. */
export const buildReport = (draft: DraftState, teamId: TeamId, prospect: Prospect, interviewed?: boolean, cfg: DraftConfig = DRAFT_CONFIG): ScoutingReport => {
  const entry = scoutingEntry(draft, teamId);
  const id = prospect.player.id;
  const seed = draftSeed(draft);
  return generateReport(
    reportRng(seed, teamId, id), prospect, entry.invested[id] ?? 0, entry.scoutQuality ?? DEFAULT_SCOUT_QUALITY,
    interviewed ?? draft.reports[teamId]?.[id]?.interviewed ?? false, { bias: teamBias(seed, teamId, prospect.player.position, cfg), accuracy: entry.accuracy ?? 0, cfg },
  );
};

/** Options for refreshReports: restrict to some teams and/or prospects (default: everything). */
export interface RefreshOptions {
  teamIds?: readonly TeamId[];
  prospectIds?: readonly PlayerId[];
  cfg?: DraftConfig;
}

/**
 * Regenerates reports (after pro days, a new scout, or the weekly pass). Teams default to every team
 * with a scouting ledger; prospects default to the whole pool. Interview flags are preserved.
 */
export const refreshReports = (draft: DraftState, opts: RefreshOptions = {}): DraftState => {
  const teamIds = opts.teamIds ?? (Object.keys(draft.scouting) as TeamId[]);
  const wanted = opts.prospectIds ? new Set<string>(opts.prospectIds) : null;
  const prospects = wanted ? draft.prospects.filter((p) => wanted.has(p.player.id)) : draft.prospects;
  const reports = { ...draft.reports };
  for (const teamId of teamIds) {
    const own = { ...(reports[teamId] ?? {}) };
    for (const prospect of prospects) own[prospect.player.id] = buildReport(draft, teamId, prospect, undefined, opts.cfg);
    reports[teamId] = own;
  }
  return { ...draft, reports };
};

/** Base (film-only or current-investment) reports for every team with a ledger on every prospect. */
export const initialReports = (draft: DraftState, cfg: DraftConfig = DRAFT_CONFIG): DraftState => refreshReports(draft, { cfg });

/**
 * Adds a week's scouting points and records the department's current quality (and, when given, the analytics
 * accuracy). When either changed (new Scout, facility upgrade) the team's existing reports are regenerated.
 */
export const grantScoutingPoints = (
  draft: DraftState, teamId: TeamId, points: number, scoutQuality: number, cfg: DraftConfig = DRAFT_CONFIG, accuracy?: number,
): DraftState => {
  if (!Number.isFinite(points) || points < 0) throw new Error(`grantScoutingPoints: points must be >= 0, got ${points}`);
  const entry = scoutingEntry(draft, teamId);
  const quality = clampRating(scoutQuality);
  const acc = accuracy === undefined ? entry.accuracy : clamp(accuracy, 0, 0.5);
  const next: DraftState = {
    ...draft,
    scouting: { ...draft.scouting, [teamId]: { ...entry, pointsAvailable: entry.pointsAvailable + points, scoutQuality: quality, ...(acc !== undefined ? { accuracy: acc } : {}) } },
  };
  const changed = (entry.scoutQuality !== undefined && entry.scoutQuality !== quality) || (entry.accuracy ?? 0) !== (acc ?? 0);
  const missing = draft.reports[teamId] === undefined;
  return changed || missing ? refreshReports(next, { teamIds: [teamId], cfg }) : next;
};

/** A batch of investments (prospect -> points) and interviews for one team. */
export interface ScoutingPlan {
  invest: ReadonlyMap<PlayerId, number>;
  interviews: readonly PlayerId[];
}

/**
 * Applies a whole plan atomically: validates every prospect, clamps each investment to the
 * per-prospect cap, charges points (investments plus interview costs) and regenerates only the
 * affected reports. Throws when the plan costs more than the team has.
 */
export const applyScoutingPlan = (draft: DraftState, teamId: TeamId, plan: ScoutingPlan, cfg: DraftConfig = DRAFT_CONFIG): DraftState => {
  const s = cfg.scouting;
  const entry = scoutingEntry(draft, teamId);
  const invested = { ...entry.invested };
  let cost = 0;
  const touched = new Set<PlayerId>();
  for (const [id, points] of plan.invest) {
    if (!Number.isFinite(points) || points <= 0) throw new Error(`allocateScouting: points must be positive, got ${points}`);
    findProspect(draft, id, 'allocateScouting');
    const current = invested[id] ?? 0;
    const spend = Math.min(points, s.maxInvestedPerProspect - current);
    if (spend <= 0) continue;
    invested[id] = current + spend;
    cost += spend;
    touched.add(id);
  }
  const reports = { ...(draft.reports[teamId] ?? {}) };
  const interviewedNow = new Set<PlayerId>();
  for (const id of plan.interviews) {
    findProspect(draft, id, 'interview');
    if (reports[id]?.interviewed || interviewedNow.has(id)) throw new Error(`interview: prospect '${id}' was already interviewed`);
    interviewedNow.add(id);
    cost += s.interviewCost;
    touched.add(id);
  }
  if (cost > entry.pointsAvailable + 1e-9) {
    throw new Error(`scouting: plan costs ${cost} points but team '${teamId}' has ${entry.pointsAvailable}`);
  }
  const next: DraftState = {
    ...draft,
    scouting: { ...draft.scouting, [teamId]: { ...entry, pointsAvailable: entry.pointsAvailable - cost, invested } },
  };
  for (const id of touched) {
    const interviewed = interviewedNow.has(id) || (reports[id]?.interviewed ?? false);
    reports[id] = buildReport(next, teamId, findProspect(draft, id, 'scouting'), interviewed, cfg);
  }
  return { ...next, reports: { ...draft.reports, [teamId]: reports } };
};

/**
 * Spends `points` of the team's budget on one prospect (capped at maxInvestedPerProspect; only the
 * amount actually invested is charged) and regenerates that report. Throws when the team cannot
 * afford it or the prospect is not in the pool.
 */
export const allocateScouting = (draft: DraftState, teamId: TeamId, prospectId: PlayerId, points: number, cfg: DraftConfig = DRAFT_CONFIG): DraftState =>
  applyScoutingPlan(draft, teamId, { invest: new Map([[prospectId, points]]), interviews: [] }, cfg);

/**
 * Interviews a prospect (costs interviewCost points): reveals one or two of his personality traits,
 * red flags first when the scouts catch them, and marks the report interviewed. Once per prospect.
 */
export const interview = (draft: DraftState, teamId: TeamId, prospectId: PlayerId, cfg: DraftConfig = DRAFT_CONFIG): DraftState =>
  applyScoutingPlan(draft, teamId, { invest: new Map(), interviews: [prospectId] }, cfg);
