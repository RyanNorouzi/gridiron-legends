import { dist, vec2 } from '@/core/vec2';
import type { Player } from '@/players/types';
import { formationToField } from '@/playbook/transform';
import { isFakePlay } from '@/playbook/special-teams';
import type { DefAssignment, OffAssignment } from '@/playbook/types';
import { createBall } from '@/physics/ball';
import { createAthlete, createPlayState } from './athlete';
import { applyCpuEdge, cpuEdgeFor } from './difficulty-sides';
import type { LivePlayOptions } from './engine-api';
import { resolveDefensiveFormation, resolveOffensiveFormation } from './play-context';
import type { AthleteId } from './play-events';
import type { Athlete, PlayContext, PlayState } from './play-types';
import { createKickMeter } from './systems/kick-meter';
import { createTrack, type EngineEnv } from './systems/env';
import { fieldY, otherSide, type Side, type TeamSide } from './types';

/**
 * createPlay: places both units from their formations at (ctx.ballX, losY), builds the athletes with their
 * assignments, puts the ball on the LOS in the 'presnap' phase, chooses the controlled athletes and creates the
 * kick meter for a human kicker. Also builds the engine-private EngineEnv the systems share.
 *
 * Kick plays: the kicking team is the offense; the ball sits on the tee at fieldY(ctx.ballOn) (the controller
 * sets ballOn to ruleset.kickoffYardLine for kickoffs and to the free-kick line after a safety). Field goals and
 * extra points hold 7 yd behind the LOS (the holder slot), punts long-snap to the punter's slot.
 */
export interface CreatedPlay {
  state: PlayState;
  env: EngineEnv;
}

const OFF_FALLBACK: OffAssignment = { type: 'passBlock' };
const DEF_FALLBACK: DefAssignment = { type: 'zone', zone: 'middleHook' };

/** contactTimer value for an athlete who has not been touched this play. */
export const NO_CONTACT_SECONDS = 10;

const isKickSpecial = (ctx: PlayContext): boolean => ctx.special !== 'none' && ctx.special !== 'twoPoint';

/** Man-coverage targets that are not on the field are reassigned to the nearest uncovered eligible receiver. */
const reassignManCoverage = (athletes: Athlete[]): void => {
  const offense = athletes.filter((a) => a.side === 'offense');
  const covered = new Set<string>();
  for (const d of athletes) {
    if (d.side !== 'defense' || d.assignment.type !== 'manCover') continue;
    const target = (d.assignment as DefAssignment).manTarget;
    if (target && offense.some((o) => o.role === target)) covered.add(target);
  }
  for (const d of athletes) {
    if (d.side !== 'defense' || d.assignment.type !== 'manCover') continue;
    const a = d.assignment as DefAssignment;
    if (a.manTarget && offense.some((o) => o.role === a.manTarget)) continue;
    const candidates = offense.filter((o) => o.eligible && !covered.has(o.role)).sort((p, q) => dist(p.pos, d.pos) - dist(q.pos, d.pos));
    const pick = candidates[0] ?? offense.filter((o) => o.eligible).sort((p, q) => dist(p.pos, d.pos) - dist(q.pos, d.pos))[0];
    if (!pick) continue;
    covered.add(pick.role);
    d.assignment = { ...a, manTarget: pick.role };
  }
};

const byAssignment = (athletes: readonly Athlete[], side: Side, type: string): Athlete | null =>
  athletes.find((a) => a.side === side && a.assignment.type === type) ?? null;

const byRole = (athletes: readonly Athlete[], side: Side, role: string): Athlete | null =>
  athletes.find((a) => a.side === side && a.role === role) ?? null;

/** Default controlled athlete for a side: offense QB (kicker on kick plays), defense FS > SS > MLB (returner on kicks). */
export const defaultControlRole = (ctx: PlayContext, athletes: readonly Athlete[], side: Side): Athlete | null => {
  const kick = isKickSpecial(ctx) && !isFakePlay(ctx.offensivePlay);
  if (side === 'offense') {
    if (kick) return byAssignment(athletes, 'offense', 'kicker') ?? byAssignment(athletes, 'offense', 'holder');
    return byAssignment(athletes, 'offense', 'qb') ?? (ctx.offensivePlay.ballCarrier ? byRole(athletes, 'offense', ctx.offensivePlay.ballCarrier) : null) ?? athletes.find((a) => a.side === 'offense') ?? null;
  }
  if (isKickSpecial(ctx)) {
    const returners = athletes.filter((a) => a.side === 'defense' && a.assignment.type === 'returner');
    const deepest = returners.sort((p, q) => ctx.direction * (q.pos.y - p.pos.y))[0];
    if (deepest) return deepest;
  }
  return byRole(athletes, 'defense', 'FS') ?? byRole(athletes, 'defense', 'SS') ?? byRole(athletes, 'defense', 'MLB') ?? athletes.find((a) => a.side === 'defense') ?? null;
};

