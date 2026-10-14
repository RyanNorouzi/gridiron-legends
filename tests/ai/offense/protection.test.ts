/**
 * Offensive line quality through the real PlayEngine. Tuned for MORE PRESSURE on both sides (owner request 2026-10-02,
 * replacing the earlier ~5 s pocket): a passer who holds the ball is sacked about 4 s after the snap against an even
 * four-man rush (median, with a realistic spread), the pocket visibly closes a little before, nobody
 * runs free, and ratings move it both ways; plus the no-crossing assignment and stunt hand-off, blitz pickup by a
 * back, a human passer who stays under centre, and zone combos that climb to the second level on runs.
 */
import { describe, expect, it } from 'vitest';
import { decideIntent } from '@/ai/index';
import { blitzPickupIntent, passProtection, perceivedRushers } from '@/ai/blocking';
import { timeSinceSnap, toField, toLocal } from '@/ai/route-running';
import { idleIntent, type IntentDecider } from '@/game/engine-api';
import { PlayEngine, createPlayEngine } from '@/game/play-engine';
import { USER_DROP_DONE_KEY } from '@/ai/blocking-pass';
import { dist } from '@/core/vec2';
import { buildCtx, createMeasureEnv } from '../../integration/measure';
import { fixture, place, snapNow } from './sim';
import { measurePocket, quantile, summarize, type PocketSnap } from './pocket-harness';

const env = createMeasureEnv(2026);

const FOUR_MAN = ['43-cover3-zone', '43-cover2-zone', '43-cover4-zone', 'nickel-cover3-match', '43-cover1-man'];
const DROPS = ['shotgun-mesh', 'singleback-curlFlat', 'shotgun-goRoutes'];

/** Snaps of a passer who takes the called drop and holds the ball, against a four-man rush. */
const pocket = (seeds: number, ratings: { ol?: number; dl?: number; athletic?: number } = {}, tag = 'pocket'): PocketSnap[] => {
  const out: PocketSnap[] = [];
  for (const off of DROPS) for (const def of FOUR_MAN) for (let v = 0; v < seeds; v++) {
    out.push(measurePocket(env, { off, def, seed: `${tag}:${v}`, teamIndex: v % 8, ...ratings }));
  }
  return out;
};

describe('pass protection (live engine): a ~4-second pocket against a four-man rush', () => {
  const even = pocket(4, { ol: 70, dl: 70, athletic: 70 });
  const sacks = summarize(even.map((s) => s.sack));
  const pressure = summarize(even.map((s) => s.pressure));

  it('holds a passer who keeps the ball for about 4 s before the first rusher gets him (median, even ratings)', () => {
    expect(sacks.median).toBeGreaterThanOrEqual(3.2);
    expect(sacks.median).toBeLessThanOrEqual(4.6);
    // A spread, not a clock: some pockets break a little early, some hold on.
    expect(sacks.q25).toBeGreaterThanOrEqual(2.4);
    expect(sacks.q75).toBeLessThanOrEqual(6);
    expect(even.filter((s) => s.sack < 2).length / even.length).toBeLessThan(0.08);
  });

  it('shows the pocket closing (a rusher within 2 yd) a little before the sack, from about 3 s', () => {
    expect(pressure.median).toBeGreaterThanOrEqual(2.6);
    expect(pressure.median).toBeLessThan(sacks.median);
    expect(pressure.under2).toBeLessThan(0.15);
  });

  it('never lets a rusher run free untouched', () => {
    expect(even.filter((s) => s.unblocked).length).toBe(0);
  });

  it('is rating-sensitive: an elite front gets home in ~2.5-3.5 s, an elite line holds clearly longer', () => {
    const strongRush = summarize(pocket(3, { ol: 60, dl: 85 }, 'rush').map((s) => s.sack));
    const strongLine = summarize(pocket(3, { ol: 85, dl: 60 }, 'line').map((s) => s.sack));
    expect(strongRush.median).toBeGreaterThanOrEqual(2.4);
    expect(strongRush.median).toBeLessThanOrEqual(3.6);
    expect(strongLine.median).toBeGreaterThanOrEqual(sacks.median + 1);
    expect(strongRush.median).toBeLessThan(sacks.median - 0.4);
  });
});

