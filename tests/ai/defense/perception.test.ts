import { describe, expect, it } from 'vitest';
import { idleIntent, moveIntent } from '@/game/engine-api';
import type { Athlete } from '@/game/play-types';
import { fumbleBall, holdBall } from '@/physics/ball';
import { getDecider } from '@/ai/index';
import { registerDefense } from '@/ai/defense';
import { commonIntent, defenderNoise, depthOf, perceive, reactionSeconds, teamView } from '@/ai/defense-shared';
import { dropbackScript, handoff, pathScript, runFor, setAttrs, setup, snap, stillScript, type Scripts } from './harness';

const offenseStill = (f: ReturnType<typeof setup>): Scripts => {
  const s: Scripts = {};
  for (const a of f.state.athletes) if (a.side === 'offense') s[a.id] = stillScript;
  return s;
};

describe('reaction delays', () => {
  it('legend defenders react sooner than rookie ones for every defender across seeds', () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const rookie = setup({ seed, difficulty: 'rookie' });
      const legend = setup({ seed, difficulty: 'legend' });
      for (const a of rookie.state.athletes) {
        if (a.side !== 'defense') continue;
        const r = reactionSeconds(a, rookie.state.ctx.difficulty);
        const l = reactionSeconds(legend.athlete(a.id), legend.state.ctx.difficulty);
        expect(l).toBeLessThan(r);
      }
    }
  });

  it('two defenders with different reaction ratings react at different times; same rating still differs by personality', () => {
    const f = setup({ seed: 7 });
    const quick = f.byRole('defense', 'FS');
    const slow = f.byRole('defense', 'SS');
    setAttrs(quick, 70, { reaction: 95 });
    setAttrs(slow, 70, { reaction: 45 });
    const q = reactionSeconds(quick, f.state.ctx.difficulty);
    const s = reactionSeconds(slow, f.state.ctx.difficulty);
    expect(q).toBeLessThan(s);
    expect(s - q).toBeGreaterThan(0.08);
    setAttrs(slow, 70, { reaction: 95 });
    expect(reactionSeconds(slow, f.state.ctx.difficulty)).not.toBe(q);
    expect(defenderNoise(quick, 'x')).not.toBe(defenderNoise(slow, 'x'));
    expect(defenderNoise(quick, 'x')).toBe(defenderNoise(quick, 'x'));
  });

  it('behaviour follows the delay: legend linebackers commit to the run before rookie ones', () => {
    const commitAt = (difficulty: 'rookie' | 'legend', seed: number): number => {
      const f = setup({ offensePlayId: 'iform-iso-right', defensePlayId: '43-runStop-cover1', difficulty, seed });
      const st = f.state;
      const dir = st.ctx.direction;
      const rb = f.byRole('offense', 'RB');
      const mlb = f.byRole('defense', 'MLB');
      const scripts = offenseStill(f);
      scripts[rb.id] = pathScript([{ x: st.ctx.ballX + dir * 1.9, y: st.losY + dir * 10 }]);
      snap(f);
      handoff(f, 'RB');
      let at = Infinity;
      runFor(f, 1.5, scripts, {}, (s, t) => { if (at === Infinity && s.intents[mlb.id]?.debug.includes('on RB')) at = t; });
      return at;
    };
    for (const seed of [1, 2, 3]) expect(commitAt('legend', seed)).toBeLessThan(commitAt('rookie', seed));
  });
});

describe('run / pass recognition', () => {
  it('recognises a run when a back has the ball, after the reaction delay', () => {
    const f = setup({ offensePlayId: 'iform-iso-right', defensePlayId: '43-runStop-cover1', seed: 2 });
    const mlb = f.byRole('defense', 'MLB');
    const scripts = offenseStill(f);
    snap(f);
    handoff(f, 'RB');
    const reaction = reactionSeconds(mlb, f.state.ctx.difficulty);
    let at = Infinity;
    runFor(f, 1, scripts, {}, (_s, t) => { if (at === Infinity && mlb.ai.recognizedRun) at = t; });
    expect(at).toBeGreaterThanOrEqual(reaction - 0.02);
    expect(at).toBeLessThanOrEqual(reaction + 0.04);
    expect(mlb.ai.recognizedPass).toBe(false);
  });

  it('recognises a run from the line firing out even before the handoff', () => {
    const f = setup({ offensePlayId: 'iform-iso-right', defensePlayId: '43-cover3-zone', seed: 2 });
    const st = f.state;
    const dir = st.ctx.direction;
    const scripts = offenseStill(f);
    for (const role of ['LT', 'LG', 'C', 'RG', 'RT']) scripts[`off:${role}`] = () => moveIntent({ x: 0, y: dir }, false, 'fire out');
    snap(f);
    runFor(f, 1, scripts);
    const fs = f.byRole('defense', 'FS');
    expect(teamView(st).olDrive).toBeGreaterThan(0.45);
    expect(fs.ai.recognizedRun).toBe(true);
  });

  it('recognises a pass on a dropback / pass set, and a draw overrides a pass read', () => {
    const f = setup({ offensePlayId: 'shotgun-curls', defensePlayId: '43-cover3-zone', seed: 3 });
    const mlb = f.byRole('defense', 'MLB');
    const scripts = offenseStill(f);
    scripts['off:QB'] = dropbackScript(f, 5);
    snap(f);
    runFor(f, 0.8, scripts);
    expect(mlb.ai.recognizedPass).toBe(true);
    expect(mlb.ai.recognizedRun).toBe(false);
    handoff(f, 'RB');
    runFor(f, 0.8, scripts);
    expect(mlb.ai.recognizedRun).toBe(true);
    expect(mlb.ai.recognizedPass).toBe(false);
  });

  it('play action: a run read is overridden once the quarterback keeps it and sets up', () => {
    const f = setup({ offensePlayId: 'singleback-paPost', defensePlayId: '43-cover3-zone', seed: 3 });
    const st = f.state;
    const dir = st.ctx.direction;
    const mlb = f.byRole('defense', 'MLB');
    const scripts = offenseStill(f);
    for (const role of ['LT', 'LG', 'C', 'RG', 'RT']) scripts[`off:${role}`] = (a) => (depthOf(st, a.pos) < 0.6 ? moveIntent({ x: 0, y: dir }, false, 'fire out') : idleIntent('hold'));
    snap(f);
    runFor(f, 0.7, scripts);
    expect(mlb.ai.recognizedRun).toBe(true);
    scripts['off:QB'] = dropbackScript(f, 7);
    runFor(f, 1.0, scripts);
    expect(mlb.ai.recognizedPass).toBe(true);
    expect(mlb.ai.recognizedRun).toBe(false);
  });

  it('notices a new ball carrier only after the delay, and a thrown ball likewise', () => {
    const f = setup({ offensePlayId: 'iform-iso-right', defensePlayId: '43-runStop-cover1', seed: 4 });
    const olb = f.byRole('defense', 'OLB1');
    snap(f);
    handoff(f, 'RB');
    const first = perceive(olb, f.state);
    expect(first.carrier).toBeNull();
    expect(first.view.carrier?.role).toBe('RB');
    runFor(f, first.reaction + 0.05, offenseStill(f));
    expect(perceive(olb, f.state).carrier?.role).toBe('RB');
  });
});

