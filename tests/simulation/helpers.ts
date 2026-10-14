/**
 * Shared helpers for the simulation tests: contexts from the play-state fixture with per-play rng forks and
 * situation overrides, plus aggregate counters for calibration checks.
 */
import { createRng } from '@/core/rng';
import type { PlayContext, PlayOutcome } from '@/game/play-types';
import type { DifficultyId } from '@/game/types';
import { buildPlayState, type FixtureOptions } from '../fixtures/play-state';

export interface CtxOptions extends FixtureOptions {
  quarter?: number;
  clockRemaining?: number;
  scoreDiff?: number;
  special?: PlayContext['special'];
  clockRunning?: boolean;
  controllers?: PlayContext['controllers'];
}

/** A PlayContext for a bundled matchup; `variant` forks the rng so one lineup yields many independent plays. */
export const makeCtx = (o: CtxOptions = {}, variant = 0): PlayContext => {
  const fx = buildPlayState(o);
  const base = fx.state.ctx;
  return {
    ...base,
    quarter: o.quarter ?? base.quarter,
    clockRemaining: o.clockRemaining ?? base.clockRemaining,
    scoreDiff: o.scoreDiff ?? base.scoreDiff,
    special: o.special ?? base.special,
    controllers: o.controllers ?? base.controllers,
    ...(o.clockRunning !== undefined && { clockRunning: o.clockRunning }),
    rng: createRng(`${o.seed ?? 1}:${o.offensePlayId ?? ''}:${o.defensePlayId ?? ''}:${variant}`),
  };
};

/** Re-seeds an existing context for another independent play (same lineups, same plays). */
export const variantOf = (ctx: PlayContext, variant: number, patch: Partial<PlayContext> = {}): PlayContext => ({
  ...ctx, ...patch, rng: createRng(`${ctx.offensivePlay.id}:${ctx.defensivePlay.id}:${variant}`),
});

export const PASS_PLAYS = ['shotgun-mesh', 'shotgun-slants', 'singleback-curlFlat', 'shotgun-postWheel', 'trips-smash', 'shotgun-goRoutes', 'shotgun-deepCross', 'shotgun-dragDig', 'shotgun-fourVerts', 'iform-paBoot-right', 'singleback-paPost', 'shotgun-rbScreen-right', 'shotgun-quickOuts', 'trips-outs', 'shotgun-curls'];
export const RUN_PLAYS = ['iform-dive-right', 'iform-iso-left', 'singleback-counter-left', 'shotgun-insideZone-left', 'pistol-insideZone-right', 'iform-toss-right', 'singleback-stretch-right', 'shotgun-sweep-left', 'pistol-outsideZone-right', 'shotgun-rbDraw', 'twoTE-dive-right', 'heavy-iso-right'];
export const DEF_PLAYS = ['43-cover3-zone', '43-cover1-man', '43-cover2-zone', '43-cover4-zone', '34-cover3-zone', '34-cover1-edge', 'nickel-cover1-man', 'nickel-cover2-zone', '425-cover3-zone', '43-cover0-lbBlitz', 'nickel-cover3-match', '43-runStop-cover1', 'dime-cover2-zone', '43-cover6-zone'];

export interface Tally {
  plays: number; dropbacks: number; attempts: number; completions: number; passYards: number; sacks: number; interceptions: number; scrambles: number;
  carries: number; rushYards: number; fumbles: number; fumblesLost: number; explosive: number; scrimmage: number; penalties: number; touchdowns: number; injuries: number;
  incompletes: number; drops: number; presnapFouls: number; oob: number; reviews: number;
}

export const emptyTally = (): Tally => ({
  plays: 0, dropbacks: 0, attempts: 0, completions: 0, passYards: 0, sacks: 0, interceptions: 0, scrambles: 0, carries: 0, rushYards: 0, fumbles: 0, fumblesLost: 0,
  explosive: 0, scrimmage: 0, penalties: 0, touchdowns: 0, injuries: 0, incompletes: 0, drops: 0, presnapFouls: 0, oob: 0, reviews: 0,
});

export const tallyOutcome = (t: Tally, o: PlayOutcome): void => {
  t.plays += 1;
  t.penalties += o.penalties.length;
  t.injuries += o.injuries.length;
  if (o.review) t.reviews += 1;
  if (o.result === 'penalty') { t.presnapFouls += 1; return; }
  t.scrimmage += 1;
  if (o.touchdown) t.touchdowns += 1;
  if (o.outOfBounds) t.oob += 1;
  if (o.bigPlay) t.explosive += 1;
  const fumbled = o.events.some((e) => e.type === 'fumble');
  if (fumbled) t.fumbles += 1;
  if (o.turnoverType === 'fumble') t.fumblesLost += 1;
  switch (o.result) {
    case 'pass': t.dropbacks += 1; t.attempts += 1; t.completions += 1; t.passYards += o.yards; break;
    case 'incomplete': t.dropbacks += 1; t.attempts += 1; t.incompletes += 1; if (o.events.some((e) => e.type === 'incomplete' && e.reason === 'drop')) t.drops += 1; break;
    case 'interception': t.dropbacks += 1; t.attempts += 1; t.interceptions += 1; break;
    case 'sack': t.dropbacks += 1; t.sacks += 1; break;
    case 'scramble': t.dropbacks += 1; t.scrambles += 1; t.carries += 1; t.rushYards += o.yards; break;
    case 'run': t.carries += 1; t.rushYards += o.yards; break;
    default: break;
  }
};

export const rates = (t: Tally) => ({
  completionPct: t.attempts ? t.completions / t.attempts : 0,
  ypa: t.attempts ? t.passYards / t.attempts : 0,
  sackRate: t.dropbacks ? t.sacks / t.dropbacks : 0,
  intRate: t.attempts ? t.interceptions / t.attempts : 0,
  ypc: t.carries ? t.rushYards / t.carries : 0,
  fumblePerTouch: t.carries + t.completions ? t.fumbles / (t.carries + t.completions) : 0,
  explosiveRate: t.scrimmage ? t.explosive / t.scrimmage : 0,
  scrambleRate: t.dropbacks ? t.scrambles / t.dropbacks : 0,
  penaltyRate: t.plays ? t.penalties / t.plays : 0,
  injuryRate: t.plays ? t.injuries / t.plays : 0,
  dropRate: t.attempts ? t.drops / t.attempts : 0,
  oobRate: t.scrimmage ? t.oob / t.scrimmage : 0,
});

export const DIFFICULTIES: DifficultyId[] = ['rookie', 'pro', 'allPro', 'legend'];
