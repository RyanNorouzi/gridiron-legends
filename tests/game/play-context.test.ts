import { describe, expect, it } from 'vitest';
import { createRng } from '@/core/rng';
import { MIDDLE_X } from '@/game/types';
import { buildPlayContext, isReturnPlay, resolveOffensiveFormation, specialFor, syntheticReturnPlay, syntheticScrimmagePlay, syntheticSpecialPlay } from '@/game/play-context';
import { DEFENSE_PLAYS, makeSetup, OFFENSE_PLAYS, situation } from './fixtures';

const play = (id: string) => OFFENSE_PLAYS.find((p) => p.id === id)!;
const def = (id: string) => DEFENSE_PLAYS.find((p) => p.id === id)!;

describe('buildPlayContext', () => {
  it('captures the situation, lineups keyed by role, coaches and a forked rng', () => {
    const setup = makeSetup({ controllers: { home: 'human', away: 'ai' }, userSide: 'home' });
    const s = situation(setup, { possession: 'away', ballOn: 62, down: 3, distance: 4, ballX: 20, score: { home: 10, away: 13 }, clock: { quarter: 3, secondsRemaining: 200, running: true, playClock: 40, playClockRunning: false } });
    const ctx = buildPlayContext(s, setup, play('pass-curl'), def('cover3'), createRng(9));
    expect(ctx).toMatchObject({ down: 3, distance: 4, ballOn: 62, ballX: 20, offense: 'away', quarter: 3, clockRemaining: 200, scoreDiff: 3, special: 'none', userSide: 'home', userControl: 'defense', playIndex: 0 });
    expect(ctx.direction).toBe(s.direction);
    expect(Object.keys(ctx.offenseLineup)).toEqual(Object.keys(play('pass-curl').assignments));
    expect(Object.keys(ctx.defenseLineup)).toEqual(Object.keys(def('cover3').assignments));
    expect(ctx.offenseLineup['QB']!.teamId).toBe(setup.away.team.id);
    expect(ctx.defenseLineup['FS']!.teamId).toBe(setup.home.team.id);
    expect(ctx.crowdFactor).toBeGreaterThan(0.5);
    expect(ctx.crowdFactor).toBeLessThanOrEqual(1);
    for (const p of Object.values(ctx.offenseLineup)) expect(ctx.fatigue[p.id]).toBe(0);
    const again = buildPlayContext(s, setup, play('pass-curl'), def('cover3'), createRng(9));
    expect(again.rng.next()).toBe(ctx.rng.next());
    expect(buildPlayContext(s, setup, play('pass-curl'), def('cover3'), createRng(10)).rng.next()).not.toBe(createRng(9).next());
  });

  it('user control modes follow controllers and the offense', () => {
    const setup = makeSetup({ controllers: { home: 'human', away: 'ai' }, userSide: 'home' });
    expect(buildPlayContext(situation(setup, { possession: 'home' }), setup, play('run-inside'), def('cover3'), createRng(1)).userControl).toBe('offense');
    const watch = makeSetup({ controllers: { home: 'watch', away: 'ai' }, userSide: 'home' });
    expect(buildPlayContext(situation(watch, { possession: 'away' }), watch, play('run-inside'), def('cover3'), createRng(1)).userControl).toBe('watch');
    const none = makeSetup();
    expect(buildPlayContext(situation(none), none, play('run-inside'), def('cover3'), createRng(1)).userControl).toBe('none');
  });

  it('special-teams plays centre the ball and use the kicking team as the offense', () => {
    const setup = makeSetup();
    const s = situation(setup, { possession: 'home', kickoffPending: 'home', ballOn: 35, ballX: 12 });
    const ctx = buildPlayContext(s, setup, play('kickoff'), def('kick-return'), createRng(2));
    expect(ctx.special).toBe('kickoff');
    expect(ctx.ballX).toBe(MIDDLE_X);
    expect(ctx.offenseLineup['K']!.position).toBe('K');
    expect(ctx.defenseLineup['KR']!.id).toBe(setup.away.team.depthChart.KR[0]);
    expect(specialFor('fakePunt')).toBe('punt');
    expect(specialFor('fakeFieldGoal')).toBe('fieldGoal');
    expect(specialFor('curl')).toBe('none');
    const two = buildPlayContext(situation(setup, { possession: 'home', patPending: 'home', ballOn: 98, ballX: 12 }), setup, play('run-inside'), def('cover3'), createRng(2), {}, { special: 'twoPoint' });
    expect(two.special).toBe('twoPoint');
    expect(two.ballX).toBe(12);
    expect(two.ballOn).toBe(98);
  });

  it('uses registry formations when present, otherwise infers from roles; synthetic plays are well formed', () => {
    const setup = makeSetup();
    const reg = { offensiveFormations: { form_curl: { id: 'form_curl', name: 'x', personnel: '11' as const, qbAlignment: 'shotgun' as const, slots: [{ role: 'QB', position: 'QB' as const, x: 0, y: -5 }, { role: 'WR1', position: 'WR' as const, x: 15, y: 0, eligible: true }] } } };
    expect(resolveOffensiveFormation(play('pass-curl'), reg).slots).toHaveLength(2);
    expect(resolveOffensiveFormation(play('pass-curl'), {}).slots).toHaveLength(Object.keys(play('pass-curl').assignments).length);
    const ctx = buildPlayContext(situation(setup), setup, play('pass-curl'), def('cover3'), createRng(3), reg);
    expect(Object.keys(ctx.offenseLineup)).toEqual(['QB', 'WR1']);
    for (const c of ['kickoff', 'onside', 'punt', 'fieldGoal', 'extraPoint'] as const) {
      const p = syntheticSpecialPlay(c);
      expect(p.concept).toBe(c);
      expect(Object.keys(p.assignments).length).toBeGreaterThanOrEqual(6);
      expect(() => buildPlayContext(situation(setup), setup, p, syntheticReturnPlay(c === 'punt' ? 'punt' : 'kickoff'), createRng(4))).not.toThrow();
    }
    expect(Object.keys(syntheticScrimmagePlay().assignments)).toHaveLength(11);
    expect(isReturnPlay(syntheticReturnPlay('kickoff'))).toBe(true);
    expect(isReturnPlay(def('cover3'))).toBe(false);
  });
});
