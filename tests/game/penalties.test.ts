import { describe, expect, it } from 'vitest';
import { deadBallOutcome, makePenalty, outcomeAt } from '@/game/outcome-factory';
import { adjustKickSpot, aiShouldAccept, applyDeadBallYards, applyReturnFouls, decidePenalty, decidingTeam, enforcePenalties, extendsPeriodFoul, hasOffsettingFouls, isReturnFoul } from '@/game/rules/penalties';
import { getRuleset } from '@/game/rulesets';

const rs = getRuleset('simulation');
const st = (ballOn: number, down = 1, distance = 10) => ({ possession: 'home' as const, ballOn, down, distance, ruleset: rs });
const accepted = (p: ReturnType<typeof makePenalty>) => ({ ...p, accepted: true });

describe('enforcePenalties', () => {
  it('false start: dead-ball, previous spot, replay the down 5 yards back', () => {
    const o = deadBallOutcome(30, accepted(makePenalty('falseStart')));
    const e = enforcePenalties(st(30, 2, 7), o);
    expect(e).toMatchObject({ nullified: true, replayDown: true, ballOn: 25, down: 2, distance: 12, offsetting: false });
    expect(e.yardsBySide.offense).toBe(5);
  });

  it('keeps the series line to gain exact from a fractional spot (no half-yard chain drift)', () => {
    // 2nd & 7.2 at 30.3: the line to gain is 37.5. A false start walks back to 25.3 and it must stay 37.5.
    const o = deadBallOutcome(30.3, accepted(makePenalty('falseStart')));
    const e = enforcePenalties(st(30.3, 2, 7.2), o);
    expect(e.down).toBe(2);
    expect(e.ballOn + e.distance).toBeCloseTo(37.5, 9);
  });

  it('defensive offside on an incomplete pass: 5 yards, same down, first down if it reaches the line to gain', () => {
    const o = outcomeAt(40, { incomplete: true, result: 'incomplete', penalties: [accepted(makePenalty('offsides'))] });
    expect(enforcePenalties(st(40, 3, 8), o)).toMatchObject({ nullified: true, ballOn: 45, down: 3, distance: 3 });
    expect(enforcePenalties(st(40, 3, 4), o)).toMatchObject({ nullified: true, ballOn: 45, down: 1, distance: 10 });
  });

  it('DPI is a spot foul with an automatic first down; in the end zone the ball goes to the 1', () => {
    const o = outcomeAt(40, { incomplete: true, result: 'incomplete', penalties: [accepted(makePenalty('passInterferenceDefense', { spotBallOn: 72 }))] });
    expect(enforcePenalties(st(40, 3, 8), o)).toMatchObject({ nullified: true, ballOn: 72, down: 1, distance: 10, automaticFirstDown: true });
    const ez = outcomeAt(80, { incomplete: true, result: 'incomplete', penalties: [accepted(makePenalty('passInterferenceDefense', { spotBallOn: 104 }))] });
    expect(enforcePenalties(st(80, 2, 10), ez)).toMatchObject({ ballOn: 99, down: 1, distance: 1 });
  });

  it('offsetting fouls replay the down at the previous spot', () => {
    const pens = [accepted(makePenalty('holdingOffense')), accepted(makePenalty('offsides'))];
    expect(hasOffsettingFouls(pens)).toBe(true);
    const e = enforcePenalties(st(50, 2, 6), outcomeAt(50, { yards: 12, penalties: pens }));
    expect(e).toMatchObject({ nullified: true, offsetting: true, replayDown: true, ballOn: 50, down: 2, distance: 6 });
    expect(e.yardsBySide).toEqual({ offense: 0, defense: 0 });
  });

  it('half distance to goal caps the walk-off in both directions', () => {
    const hold = outcomeAt(4, { yards: 3, penalties: [accepted(makePenalty('holdingOffense'))] });
    expect(enforcePenalties(st(4, 1, 10), hold)).toMatchObject({ ballOn: 2, distance: 12 });
    const face = outcomeAt(96, { incomplete: true, result: 'incomplete', penalties: [accepted(makePenalty('roughingPasser'))] });
    expect(enforcePenalties(st(96, 1, 4), face)).toMatchObject({ ballOn: 98, down: 1, distance: 2, automaticFirstDown: true });
  });

  it('loss of down fouls advance the down; on fourth down that is a turnover on downs', () => {
    const ground = outcomeAt(40, { incomplete: true, result: 'incomplete', penalties: [accepted(makePenalty('intentionalGrounding', { spotBallOn: 33 }))] });
    expect(enforcePenalties(st(40, 2, 10), ground)).toMatchObject({ ballOn: 23, down: 3, distance: 27, lossOfDown: true });
    expect(enforcePenalties(st(40, 4, 10), ground)).toMatchObject({ turnoverOnDowns: true, ballOn: 23 });
  });

  it('reports a first down only when the enforcement produces a new series', () => {
    const offside = outcomeAt(40, { incomplete: true, result: 'incomplete', penalties: [accepted(makePenalty('offsides'))] });
    expect(enforcePenalties(st(40, 1, 10), offside).firstDown).toBe(false);
    expect(enforcePenalties(st(40, 3, 4), offside).firstDown).toBe(true);
    const auto = outcomeAt(40, { incomplete: true, result: 'incomplete', penalties: [accepted(makePenalty('roughingPasser'))] });
    expect(enforcePenalties(st(40, 1, 10), auto).firstDown).toBe(true);
    const hold = outcomeAt(40, { yards: 3, penalties: [accepted(makePenalty('holdingOffense'))] });
    expect(enforcePenalties(st(40, 1, 10), hold).firstDown).toBe(false);
    const walked = applyDeadBallYards({ possession: 'home', ballOn: 55, down: 2, distance: 4 }, 'away', makePenalty('unsportsmanlike', { side: 'defense' }));
    expect(walked.firstDown).toBe(true);
    expect(walked.spot).not.toHaveProperty('goalToGo');
    expect(extendsPeriodFoul(accepted(makePenalty('offsides')))).toBe(true);
    expect(extendsPeriodFoul(accepted(makePenalty('facemask')))).toBe(true);
    expect(extendsPeriodFoul(accepted(makePenalty('unsportsmanlike', { side: 'defense' })))).toBe(false);
    expect(extendsPeriodFoul(accepted(makePenalty('holdingOffense')))).toBe(false);
    expect(extendsPeriodFoul(makePenalty('offsides'))).toBe(false);
  });

  it('declined penalties leave the play untouched', () => {
    const o = outcomeAt(40, { yards: 20, penalties: [makePenalty('offsides')] });
    expect(enforcePenalties(st(40), o)).toMatchObject({ nullified: false, ballOn: 40, accepted: [] });
  });

  it('dead-ball fouls after the play are reported for post-result enforcement and walked from the new spot', () => {
    const o = outcomeAt(40, { yards: 15, firstDown: true, penalties: [accepted(makePenalty('unsportsmanlike', { side: 'defense' }))] });
    const e = enforcePenalties(st(40), o);
    expect(e.nullified).toBe(false);
    expect(e.postPlay).toHaveLength(1);
    const walked = applyDeadBallYards({ possession: 'home', ballOn: 55, down: 1, distance: 10 }, 'away', e.postPlay[0]!);
    expect(walked.spot).toMatchObject({ ballOn: 70, down: 1, distance: 10 });
    const ownFoul = applyDeadBallYards({ possession: 'home', ballOn: 55, down: 2, distance: 4 }, 'home', makePenalty('taunting'));
    expect(ownFoul.spot).toMatchObject({ ballOn: 40, down: 2, distance: 19 });
    const reach = applyDeadBallYards({ possession: 'home', ballOn: 55, down: 3, distance: 4 }, 'away', makePenalty('unsportsmanlike', { side: 'defense', automaticFirstDown: false }));
    expect(reach.spot).toMatchObject({ ballOn: 70, down: 1, distance: 10 });
    expect(adjustKickSpot(35, true, 15)).toBe(20);
    expect(adjustKickSpot(35, false, 15)).toBe(50);
  });

  it('a nullifying foul plus a dead-ball foul on the same play stack from the enforcement spot', () => {
    const o = outcomeAt(50, { yards: 8, penalties: [accepted(makePenalty('holdingOffense')), accepted(makePenalty('unsportsmanlike', { side: 'defense' }))] });
    const e = enforcePenalties(st(50, 1, 10), o);
    expect(e).toMatchObject({ nullified: true, ballOn: 55, down: 1, distance: 5, postPlay: [] });
  });
});

