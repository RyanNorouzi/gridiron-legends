import type { Rng } from '@/core/rng';
import { clockManagementPlay, fourthDownDecision, kneelRunoffSec, shouldGoForTwo as coachGoesForTwo, shouldHurryUp, shouldOnsideKick } from '@/ai/coaching';
import { gameStaffTendencies, type GameStaff } from '@/ai/scouting';
import { defensivePlaysForSituation, pickWeighted, playsForSituation, twoPointPlays, type PlaySituation, type WeightedPlay } from '@/playbook/playbooks';
import { extraPointPlay, fieldGoalPlay, isKickConcept, kickoffPlay, puntPlay, returnPlay, type SpecialKind } from '@/playbook/special-teams';
import type { DefensivePlay, OffensivePlay } from '@/playbook/types';
import type { Coach } from '@/teams/types';
import { isSpecialConcept, specialFor } from '@/game/play-context';
import { otherSide, type DifficultyProfile, type GameState, type TeamSide } from '@/game/types';

/**
 * Default AI play-calling for simulated games: situational weights from the playbook module, and the same game
 * management the live AI coach uses (src/ai/coaching.ts): the expected-points fourth-down model (go / field goal /
 * punt), the two-point chart, onside kicks, kneel-downs and spikes, and the no-huddle rule. League games are called
 * at a fixed league judgement (LEAGUE_PLAYCALLING_IQ) so the user's difficulty setting never changes other teams'
 * results; `createSimPlaycaller` takes each side's head coach so staff personality (aggression, pass lean) shows.
 * Callers can inject their own Playcaller.
 */
export interface Playcaller {
  /** Offensive call; null lets the controller pick (kickoff / PAT defaults). */
  offense(state: Readonly<GameState>, plays: readonly OffensivePlay[], rng: Rng): OffensivePlay | null;
  /** Defensive call against the offensive play just chosen (null = the coach's default pick). */
  defense(state: Readonly<GameState>, plays: readonly DefensivePlay[], rng: Rng, offensive: OffensivePlay | null): DefensivePlay | null;
  /** True when the offense should hurry (no huddle). */
  hurryUp(state: Readonly<GameState>): boolean;
}

/** Offense-perspective yard line from which a field goal is about 52 yards (the default kicker's range). */
export const FG_TRUST_BALL_ON = 65;
/** Desperate late-game field goal range (~58 yards). */
export const FG_DESPERATE_BALL_ON = 59;
/** Play-calling judgement of a league staff in simulated games (between pro and all-pro). */
export const LEAGUE_PLAYCALLING_IQ = 0.65;

const margin = (s: Readonly<GameState>): number => s.score[s.possession] - s.score[otherSide(s.possession)];

/** Seconds left in the half (or game) for situational weighting. */
const clockLeft = (s: Readonly<GameState>): number => s.clock.secondsRemaining + (s.clock.quarter === 1 || s.clock.quarter === 3 ? s.ruleset.quarterLengthSec : 0);

export const situationOf = (s: Readonly<GameState>): PlaySituation => ({
  down: s.down, distance: s.distance, ballOn: s.ballOn, clock: clockLeft(s), scoreDiff: margin(s), clockRunning: s.clock.running,
  timeouts: s.timeouts[s.possession], opponentTimeouts: s.timeouts[otherSide(s.possession)], runoffSec: kneelRunoffSec(s.ruleset),
});

/** The game's difficulty with the league's play-calling judgement (only the decision knob matters here). */
const leagueJudgement = (s: Readonly<GameState>): DifficultyProfile => ({ ...s.difficulty, playcallingIq: LEAGUE_PLAYCALLING_IQ });

/** Late, trailing: the coaching model's onside rule (always inside the last minute; earlier two scores down). */
export const shouldOnside = (s: Readonly<GameState>, coach: Coach | null = null): boolean =>
  shouldOnsideKick(coach, { scoreDiff: margin(s), quarter: s.clock.quarter, secondsRemaining: s.clock.secondsRemaining, timeouts: s.timeouts[s.possession], overtime: s.overtime !== null });

/** Go for two on the margin chart (after the six is on the board). */
export const shouldGoForTwo = (s: Readonly<GameState>, coach: Coach | null = null): boolean =>
  coachGoesForTwo(coach, leagueJudgement(s), { scoreDiff: margin(s), quarter: s.clock.quarter, secondsRemaining: s.clock.secondsRemaining, overtime: s.overtime !== null });

export type FourthDownChoice = 'fieldGoal' | 'punt' | 'go';

/** Fourth-down decision from the expected-points model (field position, distance, score and time). */
export const fourthDownChoice = (s: Readonly<GameState>, coach: Coach | null = null): FourthDownChoice =>
  fourthDownDecision(coach, leagueJudgement(s), {
    distance: s.distance, ballOn: s.ballOn, scoreDiff: margin(s), quarter: s.clock.quarter, secondsRemaining: s.clock.secondsRemaining,
    timeouts: s.timeouts[s.possession], overtime: s.overtime !== null,
  });

