import { clamp } from '@/core/math';
import type { Rng } from '@/core/rng';
import type { PlayContext } from '@/game/play-types';
import { carrierPowerOf, openFieldOf, tacklePowerOf, type Matchups, type RatedPlayer } from './matchups';
import type { FumbleInfo, ModelKnobs, RunResolution, TackleInfo } from './play-model';
import { approachFactor, lognormal, lognormalMean, pickTackleKind, pickTackler, rollFumble, roundYards } from './sim-random';

/**
 * Run model. Stuff rate and the yardage median come from run blocking vs the box, the concept-vs-front
 * modifiers and the carrier's open-field skill; the distribution is log-normal so explosive runs appear
 * with a real tail (~10% of carries at 12+). Broken tackles, contact, fumbles, sidelines, touchdowns and
 * safeties are resolved here so the outcome assembler only has to describe them.
 */
export interface RunOptions {
  carrier: RatedPlayer;
  /** QB scramble on a called pass. */
  scramble: boolean;
  /** Designed QB run (read option, sneak, draw). */
  designedQb: boolean;
  draw: boolean;
}

/** Median yards per unit of the carrier's open-field factor (see medianGain). */
export const CARRIER_SKILL_GAIN = 1.4;

/** League-average fumble rate per carry before carrier/weather/tackler scaling. */
export const FUMBLE_PER_CARRY = 0.012;

const stuffProbability = (ctx: PlayContext, m: Matchups, knobs: ModelKnobs, power: number, o: RunOptions): number => {
  let p = 0.19 + 0.55 * (m.runDefense - m.runBlocking) + 0.025 * (m.boxCount - 7) - 0.08 * (power - 0.5);
  p += o.scramble ? -0.06 : m.modifiers.stuff;
  if (o.draw) p -= 0.02;
  if (ctx.ballOn >= 97) p += 0.08;
  // The compressed field: fewer run lanes and more bodies in the box the closer the goal line.
  if (ctx.ballOn > 80) p += 0.06 * (ctx.ballOn - 80) / 20;
  // The front's run fits (gap discipline, flowing to the ball) are the AI decision here: pursuitQuality.
  const fit = knobs.pursuitIq ?? null;
  if (fit !== null) p += (fit - 0.6) * 0.06;
  return clamp(p, 0.05, 0.5);
};

const medianGain = (ctx: PlayContext, m: Matchups, open: number, o: RunOptions): number => {
  // The runner's own open-field skill moves the median by CARRIER_SKILL_GAIN per unit around a typical back (0.75), so
  // an elite back averages ~5-5.5 a carry over a season rather than 6+.
  let median = 3.4 + 3.5 * (m.runBlocking - m.runDefense) - 0.25 * (m.boxCount - 7) + 0.35 + CARRIER_SKILL_GAIN * (open - 0.75);
  median += o.scramble ? 1.5 : m.modifiers.runYards;
  if (o.designedQb) median += 0.3;
  if (ctx.ballOn > 80) median -= 0.9 * Math.min(1, (ctx.ballOn - 80) / 12);
  return clamp(median, 1.5, 9);
};

/** Resolves one carry. */
export const resolveRun = (ctx: PlayContext, m: Matchups, knobs: ModelKnobs, rng: Rng, o: RunOptions): RunResolution => {
  const carrier = o.carrier;
  const power = carrierPowerOf(carrier);
  const open = openFieldOf(carrier);
  const defenders = m.runDefenders.length ? m.runDefenders : m.defense;
  const stuffed = rng.chance(stuffProbability(ctx, m, knobs, power, o));
  let yards: number;
  if (stuffed) {
    yards = o.scramble ? 0 : -clamp(Math.round(rng.gaussian(1.3, 1.3)), 0, 6);
  } else {
    const sigma = 0.78 + 0.6 * Math.max(0, m.modifiers.explosive) + 0.08 * (open - 0.5);
    yards = 1 + lognormal(rng, medianGain(ctx, m, open, o) - 1, sigma);
  }
  yards = roundYards(yards);

  let tackler = pickTackler(rng, defenders, yards);
  const missed: RatedPlayer[] = [];
  let brokenTackles = 0;
  if (!stuffed && tackler) {
    // Ratings decide the contest; the tackler's approach (squared up vs lunging: the AI decision) shifts it.
    let fade = 1;
    for (let i = 0; i < 2 && tackler; i++) {
      const pBreak = clamp((0.10 + 0.45 * (power - tacklePowerOf(tackler)) + (ctx.ruleset.exaggeratedMoves ? 0.05 : 0)) * fade * approachFactor(rng, tackler, knobs.tackleIq), 0.02, 0.45);
      if (!rng.chance(pBreak)) break;
      brokenTackles += 1;
      missed.push(tackler);
      yards += Math.round(lognormalMean(rng, 4.5, 0.8));
      tackler = pickTackler(rng, defenders, yards, { exclude: missed });
      fade *= 0.6;
    }
  }

  let touchdown = false;
  let safety = false;
  // Whole yards on the stat sheet even from a fractional spot (see pass-model).
  if (ctx.ballOn + yards >= 100) { yards = roundYards(100 - ctx.ballOn); touchdown = true; }
  else if (ctx.ballOn + yards <= 0) { yards = roundYards(-ctx.ballOn); safety = true; }

  const contactAt = stuffed ? 0 : clamp(Math.round(rng.gaussian(2.5, 2)), 0, Math.max(0, yards));
  const yardsAfterContact = stuffed ? 0 : Math.max(0, yards - contactAt);
  const outside = ctx.offensivePlay.concept === 'outsideRun';
  const pOob = o.scramble ? 0.18 : outside ? 0.2 : 0.04;
  const outOfBounds = !touchdown && !safety && rng.chance(pOob);
  const slide = o.scramble && !touchdown && !outOfBounds && yards > 0 && rng.chance(0.35);
  const contact = !touchdown && !slide;

  let tackle: TackleInfo | null = null;
  let fumble: FumbleInfo | null = null;
  if (contact && tackler) {
    const assists: RatedPlayer[] = [];
    if (rng.chance(0.3)) {
      const helper = pickTackler(rng, defenders, yards, { exclude: [tackler, ...missed] });
      if (helper) assists.push(helper);
    }
    const kind = pickTackleKind(rng, yards, assists.length);
    tackle = { tackler, assists, kind, missed };
    if (!outOfBounds && !safety) {
      const roll = rollFumble(rng, ctx.weather, carrier, tackler, m.offense, m.defense, FUMBLE_PER_CARRY, kind);
      if (roll) {
        const spotBallOn = clamp(ctx.ballOn + yards, 0.5, 99.5);
        const returnYards = roll.lost ? Math.min(roll.returnYards, Math.round(spotBallOn)) : 0;
        fumble = { forcedBy: roll.forcedBy, recoveredBy: roll.recoveredBy, lost: roll.lost, spotBallOn, returnYards, touchdown: roll.lost && spotBallOn - returnYards <= 0 };
      }
    }
  }
  const timeElapsed = clamp(4 + Math.abs(yards) / 6.5 + rng.gaussian(0, 0.5), 3.8, 8);
  return {
    kind: 'run', carrier, scramble: o.scramble, designedQb: o.designedQb, yards, stuffed, brokenTackles, yardsAfterContact,
    contact, slide, tackle, outOfBounds, touchdown, safety, fumble, timeElapsed,
  };
};