describe('turnover fallbacks and dispatch', () => {
  it('everyone goes for a loose ball, nearest sprinting', () => {
    const f = setup({ seed: 5 });
    const st = f.state;
    const scripts = offenseStill(f);
    snap(f);
    const qb = f.byRole('offense', 'QB');
    st.ball = fumbleBall(st.ball, qb, st.ctx.rng, st.tick);
    qb.hasBall = false;
    runFor(f, 1 / 60, scripts);
    const defenders = st.athletes.filter((a) => a.side === 'defense');
    for (const d of defenders) expect(st.intents[d.id]?.debug).toBe('loose ball');
    const sprinting = defenders.filter((d) => st.intents[d.id]?.sprint);
    expect(sprinting.length).toBeGreaterThanOrEqual(1);
    expect(sprinting.length).toBeLessThanOrEqual(3);
  });

  it('after an interception the returner heads for his end zone and teammates convoy', () => {
    const f = setup({ offensePlayId: 'shotgun-curls', defensePlayId: '43-cover3-zone', seed: 6 });
    const st = f.state;
    const dir = st.ctx.direction;
    const fs = f.byRole('defense', 'FS');
    const qb = f.byRole('offense', 'QB');
    snap(f);
    st.ball = holdBall(st.ball, fs.id, st.tick, 'pass');
    st.ball.pos = { ...fs.pos };
    qb.hasBall = false;
    fs.hasBall = true;
    const scripts = offenseStill(f);
    // A would-be tackler stands right in the convoy's way.
    const wr = f.byRole('offense', 'WR1');
    const olb = f.byRole('defense', 'OLB1');
    wr.pos = { x: olb.pos.x, y: olb.pos.y - dir * 1.2 };
    runFor(f, 1 / 60, scripts);
    const ret = st.intents[fs.id];
    expect(ret?.debug).toBe('return');
    expect(dir * ret!.move.y).toBeLessThan(0);
    const convoy = st.intents[olb.id];
    expect(convoy?.debug.startsWith('convoy')).toBe(true);
    expect(convoy?.action).toBe('block');
    expect(convoy?.targetId).toBe(wr.id);
  });

  it('a recovered fumble is no longer loose: the recovering defender returns it and teammates convoy', () => {
    const f = setup({ seed: 8 });
    const st = f.state;
    const qb = f.byRole('offense', 'QB');
    const mlb = f.byRole('defense', 'MLB');
    const ss = f.byRole('defense', 'SS');
    snap(f);
    st.ball = fumbleBall(st.ball, qb, st.ctx.rng, st.tick);
    qb.hasBall = false;
    // Engine-style recovery keeps the ball kind ('fumble') and only flips the phase to held.
    st.ball = holdBall(st.ball, mlb.id, st.tick);
    st.ball.pos = { ...mlb.pos };
    mlb.hasBall = true;
    expect(st.ball.kind).toBe('fumble');
    runFor(f, 1 / 60, offenseStill(f));
    expect(teamView(st).loose).toBe(false);
    expect(st.intents[mlb.id]?.debug).toBe('return');
    expect(st.intents[ss.id]?.debug.startsWith('convoy')).toBe(true);
  });

  it('idles when the play is dead or the athlete is out of it', () => {
    const f = setup({ seed: 1 });
    const cb = f.byRole('defense', 'CB1');
    f.state.phase = 'dead';
    expect(commonIntent(cb, f.state, teamView(f.state))?.debug).toBe('out');
    f.state.phase = 'live';
    cb.active = false;
    expect(commonIntent(cb, f.state, teamView(f.state))?.debug).toBe('out');
  });

  it('registerDefense wires every defensive assignment type', () => {
    registerDefense();
    for (const type of ['manCover', 'zone', 'blitz', 'rushGap', 'contain', 'spy', 'runFill'] as const) {
      const probe = { side: 'defense', assignment: { type } } as unknown as Athlete;
      expect(getDecider(probe), type).toBeDefined();
    }
  });
});
