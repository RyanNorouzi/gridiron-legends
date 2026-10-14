/**
 * The pocket against pressure through the real PlayEngine: blitzes the protection can block (a back checks and picks
 * up the extra man) against the ones it cannot (the unblocked blitzer is the only fast sack), stunts handed off, a
 * play-action line that protects after the fake, and a human quarterback who does nothing but snap it (the automatic
 * drop) protected like an AI passer.
 */
import { describe, expect, it } from 'vitest';
import { twistFor } from '@/ai/pass-rush';
import { USER_DROP_DONE_KEY } from '@/ai/blocking-pass';
import { dropbackDepth } from '@/ai/qb';
import { routeAlignment, timeSinceSnap, toLocal } from '@/ai/route-running';
import { vec2 } from '@/core/vec2';
import { createPlayEngine } from '@/game/play-engine';
import { AUTO_DROP_OVERRIDE, autoDrop } from '@/game/user-control';
import { buildCtx, createMeasureEnv } from '../../integration/measure';
import { measurePocket, neutralInput, summarize, type PocketSnap } from './pocket-harness';

const env = createMeasureEnv(2026);
const DROPS = ['shotgun-mesh', 'singleback-curlFlat', 'shotgun-goRoutes'];
const FOUR_MAN = ['43-cover3-zone', '43-cover2-zone', '43-cover4-zone', 'nickel-cover3-match', '43-cover1-man'];

const snaps = (offs: readonly string[], defs: readonly string[], seeds: number, tag: string, humanQb = false): PocketSnap[] => {
  const out: PocketSnap[] = [];
  for (const off of offs) for (const def of defs) for (let v = 0; v < seeds; v++) {
    out.push(measurePocket(env, { off, def, seed: `${tag}:${v}`, teamIndex: v % 8, humanQb }));
  }
  return out;
};

describe('blitz protection', () => {
  it('blocks a five-man pressure: the back checks, stays in and picks up the extra man, but it gets home sooner', () => {
    const five = snaps(DROPS, ['43-cover3-edgeBlitz', 'nickel-cover0-cbBlitz', '43-cover1-safetyBlitz'], 3, 'five');
    const s = summarize(five.map((x) => x.sack));
    // More pressure (the owner's request): a stretched protection (no spare, every man on an island) breaks around
    // 3 s, a second before the four-man rush's ~4 s, and not the unblocked blitzer's ~2 s.
    expect(s.median).toBeGreaterThanOrEqual(2.5);
    expect(s.median).toBeLessThanOrEqual(3.4);
    expect(five.filter((x) => x.sack < 2).length).toBe(0);
    // A late safety or corner off the edge, and a linebacker who only steps up in coverage, must not pull the back
    // away from the real blitzer (was 4 of 27 unblocked).
    expect(five.filter((x) => x.unblocked).length / five.length).toBeLessThan(0.08);
  });

  it('blocks a five-man edge blitz: a guard cannot kick out to the edge, so the checking back takes the edge man', () => {
    const offs = [...DROPS, 'shotgun-curls', 'trips-outs', 'shotgun-deepCross'];
    const edge = snaps(offs, ['43-cover3-edgeBlitz'], 4, 'edgeBlitz');
    // Five rushers against five linemen and a back: nobody should come clean (was 7 of 24 at ~2.5 s); the stretched
    // protection holds a little under 3 s before the first man gets his hands on the passer.
    expect(edge.filter((x) => x.unblocked).length).toBeLessThanOrEqual(1);
    const contact = summarize(edge.map((x) => x.contact)).median;
    expect(contact).toBeGreaterThanOrEqual(2.3);
    expect(contact).toBeLessThanOrEqual(3.3);
  });

  it('the blitz gets home earliest: a four-man rush sacks a holding passer in ~4 s, one extra rusher takes ~a second off', () => {
    const four = summarize(snaps(DROPS, FOUR_MAN, 3, 'rushCount').map((x) => x.sack));
    const five = summarize(snaps(DROPS, ['43-cover1-doubleAGap', '425-cover1-nickelBlitz', '34-cover1-edge'], 3, 'rushCount').map((x) => x.sack));
    const six = summarize(snaps(DROPS, ['43-cover0-lbBlitz', '34-cover0-allOut'], 3, 'rushCount').map((x) => x.sack));
    expect(four.median).toBeGreaterThanOrEqual(3.5);
    expect(four.median).toBeLessThanOrEqual(4.5);
    expect(five.median).toBeGreaterThanOrEqual(2.5);
    expect(five.median).toBeLessThanOrEqual(3.4);
    expect(four.median - five.median).toBeGreaterThanOrEqual(0.7);
    expect(six.median).toBeGreaterThanOrEqual(2);
    expect(six.median).toBeLessThanOrEqual(2.9);
    expect(six.median).toBeLessThan(five.median);
  });

  it('an all-out blitz with more rushers than blockers gets home fast, and only through the unblocked man', () => {
    const all = snaps(DROPS, ['34-cover0-allOut'], 4, 'allout');
    const s = summarize(all.map((x) => x.contact));
    expect(s.median).toBeGreaterThanOrEqual(1.6);
    expect(s.median).toBeLessThanOrEqual(3.2);
    const fast = all.filter((x) => x.contact < 3);
    expect(fast.length).toBeGreaterThan(0);
    expect(fast.filter((x) => x.unblocked).length / fast.length).toBeGreaterThan(0.8);
  });

  it('a releasing back picks up a blitzer the line leaves free and stays on him', () => {
    let pickedUp = 0;
    for (let v = 0; v < 6; v++) {
      const ctx = buildCtx(env, { off: 'shotgun-mesh', def: 'nickel-cover0-cbBlitz', teamIndex: v % 8, seed: `pickup:${v}` });
      const play = createPlayEngine(ctx, { registries: env.registries });
      let engaged = false;
      try {
        play.run((s) => {
          const rb = s.athletes.find((a) => a.role === 'RB');
          const on = rb?.engagedWith ? s.athletes.find((a) => a.id === rb.engagedWith) : null;
          if (on && on.assignment.type === 'blitz') engaged = true;
          return {};
        });
      } catch {
        // Tick cap: irrelevant here.
      }
      if (engaged) pickedUp += 1;
    }
    expect(pickedUp).toBeGreaterThanOrEqual(3);
  });
});

