import { describe, expect, it } from 'vitest';
import { outcomeAt } from '@/game/outcome-factory';
import type { PlayEvent } from '@/game/play-events';
import type { PlayOutcome } from '@/game/play-types';
import {
  DEFAULT_DRILL_OPTIONS, EVALUATORS, emptyMetrics, evaluateCompletion, evaluateCoverage, evaluateFieldGoal, evaluateJugsCatch, evaluatePunt,
  evaluateRunGain, evaluateTackle, fieldThird, getDrill, type DrillId, type DrillOptions, type RepEvidence, type RepMetrics,
} from '@/game/practice';
import { FIELD_WIDTH, fieldY } from '@/game/types';

const BALL_ON = 30;
const LOS = fieldY(BALL_ON, 1);

const evidence = (events: PlayEvent[], outcome: PlayOutcome | null = null, over: Partial<RepEvidence> = {}): RepEvidence => ({
  events, outcome, userIds: ['off:QB'], focusId: 'off:WR2', startBallOn: BALL_ON, losY: LOS, direction: 1, ballX: FIELD_WIDTH / 2, metrics: emptyMetrics(), ...over,
});

const judge = (id: DrillId, ev: RepEvidence, o: Partial<DrillOptions> = {}) => {
  const def = getDrill(id);
  const options = { ...DEFAULT_DRILL_OPTIONS, ...o };
  return EVALUATORS[def.evaluator](ev, def.levels[options.difficulty], def, options);
};

const throwEv = (target: string): PlayEvent => ({ type: 'throw', tick: 80, thrower: 'off:QB', target, throwType: 'bullet', airYards: 10, difficulty: 0.3 });
const catchEv = (receiver: string, ballOn: number, catchKind: 'possession' | 'diving' = 'possession'): PlayEvent => ({ type: 'catch', tick: 100, receiver, contested: false, catchKind, ballOn });

describe('passing evaluator', () => {
  it('scores a completion past the bar, with a primary-read bonus', () => {
    const primary = judge('passZone', evidence([throwEv('off:WR2'), catchEv('off:WR2', BALL_ON + 12)]));
    const other = judge('passZone', evidence([throwEv('off:WR1'), catchEv('off:WR1', BALL_ON + 12)]));
    expect(primary?.success).toBe(true);
    expect(primary?.headline).toBe('COMPLETE +12');
    expect(other?.success).toBe(true);
    expect(primary!.points).toBeGreaterThan(other!.points);
  });

  it('fails short completions, incompletions, picks, sacks and plays without a throw', () => {
    expect(judge('passZone', evidence([throwEv('off:WR2'), catchEv('off:WR2', BALL_ON + 2)]))?.headline).toBe('TOO SHORT');
    expect(judge('passZone', evidence([throwEv('off:WR2'), { type: 'incomplete', tick: 90, reason: 'overthrown', target: 'off:WR2', defender: null }]))?.success).toBe(false);
    expect(judge('passMan', evidence([throwEv('off:WR2'), { type: 'interception', tick: 90, defender: 'def:CB2', ballOn: 45 }]))?.headline).toBe('INTERCEPTED');
    expect(judge('passMan', evidence([{ type: 'sack', tick: 90, by: 'def:DE1', assists: [], yardsLost: 7 }]))?.headline).toBe('SACKED');
    expect(judge('passRoutes', evidence([], outcomeAt(BALL_ON, { result: 'scramble', yards: 6 })))?.headline).toBe('NO THROW');
  });

  it('stays undecided while the ball is in the air', () => {
    expect(evaluateCompletion(evidence([{ type: 'snap', tick: 1 }, throwEv('off:WR2')]), getDrill('passZone').levels.pro, getDrill('passZone'), DEFAULT_DRILL_OPTIONS)).toBeNull();
  });
});

