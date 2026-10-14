import { findAthlete } from './athlete';
import type { AthleteId, DeadReason, PlayEvent } from './play-events';
import type { PlayContext, PlayState } from './play-types';
import type { AlternateRuling, EngineEnv } from './systems/env';
import type { OutcomeFacts } from './systems/outcome-facts';
import { catchLabel, deadReasonLabel, downDistanceLabel, foulLabel, humanizeId, incompleteLabel, kickLabel, specialLabel, throwLabel, yardsLabel } from './text-labels';

/**
 * Play-by-play text: situation, key moments and the result. Yard lines are broadcast style, naming the team whose
 * territory the ball is in ("the ATL 32") so kick plays (where ctx.offense is the kicking team) read naturally;
 * without team abbreviations they fall back to the offense's OWN / OPP.
 */
export const yardLineLabel = (ballOn: number, ctx?: Pick<PlayContext, 'offense' | 'teamAbbrs'>): string => {
  const abbrs = ctx?.teamAbbrs;
  const own = abbrs && ctx ? abbrs[ctx.offense] : 'OWN';
  const opp = abbrs && ctx ? abbrs[ctx.offense === 'home' ? 'away' : 'home'] : 'OPP';
  // Only a spot on or past a goal line is in the end zone, never "the BAL 0"; a ball half a yard short of it is on
  // the 1 (rounding it would call a runner stopped short "in the end zone").
  if (ballOn <= 0) return `the ${own} end zone`;
  if (ballOn >= 100) return `the ${opp} end zone`;
  const v = Math.min(99, Math.max(1, Math.round(ballOn)));
  if (v === 50) return 'the 50';
  return v < 50 ? `the ${own} ${v}` : `the ${opp} ${100 - v}`;
};

/** Where a pass was aimed relative to the line: "12 yards downfield", "3 yards behind the line", "at the line". */
const airYardsText = (airYards: number): string => {
  const y = Math.round(airYards);
  return y > 0 ? `${yardsLabel(y)} downfield` : y < 0 ? `${yardsLabel(-y)} behind the line` : 'at the line';
};

/** Why the ball is dead, in words. A dive that lands untouched is also ruled 'slide' by the engine: say "dives". */
const deadLabel = (state: PlayState, reason: DeadReason | null = state.deadReason): string =>
  reason === 'slide' && !state.events.some((e) => e.type === 'slide') ? 'the runner dives' : deadReasonLabel(reason);

/**
 * The events a ruling stands on. Under a review's alternate ruling the moments the reversal takes back are dropped:
 * the score of an overturned touchdown or safety, the catch of a pass ruled incomplete.
 */
export const eventsForRuling = (events: readonly PlayEvent[], facts: Pick<OutcomeFacts, 'touchdown' | 'safety'>, alt?: AlternateRuling): PlayEvent[] => {
  if (!alt) return events.slice();
  return events.filter((e) => !(e.type === 'touchdown' && !facts.touchdown) && !(e.type === 'safety' && !facts.safety) && !(e.type === 'catch' && alt.wipeCompletion));
};

/** "A", "A and B", "A, B and C". */
export const nameList = (names: readonly string[]): string =>
  names.length <= 1 ? names[0] ?? '' : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;

const COUNT_WORDS = ['no', 'one', 'two', 'three', 'four', 'five'];

/**
 * The tackle struggle in words: "Smith drags Jones for 3 more yards" / "drags two defenders for 4 more yards". Nothing
 * when he gained less than a yard while held.
 */
export const dragLine = (carrier: string, defenders: readonly string[], dragYards: number): string | null => {
  const y = Math.round(dragYards);
  if (y < 1 || defenders.length === 0) return null;
  const who = defenders.length === 1 ? defenders[0] : `${COUNT_WORDS[defenders.length] ?? defenders.length} defenders`;
  return `${carrier} drags ${who} for ${y} more yard${y === 1 ? '' : 's'}`;
};

