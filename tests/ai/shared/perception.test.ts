import { describe, expect, it } from 'vitest';
import { secondsToTicks } from '@/core/time';
import { getDifficulty } from '@/game/rulesets';
import { anticipation, kickLaunched, perceive, recognisePlay, seesThroughFake, timeSinceSnap } from '@/ai/perception';
import { reactionDelay } from '@/ai/variance';
import { buildPlayState } from '../../fixtures/play-state';
import { advance, giveBall, goLive, place } from './helpers';

const runPlay = (difficulty: 'rookie' | 'pro' | 'legend', seed = 3) =>
  buildPlayState({ seed, difficulty, offensePlayId: 'shotgun-insideZone-left', defensePlayId: '43-cover3-zone' });

/** Ticks until the MLB flags the play as a run after the handoff. */
const ticksToRecognise = (difficulty: 'rookie' | 'pro' | 'legend', reaction: number): number => {
  const f = runPlay(difficulty);
  goLive(f.state);
  const mlb = f.byRole('defense', 'MLB');
  mlb.attrs.reaction = reaction;
  mlb.attrs.awareness = 70;
  // Before the handoff nothing is known.
  for (let i = 0; i < 20; i++) { perceive(mlb, f.state); advance(f.state, 1); }
  expect(mlb.ai.recognizedRun).toBe(false);
  expect(mlb.ai.recognizedPass).toBe(false);
  giveBall(f.state, 'off:RB');
  let ticks = 0;
  while (!mlb.ai.recognizedRun && ticks < 200) { perceive(mlb, f.state); advance(f.state, 1); ticks++; }
  return ticks;
};