describe('stunts and play action', () => {
  it('passes off tackle-end twists: no looper runs free', () => {
    const offs = [...DROPS, 'shotgun-curls', 'trips-outs'];
    let twists = 0;
    let freeOnTwist = 0;
    for (const off of offs) for (const def of FOUR_MAN) for (let v = 0; v < 3; v++) {
      const ctx = buildCtx(env, { off, def, teamIndex: v % 8, seed: `twist:${v}` });
      const probe = createPlayEngine(ctx, { registries: env.registries });
      const twisted = probe.state.athletes.some((a) => a.side === 'defense' && twistFor(a, probe.state) !== null);
      if (!twisted) continue;
      twists += 1;
      if (measurePocket(env, { off, def, seed: `twist:${v}`, teamIndex: v % 8 }).unblocked) freeOnTwist += 1;
    }
    expect(twists).toBeGreaterThanOrEqual(3);
    expect(freeOnTwist).toBe(0);
  });

  it('a play-action line sells the run, then protects the passer as long as a dropback pocket', () => {
    const pa = snaps(['iform-paBoot-right', 'singleback-paPost', 'pistol-paSeams'], ['43-cover3-zone', '43-cover2-zone', '43-cover1-man'], 3, 'pa');
    const s = summarize(pa.map((x) => x.sack));
    expect(s.median).toBeGreaterThanOrEqual(3.5);
    expect(pa.filter((x) => x.unblocked).length).toBe(0);
  });
});