const scrimmage = (plays: readonly OffensivePlay[]): OffensivePlay[] => plays.filter((p) => !isSpecialConcept(p.concept));

/**
 * Multiplier on dropback-play weights in ordinary down-and-distance (not short yardage, not protecting a fourth-quarter
 * lead): league offenses throw on ~57-60% of snaps, a touch more than the playbook's neutral situational weights.
 */
export const PASS_LEAN = 1.35;

const DROPBACK_TYPES: ReadonlySet<OffensivePlay['type']> = new Set(['pass', 'playAction', 'screen']);

/** Staff pass lean (-1..1) stretches the dropback weight by up to +/-25%. */
const leanWeights = (s: Readonly<GameState>, weighted: WeightedPlay<OffensivePlay>[], passLean = 0): WeightedPlay<OffensivePlay>[] => {
  const protectingLead = s.clock.quarter >= 4 && margin(s) > 0;
  if (s.distance < 3 || protectingLead) return weighted;
  const lean = PASS_LEAN * (1 + 0.25 * passLean);
  return weighted.map((w) => (DROPBACK_TYPES.has(w.play.type) ? { ...w, weight: w.weight * lean } : w));
};

const isClockPlay = (p: OffensivePlay): boolean => p.type === 'kneel' || p.type === 'spike';

/** Lead (points) from which a second-half offense protects it and a fourth-quarter defense plays soft. */
export const GAME_SCRIPT_LEAD = 17;
/** Lead (points) of a rout: from the third quarter on the defense protecting it sits back (see gameScriptDefense). */
export const GAME_SCRIPT_ROUT = 21;
/** Fourth-quarter lead (points) from which the defense protecting it sits back without the prevent shell. */
export const GAME_SCRIPT_SOFT = 14;
const RUN_CALLS: ReadonlySet<OffensivePlay['type']> = new Set(['run', 'qbRun', 'rpo']);

/**
 * Game script for a big second-half lead: the offense leans on the run and stops taking deep shots (long-yardage
 * dropbacks), so it bleeds the clock instead of piling on. Trailing teams already lean pass through the two-minute
 * weights. Nothing changes below GAME_SCRIPT_LEAD or before halftime.
 */
export const gameScriptOffense = (s: Readonly<GameState>, weighted: WeightedPlay<OffensivePlay>[]): WeightedPlay<OffensivePlay>[] => {
  if (s.clock.quarter < 3 || margin(s) < GAME_SCRIPT_LEAD) return weighted;
  return weighted.map((w) => ({ ...w, weight: w.weight * (RUN_CALLS.has(w.play.type) ? 1.8 : w.play.tags.includes('longYardage') ? 0.5 : 1) }));
};

/**
 * Game script for a defense up big in the second half: it sits back (zone and prevent calls up, blitzes down),
 * conceding the underneath yards and the late points that keep real blowouts closer than the talent gap. Two scores up
 * in the fourth quarter (GAME_SCRIPT_SOFT) or a rout in the third (GAME_SCRIPT_ROUT) it only sits back; from
 * GAME_SCRIPT_LEAD in the fourth it plays the prevent shell.
 */
export const gameScriptDefense = (s: Readonly<GameState>, weighted: WeightedPlay<DefensivePlay>[]): WeightedPlay<DefensivePlay>[] => {
  const lead = -margin(s);
  const q = s.clock.quarter;
  if (q >= 4 && lead >= GAME_SCRIPT_LEAD) {
    return weighted.map((w) => ({
      ...w,
      weight: w.weight * (w.play.tags.includes('prevent') ? 15 : 1) * (w.play.family === 'zone' ? 1.6 : 1) * (w.play.blitz !== 'none' ? 0.4 : 1),
    }));
  }
  if ((q >= 4 && lead >= GAME_SCRIPT_SOFT) || (q === 3 && lead >= GAME_SCRIPT_ROUT)) {
    return weighted.map((w) => ({ ...w, weight: w.weight * (w.play.family === 'zone' ? 1.4 : 1) * (w.play.blitz !== 'none' ? 0.6 : 1) }));
  }
  return weighted;
};

/** A weighted scrimmage call. Kneels and spikes come only from the coaching model (clockPlay), never the draw. */
const pickScrimmage = (s: Readonly<GameState>, plays: readonly OffensivePlay[], rng: Rng, passLean = 0): OffensivePlay | null => {
  const weighted = gameScriptOffense(s, leanWeights(s, playsForSituation(plays, situationOf(s)).filter((w) => !isClockPlay(w.play)), passLean));
  const pick = pickWeighted(weighted, rng);
  if (pick) return pick;
  const pool = scrimmage(plays).filter((p) => !isClockPlay(p));
  return pool.length ? rng.pick(pool) : null;
};

