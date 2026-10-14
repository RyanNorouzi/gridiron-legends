import { clamp01 } from '@/core/math';
import type { Rng } from '@/core/rng';
import type { DifficultyProfile } from '@/game/types';
import { defensivePlaysForSituation, pickWeighted, type PlaySituation, type WeightedPlay } from '@/playbook/playbooks';
import type { DefensivePlay } from '@/playbook/types';
import type { Coach, DefensiveScheme } from '@/teams/types';
import { coachIq } from './coaching';
import { adapt, adaptationFor, formationPersonnel, staffTendencies, type OffenseTendencies } from './scouting';

/**
 * Defensive play selection: a shell for the down and distance (two-high on long yardage, single-high in
 * between, zero/blitz on third and short or when chasing the game late, prevent when protecting a late
 * lead, goal line inside the 5), the coordinator's scheme, personnel and tendency answers, then a weighted
 * draw flattened toward random by low playcallingIq. The in-game scouting report (scouting.ts) is answered in
 * proportion to adaptationStrength (ignored at rookie, leaned on at legend). `defensiveCheck` is the check at the
 * line once the offense's personnel and formation are on the field. The pre-snap disguise is not a play-call roll:
 * the live engine's defenders make it from a hash of the play seed (ai/disguise.ts), so the call draws one die.
 */
export type { OffenseTendencies } from './scouting';

export interface DefensiveCallArgs {
  plays: readonly DefensivePlay[];
  /** scoreDiff follows the playbook convention: OFFENSE score minus defense score. `clock` is seconds in the half. */
  situation: PlaySituation;
  coach: Coach | null;
  /** The defensive coordinator, when the side has one: his pressure lean pulls the head coach's toward his own. */
  defensiveCoordinator?: Coach | null;
  difficulty: DifficultyProfile;
  rng: Rng;
  quarter?: number;
  overtime?: boolean;
  offenseTendencies?: OffenseTendencies;
  /** Personnel grouping the offense is showing ('11', '12', '10', ...). */
  offenseFormationPersonnel?: string;
  /** Formation id the offense has lined up in (read against its per-formation tendencies). */
  offenseFormation?: string;
  /** Ids of this defense's recent calls, oldest first. */
  recentPlayIds?: readonly string[];
}

export interface DefensiveCall {
  play: DefensivePlay;
}

export type FormationClass = 'base' | 'nickel' | 'dime' | 'goalLine' | 'prevent' | 'other';

export const isBlitz = (p: DefensivePlay): boolean => p.blitz !== 'none';
export const isPrevent = (p: DefensivePlay): boolean => p.tags.includes('prevent');
export const isRunStop = (p: DefensivePlay): boolean => p.tags.includes('runStop') || p.tags.includes('goalLine');
export const isTwoHigh = (p: DefensivePlay): boolean => p.coverage === 'cover2' || p.coverage === 'cover4' || p.coverage === 'cover6';
export const isSingleHigh = (p: DefensivePlay): boolean => p.coverage === 'cover1' || p.coverage === 'cover3' || p.coverage === 'cover9';
export const isZeroShell = (p: DefensivePlay): boolean => p.coverage === 'cover0';

/** Rough sub-package class of a defensive formation id. */
export const formationClass = (formation: string): FormationClass => {
  const f = formation.toLowerCase();
  if (f.includes('goal')) return 'goalLine';
  if (f.includes('prevent')) return 'prevent';
  if (f.includes('dime')) return 'dime';
  if (f.includes('nickel') || f.includes('425') || f.includes('4-2-5')) return 'nickel';
  if (f === '43' || f === '34' || f.includes('4-3') || f.includes('3-4') || f.includes('base')) return 'base';
  return 'other';
};