describe('a human quarterback is protected like an AI passer', () => {
  it('drops back on his own when the user does nothing, and feels the four-man rush around 3-3.5 s, not at the snap', () => {
    const human = snaps(DROPS, FOUR_MAN, 3, 'human', true);
    const s = summarize(human.map((x) => x.contact));
    expect(s.median).toBeGreaterThanOrEqual(2.8);
    expect(s.median).toBeLessThanOrEqual(4.2);
    expect(human.filter((x) => x.contact < 1.8).length / human.length).toBeLessThan(0.1);
    expect(human.filter((x) => x.unblocked).length).toBe(0);
  });

  it('keeps his feet alive in a long pocket: a passer reading the field is never whistled down untouched', () => {
    // A strong line and a human who never touches the stick after the snap: the pocket outlasts the engine's 5 s
    // stall net for a runner standing still, which must not blow the play dead (or call a safety) on the passer.
    let stalled = 0;
    let n = 0;
    for (const off of DROPS) for (const def of ['43-cover3-zone', '43-cover2-zone', '43-cover1-man']) for (let v = 0; v < 2; v++) {
      const ctx = buildCtx(env, { off, def, teamIndex: v % 8, seed: `feet:${v}` });
      ctx.controllers = { home: 'human', away: 'ai' };
      ctx.userSide = 'home';
      const play = createPlayEngine(ctx, { registries: env.registries });
      const qb = play.state.athletes.find((a) => a.assignment.type === 'qb')!;
      for (const a of play.state.athletes) {
        if (a.teamSide === 'home') a.controlled = a.id === qb.id;
        for (const k of ['blocking', 'strength', 'balance', 'passRush', 'agility', 'awareness'] as const) a.baseAttrs[k] = a.side === 'offense' ? 90 : 55;
      }
      play.state.controlledIds.home = qb.id;
      play.state.controlledId = qb.id;
      try {
        const o = play.run((s) => ({ home: neutralInput({ snap: s.phase === 'presnap' }) }), 60 * 14);
        n += 1;
        if (o.playByPlay.some((l) => /forward progress/i.test(l)) && !o.events.some((e) => e.type === 'tackle' || e.type === 'sack')) stalled += 1;
      } catch {
        n += 1;
      }
    }
    expect(n).toBe(18);
    expect(stalled).toBe(0);
  });

  it('takes the called drop (depth from the play) and gives the user his feet at the top of it or the moment he steers', () => {
    for (const off of ['singleback-curlFlat', 'shotgun-goRoutes', 'singleback-slantFlat']) {
      const ctx = buildCtx(env, { off, def: '43-cover3-zone', seed: 'drop' });
      ctx.controllers = { home: 'human', away: 'ai' };
      ctx.userSide = 'home';
      const play = createPlayEngine(ctx, { registries: env.registries });
      const qb = play.state.athletes.find((a) => a.assignment.type === 'qb')!;
      for (const a of play.state.athletes) if (a.teamSide === 'home') a.controlled = a.id === qb.id;
      play.state.controlledIds.home = qb.id;
      let deepest = 0;
      for (let t = 0; t < 60 * 4 && play.state.phase !== 'dead'; t++) {
        play.tick({ home: neutralInput({ snap: play.state.phase === 'presnap' }) });
        if (play.state.phase === 'live') deepest = Math.max(deepest, -toLocal(qb.pos, play.state).y);
        if (play.state.phase === 'live' && timeSinceSnap(play.state) > 2.5) break;
      }
      const want = dropbackDepth(ctx.offensivePlay, -routeAlignment(qb, play.state).y, ctx.ballOn);
      expect(deepest).toBeGreaterThan(want - 0.8);
      expect(deepest).toBeLessThan(want + 1.2);
      expect(qb.ai.scratch[USER_DROP_DONE_KEY]).toBe(1);
      // Steering takes over at once.
      qb.ai.scratch[USER_DROP_DONE_KEY] = 0;
      expect(autoDrop(qb, neutralInput({ move: vec2(AUTO_DROP_OVERRIDE + 0.1, 0) }), play.state)).toBeNull();
      expect(qb.ai.scratch[USER_DROP_DONE_KEY]).toBe(1);
    }
  });

  it('backed up at his own 3, he shortens the drop instead of walking into his end zone', () => {
    const ctx = buildCtx(env, { off: 'singleback-curlFlat', def: '43-cover3-zone', seed: 'backed', ballOn: 3 });
    ctx.controllers = { home: 'human', away: 'ai' };
    ctx.userSide = 'home';
    const play = createPlayEngine(ctx, { registries: env.registries });
    const qb = play.state.athletes.find((a) => a.assignment.type === 'qb')!;
    for (const a of play.state.athletes) if (a.teamSide === 'home') a.controlled = a.id === qb.id;
    play.state.controlledIds.home = qb.id;
    let deepest = 0;
    for (let t = 0; t < 60 * 4 && play.state.phase !== 'dead'; t++) {
      play.tick({ home: neutralInput({ snap: play.state.phase === 'presnap' }) });
      if (play.state.phase === 'live') deepest = Math.max(deepest, -toLocal(qb.pos, play.state).y);
      if (play.state.phase === 'live' && timeSinceSnap(play.state) > 2) break;
    }
    // Under centre at his own 3: a 5-step drop would put him 4 yards deep in the end zone.
    expect(deepest).toBeLessThan(3);
  });
});
