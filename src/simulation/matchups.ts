import { clamp, clamp01, lerp, logistic, mean, ratingToFactor } from '@/core/math';
import { ATTRIBUTE_KEYS, POSITION_GROUP, type AttributeKey, type AttributeSet, type Player, type Position } from '@/players/types';
import { loadPlaybookData } from '@/playbook/loader';
import { readOrder, type DefAssignment, type DefensivePlay, type OffAssignment, type OffensivePlay, type RouteType } from '@/playbook/types';
import { effectiveAttrs } from '@/physics/attributes';
import { coverageEdge } from '@/ai/coverage-iq';
import type { PlayContext } from '@/game/play-types';
import type { Side } from '@/game/types';
import { applyCpuEdge, cpuEdgeFor } from '@/game/difficulty-sides';

/**
 * Lineup-strength summaries for the statistical simulation. Every number here is a 0..1 factor built from
 * EFFECTIVE attributes (base ratings minus fatigue, weather and injury, via physics/attributes) so tired,
 * hurt or rain-soaked players genuinely play worse. The play model (play-model.ts) turns these into
 * probabilities; nothing here consumes randomness.
 */
const f = ratingToFactor;

/** Difficulty knobs for AI-controlled sides (null = human side: attributes only). */
export interface MatchupKnobs {
  /** DifficultyProfile.qbDecisionQuality for an AI offense. */
  qbIq: number | null;
  /** DifficultyProfile.coverageAnticipation for an AI defense. */
  coverageIq: number | null;
}

/** One player on the field with his effective ratings for this snap. */
export interface RatedPlayer {
  side: Side;
  role: string;
  player: Player;
  position: Position;
  attrs: AttributeSet;
  assignment: OffAssignment | DefAssignment;
}

/** A receiver in the QB's progression with the coverage he faces. */
export interface ReceiverOption {
  rated: RatedPlayer;
  /** 0 = primary read. */
  readIndex: number;
  routeType: RouteType | null;
  /** Nominal route depth (yards past the LOS; negative for screens). */
  depth: number;
  /** Catch/route/speed quality 0..1. */
  quality: number;
  /** Expected separation 0..1 (0.5 = even matchup) before per-play noise. */
  openness: number;
  /** The defender most responsible for him (man defender, or the closest zone defender), if any. */
  defender: RatedPlayer | null;
  /** Route works the sideline (out-of-bounds finishes, sideline catches). */
  sideline: boolean;
}

/** Concept-vs-coverage adjustments; additive on the probabilities / yards they name. */
export interface ConceptModifiers {
  completion: number;
  airYards: number;
  /** Multiplier delta on mean yards after catch (0.2 = +20%). */
  yac: number;
  pressure: number;
  sack: number;
  interception: number;
  runYards: number;
  stuff: number;
  explosive: number;
}

export interface Matchups {
  offense: RatedPlayer[];
  defense: RatedPlayer[];
  passer: RatedPlayer | null;
  /** Accuracy / awareness / vision / arm blend 0..1. */
  qbQuality: number;
  qbMobility: number;
  qbDecision: number;
  carrier: RatedPlayer | null;
  blockers: RatedPlayer[];
  passProtection: number;
  rushers: RatedPlayer[];
  passRush: number;
  blitzCount: number;
  runBlocking: number;
  runDefenders: RatedPlayer[];
  runDefense: number;
  boxCount: number;
  receivers: ReceiverOption[];
  coverageDefenders: RatedPlayer[];
  coverageQuality: number;
  hasContain: boolean;
  hasSpy: boolean;
  hasPress: boolean;
  kicker: RatedPlayer | null;
  holder: RatedPlayer | null;
  returner: RatedPlayer | null;
  /** Kick-coverage unit speed/pursuit/tackling 0..1. */
  kickCoverage: number;
  /** Return-blocking unit 0..1. */
  returnBlocking: number;
  modifiers: ConceptModifiers;
}