/** Down, distance, field position and score/time shaping. */
export const situationMultiplier = (play: DefensivePlay, args: DefensiveCallArgs): number => {
  const s = args.situation;
  const late = (args.quarter ?? 1) >= 4 || args.overtime === true;
  const defenseLeads = s.scoreDiff < 0;
  const cls = formationClass(play.formation);
  let w = 1;
  if (late && s.clock <= 150 && defenseLeads) {
    if (isPrevent(play)) w *= 10;
    if (isTwoHigh(play)) w *= 2;
    if (isBlitz(play)) w *= 0.25;
    if (isZeroShell(play)) w *= 0.1;
    if (isRunStop(play)) w *= 0.3;
  } else {
    if (isPrevent(play)) w *= 0.05;
    if (late && s.clock <= 300 && !defenseLeads) {
      if (isBlitz(play)) w *= 1.6;
      if (isZeroShell(play)) w *= 1.3;
    }
  }
  if (s.distance <= 2) {
    if (isZeroShell(play)) w *= 1.5;
    if (play.coverage === 'cover1') w *= 1.3;
    if (isRunStop(play)) w *= 1.6;
    if (isBlitz(play)) w *= s.down >= 3 ? 2.5 : 1.3;
    if (isTwoHigh(play)) w *= 0.5;
    if (cls === 'dime') w *= 0.3;
  } else if (s.distance <= 7) {
    if (isSingleHigh(play)) w *= 1.4;
    if (isBlitz(play)) w *= s.down === 3 ? 1.3 : 0.9;
  } else {
    if (isTwoHigh(play)) w *= 1.7;
    if (isZeroShell(play)) w *= 0.35;
    if (isRunStop(play)) w *= 0.3;
    if (isBlitz(play)) w *= s.down === 3 && s.distance >= 10 ? 1.1 : 0.7;
    if (cls === 'dime' && s.distance >= 10) w *= 1.4;
    if (cls === 'nickel') w *= 1.2;
  }
  if (s.ballOn >= 95) {
    w *= cls === 'goalLine' ? 4 : 0.6;
    if (isZeroShell(play)) w *= 1.4;
    if (isTwoHigh(play)) w *= 0.3;
    if (cls === 'dime') w *= 0.2;
  } else if (s.ballOn >= 80) {
    if (play.tags.includes('redZone')) w *= 1.4;
    if (play.coverage === 'cover4') w *= 0.6;
    if (cls === 'goalLine') w *= 0.5;
  }
  return w;
};

/** Coordinator scheme: blitz heavy brings pressure, coverage first sits back, run stuff loads the box. */
export const schemeMultiplier = (play: DefensivePlay, scheme: DefensiveScheme): number => {
  const cls = formationClass(play.formation);
  switch (scheme) {
    case 'blitzHeavy': return (isBlitz(play) ? 2.2 : 1) * (isZeroShell(play) ? 1.3 : 1);
    case 'coverageFirst': return (isBlitz(play) ? 0.45 : 1) * (play.family === 'zone' ? 1.4 : play.family === 'match' ? 1.2 : 1);
    case 'runStuff': return (isRunStop(play) ? 1.8 : 1) * (cls === 'base' ? 1.3 : cls === 'dime' ? 0.6 : 1);
    default: return 1;
  }
};

/** Personnel match: sub packages against spread sets, base and run stoppers against heavy ones. */
export const personnelMultiplier = (play: DefensivePlay, personnel: string | undefined): number => {
  if (!personnel) return 1;
  const cls = formationClass(play.formation);
  switch (personnel) {
    case '10':
    case '00': return cls === 'dime' ? 1.6 : cls === 'nickel' ? 1.2 : cls === 'base' ? 0.5 : cls === 'goalLine' ? 0.2 : 1;
    case '11': return cls === 'nickel' ? 1.4 : 1;
    case '12':
    case '21': return cls === 'base' ? 1.4 : cls === 'dime' ? 0.5 : 1;
    case '13':
    case '22':
    case '23': return (isRunStop(play) ? 1.7 : 1) * (cls === 'dime' ? 0.2 : 1);
    default: return 1;
  }
};

/**
 * The answer to the scouting report at full strength: nickel/dime and fewer run stoppers against a passing offense
 * (overall and out of the formation on the field), run stoppers against a running one, two-high against deep shots,
 * tighter man/press against a quick-game diet.
 */
