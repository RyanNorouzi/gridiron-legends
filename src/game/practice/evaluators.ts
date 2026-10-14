/**
 * Drill success evaluators: pure functions from a rep's evidence (events so far, the outcome once the play is
 * dead, kick measurements) to a verdict. Each returns null while the evidence is not yet decisive, and always
 * returns a verdict once `outcome` is set, so the rep runner can decide early (the catch, the kick) and still
 * never leaves a rep unjudged.
 */
import type { AthleteId, IncompleteReason, PlayEvent } from '../play-events';
import { FIELD_WIDTH } from '../types';
import type { DrillEvaluator, EvaluatorId, RepEvidence, RepVerdict } from './types';

type EventOf<T extends PlayEvent['type']> = Extract<PlayEvent, { type: T }>;

/** First event of a type matching `pred`. */
export const findEvent = <T extends PlayEvent['type']>(events: readonly PlayEvent[], type: T, pred: (e: EventOf<T>) => boolean = () => true): EventOf<T> | null => {
  for (const e of events) if (e.type === type && pred(e as EventOf<T>)) return e as EventOf<T>;
  return null;
};

const byUser = (ev: RepEvidence, id: AthleteId | null): boolean => id !== null && ev.userIds.includes(id);

/** A successful verdict (points rounded, never negative). */
export const pass = (headline: string, detail: string, points: number): RepVerdict => ({ success: true, points: Math.max(0, Math.round(points)), headline, detail });
/** A failed verdict (no points). */
export const fail = (headline: string, detail: string): RepVerdict => ({ success: false, points: 0, headline, detail });

const INCOMPLETE_TEXT: Readonly<Record<IncompleteReason, string>> = {
  drop: 'Dropped it',
  overthrown: 'Overthrown',
  underthrown: 'Underthrown',
  defended: 'Broken up by the defense',
  throwAway: 'Thrown away',
  outOfBounds: 'Out of bounds',
  spike: 'Spiked',
  batted: 'Batted at the line',
};

const signed = (n: number): string => (n >= 0 ? `+${n}` : `${n}`);

/** Passing drills: complete a pass caught at least `level.yards` downfield; bonus for hitting the primary read. */
export const evaluateCompletion: DrillEvaluator = (ev, level) => {
  const sack = findEvent(ev.events, 'sack');
  if (sack) return fail('SACKED', `Lost ${Math.round(sack.yardsLost)} yards - get the ball out`);
  if (findEvent(ev.events, 'interception')) return fail('INTERCEPTED', 'Read the coverage before you let it go');
  const caught = findEvent(ev.events, 'catch', (e) => e.receiver.startsWith('off:'));
  if (caught) {
    const gain = Math.round(caught.ballOn - ev.startBallOn);
    const primary = caught.receiver === ev.focusId;
    if (gain < level.yards) return fail('TOO SHORT', `Caught at ${signed(gain)}; need ${level.yards}+ yards`);
    return pass(`COMPLETE ${signed(gain)}`, primary ? 'Hit the primary read' : 'Completion', 100 + 4 * Math.max(0, gain) + (primary ? 20 : 0));
  }
  const inc = findEvent(ev.events, 'incomplete');
  if (inc) return fail(inc.reason === 'throwAway' ? 'THROWN AWAY' : 'INCOMPLETE', INCOMPLETE_TEXT[inc.reason]);
  if (!ev.outcome) return null;
  if (!findEvent(ev.events, 'throw')) return fail('NO THROW', 'Scrambles do not count - throw it');
  return fail('INCOMPLETE', 'The pass was not completed');
};

/** Running drill: gain at least `level.yards` without putting the ball on the ground. */
export const evaluateRunGain: DrillEvaluator = (ev, level) => {
  const o = ev.outcome;
  if (!o) return null;
  if (o.turnover) return fail('FUMBLE', 'Protect the ball in traffic');
  const gain = Math.round(o.yards);
  const broken = ev.events.filter((e) => e.type === 'brokenTackle' && byUser(ev, e.carrier)).length;
  if (o.touchdown) return pass('TOUCHDOWN', `${gain}-yard run`, 200 + 10 * gain + 15 * broken);
  if (gain < level.yards) return fail('STOPPED', `Gained ${gain}; need ${level.yards}+`);
  return pass(`RUN ${signed(gain)}`, broken > 0 ? `${broken} broken tackle${broken > 1 ? 's' : ''}` : 'Good read', 50 + 10 * gain + 15 * broken);
};

/** JUGS drill: catch the machine's throw with the user's receiver. */
export const evaluateJugsCatch: DrillEvaluator = (ev) => {
  const caught = findEvent(ev.events, 'catch', (e) => byUser(ev, e.receiver));
  if (caught) {
    const bonus = caught.catchKind === 'diving' || caught.catchKind === 'highPoint' ? 50 : caught.contested ? 25 : 0;
    const detail = caught.catchKind === 'diving' ? 'Diving catch' : caught.catchKind === 'highPoint' ? 'High-pointed it' : caught.catchKind === 'sideline' ? 'Toe-tap on the sideline' : 'Clean catch';
    return pass('CAUGHT', detail, 100 + bonus);
  }
  const inc = findEvent(ev.events, 'incomplete');
  if (inc) return fail(inc.reason === 'drop' ? 'DROPPED' : 'MISSED', inc.reason === 'drop' ? 'Look it in' : `${INCOMPLETE_TEXT[inc.reason]} - get under it`);
  if (findEvent(ev.events, 'catch')) return fail('WRONG MAN', 'Someone else caught it');
  return ev.outcome ? fail('MISSED', 'The ball was never caught') : null;
};