describe('running, catching and coverage evaluators', () => {
  const run = getDrill('running');
  it('running needs the yards, no fumble, and waits for the outcome', () => {
    expect(evaluateRunGain(evidence([]), run.levels.pro, run, DEFAULT_DRILL_OPTIONS)).toBeNull();
    expect(judge('running', evidence([], outcomeAt(BALL_ON, { yards: 6 })))?.success).toBe(true);
    expect(judge('running', evidence([], outcomeAt(BALL_ON, { yards: 2 })))?.headline).toBe('STOPPED');
    expect(judge('running', evidence([], outcomeAt(BALL_ON, { yards: 8, turnover: true, turnoverType: 'fumble' })))?.headline).toBe('FUMBLE');
    const td = judge('running', evidence([], outcomeAt(BALL_ON, { yards: 70, touchdown: true })));
    expect(td?.headline).toBe('TOUCHDOWN');
    const broke = judge('running', evidence([{ type: 'brokenTackle', tick: 50, carrier: 'off:RB', defender: 'def:MLB', move: 'juke' }], outcomeAt(BALL_ON, { yards: 6 }), { userIds: ['off:QB', 'off:RB'] }));
    expect(broke!.points).toBeGreaterThan(judge('running', evidence([], outcomeAt(BALL_ON, { yards: 6 })))!.points);
  });

  it('JUGS credits only the user receiver and rewards the hard catches', () => {
    const def = getDrill('catching');
    const me = { userIds: ['off:WR2'] };
    const plain = evaluateJugsCatch(evidence([catchEv('off:WR2', 45)], null, me), def.levels.pro, def, DEFAULT_DRILL_OPTIONS);
    const diving = evaluateJugsCatch(evidence([catchEv('off:WR2', 45, 'diving')], null, me), def.levels.pro, def, DEFAULT_DRILL_OPTIONS);
    expect(plain?.success).toBe(true);
    expect(diving!.points).toBeGreaterThan(plain!.points);
    expect(evaluateJugsCatch(evidence([catchEv('off:WR1', 45)], null, me), def.levels.pro, def, DEFAULT_DRILL_OPTIONS)?.headline).toBe('WRONG MAN');
    expect(evaluateJugsCatch(evidence([{ type: 'incomplete', tick: 90, reason: 'drop', target: 'off:WR2', defender: null }], null, me), def.levels.pro, def, DEFAULT_DRILL_OPTIONS)?.headline).toBe('DROPPED');
    expect(evaluateJugsCatch(evidence([throwEv('off:WR2')], null, me), def.levels.pro, def, DEFAULT_DRILL_OPTIONS)).toBeNull();
  });

  it('coverage: breakups, picks and short completions pass; long completions fail', () => {
    const def = getDrill('coverage');
    const me = { userIds: ['def:CB2'] };
    const lvl = def.levels.pro;
    const pbu = evaluateCoverage(evidence([{ type: 'incomplete', tick: 90, reason: 'defended', target: 'off:WR2', defender: 'def:CB2' }], null, me), lvl, def, DEFAULT_DRILL_OPTIONS);
    expect(pbu?.headline).toBe('PASS BROKEN UP');
    const pick = evaluateCoverage(evidence([{ type: 'interception', tick: 90, defender: 'def:CB2', ballOn: 40 }], null, me), lvl, def, DEFAULT_DRILL_OPTIONS);
    expect(pick!.points).toBeGreaterThan(pbu!.points);
    expect(evaluateCoverage(evidence([catchEv('off:WR2', 36)], null, me), lvl, def, DEFAULT_DRILL_OPTIONS)).toBeNull();
    expect(evaluateCoverage(evidence([catchEv('off:WR2', 34)], outcomeAt(BALL_ON, { result: 'pass', yards: lvl.yards }), me), lvl, def, DEFAULT_DRILL_OPTIONS)?.success).toBe(true);
    expect(evaluateCoverage(evidence([catchEv('off:WR2', 45)], outcomeAt(BALL_ON, { result: 'pass', yards: lvl.yards + 9 }), me), lvl, def, DEFAULT_DRILL_OPTIONS)?.headline).toBe('COMPLETION');
  });
});