const DEEP_ZONE = /^deep/;
const SIDELINE_ROUTES = new Set<RouteType>(['out', 'corner', 'comeback', 'fade', 'flat', 'wheel', 'screen']);
const FALLBACK_DEPTH: Readonly<Record<RouteType, number>> = {
  go: 15, post: 12, corner: 12, out: 10, in: 10, dig: 14, slant: 3, curl: 10, comeback: 12, drag: 4, flat: 3, wheel: 6,
  screen: -2, hitch: 5, seam: 12, fade: 10, cross: 10, angle: 3, stick: 6, swing: 0, checkRelease: 2, block: 0,
};
const ROUTE_TYPES = Object.keys(FALLBACK_DEPTH) as RouteType[];

/** Route type + depth for a route id (registry first, then the id prefix, e.g. 'quickOut~m' -> out). */
export const routeInfo = (routeId: string): { type: RouteType | null; depth: number } => {
  let registry: ReturnType<typeof loadPlaybookData> | null = null;
  try { registry = loadPlaybookData(); } catch { registry = null; }
  const def = registry?.routes[routeId];
  if (def) return { type: def.type, depth: def.depth };
  const base = routeId.replace(/~m$/, '').toLowerCase();
  const type = ROUTE_TYPES.find((t) => base.includes(t.toLowerCase())) ?? null;
  return { type, depth: type ? FALLBACK_DEPTH[type] : 5 };
};

/**
 * Share of a player's distance from the league-reference overall that the statistical model feels. Ratings still order
 * everything (a better lineup always plays better), but at full leverage an 11-point overall edge was worth ~26 points
 * a game and a 67-77 league produced 16-1 and 0-17 records; at this leverage (with GAME_FORM_SD) full-length league
 * seasons have an NFL-like win spread (SD ~3) and mean margin (~11-12; 0.42 left 16 with a 16-1 best record, 0.3 left
 * ~12.5-13.5 with 1,900-yard rushers and 150-catch receivers once league completion was raised to the NFL's ~63%).
 */
export const RATING_LEVERAGE = 0.27;
/** Overall of the league's typical starter (snap-weighted); players at this level are rated unchanged. */
export const REFERENCE_OVERALL = 70;
const UNLEVERAGED_KEYS: ReadonlySet<AttributeKey> = new Set<AttributeKey>(['kickPower', 'kickAccuracy', 'stamina', 'injuryResistance']);

/**
 * A player's attributes as the statistical model rates them: every non-kicking attribute moves by (leverage - 1) x
 * (overall - reference), i.e. the player plays like a reference-level player of his own archetype plus `leverage` of
 * his edge. Kickers and punters, kicking attributes and durability (stamina, injury resistance) are untouched.
 */
export const leveragedAttrs = (player: Player, leverage: number = RATING_LEVERAGE): AttributeSet => {
  if (leverage === 1 || player.position === 'K' || player.position === 'P') return player.attrs;
  const shift = (leverage - 1) * (player.overall - REFERENCE_OVERALL);
  if (shift === 0) return player.attrs;
  const out = { ...player.attrs };
  for (const key of ATTRIBUTE_KEYS) if (!UNLEVERAGED_KEYS.has(key)) out[key] = clamp(player.attrs[key] + shift, 1, 99);
  return out;
};

const rate = (ctx: PlayContext, side: Side): RatedPlayer[] => {
  const lineup = side === 'offense' ? ctx.offenseLineup : ctx.defenseLineup;
  const plays = side === 'offense' ? ctx.offensivePlay.assignments : ctx.defensivePlay.assignments;
  // The CPU team's performance edge in a simulated user game (NO_EDGE otherwise), as in the live engine.
  const edge = cpuEdgeFor(ctx, side === 'offense' ? ctx.offense : ctx.offense === 'home' ? 'away' : 'home');
  const out: RatedPlayer[] = [];
  for (const [role, player] of Object.entries(lineup)) {
    const assignment: OffAssignment | DefAssignment = plays[role] ?? (side === 'offense' ? { type: 'passBlock' } : { type: 'zone', zone: 'middleHook' });
    const attrs = applyCpuEdge(effectiveAttrs(leveragedAttrs(player), ctx.fatigue[player.id] ?? 0, ctx.weather, player.injury), edge);
    out.push({ side, role, player, position: player.position, attrs, assignment });
  }
  return out;
};

