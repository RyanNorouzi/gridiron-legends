import { describe, expect, it } from 'vitest';
import { createPlayEngine } from '@/game/play-engine';
import type { PlayContext, PlayOutcome, PlayState, UserPlayInput } from '@/game/play-types';
import { predictLanding } from '@/physics/ball';
import { buildCtx, createMeasureEnv, runLive } from '../../integration/measure';
import { emptyInput } from './helpers';

/**
 * Kick returns in real play: the AI return unit blocks man for man and the returner runs north-south behind it, so a
 * kickoff return averages low-20s yards and a punt return high single digits, with no safeties; a human returner who
 * fields a kick in his own end zone and does not bring it out takes a knee (touchback) instead of being tackled there.
 */
const env = createMeasureEnv(2026);

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)] ?? 0;
};

const kickoff = (i: number): PlayContext => buildCtx(env, { off: 'kickoff-deep', def: 'kickReturn-middle', special: 'kickoff', ballOn: 35, teamIndex: i % 8, seed: `kr-test:${i}` });

describe('kick returns', () => {
  it('AI kickoff and punt returns land in realistic ranges and never end in a safety', () => {
    const ko: number[] = [];
    const punt: number[] = [];
    let safeties = 0;
    for (let i = 0; i < 48; i++) {
      const o = runLive(env, kickoff(i)).outcome as PlayOutcome;
      if (o.safety) safeties += 1;
      if (!o.events.some((e) => e.type === 'touchback') && !o.turnover) ko.push(o.returnYards);
      const p = buildCtx(env, { off: 'punt-standard', def: 'puntReturn-middle', special: 'punt', ballOn: 20 + (i % 6) * 8, down: 4, teamIndex: i % 8, seed: `pr-test:${i}` });
      const po = runLive(env, p).outcome as PlayOutcome;
      if (po.safety) safeties += 1;
      const returned = !po.turnover && !po.events.some((e) => e.type === 'touchback' || e.type === 'fairCatch' || e.type === 'downed')
        && po.events.some((e) => e.type === 'tackle' || e.type === 'outOfBounds' || e.type === 'touchdown');
      if (returned) punt.push(po.returnYards);
    }
    expect(safeties).toBe(0);
    expect(ko.length).toBeGreaterThanOrEqual(10);
    expect(punt.length).toBeGreaterThanOrEqual(10);
    // Real football: kickoff returns ~22-24 yd on average (median a little lower), punt returns ~8-10.
    expect(median(ko)).toBeGreaterThanOrEqual(18);
    expect(median(ko)).toBeLessThanOrEqual(27);
    expect(median(punt)).toBeGreaterThanOrEqual(4);
    expect(median(punt)).toBeLessThanOrEqual(13);
  }, 120_000);

  it('punt returns across the whole league stay short: the punter trails as the safety and long returns are rare', () => {
    // Every team's punt unit (weak coverage tacklers included): real punt returns average ~9-10 yd with ~1% touchdowns.
    const pr: number[] = [];
    let tds = 0;
    for (let i = 0; i < 128; i++) {
      const ctx = buildCtx(env, { off: 'punt-standard', def: 'puntReturn-middle', special: 'punt', ballOn: 20 + (i % 6) * 8, down: 4, teamIndex: i % 32, seed: `pr-league:${i}` });
      const o = runLive(env, ctx).outcome as PlayOutcome;
      const returned = !o.turnover && !o.events.some((e) => e.type === 'touchback' || e.type === 'fairCatch' || e.type === 'downed')
        && o.events.some((e) => e.type === 'tackle' || e.type === 'outOfBounds' || e.type === 'touchdown');
      if (!returned) continue;
      pr.push(o.returnYards);
      if (o.touchdown) tds += 1;
    }
    const mean = pr.reduce((a, b) => a + b, 0) / Math.max(1, pr.length);
    expect(pr.length).toBeGreaterThanOrEqual(40);
    expect(median(pr)).toBeLessThanOrEqual(11);
    expect(mean).toBeLessThanOrEqual(16);
    expect(tds / pr.length).toBeLessThanOrEqual(0.08);
  }, 120_000);

  it('gunners come off the sideline to the catch instead of running past the returner', () => {
    // Gunners used to hold the sideline until within 18 yards of the landing, so on a punt down the middle they ran
    // straight past the returner (about 22-24 yards away at the catch; now about 12).
    const gaps: number[] = [];
    for (let i = 0; i < 24; i++) {
      const ctx = buildCtx(env, { off: 'punt-standard', def: 'puntReturn-middle', special: 'punt', ballOn: 20 + (i % 3) * 5, down: 4, teamIndex: i % 32, seed: `gunner:${i}` });
      const play = createPlayEngine(ctx, { registries: env.registries });
      for (let t = 0; t < 6000 && !play.isDead; t++) {
        play.tick({});
        const s = play.state;
        const fielded = s.events.some((e) => e.type === 'catch' || e.type === 'fairCatch') || (s.ball.phase === 'held' && s.ball.carrierId?.startsWith('def:'));
        if (!fielded) continue;
        const pr = s.athletes.find((a) => a.role === 'PR')!;
        const gunners = s.athletes.filter((a) => a.assignment.type === 'gunner');
        gaps.push(Math.min(...gunners.map((g) => Math.hypot(g.pos.x - pr.pos.x, g.pos.y - pr.pos.y))));
        break;
      }
    }
    expect(gaps.length).toBeGreaterThanOrEqual(16);
    expect(median(gaps)).toBeLessThanOrEqual(16);
  }, 60_000);

  const humanReturn = (i: number, bringItOut: boolean): { o: PlayOutcome; s: PlayState; caughtDeep: boolean } => {
    const ctx = kickoff(i);
    ctx.controllers = { home: 'ai', away: 'human' };
    ctx.userSide = 'away';
    ctx.userControl = 'defense';
    const play = createPlayEngine(ctx, { registries: env.registries });
    let caughtDeep = false;
    const input = (s: PlayState): { away: UserPlayInput } => {
      const u = emptyInput();
      const me = s.athletes.find((a) => a.id === s.controlledIds.away);
      if (!me) return { away: u };
      if (s.ball.phase === 'inAir' && s.ball.kind !== 'snap') {
        const p = predictLanding(s.ball, s.ctx.weather, 1.2).pos;
        const d = Math.hypot(p.x - me.pos.x, p.y - me.pos.y);
        if (d > 0.3) u.move = { x: (p.x - me.pos.x) / d, y: (p.y - me.pos.y) / d };
      } else if (s.ball.phase === 'held' && s.ball.carrierId === me.id) {
        // The receiving team's own goal line is the kicking team's goal (y = 110 when the kick goes toward +y).
        if (s.ball.kind === 'kickoff' && me.pos.y > 110) caughtDeep = true;
        if (bringItOut) { u.move = { x: 0, y: -s.ctx.direction }; u.sprint = true; }
      }
      return { away: u };
    };
    const o = play.run(input, 5000);
    return { o, s: play.state, caughtDeep };
  };

  it('a human returner who fields a kickoff in his end zone and stays there takes a knee: a touchback, never a safety', () => {
    let deep = 0;
    for (let i = 0; i < 16 && deep < 4; i++) {
      const { o, s, caughtDeep } = humanReturn(i, false);
      if (!caughtDeep) continue;
      deep += 1;
      expect(s.deadReason).toBe('touchback');
      expect(o.safety).toBe(false);
      expect(o.events.some((e) => e.type === 'tackle')).toBe(false);
      const kick = o.events.find((e) => e.type === 'kick');
      const kneel = o.events.find((e) => e.type === 'kneel');
      expect(kick && kneel && kneel.tick > kick.tick).toBe(true);
    }
    expect(deep).toBeGreaterThanOrEqual(2);
  }, 60_000);

  it('a human returner who brings it out of the end zone gets a return, not a knee', () => {
    let deep = 0;
    for (let i = 0; i < 16 && deep < 4; i++) {
      const { o, caughtDeep } = humanReturn(i, true);
      if (!caughtDeep) continue;
      deep += 1;
      expect(o.events.some((e) => e.type === 'kneel')).toBe(false);
      expect(o.safety).toBe(false);
      expect(o.returnYards).toBeGreaterThan(5);
    }
    expect(deep).toBeGreaterThanOrEqual(2);
  }, 60_000);
});