const snapperFor = (athletes: readonly Athlete[], ball: { x: number; y: number }, qbId: AthleteId | null): AthleteId | null => {
  const ls = byAssignment(athletes, 'offense', 'longSnapper') ?? byRole(athletes, 'offense', 'C') ?? byRole(athletes, 'offense', 'LS');
  if (ls) return ls.id;
  const others = athletes.filter((a) => a.side === 'offense' && a.id !== qbId).sort((p, q) => dist(p.pos, ball) - dist(q.pos, ball));
  return others[0]?.id ?? null;
};

/** Clearance kept between a pre-snap alignment and the end line behind it. */
export const END_LINE_CLEARANCE = 0.75;

/**
 * Positions moved up to at least END_LINE_CLEARANCE in front of `endLineY`; `forward` is the direction away from that
 * end line (+1 / -1 in field y).
 */
export const insideEndLine = <K extends string>(pos: Record<K, { x: number; y: number }>, endLineY: number, forward: number): Record<K, { x: number; y: number }> => {
  const minY = endLineY + forward * END_LINE_CLEARANCE;
  const out = { ...pos };
  for (const k of Object.keys(out) as K[]) {
    const p = out[k];
    if ((p.y - minY) * forward < 0) out[k] = { x: p.x, y: minY };
  }
  return out;
};

