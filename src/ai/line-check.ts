import { clamp01 } from '@/core/math';
import type { AthleteIntent, IntentDecider } from '@/game/engine-api';
import type { Athlete, PlayState } from '@/game/play-types';
import { otherSide } from '@/game/types';
import type { DefensiveAudibleKey } from '@/playbook/audibles';
import type { DefensivePlay } from '@/playbook/types';
import { formationPersonnel } from './scouting';
import { noiseFor } from './variance';
import { difficultyFor } from '@/game/difficulty-sides';

/**
 * The AI defense's check at the line in the live engine. Once the offense has lined up, the defense can see its
 * formation, the personnel grouping that formation carries and who is actually standing where (receivers split out,
 * tight ends and backs in the core) and nothing else: never the offense's play id, type or concept. Against a
 * spread look (empty / four or more wide) a run-stop or man-heavy call checks to its zone shift; against a heavy look
 * (three or more tight ends and backs) a light two-high or sub-package call checks to its man shift (a safety
 * rotated down: an extra run fitter) or its run blitz. Only audibles the called play defines are used (the engine
 * then resolves them against the same front, with the caller's awareness deciding whether the check gets through).
 * How often the defense makes the check is a decision of the difficulty's playcallingIq (never at rookie or pro,
 * about half the time at all-pro, most of the time at legend), rolled from a hash of the play seed so it costs no die.
 */

/** What the defense can see of the offense before the snap. */
export interface OffenseLook {
  /** Offensive formation id (visible from the alignment). */
  formation: string;
  /** Personnel grouping of that formation ('10', '11', '22', ...), null when unknown. */
  personnel: string | null;
  wideReceivers: number;
  tightEnds: number;
  backs: number;
}

/** Seconds into the pre-snap when the defense has read the offense's alignment and may check. */
export const LINE_CHECK_T = 0.3;

const HEAVY = new Set(['13', '22', '23']);
const SPREAD = new Set(['00', '10']);

/** The offense's pre-snap look from the athletes on the field and the formation they lined up in. */
export const offenseLook = (state: Pick<PlayState, 'athletes' | 'ctx'>): OffenseLook => {
  let wideReceivers = 0;
  let tightEnds = 0;
  let backs = 0;
  for (const a of state.athletes) {
    if (a.side !== 'offense' || !a.active) continue;
    if (a.position === 'WR') wideReceivers++;
    else if (a.position === 'TE') tightEnds++;
    else if (a.position === 'RB' || a.position === 'FB') backs++;
  }
  const formation = state.ctx.offensivePlay.formation;
  return { formation, personnel: formationPersonnel(formation) ?? null, wideReceivers, tightEnds, backs };
};

export const isSpreadLook = (look: OffenseLook): boolean =>
  look.wideReceivers >= 4 || look.formation === 'empty' || (look.personnel !== null && SPREAD.has(look.personnel));

export const isHeavyLook = (look: OffenseLook): boolean =>
  look.tightEnds + look.backs >= 4 || (look.personnel !== null && HEAVY.has(look.personnel));

const isRunStopCall = (p: DefensivePlay): boolean => p.tags.includes('runStop') || p.tags.includes('goalLine') || p.formation === 'goalLine';
const isLightCall = (p: DefensivePlay): boolean =>
  p.coverage === 'cover2' || p.coverage === 'cover4' || p.coverage === 'cover6' || p.formation === 'dime' || p.formation === 'prevent' || p.tags.includes('prevent');

/**
 * The audible that answers a mismatch between the call and the look, or null: spread vs a run stopper or a man call
 * -> zoneShift; heavy vs a two-high / light call -> manShift (else a run blitz). Only keys the play defines.
 */
export const lineCheckKey = (play: DefensivePlay, look: OffenseLook): DefensiveAudibleKey | null => {
  const has = (k: DefensiveAudibleKey): boolean => play.audibles?.[k] !== undefined;
  if (isSpreadLook(look) && (isRunStopCall(play) || play.family === 'man') && has('zoneShift')) return 'zoneShift';
  if (isHeavyLook(look) && isLightCall(play)) {
    if (has('manShift')) return 'manShift';
    if (has('blitz')) return 'blitz';
  }
  return null;
};

/** Share of mismatches the AI defense checks out of at the line: 0 at rookie and pro, ~0.44 all-pro, ~0.77 legend. */
export const lineCheckRate = (playcallingIq: number): number => clamp01(2.2 * (clamp01(playcallingIq) - 0.55));

const LB_ORDER: readonly string[] = ['MLB', 'OLB'];

/** The defender who makes the calls: the middle linebacker, else another linebacker, else the first defender. */
export const signalCaller = (state: Pick<PlayState, 'athletes'>): Athlete | null => {
  const defense = state.athletes.filter((a) => a.side === 'defense' && a.active);
  for (const pos of LB_ORDER) {
    const lb = defense.find((a) => a.position === pos);
    if (lb) return lb;
  }
  return defense[0] ?? null;
};

/**
 * The audible key the AI defense checks to on this snap, or null (human defense, kick snaps, no mismatch, or the
 * coordinator did not make the check this time).
 */
export const aiLineCheck = (state: PlayState): DefensiveAudibleKey | null => {
  const ctx = state.ctx;
  if (ctx.special !== 'none' && ctx.special !== 'twoPoint') return null;
  if (ctx.controllers[otherSide(ctx.offense)] === 'human') return null;
  const key = lineCheckKey(ctx.defensivePlay, offenseLook(state));
  if (!key) return null;
  return noiseFor(`${ctx.rng.seed}`, `lineCheck:${ctx.defensivePlay.id}`) < lineCheckRate(difficultyFor(ctx, otherSide(ctx.offense)).playcallingIq) ? key : null;
};

/**
 * Wraps a defensive decider: before the snap, once the offense is set (LINE_CHECK_T), the signal caller of an AI
 * defense signals the check (an 'audible' intent the engine resolves); everyone else, and every other tick, decides
 * as usual. The signal goes out once per call.
 */
export const withLineCheck = (decider: IntentDecider): IntentDecider => (athlete, state, dt) => {
  const intent: AthleteIntent = decider(athlete, state, dt);
  if (state.phase !== 'presnap' || athlete.controlled || state.time < LINE_CHECK_T) return intent;
  const s = athlete.ai.scratch;
  if (s.lineCheck === 1 || signalCaller(state)?.id !== athlete.id) return intent;
  s.lineCheck = 1;
  const key = aiLineCheck(state);
  if (!key) return intent;
  return { ...intent, action: 'audible', audible: key, debug: `check: ${key}` };
};