/** Yards after contact (rounded) a runner must drag the pile before the log tells it. */
export const DRAG_LINE_YARDS = 2;

/** Yards a passer must retreat from where he took the snap before the log says he "drops back". */
export const DROP_BACK_YARDS = 1.5;

/** The passer really dropped (retreated DROP_BACK_YARDS or more before the ball left his hands). */
const droppedBack = (env: EngineEnv): boolean => !!env.qbDrop && env.qbDrop.start - env.qbDrop.deepest >= DROP_BACK_YARDS;

/** "with a spin" for a broken tackle's special move; nothing when he just ran through it. */
const moveText = (move: string | null | undefined): string => (move && move !== 'none' ? ` with a ${humanizeId(move).toLowerCase()}` : '');

const signed = (n: number): string => (n > 0 ? `gain of ${n}` : n < 0 ? `loss of ${-n}` : 'no gain');

const returnOf = (n: number): string => (n > 0 ? `return of ${n}` : n < 0 ? `return for a loss of ${-n}` : 'no return');

/**
 * Result line of a kickoff / onside / punt, worded from the same facts the outcome carries (deadReason, returnYards,
 * turnover) so the recap banner and the log can never disagree: a touchback or fair catch has no return, a kick out of
 * bounds is not a return, an onside recovery names the recovering team.
 */
const kickResultLine = (state: PlayState, facts: OutcomeFacts, name: (id: AthleteId | null) => string, reason: DeadReason | null): string => {
  const ctx = state.ctx;
  const spot = yardLineLabel(facts.endBallOn, ctx);
  if (facts.touchdown) return facts.turnover ? `Kicking team recovers in the end zone: touchdown.` : `Returned for a touchdown, ${returnOf(facts.returnYards)}.`;
  switch (reason) {
    case 'touchback': return 'Touchback, no return.';
    case 'fairCatch': return `Fair catch at ${spot}, no return.`;
    case 'kickDowned': return `Kick downed at ${spot}, no return.`;
    case 'onsideRecovered': return `Onside kick recovered by the kicking team at ${spot}.`;
    case 'blockedKick': return `Blocked kick, dead at ${spot}.`;
    default: break;
  }
  // A return that ended in a fumble the kicking team fell on still quotes the return it had.
  if (facts.turnover) return `Kicking team recovers at ${spot}${facts.returnYards !== 0 ? ` after a ${returnOf(facts.returnYards)}` : ''}.`;
  if (facts.outOfBounds && !facts.carrier) return `Kick out of bounds at ${spot}, no return.`;
  if (facts.tackle) return `${name(facts.tackle.carrier)} tackled at ${spot} by ${name(facts.tackle.tackler)}, ${returnOf(facts.returnYards)}.`;
  if (facts.outOfBounds) return `Out of bounds at ${spot}, ${returnOf(facts.returnYards)}.`;
  return `Ball dead at ${spot} (${deadLabel(state, reason)}), ${returnOf(facts.returnYards)}.`;
};

const PASS_TYPES = new Set(['pass', 'playAction', 'screen', 'rpo']);

/** The side's team name for a recovery or a flag: its abbreviation when known, else offense / defense. */
const sideName = (ctx: PlayContext, side: 'offense' | 'defense'): string => {
  const team = side === 'offense' ? ctx.offense : ctx.offense === 'home' ? 'away' : 'home';
  const abbr = ctx.teamAbbrs?.[team];
  if (abbr) return abbr;
  const kick = ctx.special === 'kickoff' || ctx.special === 'onside' || ctx.special === 'punt';
  if (kick) return side === 'offense' ? 'the kicking team' : 'the receiving team';
  return `the ${side}`;
};

/** 'Shotgun Trips' from the formation registry, else the id made readable. */
const formationName = (env: EngineEnv, id: string): string => env.opts.registries?.offensiveFormations?.[id]?.name ?? humanizeId(id);