const avg = (xs: number[], fallback = 0.5): number => (xs.length ? mean(xs) : fallback);
const group = (p: RatedPlayer): string => POSITION_GROUP[p.position];

/** Pass-protection factor: interior line technique/strength/awareness, backs and tight ends at half weight. */
export const passProtectionOf = (blockers: RatedPlayer[]): number => {
  let total = 0;
  let weight = 0;
  for (const b of blockers) {
    const w = group(b) === 'OL' ? 1 : 0.5;
    total += w * (0.5 * f(b.attrs.blocking) + 0.3 * f(b.attrs.strength) + 0.2 * f(b.attrs.awareness));
    weight += w;
  }
  return weight > 0 ? total / weight : 0.4;
};

/** Pass-rush factor: the best four rushers plus a small bonus for every extra body sent. */
export const passRushOf = (rushers: RatedPlayer[]): number => {
  const scores = rushers.map((r) => (group(r) === 'DL'
    ? 0.5 * f(r.attrs.passRush) + 0.3 * f(r.attrs.speed) + 0.2 * f(r.attrs.strength)
    : 0.4 * f(r.attrs.passRush) + 0.4 * f(r.attrs.speed) + 0.2 * f(r.attrs.acceleration))).sort((a, b) => b - a);
  const top = scores.slice(0, 4);
  return avg(top, 0.45) + 0.05 * Math.max(0, scores.length - 4);
};

export const runBlockingOf = (blockers: RatedPlayer[]): number =>
  avg(blockers.map((b) => 0.5 * f(b.attrs.blocking) + 0.35 * f(b.attrs.strength) + 0.15 * f(b.attrs.balance)), 0.4);

export const runDefenseOf = (box: RatedPlayer[]): number =>
  avg(box.map((d) => 0.4 * f(d.attrs.tackling) + 0.3 * f(d.attrs.strength) + 0.2 * f(d.attrs.pursuit) + 0.1 * f(d.attrs.awareness)), 0.45);

const qbQualityOf = (qb: RatedPlayer | null): number =>
  qb ? 0.4 * f(qb.attrs.throwAccuracy) + 0.25 * f(qb.attrs.awareness) + 0.2 * f(qb.attrs.vision) + 0.15 * f(qb.attrs.throwPower) : 0.4;
const qbMobilityOf = (qb: RatedPlayer | null): number =>
  qb ? 0.5 * f(qb.attrs.speed) + 0.3 * f(qb.attrs.agility) + 0.2 * f(qb.attrs.acceleration) : 0.3;

/** Receiver catch/route/speed quality 0..1. */
export const receiverQualityOf = (r: RatedPlayer): number =>
  0.35 * f(r.attrs.routeRunning) + 0.25 * f(r.attrs.speed) + 0.2 * f(r.attrs.catching) + 0.2 * f(r.attrs.hands);

/**
 * Cover-score shift per unit of the AI defense's coverage edge (ai/coverage-iq coverageEdge: -1 rookie, 0 pro, +1
 * legend): the fast sim's stand-in for the live coverage decisions (throw read, soft/tight technique, zone discipline,
 * safety help), sized so the rookie-to-legend completion gap tracks the live engine's.
 */
export const COVERAGE_EDGE_SCORE = 0.12;

const coverageShift = (coverageIq: number | null): number =>
  coverageIq === null ? 0 : COVERAGE_EDGE_SCORE * coverageEdge({ coverageAnticipation: coverageIq });

const manCoverScore = (d: RatedPlayer, coverageIq: number | null): number =>
  0.5 * f(d.attrs.coverage) + 0.3 * f(d.attrs.speed) + 0.2 * f(d.attrs.reaction) + coverageShift(coverageIq);
const zoneCoverScore = (d: RatedPlayer, coverageIq: number | null): number =>
  0.4 * f(d.attrs.awareness) + 0.4 * f(d.attrs.coverage) + 0.2 * f(d.attrs.reaction) + coverageShift(coverageIq);

const isDeepZone = (d: RatedPlayer): boolean => d.assignment.type === 'zone' && DEEP_ZONE.test((d.assignment as DefAssignment).zone ?? '');

