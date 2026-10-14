/**
 * Scripted AI layer for drills. The practice decider wraps the real AI decider (ai/index decideIntent by default)
 * and overrides it per DrillScript: a JUGS quarterback that throws to the user's receiver, a quarterback who
 * targets the receiver the user covers, benched defenders for one-on-one tackling, a defense that does not rush
 * kicks. In puppet control it also turns the user's input into the puppet athlete's intent (user-control.ts).
 * AI rules hold: the decider only returns intents; `stageRep` repositions athletes once, before the snap.
 */
import type { Rng } from '@/core/rng';
import { dist, vec2, type Vec2 } from '@/core/vec2';
import { findAthlete } from '../athlete';
import { idleIntent, moveIntent, type AthleteIntent, type IntentDecider } from '../engine-api';
import type { AthleteId, ThrowType } from '../play-events';
import type { Athlete, PlayState, UserPlayInput } from '../play-types';
import { leadPoint } from '../systems/passing';
import { FIELD_WIDTH } from '../types';
import { userControl } from '../user-control';
import type { DrillScenario } from './scenarios';

/** A UserPlayInput with nothing pressed. */
export const idlePlayInput = (): UserPlayInput => ({
  move: vec2(0, 0), sprint: false, strafe: false, throwTo: null, throwType: null, juke: false, spin: false, stiffArm: false,
  hurdle: false, dive: false, slide: false, throwAway: false, snap: false, audible: null, defAudible: null, switchPlayer: false,
  switchToId: null, hitStick: false, strip: false, tackle: false, jumpSwat: false, kickPress: false, fairCatch: false, pitch: false,
});

const BLOCKING = new Set(['runBlock', 'passBlock', 'leadBlock', 'chipRelease']);
/** Yards downfield of the line the benched defenders wait in one-on-one drills. */
export const BENCH_DEPTH = 45;

/** Seconds after the snap the scripted quarterback releases (JUGS / coverage), drawn per rep. */
export const THROW_WINDOW: Readonly<Record<'jugs' | 'coverage', readonly [number, number]>> = Object.freeze({ jugs: [1.3, 2.1], coverage: [1.5, 2.3] });

/** Throw types the JUGS machine mixes in per difficulty. */
export const JUGS_THROWS: Readonly<Record<string, readonly ThrowType[]>> = Object.freeze({
  rookie: ['touch'], pro: ['touch', 'bullet'], allPro: ['touch', 'bullet', 'lob'], legend: ['bullet', 'lob', 'touch', 'highPoint'],
});

/** What the practice decider needs from the rep that owns it. */
export interface ScriptEnv {
  scenario: DrillScenario;
  /** Rep-level rng for scripted choices (independent of the play rng). */
  rng: Rng;
  base: IntentDecider;
  /** The user's input this tick (puppet control). */
  userInput: () => UserPlayInput | null;
  /** The athlete the user drives in puppet control. */
  puppetId: AthleteId | null;
  /** The receiver the scripted quarterback throws to. */
  focusId: () => AthleteId | null;
}

const secondsSinceSnap = (s: PlayState): number => (s.snapTick < 0 ? -1 : (s.tick - s.snapTick) / 60);

const holding = (a: Athlete, s: PlayState): boolean => s.ball.phase === 'held' && s.ball.carrierId === a.id && s.pass === null;

const stripThrow = (intent: AthleteIntent): AthleteIntent =>
  intent.action === 'throw' || intent.action === 'throwAway' ? { ...intent, action: null, targetId: null, throwType: null, throwTarget: null } : intent;

/** Zone coverage target: the route runner nearest the user's defender (the quarterback attacks his zone). */
export const receiverNearest = (s: PlayState, defenderId: AthleteId | null): Athlete | null => {
  const d = findAthlete(s, defenderId);
  if (!d) return null;
  let best: Athlete | null = null;
  for (const a of s.athletes) {
    if (a.side !== 'offense' || !a.active || !a.eligible || a.assignment.type !== 'route') continue;
    if (!best || dist(a.pos, d.pos) < dist(best.pos, d.pos)) best = a;
  }
  return best;
};

/** The JUGS throw: the receiver's lead point pushed `spread` yards in a random direction, kept inbounds. */
export const jugsAim = (passer: Athlete, target: Athlete, type: ThrowType, spread: number, rng: Rng): Vec2 => {
  const lead = leadPoint(passer, target, type);
  const angle = rng.range(0, Math.PI * 2);
  const r = spread * rng.range(0.5, 1);
  return { x: Math.min(FIELD_WIDTH - 1.5, Math.max(1.5, lead.x + Math.cos(angle) * r)), y: lead.y + Math.sin(angle) * r };
};