describe('pass protection for a human passer', () => {
  it('keeps the line in front of a passer who stays under centre (aiming a pull-back throw) instead of backing into him', () => {
    // A human quarterback has no scripted drop: while he aims he may simply stand where he took the snap.
    const still: IntentDecider = (a, s, dt) => (a.position === 'QB' && a.hasBall && s.phase === 'live' ? idleIntent('aim') : decideIntent(a, s, dt));
    const times: number[] = [];
    for (const def of ['43-cover3-zone', '43-cover2-zone', '43-cover4-zone']) {
      for (let v = 0; v < 3; v++) {
        const ctx = buildCtx(env, { off: 'singleback-curlFlat', def, teamIndex: v % 8, seed: `still:${v}` });
        const play = createPlayEngine(ctx, { registries: env.registries, decider: still });
        const qb = play.state.athletes.find((a) => a.position === 'QB')!;
        qb.controlled = true;
        // He took his feet over from the automatic drop (game/user-control.ts autoDrop) and stayed put.
        qb.ai.scratch[USER_DROP_DONE_KEY] = 1;
        let t = 6;
        try {
          play.run((s) => {
            if (s.phase !== 'live' || t < 6 || !qb.hasBall) return {};
            if (s.athletes.some((d) => d.side === 'defense' && dist(d.pos, qb.pos) < 1.2)) t = timeSinceSnap(s);
            return {};
          }, 60 * 7);
        } catch {
          // The tick cap: nobody got to him.
        }
        times.push(t);
      }
    }
    times.sort((a, b) => a - b);
    // Linemen who kick back to their drop-back set would leave him to the tackles in ~0.6 s.
    expect(quantile(times, 0.5)).toBeGreaterThan(1.6);
    expect(times[0]).toBeGreaterThan(1.1);
  });
});

describe('pass protection for a human passer standing under centre', () => {
  it('the tackles still kick-slide to the edge and a spare lineman takes a looper: no end comes round untouched', () => {
    const still: IntentDecider = (a, s, dt) => (a.position === 'QB' && a.hasBall && s.phase === 'live' ? idleIntent('aim') : decideIntent(a, s, dt));
    let unblocked = 0;
    let n = 0;
    for (const off of ['singleback-curlFlat', 'twoTE-skinnyPosts']) for (const def of FOUR_MAN) for (let v = 0; v < 3; v++) {
      const ctx = buildCtx(env, { off, def, teamIndex: v % 8, seed: `under:${v}` });
      const play = createPlayEngine(ctx, { registries: env.registries, decider: still });
      const qb = play.state.athletes.find((a) => a.position === 'QB')!;
      qb.controlled = true;
      qb.ai.scratch[USER_DROP_DONE_KEY] = 1;
      const touched = new Set<string>();
      let first: string | null = null;
      try {
        play.run((s) => {
          for (const d of s.athletes) if (d.side === 'defense' && d.engagedWith) touched.add(d.id);
          for (const e of s.events) if (e.type === 'blockShed' || e.type === 'pancake') touched.add(e.defender);
          if (s.phase === 'live' && first === null) {
            const on = s.athletes.find((d) => d.side === 'defense' && dist(d.pos, qb.pos) < 1.3 && (d.state === 'wrapping' || qb.state === 'wrapped'));
            if (on) first = on.id;
          }
          return {};
        }, 60 * 8);
      } catch {
        // The tick cap: nobody got to him.
      }
      n += 1;
      if (first !== null && !touched.has(first)) unblocked += 1;
    }
    expect(n).toBe(30);
    // Was 5-13 of 30 (the right end looping behind a tackle who could not open, past an idle guard).
    expect(unblocked).toBeLessThanOrEqual(2);
  });
});