const routeIdOf = (a: OffAssignment): string | undefined => (a.type === 'route' ? a.route : a.type === 'chipRelease' ? a.releaseRoute : undefined);

/** Builds the progression with an openness estimate per receiver. Blocking "routes" (stalk blocks) are skipped. */
const buildReceivers = (ctx: PlayContext, offense: RatedPlayer[], coverage: RatedPlayer[], coverageIq: number | null): ReceiverOption[] => {
  const play = ctx.offensivePlay;
  const def = ctx.defensivePlay;
  const roles = [...readOrder(play)];
  for (const p of offense) if (!roles.includes(p.role) && (p.assignment.type === 'route' || p.assignment.type === 'chipRelease')) roles.push(p.role);
  const zoneDefenders = coverage.filter((d) => d.assignment.type === 'zone' || d.assignment.type === 'spy');
  const zoneScore = (deep: boolean): number => {
    const bucket = zoneDefenders.filter((d) => isDeepZone(d) === deep);
    const pool = bucket.length ? bucket : zoneDefenders;
    return avg(pool.map((d) => zoneCoverScore(d, coverageIq)), 0.5) + 0.03 * (pool.length - (deep ? 3 : 4));
  };
  const out: ReceiverOption[] = [];
  for (const role of roles) {
    const rated = offense.find((p) => p.role === role);
    if (!rated || rated.assignment.type === 'qb') continue;
    const a = rated.assignment as OffAssignment;
    const routeId = routeIdOf(a);
    if (!routeId) continue;
    const info = routeInfo(routeId);
    if (info.type === 'block') continue;
    const depth = info.depth;
    const manDef = coverage.find((d) => d.assignment.type === 'manCover' && (d.assignment as DefAssignment).manTarget === role) ?? null;
    const rr = rated.attrs;
    let openness: number;
    if (manDef && def.family !== 'zone') {
      const sep = 0.4 * f(rr.routeRunning) + 0.3 * f(rr.speed) + 0.15 * f(rr.release) + 0.15 * f(rr.agility);
      const press = (manDef.assignment as DefAssignment).technique === 'press';
      openness = logistic(sep - manCoverScore(manDef, coverageIq) - (press ? 0.03 : 0), 0, 7);
    } else {
      const sep = 0.35 * f(rr.routeRunning) + 0.35 * f(rr.awareness) + 0.3 * f(rr.speed);
      openness = logistic(sep - zoneScore(depth >= 12), 0, 6);
    }
    if (def.family === 'match' && manDef) openness = lerp(openness, 0.5, 0.25);
    const deep = depth >= 12;
    const defender = manDef ?? (zoneDefenders.length ? zoneDefenders.reduce((best, d) => (isDeepZone(d) === deep && isDeepZone(best) !== deep ? d : best)) : null);
    out.push({ rated, readIndex: out.length, routeType: info.type, depth, quality: receiverQualityOf(rated), openness: clamp01(openness), defender, sideline: info.type !== null && SIDELINE_ROUTES.has(info.type) });
  }
  return rollCoverage(out);
};

/**
 * Openness a defense takes away from the offense's No. 1 wide receiver by rolling coverage to him (a shaded safety, a
 * shadowing corner): at full strength for a star (overall ROLL_COVERAGE_STAR + 12 and up) or one who out-rates the
 * next wide receiver or tight end by ROLL_COVERAGE_GAP. Without it a team with one great receiver fed him 35-40% of its
 * targets and 150+ catches; a real top target sees about 25-30% of them.
 */
export const ROLL_COVERAGE = 0.09;
/** Overall-rating edge over the next wide receiver / tight end at which the roll is at full strength. */
export const ROLL_COVERAGE_GAP = 10;
/** Overall from which a wide receiver starts drawing the roll on his own merit (full strength 12 points above). */
export const ROLL_COVERAGE_STAR = 78;