describe('tackling and kicking evaluators', () => {
  const me = { userIds: ['def:FS'] };
  const tackle = (kind: 'wrap' | 'hitStick' = 'wrap', tackler = 'def:FS'): PlayEvent => ({ type: 'tackle', tick: 120, tackler, carrier: 'off:RB', kind, assists: [] });

  it('tackle within N yards by the user succeeds; too deep, missed and touchdowns fail', () => {
    const def = getDrill('tackling');
    const n = def.levels.pro.yards;
    expect(evaluateTackle(evidence([tackle()], null, me), def.levels.pro, def, DEFAULT_DRILL_OPTIONS)).toBeNull();
    const ok = judge('tackling', evidence([tackle()], outcomeAt(BALL_ON, { yards: 3, tacklerIds: [] }), me));
    expect(ok?.success).toBe(true);
    const big = judge('tackling', evidence([tackle('hitStick')], outcomeAt(BALL_ON, { yards: 3 }), me));
    expect(big?.headline).toBe('BIG HIT');
    expect(big!.points).toBeGreaterThan(ok!.points);
    expect(judge('tackling', evidence([tackle()], outcomeAt(BALL_ON, { yards: n + 4 }), me))?.headline).toBe('TOO DEEP');
    expect(judge('tackling', evidence([tackle('wrap', 'def:MLB')], outcomeAt(BALL_ON, { yards: 3 }), me))?.headline).toBe('MISSED');
    expect(judge('tackling', evidence([], outcomeAt(BALL_ON, { yards: 70, touchdown: true }), me))?.headline).toBe('TOUCHDOWN');
    expect(judge('tackling', evidence([], outcomeAt(BALL_ON, { yards: 4, outOfBounds: true }), me))?.headline).toBe('PUSHED OUT');
  });

  it('field goals: made, missed, blocked', () => {
    const def = getDrill('fieldGoal');
    const res = (made: boolean): PlayEvent => ({ type: 'kickResult', tick: 60, kind: 'fieldGoal', made, distance: 47 });
    expect(evaluateFieldGoal(evidence([]), def.levels.pro, def, DEFAULT_DRILL_OPTIONS)).toBeNull();
    const good = judge('fieldGoal', evidence([res(true)]));
    expect(good?.success).toBe(true);
    expect(good!.points).toBeGreaterThan(100);
    expect(judge('fieldGoal', evidence([res(false)]))?.headline).toBe('NO GOOD');
    expect(judge('fieldGoal', evidence([{ type: 'kickBlocked', tick: 40, by: 'def:DT1' }]))?.headline).toBe('BLOCKED');
  });

  it('punts: distance, hang time, the called third and no touchback', () => {
    const def = getDrill('punting');
    const lvl = def.levels.pro;
    const kick: PlayEvent = { type: 'kick', tick: 90, kicker: 'off:P', kind: 'punt', power: 0.9, accuracy: 0.9 };
    const at = (gross: number, hang: number, x: number): RepMetrics => ({ hangTime: hang, landingX: x, landingY: LOS + gross });
    const mid = FIELD_WIDTH / 2;
    expect(evaluatePunt(evidence([kick]), lvl, def, DEFAULT_DRILL_OPTIONS)).toBeNull();
    const good = judge('punting', evidence([kick], null, { metrics: at(lvl.yards + 6, (lvl.hangTime ?? 0) + 0.4, mid) }));
    expect(good?.success).toBe(true);
    expect(judge('punting', evidence([kick], null, { metrics: at(lvl.yards - 5, 4.5, mid) }))?.headline).toBe('SHORT PUNT');
    expect(judge('punting', evidence([kick], null, { metrics: at(lvl.yards + 2, (lvl.hangTime ?? 0) - 0.8, mid) }))?.headline).toBe('LOW HANG TIME');
    expect(judge('punting', evidence([kick], null, { metrics: at(lvl.yards + 2, 4.5, 5) }))?.headline).toBe('WRONG SIDE');
    expect(judge('punting', evidence([kick], null, { metrics: at(lvl.yards + 2, 4.5, 5) }), { puntTarget: 'left' })?.success).toBe(true);
    expect(judge('punting', evidence([kick], null, { metrics: at(100 - BALL_ON + 5, 4.5, mid) }))?.headline).toBe('TOUCHBACK');
    const pinned = judge('punting', evidence([kick], null, { startBallOn: 45, losY: fieldY(45, 1), metrics: { hangTime: 4.4, landingX: mid, landingY: fieldY(45, 1) + 42 } }));
    expect(pinned?.headline).toBe('PINNED DEEP');
    expect(fieldThird(2, 1)).toBe('left');
    expect(fieldThird(2, -1)).toBe('right');
  });
});
