/**
 * Off-main-thread league simulation. An AsyncGameSimulator plays one game per call and answers with a Promise; the
 * browser one is a small pool of module Web Workers (./sim-worker.ts) that each run the real simulator, so the
 * page keeps drawing while a week is simulated. The pool hands each worker one game at a time (the rest wait in a
 * queue, which a cancel empties), spawns workers lazily, terminates them after a spell of idleness (their heaps
 * hold the whole engine) and marks itself broken when a worker fails to load or crashes: every waiting game is
 * rejected with a SimWorkerError and later jobs fall back to the synchronous simulator. A watchdog treats a worker
 * that stays silent past `jobTimeoutMs`, a message that cannot be deserialized (`messageerror`) and an error reply
 * that names no running game (the protocol's id -1 'malformed request') as the same kind of failure, so a wedged or
 * killed worker can never leave a sim waiting forever (the non-cancellable overlays depend on this).
 *
 * `sharedSimWorkers()` is the app-wide pool (null where Worker does not exist: Node, tests, very old browsers).
 * `inlineAsyncSimulator` wraps any synchronous GameSimulator behind the same interface with a structured-clone round
 * trip, which is how Node tests prove the worker path gives exactly the in-thread results.
 */
import type { GameSimOptions, GameSimResult, GameSimulator } from '@/franchise/sim-seam';
import type { GameSetup } from '@/game/types';
import type { SimWorkerRequest, SimWorkerResponse } from './sim-worker-protocol';

/** A simulator that plays games somewhere else and answers asynchronously. */
export interface AsyncGameSimulator {
  simulate(setup: GameSetup, opts?: GameSimOptions): Promise<GameSimResult>;
  /** Rejects every game still waiting in the queue (games already running finish; their results are dropped). */
  cancelQueued(): void;
  /** True once the pool cannot simulate any more (a worker failed); callers use the synchronous path instead. */
  readonly broken: boolean;
  /** Terminates the workers and rejects everything outstanding. */
  dispose(): void;
}

/** Why a worker-backed game did not finish: the worker failed (`kind: 'worker'`) or the game was cancelled. */
export class SimWorkerError extends Error {
  constructor(message: string, readonly kind: 'worker' | 'cancelled' | 'simulation') {
    super(message);
    this.name = 'SimWorkerError';
  }
}

