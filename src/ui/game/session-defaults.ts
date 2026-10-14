/**
 * Wiring layer: the ONLY place the real play engine, fast sim and AI registration are imported. The
 * playcaller and coach hooks are the AI modules (playcaller-ai.ts). Screens and
 * the session depend on the seams in session-types.ts; the app composes them here.
 */
import { registerAll } from '@/ai/register';
import type { AudioManager } from '@/audio/index';
import type { Settings } from '@/core/settings';
import { createPlayEngine } from '@/game/play-engine';
import type { ReplayRecording, ReplayRetention, ReplayStore } from '@/game/play-types';
import type { GameSetup } from '@/game/types';
import { loadPlaybookData } from '@/playbook/loader';
import { simulatePlay } from '@/simulation/fast-sim';
import { aiCoachFor, createAiPlaycaller } from './playcaller-ai';
import { createGameSession } from './session';
import type { GameSession, SessionDeps, SessionEvent } from './session-types';
import { createWatchPolicy } from './watch-policy';

/** In-memory replay store honouring the retention setting (never persisted). */
export const createReplayStore = (retention: ReplayRetention): ReplayStore => {
  const recs: ReplayRecording[] = [];
  const limit = retention === 'off' ? 0 : retention === 'lastPlay' ? 1 : retention === 'drive' ? 16 : Number.POSITIVE_INFINITY;
  return {
    retention,
    push: (rec) => {
      if (limit === 0) return;
      recs.push(rec);
      while (recs.length > limit) recs.shift();
    },
    get: (id) => recs.find((r) => r.id === id) ?? null,
    last: () => recs[recs.length - 1] ?? null,
    clear: () => { recs.length = 0; },
  };
};

export interface DefaultSessionOptions {
  settings: Settings;
  audio?: AudioManager;
  onEvent?: (e: SessionEvent) => void;
}

let registered = false;

/** Registers the AI deciders once per process (app boot calls this; sessions call it defensively). */
export const ensureAiRegistered = (): void => {
  if (registered) return;
  registerAll();
  registered = true;
};

/** Real executors + bundled playbook data + the AI playcaller / coach hooks + default watch policy. */
export const createDefaultSessionDeps = (opts: DefaultSessionOptions, setup?: GameSetup): SessionDeps => {
  ensureAiRegistered();
  return {
    engine: createPlayEngine,
    fastSim: simulatePlay,
    playcaller: createAiPlaycaller(setup),
    coachFor: setup ? aiCoachFor(setup) : undefined,
    registry: loadPlaybookData(),
    replayStore: createReplayStore(opts.settings.replayRetention),
    audio: opts.audio,
    settings: opts.settings,
    watchPolicy: createWatchPolicy(),
    onEvent: opts.onEvent,
  };
};

/** Convenience for the app: a session over the real executors. */
export const createDefaultSession = (setup: GameSetup, opts: DefaultSessionOptions): GameSession => createGameSession(setup, createDefaultSessionDeps(opts, setup));
