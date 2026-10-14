/**
 * Web Worker entry (module worker) of the league simulator: every message is one game, played by the same real
 * whole-game simulator the in-thread path uses (franchise/sim-real.ts), so results are identical. Spawned by
 * ./sim-workers.ts; the protocol lives in ./sim-worker-protocol.ts.
 */
import { realGameSimulator } from '@/franchise/sim-real';
import { answerSimRequest, type SimWorkerResponse } from './sim-worker-protocol';

/** The slice of the dedicated-worker global this entry uses. */
interface WorkerScope {
  onmessage: ((ev: MessageEvent<unknown>) => void) | null;
  postMessage(msg: SimWorkerResponse): void;
}

const scope = self as unknown as WorkerScope;
scope.onmessage = (ev: MessageEvent<unknown>): void => scope.postMessage(answerSimRequest(ev.data, realGameSimulator));
