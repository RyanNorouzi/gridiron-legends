import { describe, expect, it } from 'vitest';
import { buildGameSetup } from '@/franchise/game-setup';
import { fallbackSimulator } from '@/franchise/sim-fallback';
import { realGameSimulator } from '@/franchise/sim-real';
import type { GameSimulator } from '@/franchise/sim-seam';
import { gamesThisWeek } from '@/franchise/week';
import { SimJob } from '@/ui/franchise/shell/sim-job';
import { answerSimRequest, type SimWorkerRequest, type SimWorkerResponse } from '@/ui/franchise/shell/sim-worker-protocol';
import {
  SimWorkerError, createSimWorkerPool, inlineAsyncSimulator, poolSizeFor, sharedSimWorkers, type WorkerLike,
} from '@/ui/franchise/shell/sim-workers';
import { flushPromises, leagueAt } from './helpers';

/** In-process stand-in for a module worker: answers on a later macrotask through the real protocol handler. */
class FakeWorker implements WorkerLike {
  static live = 0;
  static maxLive = 0;
  onmessage: ((ev: { data: SimWorkerResponse }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  terminated = false;
  busy = 0;
  constructor(private readonly sim: GameSimulator, private readonly crashOn: string | null = null) {}
  postMessage(msg: SimWorkerRequest): void {
    this.busy++;
    FakeWorker.live++;
    FakeWorker.maxLive = Math.max(FakeWorker.maxLive, FakeWorker.live);
    const copy = structuredClone(msg);
    setTimeout(() => {
      this.busy--;
      FakeWorker.live--;
      if (this.terminated) return;
      if (this.crashOn && copy.setup.id === this.crashOn) this.onerror?.({ message: 'boom' });
      else this.onmessage?.({ data: structuredClone(answerSimRequest(copy, this.sim)) });
    }, 0);
  }
  terminate(): void { this.terminated = true; }
}

const weekSetups = (seed: number) => {
  const league = leagueAt(seed, 'regularSeason');
  return gamesThisWeek(league).filter((g) => g.result === null).map((g) => buildGameSetup(league, g));
};

describe('sim worker protocol', () => {
  it('answers a request with the simulator result, and errors for malformed requests or a throwing simulator', () => {
    const [setup] = weekSetups(41);
    const ok = answerSimRequest({ type: 'simulate', id: 7, setup, opts: {} }, fallbackSimulator);
    expect(ok.type).toBe('result');
    expect(ok.id).toBe(7);
    if (ok.type === 'result') expect(ok.result).toEqual(fallbackSimulator(setup!, {}));
    expect(answerSimRequest({ type: 'nope', id: 3 }, fallbackSimulator)).toEqual({ type: 'error', id: 3, message: 'sim worker: malformed request' });
    expect(answerSimRequest(null, fallbackSimulator).id).toBe(-1);
    const bad = answerSimRequest({ type: 'simulate', id: 2, setup, opts: {} }, () => { throw new Error('kaboom'); });
    expect(bad).toEqual({ type: 'error', id: 2, message: 'kaboom' });
  });

  it('the real simulator gives the same result through a structured-clone round trip (what postMessage does)', () => {
    const league = leagueAt(41, 'regularSeason');
    const game = gamesThisWeek(league)[0]!;
    const setup = buildGameSetup(league, game);
    const direct = realGameSimulator(setup, { keepPlayLog: true });
    const viaWorker = structuredClone(answerSimRequest(structuredClone({ type: 'simulate', id: 1, setup, opts: { keepPlayLog: true } }), realGameSimulator));
    expect(viaWorker.type).toBe('result');
    if (viaWorker.type === 'result') expect(JSON.stringify(viaWorker.result)).toBe(JSON.stringify(direct));
  }, 60000);
});

describe('createSimWorkerPool', () => {
  it('runs games on at most `size` workers and resolves every result', async () => {
    const setups = weekSetups(41).slice(0, 6);
    const spawned: FakeWorker[] = [];
    FakeWorker.live = 0;
    FakeWorker.maxLive = 0;
    const pool = createSimWorkerPool(() => { const w = new FakeWorker(fallbackSimulator); spawned.push(w); return w; }, { size: 2, idleMs: 0 });
    const results = await Promise.all(setups.map((s) => pool.simulate(s)));
    expect(spawned).toHaveLength(2);
    expect(FakeWorker.maxLive).toBeLessThanOrEqual(2);
    results.forEach((r, i) => expect(r).toEqual(fallbackSimulator(setups[i]!, {})));
    pool.dispose();
    expect(spawned.every((w) => w.terminated)).toBe(true);
  });

  it('cancelQueued rejects the waiting games but lets the running ones finish', async () => {
    const setups = weekSetups(41).slice(0, 4);
    const pool = createSimWorkerPool(() => new FakeWorker(fallbackSimulator), { size: 1, idleMs: 0 });
    const outcomes = setups.map((s) => pool.simulate(s).then(() => 'ok', (e: unknown) => (e instanceof SimWorkerError ? e.kind : 'other')));
    pool.cancelQueued();
    expect(await Promise.all(outcomes)).toEqual(['ok', 'cancelled', 'cancelled', 'cancelled']);
    expect(pool.broken).toBe(false);
  });

  it('a crashing worker breaks the pool: every outstanding game rejects as a worker error', async () => {
    const setups = weekSetups(41).slice(0, 3);
    const pool = createSimWorkerPool(() => new FakeWorker(fallbackSimulator, setups[0]!.id), { size: 1, idleMs: 0 });
    const outcomes = setups.map((s) => pool.simulate(s).then(() => 'ok', (e: unknown) => (e instanceof SimWorkerError ? e.kind : 'other')));
    expect(await Promise.all(outcomes)).toEqual(['worker', 'worker', 'worker']);
    expect(pool.broken).toBe(true);
    await expect(pool.simulate(setups[0]!)).rejects.toBeInstanceOf(SimWorkerError);
    const unspawnable = createSimWorkerPool(() => { throw new Error('no workers here'); });
    await expect(unspawnable.simulate(setups[0]!)).rejects.toThrow(/could not start/);
    expect(unspawnable.broken).toBe(true);
  });

  it('a worker that never answers times out and breaks the pool (the watchdog), so nothing waits forever', async () => {
    const setups = weekSetups(41).slice(0, 3);
    const timers: { cb: () => void; ms: number; cleared: boolean }[] = [];
    const silent: WorkerLike[] = [];
    const pool = createSimWorkerPool(() => {
      const w: WorkerLike = { postMessage: () => undefined, terminate: () => undefined, onmessage: null, onerror: null };
      silent.push(w);
      return w;
    }, {
      size: 2, idleMs: 0, jobTimeoutMs: 5000,
      setTimer: (cb, ms) => { const t = { cb, ms, cleared: false }; timers.push(t); return t; },
      clearTimer: (h) => { (h as { cleared: boolean }).cleared = true; },
    });
    const outcomes = setups.map((s) => pool.simulate(s).then(() => 'ok', (e: unknown) => (e instanceof SimWorkerError ? `${e.kind}:${e.message}` : 'other')));
    expect(timers.map((t) => t.ms)).toEqual([5000, 5000]);
    expect(pool.broken).toBe(false);
    timers[0]!.cb();
    expect(pool.broken).toBe(true);
    expect(await Promise.all(outcomes)).toEqual(Array(3).fill('worker:sim worker timed out'));
    expect(timers[1]!.cleared).toBe(true);
    expect(silent.every((w) => w.onmessage === null)).toBe(true);
  });

  it('an answered game disarms its watchdog, so a late timer never breaks a healthy pool', async () => {
    const [setup] = weekSetups(41);
    const timers: { cb: () => void; cleared: boolean }[] = [];
    const pool = createSimWorkerPool(() => new FakeWorker(fallbackSimulator), {
      size: 1, idleMs: 0, jobTimeoutMs: 5000,
      setTimer: (cb) => { const t = { cb, cleared: false }; timers.push(t); return t; },
      clearTimer: (h) => { (h as { cleared: boolean }).cleared = true; },
    });
    await pool.simulate(setup!);
    expect(timers).toHaveLength(1);
    expect(timers[0]!.cleared).toBe(true);
    timers[0]!.cb();
    expect(pool.broken).toBe(false);
  });

  it('an unreadable message or an error reply for no running game breaks the pool instead of hanging', async () => {
    const [setup] = weekSetups(41);
    const make = (): { w: WorkerLike; pool: ReturnType<typeof createSimWorkerPool> } => {
      const w: WorkerLike = { postMessage: () => undefined, terminate: () => undefined, onmessage: null, onerror: null, onmessageerror: null };
      return { w, pool: createSimWorkerPool(() => w, { size: 1, idleMs: 0, jobTimeoutMs: 0 }) };
    };
    const a = make();
    const pa = a.pool.simulate(setup!);
    a.w.onmessageerror?.({});
    await expect(pa).rejects.toMatchObject({ kind: 'worker', message: 'sim worker message could not be read' });
    expect(a.pool.broken).toBe(true);
    const b = make();
    const pb = b.pool.simulate(setup!);
    // What the worker answers when it cannot read the request's id (answerSimRequest's id -1).
    b.w.onmessage?.({ data: { type: 'error', id: -1, message: 'sim worker: malformed request' } });
    await expect(pb).rejects.toMatchObject({ kind: 'worker' });
    expect(b.pool.broken).toBe(true);
  });

  it('terminates idle workers after idleMs and respawns on demand', async () => {
    const [setup] = weekSetups(41);
    const timers: (() => void)[] = [];
    const spawned: FakeWorker[] = [];
    const pool = createSimWorkerPool(() => { const w = new FakeWorker(fallbackSimulator); spawned.push(w); return w; }, {
      size: 1, idleMs: 1000, setTimer: (cb) => timers.push(cb), clearTimer: () => undefined,
    });
    await pool.simulate(setup!);
    expect(spawned).toHaveLength(1);
    timers.at(-1)?.();
    expect(spawned[0]!.terminated).toBe(true);
    await pool.simulate(setup!);
    expect(spawned).toHaveLength(2);
  });

  it('sizes the pool from the core count and has no shared pool where Worker does not exist', () => {
    expect(poolSizeFor(undefined)).toBe(1);
    expect(poolSizeFor(2)).toBe(1);
    expect(poolSizeFor(4)).toBe(3);
    expect(poolSizeFor(16)).toBe(3);
    expect(sharedSimWorkers()).toBeNull();
  });
});

/** Steps a job like the progress overlay does, letting worker answers arrive between frames. */
const runAsync = async (job: SimJob, frames = 400): Promise<number> => {
  let waits = 0;
  for (let i = 0; i < frames; i++) {
    if (job.step()) return waits;
    if (job.waiting) waits++;
    await flushPromises(1);
  }
  throw new Error('job did not finish');
};

describe('SimJob off the main thread', () => {
  it('same seed, same League after a week: worker path and synchronous fallback agree exactly', async () => {
    const league = leagueAt(43, 'regularSeason');
    // Node has no Worker: a default job (real simulator, no remote given) takes the synchronous fallback.
    expect(new SimJob(league, { kind: 'week' }).offThread).toBe(false);
    const sync = new SimJob(league, { kind: 'week' }, { simulator: fallbackSimulator });
    expect(sync.offThread).toBe(false);
    const syncResult = sync.runToEnd();
    const job = new SimJob(league, { kind: 'week' }, { simulator: fallbackSimulator, remote: inlineAsyncSimulator(fallbackSimulator) });
    expect(job.offThread).toBe(true);
    const waits = await runAsync(job);
    expect(waits).toBeGreaterThan(0);
    const r = job.result;
    expect(r.error).toBeNull();
    expect(r.weeks).toHaveLength(1);
    expect(JSON.stringify(r.league)).toBe(JSON.stringify(syncResult.league));
    expect(job.weekProgress).toBeNull();
  }, 60000);

  it('reports progress while waiting and cancels at once, leaving the League untouched', async () => {
    const league = leagueAt(43, 'regularSeason');
    const job = new SimJob(league, { kind: 'week' }, { simulator: fallbackSimulator, remote: inlineAsyncSimulator(fallbackSimulator) });
    expect(job.step()).toBe(false);
    expect(job.waiting).toBe(true);
    expect(job.weekProgress?.done).toBe(0);
    await flushPromises(2);
    expect(job.weekProgress!.done).toBeGreaterThan(0);
    expect(job.progress).toBeGreaterThan(0);
    job.cancel();
    expect(job.waiting).toBe(false);
    expect(job.step()).toBe(true);
    expect(job.result.cancelled).toBe(true);
    expect(job.result.league).toBe(league);
  }, 30000);

  it('falls back to this thread when the workers fail, with the same result', async () => {
    const league = leagueAt(43, 'regularSeason');
    const games = gamesThisWeek(league).filter((g) => g.result === null);
    const pool = createSimWorkerPool(() => new FakeWorker(fallbackSimulator, games[2]!.id), { size: 2, idleMs: 0 });
    const job = new SimJob(league, { kind: 'week' }, { simulator: fallbackSimulator, remote: pool });
    await runAsync(job);
    expect(job.offThread).toBe(false);
    expect(job.result.error).toBeNull();
    const sync = new SimJob(league, { kind: 'week' }, { simulator: fallbackSimulator }).runToEnd();
    expect(JSON.stringify(job.result.league)).toBe(JSON.stringify(sync.league));
  }, 60000);

  it('a silent worker pool times out and the week is redone on this thread (no endless wait)', async () => {
    const league = leagueAt(43, 'regularSeason');
    const timers: (() => void)[] = [];
    const pool = createSimWorkerPool(() => ({ postMessage: () => undefined, terminate: () => undefined, onmessage: null, onerror: null }), {
      size: 2, idleMs: 0, jobTimeoutMs: 1000, setTimer: (cb) => timers.push(cb), clearTimer: () => undefined,
    });
    const job = new SimJob(league, { kind: 'week' }, { simulator: fallbackSimulator, remote: pool });
    expect(job.step()).toBe(false);
    expect(job.waiting).toBe(true);
    const settled = job.settled();
    timers[0]!();
    await settled;
    await runAsync(job);
    expect(job.offThread).toBe(false);
    expect(job.result.error).toBeNull();
    const sync = new SimJob(league, { kind: 'week' }, { simulator: fallbackSimulator }).runToEnd();
    expect(JSON.stringify(job.result.league)).toBe(JSON.stringify(sync.league));
  }, 60000);

  it('a simulation error from the worker fails the job without applying anything', async () => {
    const league = leagueAt(43, 'regularSeason');
    const job = new SimJob(league, { kind: 'week' }, {
      simulator: fallbackSimulator, remote: inlineAsyncSimulator(() => { throw new Error('bad setup'); }),
    });
    await runAsync(job);
    expect(job.result.error).toBe('bad setup');
    expect(job.result.league).toBe(league);
  }, 30000);
});