const rollCoverage = (receivers: ReceiverOption[]): ReceiverOption[] => {
  const ovr = (r: ReceiverOption): number => r.rated.player.overall;
  const wr = receivers.filter((r) => r.rated.position === 'WR').sort((a, b) => ovr(b) - ovr(a));
  const top = wr[0];
  if (!top) return receivers;
  const next = receivers.filter((r) => r !== top && (r.rated.position === 'WR' || r.rated.position === 'TE')).reduce((m, r) => Math.max(m, ovr(r)), 0);
  const cut = ROLL_COVERAGE * clamp01(Math.max((ovr(top) - next) / ROLL_COVERAGE_GAP, (ovr(top) - ROLL_COVERAGE_STAR) / 12));
  return cut > 0 ? receivers.map((r) => (r === top ? { ...r, openness: clamp01(r.openness - cut) } : r)) : receivers;
};

/** Concept-vs-coverage table: how a play design fares against a shell, family, blitz and box. */
export const conceptModifiers = (play: OffensivePlay, def: DefensivePlay, box: number, flags: { contain: boolean; spy: boolean; press: boolean }): ConceptModifiers => {
  const m: ConceptModifiers = { completion: 0, airYards: 0, yac: 0, pressure: 0, sack: 0, interception: 0, runYards: 0, stuff: 0, explosive: 0 };
  const shell = def.coverage;
  const man = def.family === 'man';
  const zone = def.family === 'zone';
  const blitz = def.blitz !== 'none';
  const halves = shell === 'cover2' || shell === 'cover6';
  const thirds = shell === 'cover3';
  const quarters = shell === 'cover4' || shell === 'cover9';
  const noDeep = shell === 'cover0' || shell === 'cover1';
  const runStop = box >= 8 || def.tags.includes('runStop');
  switch (play.concept) {
    case 'fourVerts':
      if (halves) { m.completion += 0.06; m.explosive += 0.05; }
      if (thirds || quarters) { m.completion -= 0.05; m.interception += 0.02; }
      if (blitz) { m.completion += 0.04; m.pressure += 0.06; }
      break;
    case 'mesh': case 'drag': case 'cross':
      if (man) { m.completion += 0.06; m.yac += 0.15; }
      if (zone) { m.completion -= 0.02; m.yac -= 0.1; }
      if (blitz) m.completion += 0.03;
      break;
    case 'screen':
      m.pressure -= 0.15; m.sack -= 0.1;
      if (blitz) { m.yac += 0.5; m.completion += 0.04; m.explosive += 0.06; }
      else if (zone) { m.yac -= 0.25; m.completion -= 0.04; }
      break;
    case 'slant':
      if (thirds) m.completion += 0.04;
      if (man && flags.press) m.completion -= 0.04;
      if (blitz) { m.completion += 0.05; m.yac += 0.1; }
      if (quarters) m.completion -= 0.02;
      break;
    case 'curl': case 'out':
      if (halves) m.completion -= 0.04;
      if (thirds) m.completion += 0.04;
      if (man) m.completion += 0.02;
      break;
    case 'post':
      if (halves) { m.completion += 0.04; m.explosive += 0.04; }
      if (thirds) m.completion -= 0.03;
      if (quarters) { m.completion -= 0.05; m.interception += 0.02; }
      if (noDeep) { m.completion += 0.03; m.explosive += 0.05; }
      break;
    case 'corner':
      if (halves) m.completion += 0.05;
      if (thirds) m.completion += 0.02;
      if (quarters) m.completion -= 0.04;
      break;
    case 'go':
      if (noDeep) { m.completion += 0.04; m.explosive += 0.06; }
      if (halves) { m.completion -= 0.04; m.interception += 0.02; }
      if (quarters) m.completion -= 0.06;
      break;
    case 'playAction':
      if (runStop) { m.completion += 0.06; m.explosive += 0.05; m.airYards += 2; }
      if (quarters || halves) m.completion -= 0.03;
      if (blitz) { m.pressure += 0.08; m.sack += 0.04; }
      break;
    case 'rpo':
      if (blitz) { m.completion += 0.04; m.runYards += 0.5; }
      if (box >= 7) m.completion += 0.02;
      break;
    case 'draw':
      if (blitz) { m.runYards += 1.5; m.stuff -= 0.06; }
      if (box >= 8) { m.runYards -= 1.2; m.stuff += 0.06; }
      if (zone && box <= 6) m.runYards += 0.6;
      break;
    case 'insideRun':
      if (box >= 8) { m.runYards -= 1.0; m.stuff += 0.07; }
      if (box <= 6) { m.runYards += 0.8; m.stuff -= 0.04; }
      if (def.blitz === 'doubleAGap') m.stuff += 0.05;
      break;
    case 'outsideRun':
      if (flags.contain) { m.runYards -= 0.8; m.stuff += 0.04; }
      if (def.blitz === 'edge') { m.runYards -= 0.6; m.stuff += 0.05; }
      if (box <= 6) { m.runYards += 0.7; m.explosive += 0.03; }
      if (box >= 9) m.runYards -= 0.8;
      break;
    case 'qbRun':
      if (flags.spy) { m.runYards -= 1.0; m.stuff += 0.05; }
      if (blitz && def.blitz !== 'edge') m.runYards += 0.5;
      break;
    default:
      break;
  }
  return m;
};

