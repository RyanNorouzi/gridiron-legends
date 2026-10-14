/**
 * Designed exchanges are automatic for a human quarterback: on every called run he carries out the handoff / toss
 * (whatever he does with the stick or the throw buttons) and control passes to the runner; on read plays a hard stick
 * input means he keeps it himself.
 */
import { describe, expect, it } from 'vitest';
import { registerAll } from '@/ai/register';
import { vec2 } from '@/core/vec2';
import { createPlayEngine } from '@/game/play-engine';
import type { UserPlayInput } from '@/game/play-types';
import { AUTO_EXCHANGE_SECONDS } from '@/game/user-control';
import { buildPlayState } from '../../fixtures/play-state';

registerAll();

const input = (o: Partial<UserPlayInput> = {}): UserPlayInput => ({
  move: vec2(0, 0), sprint: false, strafe: false, throwTo: null, throwType: null, juke: false, spin: false, stiffArm: false,
  hurdle: false, dive: false, slide: false, throwAway: false, snap: false, audible: null, defAudible: null, switchPlayer: false,
  switchToId: null, hitStick: false, strip: false, tackle: false, jumpSwat: false, kickPress: false, fairCatch: false, pitch: false, ...o,
});

type Style = 'nothing' | 'stick-sideways' | 'throw-after-snap';

const runPlay = (playId: string, style: Style, seed: number) => {
  const f = buildPlayState({ offensePlayId: playId, defensePlayId: '43-cover3-zone', seed, ballOn: 30, ruleset: 'arcade', userSide: 'home', controlRole: 'QB' });
  const e = createPlayEngine(f.state.ctx, { registries: f.registry });
  for (let t = 0; e.state.phase === 'presnap' && t < 600; t++) e.tick({ home: input({ snap: true }) });
  for (let live = 0; !e.isDead && live < 240; live++) {
    const o = style === 'stick-sideways' ? { move: vec2(1, 0) } : style === 'throw-after-snap' && live === 1 ? { throwTo: 0 } : {};
    e.tick({ home: input(o) });
    if (e.state.events.some((ev) => ev.type === 'handoff' || ev.type === 'pitch')) break;
  }
  return e;
};

const designedRuns = (): string[] => {
  const f = buildPlayState();
  return Object.values(f.registry.offensePlays)
    .filter((p) => p.type === 'run' && p.assignments.QB?.type === 'qb' && p.ballCarrier !== undefined && p.ballCarrier !== 'QB')
    .map((p) => p.id);
};

describe('human quarterback: automatic designed exchange', () => {
  const runs = designedRuns();
  it('covers a real set of designed runs', () => {
    expect(runs.length).toBeGreaterThanOrEqual(15);
  });
  for (const style of ['nothing', 'stick-sideways', 'throw-after-snap'] as const) {
    it(`hands off on every designed run when the player does ${style}`, () => {
      const failures: string[] = [];
      for (const id of runs) {
        const e = runPlay(id, style, 3);
        const ex = e.state.events.find((ev) => ev.type === 'handoff' || ev.type === 'pitch');
        if (!ex) { failures.push(`${id}: no exchange (ball with ${e.state.ball.carrierId})`); continue; }
        if ((ex.tick - e.state.snapTick) / 60 > AUTO_EXCHANGE_SECONDS + 0.05) failures.push(`${id}: exchange too late`);
        if (e.state.events.some((ev) => ev.type === 'throw')) failures.push(`${id}: threw on a designed run`);
        // Control follows the ball to the runner.
        e.tick({ home: input() });
        const carrier = e.state.ball.carrierId;
        if (carrier && carrier !== 'off:QB' && e.state.controlledIds.home !== carrier) failures.push(`${id}: control did not pass to ${carrier}`);
      }
      expect(failures).toEqual([]);
    });
  }
});

describe('human quarterback: read plays', () => {
  it('a hard stick input on a zone read or RPO keeps the ball', () => {
    const f = buildPlayState();
    const reads = Object.values(f.registry.offensePlays).filter((p) => p.type === 'rpo' || (p.type === 'qbRun' && p.fakeTo !== undefined)).map((p) => p.id);
    expect(reads.length).toBeGreaterThan(0);
    for (const id of reads) {
      const g = buildPlayState({ offensePlayId: id, defensePlayId: '43-cover3-zone', seed: 5, ballOn: 30, ruleset: 'arcade', userSide: 'home', controlRole: 'QB' });
      const e = createPlayEngine(g.state.ctx, { registries: g.registry });
      for (let t = 0; e.state.phase === 'presnap' && t < 600; t++) e.tick({ home: input({ snap: true }) });
      for (let live = 0; !e.isDead && live < 60; live++) e.tick({ home: input({ move: vec2(0, 1) }) });
      expect(e.state.events.some((ev) => ev.type === 'handoff'), id).toBe(false);
    }
  });
});
