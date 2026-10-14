/**
 * The standard wiring of the offseason orchestrator (offseason.ts OffseasonDeps) to the real market and draft
 * modules: AI re-signing (gm/roster-ai), all free-agency rounds (free-agency.ts), the whole draft including UDFAs
 * (draft.ts) and final cuts (gm/roster-fill aiFinalCuts). With `manageUserTeam` the AI also re-signs, bids in free
 * agency for and settles the user's roster (a hands-off user who sims the offseason); the user's draft picks are always auto-picked from his
 * board when the draft is simulated. Deterministic per the Rng the orchestrator passes in.
 */
import type { Rng } from '@/core/rng';
import { finishDraft, runDraftToEnd, startDraft } from './draft';
import { runFreeAgency } from './free-agency';
import { aiFinalCuts } from './gm/roster-fill';
import { runAiResigning } from './gm/roster-ai';
import type { OffseasonDeps } from './offseason';
import type { League } from './types';

/** Options of standardOffseasonDeps. */
export interface StandardOffseasonOptions {
  /** Let the AI re-sign, sign free agents for and settle the user's roster too (default false: the user's roster
   *  is the user's job). */
  manageUserTeam?: boolean;
  /** Free-agency bidding rounds (default free-agency.ts DEFAULT_FREE_AGENCY_ROUNDS). */
  freeAgencyRounds?: number;
}

/** Runs (the rest of) this year's draft: start or resume, every pick, UDFAs. No-op when it is already complete. */
export const simulateDraft = (league: League, rng: Rng): League => {
  if (league.draft && league.draft.year === league.year && league.draft.complete) return league;
  const running = runDraftToEnd(startDraft(league, rng.fork('start')), rng.fork('picks'));
  return running.draft?.complete ? running : finishDraft(running, rng.fork('finish'));
};

/** OffseasonDeps wired to the real re-signing, free-agency, draft and final-cut modules. */
export const standardOffseasonDeps = (opts: StandardOffseasonOptions = {}): OffseasonDeps => {
  const includeUser = opts.manageUserTeam ?? false;
  return {
    aiResign: (league, rng) => runAiResigning(league, rng, { includeUser }),
    runFreeAgency: (league, rng) => runFreeAgency(league, rng, { includeUser, ...(opts.freeAgencyRounds !== undefined ? { maxRounds: opts.freeAgencyRounds } : {}) }),
    runDraft: simulateDraft,
    postDraft: (league) => aiFinalCuts(league, { includeUser }),
  };
};