/** Builds the practice decider for a rep. */
export const createPracticeDecider = (env: ScriptEnv): IntentDecider => {
  const { scenario, rng, base } = env;
  const script = scenario.def.script;
  const window = script === 'jugs' || script === 'coverage' ? THROW_WINDOW[script] : null;
  const throwAt = window ? rng.range(window[0], window[1]) : Number.POSITIVE_INFINITY;
  const jugsType: ThrowType = rng.pick(JUGS_THROWS[scenario.options.difficulty] ?? ['touch']);
  const spread = scenario.level.throwSpread ?? 0;
  let thrown = false;

  const scriptedQb = (a: Athlete, s: PlayState, dt: number): AthleteIntent => {
    const input = env.userInput();
    if (s.phase === 'presnap') {
      if (script === 'jugs') return input?.snap ? { ...idleIntent('jugs: snap'), action: 'snap' } : idleIntent('jugs: set');
      return base(a, s, dt);
    }
    const target = findAthlete(s, env.focusId()) ?? receiverNearest(s, s.controlledIds[scenario.userSide] ?? null);
    const ready = !thrown && holding(a, s) && secondsSinceSnap(s) >= throwAt && target !== null && target.active;
    if (ready && target) {
      thrown = true;
      const type = script === 'jugs' ? jugsType : null;
      const aim = script === 'jugs' ? jugsAim(a, target, jugsType, spread, rng) : null;
      return { ...idleIntent(`${script}: throw`), action: 'throw', targetId: target.id, throwType: type, throwTarget: aim };
    }
    if (script === 'jugs') return idleIntent(thrown ? 'jugs: done' : 'jugs: wait');
    return stripThrow(base(a, s, dt));
  };

  return (a, s, dt) => {
    if (env.puppetId !== null && a.id === env.puppetId) {
      const input = env.userInput() ?? idlePlayInput();
      const intent = userControl(a, input, s, { receiverSlots: scenario.receiverSlots });
      // The free-roam drill never snaps: the user walks during the pre-snap (a game offense stays set there).
      return script === 'freeRoam' && s.phase === 'presnap' ? { ...intent, move: { x: input.move.x, y: input.move.y }, sprint: input.sprint } : intent;
    }
    switch (script) {
      case 'live':
        return base(a, s, dt);
      case 'noRush':
        return a.side === 'defense' && a.assignment.type !== 'returner' ? idleIntent('practice: no rush') : base(a, s, dt);
      case 'oneOnOne':
        return a.side === 'defense' || BLOCKING.has(a.assignment.type) ? idleIntent('practice: stand') : base(a, s, dt);
      case 'jugs':
        if (a.side === 'offense' && a.assignment.type === 'qb') return scriptedQb(a, s, dt);
        return idleIntent('practice: stand');
      case 'freeRoam': {
        if (a.side !== 'offense' || a.assignment.type !== 'qb') return idleIntent('practice: stand');
        if (s.phase === 'presnap') return env.userInput()?.snap ? { ...idleIntent('practice: snap'), action: 'snap' } : idleIntent('practice: set');
        // Shuffle in the pocket so the play never whistles dead for a stalled carrier while the user roams.
        return moveIntent(vec2(Math.sin(s.time * 2.5) >= 0 ? 0.15 : -0.15, 0), false, 'practice: shuffle');
      }
      case 'coverage': {
        if (a.side === 'offense' && a.assignment.type === 'qb') return scriptedQb(a, s, dt);
        if (a.side === 'defense' || BLOCKING.has(a.assignment.type)) return idleIntent('practice: stand');
        return base(a, s, dt);
      }
    }
  };
};

/**
 * One-time pre-snap staging: one-on-one drills bench every defender but the user's far downfield by the sideline;
 * puppet drills mark the user's athlete as controlled for the local viewer. Returns the puppet id (or null).
 */
export const stageRep = (state: PlayState, scenario: DrillScenario): AthleteId | null => {
  const dir = state.ctx.direction;
  if (scenario.def.script === 'oneOnOne') {
    const mine = state.controlledIds[scenario.userSide] ?? null;
    let i = 0;
    for (const a of state.athletes) {
      if (a.side !== 'defense' || a.id === mine) continue;
      a.pos = vec2(1 + (i % 2) * 1.2, state.losY + dir * (BENCH_DEPTH + Math.floor(i / 2) * 1.2));
      i += 1;
    }
  }
  if (scenario.def.control !== 'puppet' || !scenario.def.controlRole) return null;
  const side = scenario.def.userUnit;
  const puppet = state.athletes.find((a) => a.side === side && a.role === scenario.def.controlRole) ?? null;
  if (!puppet) throw new Error(`practice: drill ${scenario.def.id} has no ${side} role ${scenario.def.controlRole}`);
  for (const a of state.athletes) if (a.teamSide === puppet.teamSide) a.controlled = a.id === puppet.id;
  state.controlledIds[scenario.userSide] = puppet.id;
  state.controlledId = puppet.id;
  return puppet.id;
};

/** The receiver a drill focuses on: the man the user covers, the JUGS receiver, or the primary read (null for zone). */
export const focusFor = (state: PlayState, scenario: DrillScenario, puppetId: AthleteId | null): AthleteId | null => {
  if (puppetId !== null) return puppetId;
  if (scenario.def.userUnit === 'defense') {
    const mine = findAthlete(state, state.controlledIds[scenario.userSide] ?? null);
    const target = mine && mine.assignment.type === 'manCover' && 'manTarget' in mine.assignment ? mine.assignment.manTarget : undefined;
    // Zone defenders have no fixed man: the scripted quarterback picks the receiver in the user's zone at the throw.
    return target ? `off:${target}` : null;
  }
  const primary = scenario.receiverSlots[0];
  return primary ? `off:${primary}` : null;
};