/** Coverage drill: no completion, or a completion held to `level.yards` or fewer. */
export const evaluateCoverage: DrillEvaluator = (ev, level) => {
  const pick = findEvent(ev.events, 'interception');
  if (pick) return pass('INTERCEPTION', byUser(ev, pick.defender) ? 'You jumped the route' : 'Picked off', byUser(ev, pick.defender) ? 250 : 150);
  const inc = findEvent(ev.events, 'incomplete');
  if (inc) {
    if (byUser(ev, inc.defender)) return pass('PASS BROKEN UP', 'You played the ball', 175);
    return pass('INCOMPLETE', inc.reason === 'defended' ? 'Contested' : 'Stayed in phase', 100);
  }
  if (findEvent(ev.events, 'sack')) return pass('SACK', 'Coverage sack', 75);
  const o = ev.outcome;
  if (!o) return null;
  const gain = Math.round(o.yards);
  if (o.touchdown) return fail('TOUCHDOWN', 'Beaten deep - stay on top');
  if (gain <= level.yards) return pass('HELD SHORT', `Allowed ${gain} yards`, 40 + 5 * Math.max(0, level.yards - gain));
  return fail('COMPLETION', `Allowed ${gain} yards; hold it to ${level.yards}`);
};

/** Tackling drill: the user brings the carrier down within `level.yards` of the line. */
export const evaluateTackle: DrillEvaluator = (ev, level) => {
  const o = ev.outcome;
  if (!o) return null;
  const gain = Math.round(o.yards);
  if (o.touchdown) return fail('TOUCHDOWN', 'He got away - take a better angle');
  const tackle = findEvent(ev.events, 'tackle', (e) => byUser(ev, e.tackler) || e.assists.some((a) => byUser(ev, a)));
  if (tackle && gain <= level.yards) {
    const big = tackle.kind === 'hitStick';
    return pass(big ? 'BIG HIT' : 'TACKLE', `Stopped him at ${signed(gain)}`, 100 + 5 * Math.max(0, level.yards - gain) + (big ? 50 : 0));
  }
  if (!tackle && o.outOfBounds && gain <= level.yards) return pass('PUSHED OUT', `Forced out at ${signed(gain)}`, 60);
  if (tackle) return fail('TOO DEEP', `Tackle at ${signed(gain)}; stop him inside ${level.yards}`);
  const missed = findEvent(ev.events, 'missedTackle', (e) => byUser(ev, e.defender)) ?? findEvent(ev.events, 'brokenTackle', (e) => byUser(ev, e.defender));
  return fail('MISSED', missed ? 'Break down before contact' : 'Close the distance');
};

/** Field goal drill: make the kick. */
export const evaluateFieldGoal: DrillEvaluator = (ev) => {
  if (findEvent(ev.events, 'kickBlocked')) return fail('BLOCKED', 'Get the kick off quicker');
  const r = findEvent(ev.events, 'kickResult', (e) => e.kind === 'fieldGoal' || e.kind === 'extraPoint');
  if (r) {
    const d = Math.round(r.distance);
    return r.made ? pass("IT'S GOOD", `${d}-yard field goal`, 100 + 4 * Math.max(0, d - 30)) : fail('NO GOOD', `Missed from ${d} yards`);
  }
  return ev.outcome ? fail('NO KICK', 'The kick never got away') : null;
};

/** Offense-perspective third of the field an absolute x lies in. */
export const fieldThird = (x: number, direction: 1 | -1): 'left' | 'middle' | 'right' => {
  const local = direction === 1 ? x : FIELD_WIDTH - x;
  return local < FIELD_WIDTH / 3 ? 'left' : local > (2 * FIELD_WIDTH) / 3 ? 'right' : 'middle';
};

/** Punting drill: distance, hang time and the called third, without a touchback. */
export const evaluatePunt: DrillEvaluator = (ev, level, _def, options) => {
  if (findEvent(ev.events, 'kickBlocked')) return fail('BLOCKED', 'Get the punt off quicker');
  const kicked = findEvent(ev.events, 'kick', (e) => e.kind === 'punt');
  const m = ev.metrics;
  if (kicked && m.hangTime !== null && m.landingY !== null && m.landingX !== null) {
    const gross = Math.round(ev.direction * (m.landingY - ev.losY));
    const landingBallOn = ev.startBallOn + gross;
    const hang = m.hangTime;
    const third = fieldThird(m.landingX, ev.direction);
    const minHang = level.hangTime ?? 0;
    const detail = `${gross} yds, ${hang.toFixed(1)}s hang, ${third.toUpperCase()}`;
    if (landingBallOn >= 100) return fail('TOUCHBACK', `${detail} - take something off it`);
    if (gross < level.yards) return fail('SHORT PUNT', `${detail}; need ${level.yards}+ yds`);
    if (hang < minHang) return fail('LOW HANG TIME', `${detail}; need ${minHang.toFixed(1)}s`);
    if (third !== options.puntTarget) return fail('WRONG SIDE', `${detail}; aim ${options.puntTarget.toUpperCase()}`);
    const inside20 = landingBallOn >= 80;
    return pass(inside20 ? 'PINNED DEEP' : `PUNT ${gross} YDS`, detail, 60 + 2 * (gross - level.yards) + Math.round(20 * (hang - minHang)) + (inside20 ? 40 : 0));
  }
  return ev.outcome ? fail('NO KICK', 'The punt never got away') : null;
};

/** Evaluator registry keyed by DrillDefinition.evaluator. */
export const EVALUATORS: Readonly<Record<EvaluatorId, DrillEvaluator>> = Object.freeze({
  completion: evaluateCompletion,
  runGain: evaluateRunGain,
  jugsCatch: evaluateJugsCatch,
  coverage: evaluateCoverage,
  tackle: evaluateTackle,
  fieldGoal: evaluateFieldGoal,
  punt: evaluatePunt,
});
