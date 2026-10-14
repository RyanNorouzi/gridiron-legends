/**
 * Message protocol between the franchise UI and the league-simulation Web Worker (./sim-worker.ts). The main thread
 * posts one game at a time: the GameSetup the week engine built (plain data, structured-cloned) plus the seam
 * options; the worker answers with the GameSimResult of the same deterministic simulator the in-thread path uses,
 * or with the error message. `answerSimRequest` is the worker's whole job, kept pure so Node tests run it directly.
 */
import type { GameSimOptions, GameSimResult, GameSimulator } from '@/franchise/sim-seam';
import type { GameSetup } from '@/game/types';

/** Main thread -> worker: simulate one game. */
export interface SimWorkerRequest {
  type: 'simulate';
  /** Request id (unique per pool), echoed in the answer. */
  id: number;
  setup: GameSetup;
  opts: GameSimOptions;
}

/** Worker -> main thread: the game's result or why it failed. */
export type SimWorkerResponse =
  | { type: 'result'; id: number; result: GameSimResult }
  | { type: 'error'; id: number; message: string };

/** True for a well-formed request (anything else is answered with an error, never simulated). */
export const isSimRequest = (msg: unknown): msg is SimWorkerRequest => {
  if (!msg || typeof msg !== 'object') return false;
  const m = msg as Partial<SimWorkerRequest>;
  return m.type === 'simulate' && typeof m.id === 'number' && !!m.setup && typeof m.setup === 'object' && typeof m.setup.id === 'string';
};

/** The worker's answer to one message: runs `simulator` on a valid request and reports errors as messages. */
export const answerSimRequest = (msg: unknown, simulator: GameSimulator): SimWorkerResponse => {
  const id = msg && typeof msg === 'object' && typeof (msg as { id?: unknown }).id === 'number' ? (msg as { id: number }).id : -1;
  if (!isSimRequest(msg)) return { type: 'error', id, message: 'sim worker: malformed request' };
  try {
    return { type: 'result', id, result: simulator(msg.setup, msg.opts ?? {}) };
  } catch (err) {
    return { type: 'error', id, message: err instanceof Error ? err.message : String(err) };
  }
};