export const scoutingMultiplier = (play: DefensivePlay, t: OffenseTendencies, formation?: string): number => {
  const cls = formationClass(play.formation);
  let w = 1;
  const pass = t.passRate;
  if (pass !== undefined) {
    if (pass >= 0.62) w *= cls === 'nickel' ? 1.3 : cls === 'dime' ? 1.4 : 1;
    if (pass >= 0.62 && isRunStop(play)) w *= 0.5;
    if (pass <= 0.4) w *= isRunStop(play) ? 1.7 : cls === 'base' ? 1.3 : cls === 'dime' ? 0.4 : 1;
  }
  const fromHere = formation ? t.formationPassRate?.[formation] : undefined;
  if (fromHere !== undefined) {
    if (fromHere >= 0.75) w *= (isRunStop(play) ? 0.4 : 1) * (cls === 'nickel' || cls === 'dime' ? 1.4 : cls === 'base' ? 0.8 : 1);
    else if (fromHere <= 0.3) w *= (isRunStop(play) ? 2.2 : 1) * (cls === 'base' ? 1.3 : cls === 'nickel' ? 0.7 : cls === 'dime' ? 0.4 : 1);
  }
  if ((t.deepRate ?? 0) >= 0.35) w *= isTwoHigh(play) ? 1.4 : isZeroShell(play) ? 0.6 : 1;
  if ((t.quickRate ?? 0) >= 0.5) w *= (play.family === 'man' ? 1.3 : 1) * (play.coverage === 'cover4' ? 0.8 : 1);
  return w;
};

/** Personnel match plus the scouting report scaled by `strength` (adaptationFor; default: full). */
export const tendencyMultiplier = (play: DefensivePlay, t: OffenseTendencies | undefined, personnel: string | undefined, strength = 1, formation?: string): number =>
  (t ? adapt(scoutingMultiplier(play, t, formation), strength) : 1) * personnelMultiplier(play, personnel);

/**
 * Staff appetite for pressure (scouting.staffTendencies): blitz-minded staffs bring more, cautious ones less. The head
 * coach's temperament sets it; a defensive coordinator moves it by how far he pulls the staff's blitz lean from the
 * head coach's alone (the head coach's own scheme is already in schemeMultiplier).
 */
export const staffBlitzMultiplier = (play: DefensivePlay, coach: Coach | null, dc: Coach | null = null): number => {
  if ((!coach && !dc) || !isBlitz(play)) return 1;
  const head = staffTendencies(coach);
  const pull = dc ? staffTendencies(coach, null, dc).blitzLean - head.blitzLean : 0;
  return Math.max(0.5, 1 + 0.35 * head.aggression + 0.6 * pull);
};

/** Every eligible play with its final weight (return units are never included). */
export const weighDefensivePlays = (args: DefensiveCallArgs): WeightedPlay<DefensivePlay>[] => {
  const { coach, difficulty } = args;
  const exponent = 0.25 + coachIq(coach, difficulty, 'defense');
  const strength = adaptationFor(difficulty, args.offenseTendencies?.samples);
  const personnel = args.offenseFormationPersonnel ?? formationPersonnel(args.offenseFormation);
  const recent = args.recentPlayIds ?? [];
  const last = recent[recent.length - 1];
  const out: WeightedPlay<DefensivePlay>[] = [];
  for (const { play, weight } of defensivePlaysForSituation(args.plays, args.situation)) {
    const w = weight
      * situationMultiplier(play, args)
      * (coach ? schemeMultiplier(play, coach.defensiveScheme) : 1)
      * staffBlitzMultiplier(play, coach, args.defensiveCoordinator ?? null)
      * tendencyMultiplier(play, args.offenseTendencies, personnel, strength, args.offenseFormation)
      * (play.id === last ? 0.3 : 1);
    if (w > 0) out.push({ play, weight: Math.pow(w, exponent) });
  }
  return out;
};