/** Name of an audible target play (from the audible registry when the engine has it). */
const playName = (env: EngineEnv, id: string, side: 'offense' | 'defense'): string =>
  (side === 'offense' ? env.opts.plays?.offensePlays?.[id]?.name : env.opts.plays?.defensePlays?.[id]?.name) ?? humanizeId(id);

/** Situation heading: down & distance (or the kind of kick), the call and the formation when it adds anything. */
const situationLine = (state: PlayState, env: EngineEnv): string => {
  const ctx = state.ctx;
  const kick = ctx.special !== 'none' && ctx.special !== 'twoPoint';
  const situation = kick || ctx.special === 'twoPoint' ? `${specialLabel(ctx.special)} from ${yardLineLabel(ctx.ballOn, ctx)}` : `${downDistanceLabel(ctx.down, ctx.distance, ctx.ballOn)} at ${yardLineLabel(ctx.ballOn, ctx)}`;
  const formation = formationName(env, ctx.offensivePlay.formation);
  const showFormation = !ctx.offensivePlay.name.toLowerCase().includes(formation.toLowerCase());
  return `${situation} — ${ctx.offensivePlay.name}${showFormation ? ` from the ${formation} formation` : ''} vs ${ctx.defensivePlay.name}`;
};

/**
 * Result line for a scrimmage play (or a two-point try), worded from the facts: a turnover describes the return (the
 * offense's yardage is zero on a takeaway), a safety says where the carrier went down, a score says so.
 */
const scrimmageResultLine = (state: PlayState, facts: OutcomeFacts, name: (id: AthleteId | null) => string, reason: DeadReason | null): string => {
  const ctx = state.ctx;
  // The spot is told as the (rounded) line of scrimmage plus the (rounded) gain, so "from the 5 ... at the 2" never reads
  // as a loss of 4; a takeaway is spotted where the return ended.
  const told = facts.turnover ? facts.endBallOn : Math.min(99.5, Math.max(0.5, Math.round(ctx.ballOn) + facts.yards));
  const spot = yardLineLabel(told, ctx);
  if (facts.touchdown) return facts.turnover ? `Returned for a touchdown, ${returnOf(facts.returnYards)}.` : `Touchdown, ${signed(facts.yards)}.`;
  if (facts.safety) return facts.result === 'sack' ? 'Sacked in the end zone: safety.' : 'Tackled in the end zone: safety.';
  if (facts.incomplete) return 'Result: incomplete pass.';
  const gain = facts.turnover ? returnOf(facts.returnYards) : signed(facts.yards);
  if (facts.tackle) {
    const t = facts.tackle;
    // A sack is told as one ("SACKED by ..." above): the result line says where, not a second tackle by the same men.
    if (facts.result === 'sack') return `${name(t.carrier)} sacked at ${spot}, ${gain}.`;
    if (t.assists.length > 0) return `${name(t.carrier)} tackled at ${spot}, gang tackle by ${nameList([t.tackler, ...t.assists].map(name))}, ${gain}.`;
    return `${name(t.carrier)} tackled at ${spot} by ${name(t.tackler)}, ${gain}.`;
  }
  if (facts.outOfBounds) return `Out of bounds at ${spot}, ${gain}.`;
  return `Ball dead at ${spot} (${deadLabel(state, reason)}), ${gain}.`;
};

/**
 * Play-by-play lines for a dead play: the situation, each key event in order, and one result line. `alt` is a review's
 * alternate ruling (outcome.ts builds review.ifOverturned with it): the lines then tell the play as reversed.
 */