const pickPasser = (offense: RatedPlayer[]): RatedPlayer | null =>
  offense.find((p) => p.assignment.type === 'qb') ?? offense.find((p) => p.position === 'QB') ?? offense.find((p) => p.assignment.type === 'holder') ?? offense.find((p) => p.assignment.type === 'kicker') ?? offense[0] ?? null;

const pickCarrier = (ctx: PlayContext, offense: RatedPlayer[], passer: RatedPlayer | null): RatedPlayer | null => {
  const role = ctx.offensivePlay.ballCarrier;
  const byRole = role ? offense.find((p) => p.role === role) : undefined;
  return byRole ?? offense.find((p) => p.assignment.type === 'carry') ?? offense.find((p) => p.position === 'RB' || p.position === 'FB') ?? passer;
};

/** Return skill 0..1 (speed, agility, vision, carrying). */
export const returnerScore = (p: RatedPlayer): number => 0.35 * f(p.attrs.speed) + 0.25 * f(p.attrs.agility) + 0.2 * f(p.attrs.vision) + 0.2 * f(p.attrs.carrying);

/**
 * Summarises both lineups for one snap. `coverageIq` is the AI defense's difficulty knob (null for a human
 * defense) and `qbIq` the AI offense's; attributes always matter, difficulty only tilts AI decision quality.
 */