/** The defensive call: one weighted draw (the only die it rolls). Throws on an empty play list. */
export const callDefense = (args: DefensiveCallArgs): DefensiveCall => {
  if (args.plays.length === 0) throw new Error('callDefense: the play list is empty');
  return { play: pickWeighted(weighDefensivePlays(args), args.rng) ?? args.rng.pick(args.plays) };
};

/** The defensive play for the situation (see callDefense). */
export const callDefensivePlay = (args: DefensiveCallArgs): DefensivePlay => callDefense(args).play;

const HEAVY_PERSONNEL: ReadonlySet<string> = new Set(['13', '22', '23']);
const SPREAD_PERSONNEL: ReadonlySet<string> = new Set(['10', '00']);

/** How a call mismatches the personnel on the field: too light against heavy sets, too heavy against spread ones. */
export const personnelMismatch = (play: DefensivePlay, personnel: string | undefined): 'tooLight' | 'tooHeavy' | null => {
  if (!personnel) return null;
  const cls = formationClass(play.formation);
  if (HEAVY_PERSONNEL.has(personnel) && (cls === 'dime' || cls === 'prevent')) return 'tooLight';
  if (SPREAD_PERSONNEL.has(personnel) && (cls === 'goalLine' || isRunStop(play))) return 'tooHeavy';
  return null;
};

/** Chance the defense recognises a personnel mismatch and checks out of it (about 0.3 rookie .. 0.95 legend). */
export const checkChance = (coach: Coach | null, difficulty: DifficultyProfile): number => clamp01(1.6 * coachIq(coach, difficulty, 'defense') - 0.35);

/**
 * How a call mismatches what the scouting report says the offense does out of the formation on the field: a run
 * stopper or base front against a formation it throws from 75%+ of the time, a sub package against one it runs
 * from 70%+ of the time. Null without a report on that formation.
 */
export const tendencyMismatch = (play: DefensivePlay, t: OffenseTendencies | undefined, formation: string | undefined): 'tooLight' | 'tooHeavy' | null => {
  const fromHere = formation ? t?.formationPassRate?.[formation] : undefined;
  if (fromHere === undefined) return null;
  const cls = formationClass(play.formation);
  if (fromHere >= 0.75 && (isRunStop(play) || cls === 'base' || cls === 'goalLine')) return 'tooHeavy';
  if (fromHere <= 0.3 && !isRunStop(play) && (cls === 'nickel' || cls === 'dime' || cls === 'prevent')) return 'tooLight';
  return null;
};

export interface DefensiveCheck {
  play: DefensivePlay;
  /** True when the defense checked out of the huddle call. */
  checked: boolean;
}

/**
 * The check at the line. The huddle call was made blind; once the offense is on the field a call that mismatches
 * its personnel (dime against three tight ends, a run blitz against five wide) is checked with checkChance, and one
 * that mismatches the scouting report on the formation it lined up in (a loaded box against the set it always throws
 * from) with checkChance scaled by the adaptation strength (never at rookie). The new call is the best weighted one
 * that fits. Rolls the rng only when there is a mismatch to recognise.
 */
export const defensiveCheck = (call: DefensivePlay, args: DefensiveCallArgs): DefensiveCheck => {
  const personnel = args.offenseFormationPersonnel ?? formationPersonnel(args.offenseFormation);
  const t = args.offenseTendencies;
  const byPersonnel = personnelMismatch(call, personnel) !== null;
  if (!byPersonnel && !tendencyMismatch(call, t, args.offenseFormation)) return { play: call, checked: false };
  const chance = checkChance(args.coach, args.difficulty) * (byPersonnel ? 1 : adaptationFor(args.difficulty, t?.samples));
  if (chance <= 0 || !args.rng.chance(chance)) return { play: call, checked: false };
  const fits = weighDefensivePlays({ ...args, offenseFormationPersonnel: personnel })
    .filter((w) => !personnelMismatch(w.play, personnel) && (byPersonnel || !tendencyMismatch(w.play, t, args.offenseFormation)));
  const pick = pickWeighted(fits, args.rng);
  return pick ? { play: pick, checked: pick.id !== call.id } : { play: call, checked: false };
};