/** Kneel to run out a win or spike to stop the clock (the coaching model), when the playbook has the play. */
const clockPlay = (s: Readonly<GameState>, plays: readonly OffensivePlay[]): OffensivePlay | null => {
  const kind = clockManagementPlay({
    down: s.down, distance: s.distance, ballOn: s.ballOn, quarter: s.clock.quarter, secondsRemaining: s.clock.secondsRemaining, scoreDiff: margin(s),
    timeouts: s.timeouts[s.possession], opponentTimeouts: s.timeouts[otherSide(s.possession)], clockRunning: s.clock.running, overtime: s.overtime !== null,
    runoffSec: kneelRunoffSec(s.ruleset),
  });
  return kind ? plays.find((p) => p.type === kind) ?? null : null;
};

/** A side's sim staff: a bare head coach, or the whole staff (GameTeamSetup fits: head coach + coordinators). */
export type SimStaff = Coach | GameStaff | null;

const isStaff = (s: SimStaff | undefined): s is GameStaff => s !== null && s !== undefined && 'headCoach' in s;

/** Multiplier on blitz calls from the staff's pressure lean (scouting.staffTendencies blitzLean): up to +/-35%. */
export const staffBlitzLean = (play: DefensivePlay, blitzLean: number): number => (play.blitz !== 'none' ? Math.max(0.5, 1 + 0.35 * blitzLean) : 1);

/**
 * The sim playcaller for a pair of staffs (missing = neutral): the head coach's personality feeds the fourth-down,
 * two-point and onside decisions, the staff's pass lean (head coach's scheme, pulled toward the offensive
 * coordinator's) leans the run/pass mix and its blitz lean (pulled toward the defensive coordinator's) the pressure.
 */
export const createSimPlaycaller = (coaches: Partial<Record<TeamSide, SimStaff>> = {}): Playcaller => {
  const staffOf = (side: TeamSide): GameStaff => {
    const s = coaches[side];
    return isStaff(s) ? s : { headCoach: s ?? null };
  };
  const coachOf = (side: TeamSide): Coach | null => staffOf(side).headCoach;
  return {
    offense: (s, plays, rng) => {
      const coach = coachOf(s.possession);
      if (s.kickoffPending) return kickoffPlay(plays, { onside: shouldOnside(s, coach) });
      if (s.patPending) {
        if (shouldGoForTwo(s, coach)) {
          const two = twoPointPlays(plays);
          if (two.length) return rng.pick(two);
        }
        return extraPointPlay(plays);
      }
      const clock = clockPlay(s, plays);
      if (clock) return clock;
      if (s.down === 4) {
        const choice = fourthDownChoice(s, coach);
        if (choice === 'fieldGoal') { const fg = fieldGoalPlay(plays); if (fg) return fg; }
        if (choice === 'punt') { const punt = puntPlay(plays, s.ballOn); if (punt) return punt; }
      }
      return pickScrimmage(s, plays, rng, gameStaffTendencies(staffOf(s.possession)).passLean);
    },
    defense: (s, plays, rng, offensive) => {
      const kind: SpecialKind = offensive ? specialFor(offensive.concept) : s.kickoffPending ? 'kickoff' : s.patPending ? 'extraPoint' : 'none';
      if (kind !== 'none' && kind !== 'twoPoint' && !(offensive && !isKickConcept(offensive.concept))) {
        const unit = returnPlay(plays, kind, { block: kind === 'punt' && s.clock.quarter >= 4 && margin(s) > 0 && s.clock.secondsRemaining <= 240 });
        if (unit) return unit;
      }
      const lean = gameStaffTendencies(staffOf(otherSide(s.possession))).blitzLean;
      const base = gameScriptDefense(s, defensivePlaysForSituation(plays, situationOf(s)));
      const weighted = lean === 0 ? base : base.map((w) => ({ play: w.play, weight: w.weight * staffBlitzLean(w.play, lean) }));
      const pick = pickWeighted(weighted, rng);
      if (pick) return pick;
      const regular = plays.filter((p) => !p.tags.some((t) => t === 'kickReturn' || t === 'puntReturn' || t === 'fgBlock'));
      return regular.length ? rng.pick(regular) : null;
    },
    hurryUp: (s) => shouldHurryUp({ quarter: s.clock.quarter, secondsRemaining: s.clock.secondsRemaining, scoreDiff: margin(s), overtime: s.overtime !== null }),
  };
};

/** Neutral-coach sim playcaller (what simulateGame uses unless the caller injects one). */
export const defaultPlaycaller: Playcaller = createSimPlaycaller();