describe('perception', () => {
  it('recognises a run once the carrier takes the handoff, after the reaction delay', () => {
    const f = runPlay('pro');
    goLive(f.state);
    const mlb = f.byRole('defense', 'MLB');
    mlb.attrs.reaction = 70;
    const delay = reactionDelay(mlb, f.state.ctx.difficulty);
    const ticks = ticksToRecognise('pro', 70);
    expect(ticks).toBeGreaterThan(1);
    expect(Math.abs(ticks - secondsToTicks(delay))).toBeLessThanOrEqual(2);
  });

  it('legend AI and quick-reaction defenders read the handoff earlier than rookie AI and slow ones', () => {
    expect(ticksToRecognise('rookie', 60)).toBeGreaterThan(ticksToRecognise('legend', 60));
    expect(ticksToRecognise('pro', 25)).toBeGreaterThan(ticksToRecognise('pro', 95));
  });

  it('a throw is a strong pass key and flips a run read', () => {
    const f = runPlay('pro');
    goLive(f.state);
    const cb = f.byRole('defense', 'CB1');
    giveBall(f.state, 'off:RB');
    for (let i = 0; i < 90; i++) { perceive(cb, f.state); advance(f.state, 1); }
    expect(cb.ai.recognizedRun).toBe(true);
    f.state.ball.phase = 'inAir';
    f.state.ball.kind = 'pass';
    f.state.ball.carrierId = null;
    f.state.ball.z = 3;
    f.state.ball.vz = 4;
    f.state.ball.vel = { x: 0, y: 15 };
    for (let i = 0; i < 90; i++) { perceive(cb, f.state); advance(f.state, 1); }
    expect(cb.ai.recognizedPass).toBe(true);
    expect(cb.ai.recognizedRun).toBe(false);
    const p = perceive(cb, f.state);
    expect(p.ballInAir).toBe(true);
    expect(p.ballLanding).not.toBeNull();
    expect(p.ballLanding?.pos.y).toBeGreaterThan(f.state.ball.pos.y);
  });

  it('offensive athletes know their own play immediately', () => {
    const f = runPlay('pro');
    goLive(f.state);
    const rb = f.byRole('offense', 'RB');
    recognisePlay(rb, f.state);
    expect(rb.ai.recognizedRun).toBe(true);
    const pass = buildPlayState({ seed: 4 });
    goLive(pass.state);
    const wr = pass.byRole('offense', 'WR1');
    recognisePlay(wr, pass.state);
    expect(wr.ai.recognizedPass).toBe(true);
  });

  it('a play-action fake plants a false run key unless the defender sees through it', () => {
    const f = buildPlayState({ seed: 5, difficulty: 'pro', offensePlayId: 'singleback-paPost', defensePlayId: '43-cover3-zone' });
    goLive(f.state);
    const fooled = f.byRole('defense', 'MLB');
    const sharp = f.byRole('defense', 'FS');
    fooled.attrs.awareness = 10;
    sharp.attrs.awareness = 99;
    expect(seesThroughFake(fooled, f.state.ctx.difficulty)).toBe(false);
    expect(seesThroughFake(sharp, getDifficulty('legend'))).toBe(true);
    f.state.events.push({ type: 'playActionFake', tick: 0, qb: 'off:QB', to: 'off:RB' });
    for (let i = 0; i < 40; i++) { perceive(fooled, f.state); perceive(sharp, f.state); advance(f.state, 1); }
    expect(fooled.ai.recognizedRun).toBe(true);
    expect(sharp.ai.recognizedRun).toBe(false);
  });

  it('aware defenders read the subtle line keys, unaware ones do not', () => {
    const f = runPlay('legend');
    goLive(f.state);
    for (const a of f.state.athletes) if (a.side === 'offense' && (a.position === 'OT' || a.position === 'OG' || a.position === 'C')) a.vel = { x: 0, y: 2 };
    const aware = f.byRole('defense', 'OLB1');
    const dull = f.byRole('defense', 'OLB2');
    aware.attrs.awareness = 95;
    dull.attrs.awareness = 5;
    for (let i = 0; i < 60; i++) { perceive(aware, f.state); perceive(dull, f.state); advance(f.state, 1); }
    expect(aware.ai.recognizedRun).toBe(true);
    expect(dull.ai.recognizedRun).toBe(false);
  });

  it('reports threats, nearest opponent and anticipation from difficulty and awareness', () => {
    const f = runPlay('pro');
    goLive(f.state);
    const cb = f.byRole('defense', 'CB1');
    const wr = f.byRole('offense', 'WR1');
    place(f.state, wr, cb.pos.x + 2, cb.pos.y);
    const p = perceive(cb, f.state);
    expect(p.nearestOpponent?.id).toBe(wr.id);
    expect(p.threats[0]?.id).toBe(wr.id);
    expect(p.nearestTeammate).not.toBeNull();
    expect(p.timeSinceSnap).toBe(timeSinceSnap(f.state));
    cb.attrs.awareness = 99;
    expect(anticipation(cb, getDifficulty('legend'))).toBeGreaterThan(anticipation(cb, getDifficulty('rookie')));
    cb.attrs.awareness = 10;
    expect(anticipation(cb, getDifficulty('legend'))).toBeLessThan(anticipation({ ...cb, attrs: { ...cb.attrs, awareness: 99 } }, getDifficulty('legend')));
    expect(kickLaunched(f.state)).toBe(false);
  });

  it('a kick that is muffed or fumbled on the return stays launched (the coverage keeps covering)', () => {
    const f = runPlay('pro');
    goLive(f.state);
    const returner = f.state.athletes.find((a) => a.side === 'defense')!;
    giveBall(f.state, returner.id, 'fumble');
    // A fumble on a play with no kick is not a kick.
    expect(kickLaunched(f.state)).toBe(false);
    f.state.events.push({ type: 'kick', tick: f.state.tick, kicker: 'off:K', kind: 'kickoff', power: 0.8, accuracy: 0.5 });
    expect(kickLaunched(f.state)).toBe(true);
    f.state.ball.phase = 'loose';
    expect(kickLaunched(f.state)).toBe(true);
    // Recovered: the returner holds it again (a recovery re-holds the ball as a handoff).
    giveBall(f.state, returner.id, 'handoff');
    expect(kickLaunched(f.state)).toBe(true);
  });
});
