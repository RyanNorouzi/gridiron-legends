/**
 * DrillSession: the pure practice model. Tracks reps, successes, the current and best streak and points (a
 * success earns its verdict's points times the streak multiplier), hands out the next rep's scenario (same
 * situation, fresh seed: the play rotation only advances on recorded reps, so a reset re-runs the same look) and
 * summarises the session with a letter grade. No engine or rendering inside; `startRep` is a convenience that
 * builds the headless DrillRep for the next scenario.
 */
import { DEFAULT_DRILL_OPTIONS, getDrill } from './drills';
import { DrillRep, type DrillRepDeps } from './runner';
import { buildDrillScenario, type DrillScenario } from './scenarios';
import type { DrillDefinition, DrillId, DrillOptions, RepVerdict } from './types';

/** One recorded rep of a session. */
export interface RepRecord {
  /** 0-based index among recorded reps. */
  index: number;
  seed: number;
  playId: string;
  verdict: RepVerdict;
  /** Points actually awarded (verdict points x multiplier; 0 on a miss). */
  points: number;
  multiplier: number;
  /** Streak after this rep. */
  streak: number;
}

/** Letter grade of a session ('-' until there are enough reps). */
export type DrillGrade = 'A' | 'B' | 'C' | 'D' | 'F' | '-';

/** End-of-drill summary for the summary screen. */
export interface DrillSummary {
  drillId: DrillId;
  name: string;
  difficulty: DrillOptions['difficulty'];
  reps: number;
  successes: number;
  /** 0..1 (0 with no reps). */
  successRate: number;
  bestStreak: number;
  totalPoints: number;
  averagePoints: number;
  grade: DrillGrade;
  records: readonly RepRecord[];
}

/** Points multiplier for a success that extends a streak of `streak` (x1, x1.25 ... capped at x2). */
export const streakMultiplier = (streak: number): number => 1 + 0.25 * Math.min(4, Math.max(0, streak));

/** Letter grade for a success rate (needs at least 3 reps to grade). */
export const gradeFor = (successRate: number, reps: number): DrillGrade => {
  if (reps < 3) return '-';
  if (successRate >= 0.9) return 'A';
  if (successRate >= 0.75) return 'B';
  if (successRate >= 0.6) return 'C';
  if (successRate >= 0.4) return 'D';
  return 'F';
};

/** Deterministic per-attempt seed from the session seed. */
export const repSeed = (seed: number, attempt: number): number => (Math.imul((seed ^ 0x9e3779b9) >>> 0, 0x85ebca6b) + Math.imul(attempt + 1, 0x27d4eb2d)) >>> 0;

/** Pure practice model for one drill with fixed options (see the file header). */
export class DrillSession {
  private readonly log: RepRecord[] = [];
  private attempts = 0;
  private streakValue = 0;
  private best = 0;
  private points = 0;

  constructor(readonly def: DrillDefinition, readonly options: DrillOptions, readonly seed: number) {}

  get reps(): number { return this.log.length; }
  get successes(): number { return this.log.filter((r) => r.verdict.success).length; }
  get successRate(): number { return this.log.length === 0 ? 0 : this.successes / this.log.length; }
  get streak(): number { return this.streakValue; }
  get bestStreak(): number { return this.best; }
  get totalPoints(): number { return this.points; }
  get records(): readonly RepRecord[] { return this.log; }
  /** Rep attempts handed out so far (recorded + reset). */
  get attemptCount(): number { return this.attempts; }

  /** Multiplier the next success would earn. */
  get nextMultiplier(): number { return streakMultiplier(this.streakValue); }

  /** Scenario for the next attempt: the rotation follows recorded reps, the seed every attempt. */
  nextScenario(): DrillScenario {
    const scenario = buildDrillScenario(this.def, this.options, repSeed(this.seed, this.attempts), this.log.length);
    this.attempts += 1;
    return scenario;
  }

  /** Builds the headless rep for the next attempt. */
  startRep(deps: DrillRepDeps = {}): DrillRep {
    return new DrillRep(this.nextScenario(), deps);
  }

  /** Records a finished rep's verdict; returns the record with the points awarded. */
  record(verdict: RepVerdict, scenario?: DrillScenario): RepRecord {
    const multiplier = verdict.success ? streakMultiplier(this.streakValue) : 1;
    const awarded = verdict.success ? Math.round(verdict.points * multiplier) : 0;
    this.streakValue = verdict.success ? this.streakValue + 1 : 0;
    this.best = Math.max(this.best, this.streakValue);
    this.points += awarded;
    const rec: RepRecord = {
      index: this.log.length, seed: scenario?.seed ?? repSeed(this.seed, Math.max(0, this.attempts - 1)),
      playId: scenario?.ctx.offensivePlay.id ?? this.def.offensePlays[this.log.length % this.def.offensePlays.length] ?? '',
      verdict, points: awarded, multiplier, streak: this.streakValue,
    };
    this.log.push(rec);
    return rec;
  }

  summary(): DrillSummary {
    const reps = this.log.length;
    const successRate = this.successRate;
    return {
      drillId: this.def.id, name: this.def.name, difficulty: this.options.difficulty, reps, successes: this.successes, successRate,
      bestStreak: this.best, totalPoints: this.points, averagePoints: reps === 0 ? 0 : Math.round(this.points / reps), grade: gradeFor(successRate, reps), records: [...this.log],
    };
  }
}

/** Starts a session for a drill id with options merged over the defaults. */
export const startDrillSession = (id: DrillId, options: Partial<DrillOptions> = {}, seed = 1): DrillSession =>
  new DrillSession(getDrill(id), { ...DEFAULT_DRILL_OPTIONS, ...options }, seed >>> 0);