describe('decidePenalty / aiShouldAccept', () => {
  it('the offended side decides; the AI accepts when the enforcement beats the live result', () => {
    const offside = makePenalty('offsides');
    expect(decidingTeam(st(40), offside)).toBe('home');
    const badPlay = outcomeAt(40, { yards: -3, penalties: [offside] });
    expect(aiShouldAccept(st(40, 2, 10), badPlay, offside)).toBe(true);
    const bigGain = outcomeAt(40, { yards: 25, firstDown: true, penalties: [offside] });
    expect(aiShouldAccept(st(40, 2, 10), bigGain, offside)).toBe(false);
    const decided = decidePenalty(st(40, 2, 10), bigGain, () => true);
    expect(decided.pending).toBeNull();
    expect(decided.outcome.penalties[0]!.accepted).toBe(true);
    expect(bigGain.penalties[0]!.accepted).toBe(false);
  });

  it('declining a defensive penalty on a touchdown keeps the score', () => {
    const p = makePenalty('holdingDefense');
    const td = outcomeAt(60, { touchdown: true, penalties: [p] });
    expect(aiShouldAccept(st(60, 1, 10), td, p)).toBe(false);
  });

  it('dead-ball and offsetting fouls are decided automatically; humans suspend on the rest', () => {
    const r = decidePenalty(st(40), deadBallOutcome(40, makePenalty('falseStart')), () => null);
    expect(r.pending).toBeNull();
    expect(r.outcome.penalties[0]!.accepted).toBe(true);
    const offsetting = outcomeAt(40, { penalties: [makePenalty('holdingOffense'), makePenalty('offsides')] });
    expect(decidePenalty(st(40), offsetting, () => null).outcome.penalties.every((p) => p.accepted)).toBe(true);
    const live = outcomeAt(40, { yards: 2, penalties: [makePenalty('offsides')] });
    const suspended = decidePenalty(st(40, 3, 6), live, () => null);
    expect(suspended.pending).toEqual({ index: 0, side: 'home' });
    const resumed = decidePenalty(st(40, 3, 6), live, () => null, 'none', [false]);
    expect(resumed.pending).toBeNull();
    expect(resumed.outcome.penalties[0]!.accepted).toBe(false);
  });

  it('passes the value context so a decider can reason about it', () => {
    const p = makePenalty('offsides');
    const o = outcomeAt(40, { yards: -4, penalties: [p] });
    let seen: number[] = [];
    decidePenalty(st(40, 2, 10), o, (_pen, ctx) => { seen = [ctx.valueIfAccepted, ctx.valueIfDeclined]; return ctx.decidingSide === 'home'; });
    expect(seen[0]).toBeGreaterThan(seen[1]!);
  });
});