export const buildMatchups = (ctx: PlayContext, knobs: MatchupKnobs): Matchups => {
  const offense = rate(ctx, 'offense');
  const defense = rate(ctx, 'defense');
  const passer = pickPasser(offense);
  const carrier = pickCarrier(ctx, offense, passer);
  const blockers = offense.filter((p) => group(p) === 'OL' || p.assignment.type === 'passBlock' || p.assignment.type === 'runBlock' || p.assignment.type === 'leadBlock' || p.assignment.type === 'chipRelease' || p.assignment.type === 'longSnapper');
  const rushers = defense.filter((d) => d.assignment.type === 'rushGap' || d.assignment.type === 'blitz' || d.assignment.type === 'contain');
  const blitzCount = defense.filter((d) => d.assignment.type === 'blitz').length;
  const coverageDefenders = defense.filter((d) => d.assignment.type === 'manCover' || d.assignment.type === 'zone' || d.assignment.type === 'spy');
  let registryBox: number | null = null;
  try { registryBox = loadPlaybookData().defensiveFormations[ctx.defensivePlay.formation]?.boxCount ?? null; } catch { registryBox = null; }
  const frontSeven = defense.filter((d) => group(d) === 'DL' || group(d) === 'LB');
  const dbFillers = defense.filter((d) => group(d) === 'DB' && (d.assignment.type === 'runFill' || d.assignment.type === 'blitz'));
  const boxCount = clamp((registryBox ?? frontSeven.length) + dbFillers.length, 3, 11);
  const runDefenders = [...frontSeven, ...dbFillers];
  const hasContain = defense.some((d) => d.assignment.type === 'contain');
  const hasSpy = defense.some((d) => d.assignment.type === 'spy');
  const hasPress = defense.some((d) => d.assignment.type === 'manCover' && (d.assignment as DefAssignment).technique === 'press');
  const receivers = buildReceivers(ctx, offense, coverageDefenders, knobs.coverageIq);
  const attrDecision = passer ? 0.5 * f(passer.attrs.awareness) + 0.5 * f(passer.attrs.vision) : 0.4;
  const kicker = offense.find((p) => p.assignment.type === 'kicker') ?? offense.find((p) => p.position === 'K' || p.position === 'P') ?? null;
  const holder = offense.find((p) => p.assignment.type === 'holder') ?? null;
  const returners = defense.filter((d) => d.assignment.type === 'returner');
  const returnPool = returners.length ? returners : defense;
  const returner = returnPool.length ? returnPool.reduce((best, d) => (returnerScore(d) > returnerScore(best) ? d : best)) : null;
  const coverageUnit = offense.filter((p) => p.assignment.type === 'kickCoverage' || p.assignment.type === 'gunner');
  const returnBlockers = defense.filter((d) => d.assignment.type === 'returnBlock');
  return {
    offense, defense, passer, carrier, blockers, rushers, blitzCount, receivers, coverageDefenders, boxCount, runDefenders, hasContain, hasSpy, hasPress, kicker, holder, returner,
    qbQuality: qbQualityOf(passer),
    qbMobility: qbMobilityOf(passer),
    qbDecision: knobs.qbIq === null ? attrDecision : lerp(attrDecision, knobs.qbIq, 0.5),
    passProtection: passProtectionOf(blockers),
    passRush: passRushOf(rushers),
    runBlocking: runBlockingOf(blockers),
    runDefense: runDefenseOf(runDefenders),
    coverageQuality: avg(coverageDefenders.map((d) => (d.assignment.type === 'manCover' ? manCoverScore(d, knobs.coverageIq) : zoneCoverScore(d, knobs.coverageIq))), 0.5),
    kickCoverage: avg(coverageUnit.map((p) => 0.4 * f(p.attrs.speed) + 0.3 * f(p.attrs.pursuit) + 0.3 * f(p.attrs.tackling)), 0.5),
    returnBlocking: avg(returnBlockers.map((d) => 0.5 * f(d.attrs.blocking) + 0.3 * f(d.attrs.strength) + 0.2 * f(d.attrs.awareness)), 0.5),
    modifiers: conceptModifiers(ctx.offensivePlay, ctx.defensivePlay, boxCount, { contain: hasContain, spy: hasSpy, press: hasPress }),
  };
};

/** Carrier resistance 0..1 (carrying, balance, strength, agility). */
export const carrierPowerOf = (p: RatedPlayer): number =>
  0.35 * f(p.attrs.carrying) + 0.25 * f(p.attrs.balance) + 0.2 * f(p.attrs.strength) + 0.2 * f(p.attrs.agility);

/** Tackling power 0..1 (tackling, strength, pursuit). */
export const tacklePowerOf = (p: RatedPlayer): number =>
  0.5 * f(p.attrs.tackling) + 0.3 * f(p.attrs.strength) + 0.2 * f(p.attrs.pursuit);

/** Open-field running 0..1 (speed, agility, vision, carrying). */
export const openFieldOf = (p: RatedPlayer): number =>
  0.35 * f(p.attrs.speed) + 0.25 * f(p.attrs.agility) + 0.2 * f(p.attrs.vision) + 0.2 * f(p.attrs.carrying);

/** Separation in yards implied by an openness factor (0.5 -> ~2.5 yd). */
export const separationYards = (openness: number): number => 0.5 + 4.5 * clamp01(openness);

export const positionGroupOf = group;

/**
 * Shifts one snap's matchup factors by a game-level edge (offense form minus defense form, factor units): a team
 * having a good day blocks, rushes, reads and gets open a little better. Returns a new Matchups; 0 is a no-op.
 */
export const applyGameForm = (m: Matchups, edge: number): Matchups => {
  if (edge === 0) return m;
  const half = edge / 2;
  return {
    ...m,
    qbQuality: clamp01(m.qbQuality + half),
    passProtection: clamp01(m.passProtection + half),
    passRush: clamp01(m.passRush - half),
    runBlocking: clamp01(m.runBlocking + half),
    runDefense: clamp01(m.runDefense - half),
    receivers: m.receivers.map((r) => ({ ...r, openness: clamp01(r.openness + half) })),
  };
};