/** Builds the presnap PlayState and the engine environment for a PlayContext. */
export const createPlay = (ctx: PlayContext, opts: LivePlayOptions = {}): CreatedPlay => {
  const dir = ctx.direction;
  const losY = fieldY(ctx.ballOn, dir);
  const toGain = Math.max(0.5, Math.min(ctx.distance, 100 - ctx.ballOn));
  const firstDownY = losY + dir * toGain;
  const registries = opts.registries ?? {};
  const offForm = resolveOffensiveFormation(ctx.offensivePlay, registries);
  const defForm = resolveDefensiveFormation(ctx.defensivePlay, registries);
  // Backed up near a goal line, deep alignments (a punter 14 yards back at his own 2) would start behind the end line,
  // i.e. out of bounds before the snap: pull them up to just inside it, as a real team would.
  const offPos = insideEndLine(formationToField(offForm, ctx.ballX, losY, dir), fieldY(-10, dir), dir);
  const defPos = insideEndLine(formationToField(defForm, ctx.ballX, losY, dir), fieldY(110, dir), -dir);
  const offFacing = dir === 1 ? Math.PI / 2 : -Math.PI / 2;
  const defense = otherSide(ctx.offense);
  const athletes: Athlete[] = [];
  const players: Record<AthleteId, Player> = {};

  for (const slot of offForm.slots) {
    const player = ctx.offenseLineup[slot.role];
    if (!player) throw new Error(`createPlay: no player in the offense lineup for role "${slot.role}"`);
    const a = createAthlete({
      player, side: 'offense', teamSide: ctx.offense, role: slot.role, pos: offPos[slot.role] ?? vec2(ctx.ballX, losY), facing: offFacing,
      assignment: ctx.offensivePlay.assignments[slot.role] ?? OFF_FALLBACK, eligible: slot.eligible === true, fatigue: ctx.fatigue[player.id] ?? 0,
    });
    athletes.push(a);
    players[a.id] = player;
  }
  for (const slot of defForm.slots) {
    const player = ctx.defenseLineup[slot.role];
    if (!player) throw new Error(`createPlay: no player in the defense lineup for role "${slot.role}"`);
    const a = createAthlete({
      player, side: 'defense', teamSide: defense, role: slot.role, pos: defPos[slot.role] ?? vec2(ctx.ballX, losY + dir * 5), facing: offFacing + Math.PI,
      assignment: ctx.defensivePlay.assignments[slot.role] ?? DEF_FALLBACK, fatigue: ctx.fatigue[player.id] ?? 0,
    });
    athletes.push(a);
    players[a.id] = player;
  }
  reassignManCoverage(athletes);
  // The CPU team's performance edge from the first presnap tick (the engine re-applies it on every refresh).
  for (const a of athletes) a.attrs = applyCpuEdge(a.attrs, cpuEdgeFor(ctx, a.teamSide));
  // Nobody has been hit yet: a fresh contactTimer of 0 would read as "in contact" (gang-tackle assists,
  // forward-progress wrap) on the first live ticks.
  for (const a of athletes) a.contactTimer = NO_CONTACT_SECONDS;

  const kickoff = ctx.special === 'kickoff' || ctx.special === 'onside';
  const ball = createBall(vec2(ctx.ballX, losY), kickoff ? 'kickoff' : 'snap');
  ball.phase = 'presnap';
  const state = createPlayState(ctx, athletes, ball, { losY, firstDownY, recordFrames: opts.recordFrames ?? false });

  // Controlled athletes: one per human side.
  for (const side of ['home', 'away'] as const) {
    if (ctx.controllers[side] !== 'human') continue;
    const athleteSide: Side = side === ctx.offense ? 'offense' : 'defense';
    let chosen: Athlete | null = null;
    if (side === ctx.userSide && ctx.controlRole) chosen = byRole(athletes, athleteSide, ctx.controlRole);
    chosen = chosen ?? defaultControlRole(ctx, athletes, athleteSide);
    if (!chosen) continue;
    chosen.controlled = true;
    state.controlledIds[side] = chosen.id;
  }
  state.controlledId = ctx.userSide ? (state.controlledIds[ctx.userSide] ?? null) : null;

  const qb = byAssignment(athletes, 'offense', 'qb') ?? (ctx.special === 'punt' ? byAssignment(athletes, 'offense', 'kicker') : null) ?? byAssignment(athletes, 'offense', 'holder');
  const kicker = byAssignment(athletes, 'offense', 'kicker');
  const holder = byAssignment(athletes, 'offense', 'holder');
  const realKick = isKickSpecial(ctx) && !isFakePlay(ctx.offensivePlay);
  if (realKick && kicker && kicker.controlled) state.kickMeter = createKickMeter();
  const carrierRole = ctx.offensivePlay.ballCarrier;
  const designed = carrierRole ? byRole(athletes, 'offense', carrierRole) : null;
  const rng = ctx.rng;
  const tracks: Record<AthleteId, ReturnType<typeof createTrack>> = {};
  for (const a of athletes) tracks[a.id] = createTrack(a.pos);

  const env: EngineEnv = {
    ctx, rng, opts, dir, offSlots: offForm.slots, defSlots: defForm.slots, players,
    qbId: qb?.id ?? null,
    snapperId: kickoff ? null : snapperFor(athletes, ball.pos, qb?.id ?? null),
    kickerId: kicker?.id ?? null,
    holderId: holder?.id ?? null,
    designedCarrierId: designed && designed.id !== qb?.id ? designed.id : null,
    snapCadence: rng.range(0.9, 2.0),
    kickCadence: rng.range(0.7, 1.4),
    snapped: false,
    snapRequested: false,
    tracks,
    engagements: [],
    pairCooldown: {},
    blockCooldown: {},
    hitStickPress: {},
    stripPress: {},
    fairCatchSignal: {},
    invulnerableUntil: {},
    recoveryCooldown: {},
    ballStep: { hitGround: false, bounced: false, settled: false },
    penalties: [],
    injuries: [],
    injuredIds: new Set(),
    review: null,
    handoffDone: false,
    playActionFaked: false,
    pitched: false,
    passerId: null,
    releaseTime: null,
    completion: null,
    interception: null,
    sack: null,
    fumbles: [],
    muffed: false,
    rusherId: null,
    carrierHistory: [],
    lastTackle: null,
    tackleRecords: [],
    kick: null,
    kickAim: 0,
    kickReady: false,
    inputs: {},
    meterTime: 0,
    holdStart: null,
    pressureIds: new Set(),
    coverDefenderId: null,
    shedBy: {},
    possession: 'offense',
    stallTime: 0,
    progressStallTime: 0,
    liveTime: 0,
    deadTime: null,
    firstDownFlagged: false,
    audibleTried: {},
    penaltyRolled: {},
    contactPairs: {},
    slideSpot: null,
    lateHitWindowUntil: null,
  };
  return { state, env };
};

/** TeamSide of a play-side. */
export const teamSideOf = (ctx: PlayContext, side: Side): TeamSide => (side === 'offense' ? ctx.offense : otherSide(ctx.offense));