describe('kick plays (H2-06 / H2-07)', () => {
  it('a punt is a scrimmage down: a false start moves the line to gain with the ball (4th & 1 -> 4th & 6)', () => {
    const o = deadBallOutcome(31.1, accepted(makePenalty('falseStart')));
    expect(enforcePenalties(st(31.1, 4, 1), o, 'punt')).toMatchObject({ nullified: true, ballOn: 26.1, down: 4, distance: 6, firstDown: false });
    // Punting-team holding: 10 back, still fourth down.
    const hold = outcomeAt(30, { result: 'punt', penalties: [accepted(makePenalty('holdingOffense'))] });
    expect(enforcePenalties(st(30, 4, 3.5), hold, 'punt')).toMatchObject({ ballOn: 20, down: 4, distance: 13.5 });
  });

  it('a defensive foul on a punt that reaches the line to gain is a first down; roughing the kicker always is', () => {
    const offside = outcomeAt(40, { result: 'punt', penalties: [accepted(makePenalty('offsides'))] });
    expect(enforcePenalties(st(40, 4, 3), offside, 'punt')).toMatchObject({ ballOn: 45, down: 1, distance: 10, firstDown: true });
    expect(enforcePenalties(st(40, 4, 8), offside, 'punt')).toMatchObject({ ballOn: 45, down: 4, distance: 3, firstDown: false });
    const rough = outcomeAt(40, { result: 'punt', penalties: [accepted(makePenalty('roughingKicker'))] });
    expect(enforcePenalties(st(40, 4, 12), rough, 'punt')).toMatchObject({ ballOn: 55, down: 1, distance: 10, automaticFirstDown: true });
  });

  it('kickoff fouls still re-kick (no down and distance on a free kick)', () => {
    const o = deadBallOutcome(35, accepted(makePenalty('offsideFreeKick')));
    expect(enforcePenalties(st(35), o, 'kickoff')).toMatchObject({ nullified: true, replayDown: true, ballOn: 30 });
  });

  it('holding by the return team is a return foul: the kick stands, the receivers go back 10 from the foul spot', () => {
    const hold = makePenalty('holdingOffense', { side: 'defense', yards: 10, enforcement: 'spotOfFoul', spotBallOn: 75, automaticFirstDown: false, replayDown: false });
    expect(isReturnFoul(hold, 'kickoff')).toBe(true);
    expect(isReturnFoul(hold, 'punt')).toBe(true);
    expect(isReturnFoul(hold, 'none')).toBe(false);
    // Kickoff from the 35 returned to the kicking team's 45 (+55 from the receivers' 0); the hold was at the receivers' 25.
    const ret = outcomeAt(35, { result: 'kickoff', endBallOn: 45, returnYards: 55, penalties: [accepted(hold)] });
    const e = enforcePenalties(st(35), ret, 'kickoff');
    expect(e.nullified).toBe(false);
    expect(e.replayDown).toBe(false);
    const r = applyReturnFouls(ret, 'kickoff', 25);
    expect(r.outcome.endBallOn).toBe(85);
    expect(r.yards).toBe(10);
    // A hold beyond the end of the run is enforced from the end of the run.
    const late = applyReturnFouls({ ...ret, penalties: [accepted({ ...hold, spotBallOn: 30 })] }, 'kickoff', 25);
    expect(late.outcome.endBallOn).toBe(55);
    // A return touchdown with the hold behind it comes back.
    const td = outcomeAt(35, { result: 'kickoff', touchdown: true, endBallOn: 0, returnYards: 100, penalties: [accepted(hold)] });
    const back = applyReturnFouls(td, 'kickoff', 25);
    expect(back.outcome.touchdown).toBe(false);
    expect(back.outcome.endBallOn).toBe(85);
    // Declined (not accepted): nothing moves.
    const declined = { ...ret, penalties: [hold] };
    expect(applyReturnFouls(declined, 'kickoff', 25)).toEqual({ outcome: declined, yards: 0 });
  });

  it('the kicking team accepts a return hold that erases a long return', () => {
    const hold = makePenalty('holdingOffense', { side: 'defense', yards: 10, enforcement: 'spotOfFoul', spotBallOn: 75, automaticFirstDown: false, replayDown: false });
    const ret = outcomeAt(35, { result: 'kickoff', endBallOn: 45, returnYards: 55, penalties: [hold] });
    expect(aiShouldAccept(st(35), ret, hold, 'kickoff')).toBe(true);
  });
});