export const buildPlayByPlay = (state: PlayState, env: EngineEnv, facts: OutcomeFacts, alt?: AlternateRuling): string[] => {
  const ctx = state.ctx;
  const reason = alt?.deadReason ?? state.deadReason;
  const name = (id: AthleteId | null): string => findAthlete(state, id)?.name ?? 'someone';
  const lines: string[] = [situationLine(state, env)];
  const dropback = PASS_TYPES.has(ctx.offensivePlay.type) && (ctx.special === 'none' || ctx.special === 'twoPoint');
  let pressured = false;
  // Defenders who had hold of the runner (a struggle): a break from them is "breaks free".
  const holding = new Set<AthleteId>();
  const events = eventsForRuling(state.events, facts, alt);
  // A passer held up behind the line is simply sacked: no "stood up" line before the sack.
  const sacked = events.some((e) => e.type === 'sack');
  for (const e of events) {
    switch (e.type) {
      case 'snap': if (dropback && env.qbId) lines.push(`${name(env.qbId)} takes the snap${droppedBack(env) ? ' and drops back' : ''}`); break;
      case 'audible': lines.push(e.success ? `The ${e.side} audibles to ${playName(env, e.newPlayId, e.side)}` : `The ${e.side} audible fails`); break;
      case 'penalty': lines.push(`FLAG: ${foulLabel(e.penalty.foul)} on ${sideName(ctx, e.penalty.side)}${e.penalty.playerId ? ` (${name(state.athletes.find((a) => a.playerId === e.penalty.playerId)?.id ?? null)})` : ''}`); break;
      case 'handoff': lines.push(`${name(e.from)} hands to ${name(e.to)}`); break;
      case 'pitch': lines.push(`${name(e.from)} pitches to ${name(e.to)}`); break;
      case 'lateral': lines.push(`${name(e.from)} laterals to ${name(e.to)}`); break;
      case 'playActionFake': lines.push(`${name(e.qb)} fakes to ${name(e.to)}`); break;
      case 'pressure': if (!pressured) { pressured = true; lines.push(`Pressure coming from ${name(e.by)}`); } break;
      case 'scramble': lines.push(`${name(e.qb)} scrambles`); break;
      // A ball thrown to a spot (pull-back pass) with nobody credited is still a pass into the field, not a throw-away.
      case 'throw': lines.push(e.target
        ? `${name(e.thrower)} throws ${throwLabel(e.throwType)} to ${name(e.target)}, ${airYardsText(e.airYards)}`
        : e.throwType === 'throwAway' ? `${name(e.thrower)} throws it away` : `${name(e.thrower)} throws ${throwLabel(e.throwType)}, ${airYardsText(e.airYards)}`);
        break;
      case 'catch': lines.push(`${name(e.receiver)} makes the ${catchLabel(e.catchKind, e.contested)} at ${yardLineLabel(e.ballOn, ctx)}`); break;
      case 'incomplete': lines.push(e.reason === 'drop' && e.target ? `Incomplete, dropped by ${name(e.target)}` : `Incomplete, ${incompleteLabel(e.reason)}${e.defender ? ` by ${name(e.defender)}` : ''}`); break;
      case 'interception': lines.push(`INTERCEPTED by ${name(e.defender)} at ${yardLineLabel(e.ballOn, ctx)}`); break;
      case 'tipped': lines.push(`Tipped by ${name(e.by)}`); break;
      case 'wrapUp': holding.add(e.tackler); break;
      case 'pileJoin': holding.add(e.defender); break;
      case 'brokenTackle':
        lines.push(holding.delete(e.defender)
          ? `${name(e.carrier)} breaks free from ${name(e.defender)}'s tackle${moveText(e.move)}`
          : `${name(e.carrier)} breaks ${name(e.defender)}'s tackle${moveText(e.move)}`);
        break;
      case 'forwardProgressStopped': if (!sacked) lines.push(`${name(e.carrier)} is stood up at ${yardLineLabel(e.ballOn, ctx)}`);
        break;
      case 'tackle': {
        // A sacked passer is not a runner carrying the pile, and falling forward a yard is every tackle, not a story:
        // the log tells a drag of DRAG_LINE_YARDS or more.
        const drag = e.dragYards !== undefined && e.dragYards >= DRAG_LINE_YARDS - 0.5 && !sacked ? dragLine(name(e.carrier), [e.tackler, ...e.assists].map(name), e.dragYards) : null;
        if (drag) lines.push(drag);
        break;
      }
      case 'missedTackle': lines.push(`${name(e.defender)} misses the tackle`); break;
      case 'fumble': lines.push(`FUMBLE by ${name(e.carrier)}${e.forcedBy ? `, forced by ${name(e.forcedBy)}` : ''} at ${yardLineLabel(e.ballOn, ctx)}`); break;
      case 'recovery': lines.push(`Recovered by ${name(e.by)} (${sideName(ctx, e.side)}) at ${yardLineLabel(e.ballOn, ctx)}`); break;
      case 'muff': lines.push(`${name(e.by)} muffs the kick`); break;
      case 'sack': {
        if (!pressured) { pressured = true; lines.push(`Pressure coming from ${name(e.by)}`); }
        // The loss is the play's own (chain-consistent) yardage when the sack ended the play, so both lines agree.
        const loss = facts.result === 'sack' && !facts.turnover && !facts.safety ? Math.max(0, -facts.yards) : Math.round(e.yardsLost);
        lines.push(`SACKED by ${name(e.by)} ${loss > 0 ? `for a loss of ${yardsLabel(loss)}` : 'for no gain'}`);
        break;
      }
      case 'pancake': lines.push(`${name(e.blocker)} pancakes ${name(e.defender)}`); break;
      case 'kick': lines.push(`${name(e.kicker)} ${e.kind === 'punt' ? 'punts' : 'kicks'}`); break;
      case 'kickResult': lines.push(`The ${Math.round(e.distance)}-yard ${kickLabel(e.kind)} is ${e.made ? 'GOOD' : 'NO GOOD'}`); break;
      case 'kickBlocked': lines.push(`Kick BLOCKED by ${name(e.by)}`); break;
      case 'fairCatch': lines.push(`Fair catch by ${name(e.by)}`); break;
      case 'downed': lines.push(`Downed by ${name(e.by)} at ${yardLineLabel(e.ballOn, ctx)}`); break;
      case 'touchback': lines.push('Touchback'); break;
      case 'onsideRecovery': lines.push(`Onside kick recovered by ${name(e.by)}`); break;
      case 'outOfBounds': lines.push(`${e.athlete ? name(e.athlete) : 'Ball'} out of bounds at ${yardLineLabel(e.ballOn, ctx)}`); break;
      case 'touchdown': lines.push(`TOUCHDOWN ${name(e.scorer)}!`); break;
      case 'safety': lines.push('SAFETY!'); break;
      // The crossing itself is not narrated: the closing "First down." line says it once the play (and any fumble) is over.
      case 'firstDown': break;
      case 'slide': lines.push(`${name(e.athlete)} slides`); break;
      case 'kneel': lines.push(`${name(e.athlete)} kneels`); break;
      case 'spike': lines.push(`${name(e.athlete)} spikes the ball`); break;
      case 'injury': lines.push(`${name(e.athlete)} is hurt on the play (${e.severity})`); break;
      default: break;
    }
  }
  const returnKick = !facts.isScrimmage && (ctx.special === 'kickoff' || ctx.special === 'onside' || ctx.special === 'punt');
  const placeKick = !facts.isScrimmage && (ctx.special === 'fieldGoal' || ctx.special === 'extraPoint');
  if (facts.result === 'penalty') lines.push('No play.');
  else if (returnKick && !facts.safety) lines.push(kickResultLine(state, facts, name, reason));
  else if (placeKick) {
    if (!state.events.some((e) => e.type === 'kickResult')) lines.push(`${specialLabel(ctx.special)} attempt ends at ${yardLineLabel(facts.endBallOn, ctx)} (${deadLabel(state, reason)}).`);
  } else lines.push(scrimmageResultLine(state, facts, name, reason));
  if (facts.firstDown && !facts.touchdown) lines.push('First down.');
  return lines;
};