describe('pass protection plan', () => {
  it('matches the line to the rush without anyone crossing a teammate', () => {
    const fx = fixture({ offensePlayId: 'shotgun-mesh', defensePlayId: '43-cover3-zone', seed: 4 });
    snapNow(fx.state);
    const prot = passProtection(fx.state);
    const pairs = ['LT', 'LG', 'C', 'RG', 'RT']
      .map((r) => fx.byRole('offense', r))
      .filter((b) => prot.assignment.has(b.id))
      .map((b) => ({ bx: toLocal(b.pos, fx.state).x, rx: toLocal(fx.athlete(prot.assignment.get(b.id)!).pos, fx.state).x }))
      .sort((p, q) => p.bx - q.bx);
    expect(pairs.length).toBe(4);
    for (let i = 1; i < pairs.length; i++) expect(pairs[i]!.rx).toBeGreaterThan(pairs[i - 1]!.rx);
    // The spare lineman helps on a rusher instead of blocking air.
    const spare = ['LT', 'LG', 'C', 'RG', 'RT'].map((r) => fx.byRole('offense', r)).find((b) => !prot.assignment.has(b.id));
    expect(spare).toBeDefined();
    expect(prot.help.get(spare!.id)).toBeDefined();
    expect(prot.free).toEqual([]);
  });

  it('does not spend a blocker on a down lineman bailing into coverage (zone blitz)', () => {
    const fx = fixture({ offensePlayId: 'shotgun-mesh', defensePlayId: '43-cover3-zone', seed: 4 });
    snapNow(fx.state);
    const de = fx.byRole('defense', 'DE1');
    expect(passProtection(fx.state).assignment.size).toBeGreaterThan(0);
    expect([...passProtection(fx.state).assignment.values()]).toContain(de.id);
    // He drops into a hook zone at the snap.
    de.assignment = { type: 'zone', zone: 'middleHook' };
    de.vel = { x: 0, y: fx.state.ctx.direction * 5 };
    expect(perceivedRushers(fx.state, 1).map((r) => r.id)).not.toContain(de.id);
    expect([...passProtection(fx.state).assignment.values()]).not.toContain(de.id);
  });

  it('hands off a twist: when the end loops inside the tackle, the guard takes the end and the tackle the tackle', () => {
    const fx = fixture({ offensePlayId: 'shotgun-mesh', defensePlayId: '43-cover3-zone', seed: 4 });
    snapNow(fx.state);
    const lt = fx.byRole('offense', 'LT');
    const lg = fx.byRole('offense', 'LG');
    const before = passProtection(fx.state);
    const outside = fx.athlete(before.assignment.get(lt.id)!);
    const inside = fx.athlete(before.assignment.get(lg.id)!);
    // The inside man crashes out, the outside man loops in behind him.
    const o = toLocal(outside.pos, fx.state);
    const i = toLocal(inside.pos, fx.state);
    place(inside, toField({ x: o.x - 0.2, y: -0.8 }, fx.state));
    place(outside, toField({ x: i.x + 0.3, y: -0.6 }, fx.state));
    const after = passProtection(fx.state);
    expect(after.assignment.get(lt.id)).toBe(inside.id);
    expect(after.assignment.get(lg.id)).toBe(outside.id);
  });

  it('a back in protection picks up the blitzer the line cannot, and a releasing back can check for him first', () => {
    const fx = fixture({ offensePlayId: 'shotgun-mesh', defensePlayId: '43-cover0-lbBlitz', seed: 2 });
    const rb = fx.byRole('offense', 'RB');
    snapNow(fx.state);
    const asRoute = passProtection(fx.state);
    expect(asRoute.free.length).toBeGreaterThan(0);
    const pickup = blitzPickupIntent(rb, fx.state);
    expect(pickup).not.toBeNull();
    expect(asRoute.free).toContain(rb.ai.blockTargetId);
    rb.assignment = { type: 'passBlock' };
    const withBack = passProtection(fx.state);
    const target = withBack.assignment.get(rb.id);
    expect(target).toBeDefined();
    expect(asRoute.free).toContain(target);
    expect(withBack.free.length).toBe(asRoute.free.length - 1);
  });
});

describe('run blocking (live engine)', () => {
  it('zone combos double the down lineman and one blocker climbs to a linebacker', () => {
    let combos = 0;
    let climbs = 0;
    const n = 12;
    for (let v = 0; v < n; v++) {
      const off = v % 2 === 0 ? 'pistol-insideZone-right' : 'shotgun-insideZone-left';
      const ctx = buildCtx(env, { off, def: v % 3 === 0 ? '43-cover2-zone' : '43-cover3-zone', teamIndex: v % 8, seed: `zone:${v}` });
      const play = new PlayEngine(ctx, { registries: env.registries });
      const doubled = new Set<string>();
      let combo = false;
      let climb = false;
      play.run((s) => {
        if (s.phase !== 'live') return {};
        const eng = play.debugEnv().engagements;
        const count: Record<string, number> = {};
        for (const e of eng) count[e.rusherId] = (count[e.rusherId] ?? 0) + 1;
        for (const e of eng) {
          if ((count[e.rusherId] ?? 0) >= 2) { combo = true; doubled.add(e.blockerId); }
          const r = s.athletes.find((a) => a.id === e.rusherId);
          if (doubled.has(e.blockerId) && r && r.position !== 'DE' && r.position !== 'DT') climb = true;
        }
        return {};
      });
      if (combo) combos += 1;
      if (climb) climbs += 1;
    }
    expect(combos).toBeGreaterThanOrEqual(n * 0.6);
    expect(climbs).toBeGreaterThanOrEqual(n * 0.3);
  });
});