/** The part of a Worker the pool uses (a test double implements just this). */
export interface WorkerLike {
  postMessage(msg: SimWorkerRequest): void;
  terminate(): void;
  onmessage: ((ev: { data: SimWorkerResponse }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  /** Fired when a message from the worker cannot be deserialized (real Workers have it; test doubles may not). */
  onmessageerror?: ((ev: unknown) => void) | null;
}

/** Pool options. */
export interface SimWorkerPoolOptions {
  /** Workers at most (default 2). */
  size?: number;
  /** Milliseconds without work after which idle workers are terminated (default 30000; 0 keeps them). */
  idleMs?: number;
  /**
   * Milliseconds a worker may take over one game before the pool gives up on it (default DEFAULT_JOB_TIMEOUT_MS;
   * 0 disables). A real game takes well under a second in a worker, so only a wedged or killed worker hits it.
   */
  jobTimeoutMs?: number;
  /** Timer seam (default setTimeout / clearTimeout). */
  setTimer?: (cb: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

interface Job {
  req: SimWorkerRequest;
  resolve(r: GameSimResult): void;
  reject(e: Error): void;
}

interface Slot {
  worker: WorkerLike;
  job: Job | null;
  /** Watchdog of the running job (null when idle or disabled). */
  timer: unknown;
}

/** Default watchdog: generous next to the ~0.25-0.5 s a game takes, even with a cold worker on a swapping machine. */
export const DEFAULT_JOB_TIMEOUT_MS = 45_000;

/** A pool of simulation workers created by `spawn` (see the module header). */
export const createSimWorkerPool = (spawn: () => WorkerLike, opts: SimWorkerPoolOptions = {}): AsyncGameSimulator => {
  const size = Math.max(1, Math.floor(opts.size ?? 2));
  const idleMs = opts.idleMs ?? 30_000;
  const jobTimeoutMs = opts.jobTimeoutMs ?? DEFAULT_JOB_TIMEOUT_MS;
  const setTimer = opts.setTimer ?? ((cb: () => void, ms: number): unknown => setTimeout(cb, ms));
  const clearTimer = opts.clearTimer ?? ((h: unknown): void => clearTimeout(h as ReturnType<typeof setTimeout>));
  const slots: Slot[] = [];
  const queue: Job[] = [];
  let nextId = 1;
  let broken = false;
  let idleTimer: unknown = null;

  const disarm = (slot: Slot): void => {
    if (slot.timer !== null) clearTimer(slot.timer);
    slot.timer = null;
  };

  const rejectAll = (err: SimWorkerError, includeRunning: boolean): void => {
    for (const job of queue.splice(0)) job.reject(err);
    if (!includeRunning) return;
    for (const s of slots) {
      disarm(s);
      s.job?.reject(err);
      s.job = null;
    }
  };

  const terminateAll = (): void => {
    for (const s of slots.splice(0)) {
      disarm(s);
      s.worker.onmessage = null;
      s.worker.onerror = null;
      s.worker.onmessageerror = null;
      s.worker.terminate();
    }
  };

  const fail = (message: string): void => {
    broken = true;
    rejectAll(new SimWorkerError(message, 'worker'), true);
    terminateAll();
  };

  const armIdle = (): void => {
    if (idleTimer !== null) clearTimer(idleTimer);
    idleTimer = null;
    if (idleMs <= 0 || queue.length > 0 || slots.some((s) => s.job)) return;
    idleTimer = setTimer(() => {
      idleTimer = null;
      if (queue.length === 0 && slots.every((s) => !s.job)) terminateAll();
    }, idleMs);
  };

  const pump = (): void => {
    while (!broken && queue.length > 0) {
      let slot = slots.find((s) => !s.job);
      if (!slot && slots.length < size) {
        try {
          slot = addSlot();
        } catch (err) {
          fail(`sim worker could not start: ${err instanceof Error ? err.message : String(err)}`);
          return;
        }
      }
      if (!slot) break;
      const job = queue.shift() as Job;
      slot.job = job;
      try {
        slot.worker.postMessage(job.req);
      } catch (err) {
        fail(`sim worker rejected a game: ${err instanceof Error ? err.message : String(err)}`);
        return;
      }
      if (jobTimeoutMs > 0) {
        const running = slot;
        running.timer = setTimer(() => {
          running.timer = null;
          if (running.job === job) fail('sim worker timed out');
        }, jobTimeoutMs);
      }
    }
    armIdle();
  };

  const addSlot = (): Slot => {
    const slot: Slot = { worker: spawn(), job: null, timer: null };
    slot.worker.onmessage = (ev) => {
      const msg = ev.data;
      const job = slot.job;
      if (!job || !msg) return;
      if (msg.id !== job.req.id) {
        // An error that names no running game (id -1: the worker could not read the request) would otherwise
        // leave the running game unanswered forever.
        if (msg.type === 'error') fail(`sim worker failed: ${msg.message}`);
        return;
      }
      disarm(slot);
      slot.job = null;
      if (msg.type === 'result') job.resolve(msg.result);
      else job.reject(new SimWorkerError(msg.message, 'simulation'));
      pump();
    };
    slot.worker.onerror = (ev) => {
      const detail = ev && typeof ev === 'object' && 'message' in ev ? String((ev as { message: unknown }).message) : 'unknown error';
      fail(`sim worker failed: ${detail}`);
    };
    slot.worker.onmessageerror = () => fail('sim worker message could not be read');
    slots.push(slot);
    return slot;
  };

  return {
    get broken() { return broken; },
    simulate(setup, simOpts = {}) {
      if (broken) return Promise.reject(new SimWorkerError('sim worker unavailable', 'worker'));
      return new Promise<GameSimResult>((resolve, reject) => {
        queue.push({ req: { type: 'simulate', id: nextId++, setup, opts: simOpts }, resolve, reject });
        pump();
      });
    },
    cancelQueued() {
      rejectAll(new SimWorkerError('cancelled', 'cancelled'), false);
      armIdle();
    },
    dispose() {
      if (idleTimer !== null) clearTimer(idleTimer);
      idleTimer = null;
      rejectAll(new SimWorkerError('sim workers disposed', 'cancelled'), true);
      terminateAll();
    },
  };
};

/**
 * A synchronous simulator behind the async interface: each game's setup and result go through structuredClone
 * (what postMessage does) and the answer arrives on a later macrotask, like a worker's. Used by tests and as a
 * reference for the worker path's determinism.
 */
export const inlineAsyncSimulator = (simulator: GameSimulator): AsyncGameSimulator => {
  let pending: { reject(e: Error): void; timer: ReturnType<typeof setTimeout> }[] = [];
  return {
    broken: false,
    simulate(setup, opts = {}) {
      return new Promise<GameSimResult>((resolve, reject) => {
        const entry = {
          reject,
          timer: setTimeout(() => {
            pending = pending.filter((p) => p !== entry);
            try {
              resolve(structuredClone(simulator(structuredClone(setup), structuredClone(opts))));
            } catch (err) {
              reject(new SimWorkerError(err instanceof Error ? err.message : String(err), 'simulation'));
            }
          }, 0),
        };
        pending.push(entry);
      });
    },
    cancelQueued() {
      for (const p of pending.splice(0)) {
        clearTimeout(p.timer);
        p.reject(new SimWorkerError('cancelled', 'cancelled'));
      }
    },
    dispose() { this.cancelQueued(); },
  };
};

/** Workers for this machine: one fewer than its cores, between 1 and 3 (each holds a copy of the engine). */
export const poolSizeFor = (hardwareConcurrency: number | undefined): number => Math.max(1, Math.min(3, Math.floor(hardwareConcurrency ?? 2) - 1));

let shared: AsyncGameSimulator | null | undefined;

/**
 * The app's shared simulation pool, created on first use; null when this environment has no module Worker support
 * (the SimJob then simulates on the calling thread). A broken pool is replaced by null for the rest of the session.
 */
export const sharedSimWorkers = (): AsyncGameSimulator | null => {
  if (shared?.broken) shared = null;
  if (shared !== undefined) return shared;
  if (typeof Worker === 'undefined') return (shared = null);
  const cores = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency : undefined;
  // Vite bundles the entry as a separate module worker because of this exact `new Worker(new URL(...))` form.
  shared = createSimWorkerPool(() => new Worker(new URL('./sim-worker.ts', import.meta.url), { type: 'module' }) as unknown as WorkerLike, { size: poolSizeFor(cores) });
  return shared;
};
