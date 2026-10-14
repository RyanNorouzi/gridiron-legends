/**
 * Developer overlays. `buildOverlayModel` turns a PlayState into plain data per overlay kind (pure, testable in Node):
 * hitboxes (body radius and tackle reach), player ids / numbers / roles, receiver routes (routePath from the play-local
 * alignment), coverage (man lines defender -> receiver, zone landmarks via zoneLandmark), AI decisions (the per-tick
 * intent debug labels), key attributes of the athlete under the pointer (else the controlled one) and the ball's
 * flight (predicted landing point, height). The draw functions (./overlay-draw, re-exported here) render a model
 * through the camera with the pixel primitives the field view uses.
 */
import { vec2, type Vec2 } from '@/core/vec2';
import { findAthlete } from '@/game/athlete';
import type { BallKind, BallPhase, Athlete, PlayState } from '@/game/play-types';
import type { Side } from '@/game/types';
import { DIVE_REACH, TACKLE_REACH } from '@/game/systems/tackle';
import { predictLanding } from '@/physics/ball';
import { POSITION_GROUP, type AttributeKey, type PositionGroup } from '@/players/types';
import { fieldToLocal, localToField, routePath } from '@/playbook/transform';
import type { DefAssignment, OffAssignment, RouteDef, ZoneName } from '@/playbook/types';
import { zoneLandmark } from '@/playbook/zones';
import type { OverlayKind } from './dev-state';

/** Collision body and tackle reach of one athlete. */
export interface HitboxShape {
  id: string;
  center: Vec2;
  /** Body (collision) radius, yards. */
  radius: number;
  /** Radius inside which he makes tackle contact: body + TACKLE_REACH (DIVE_REACH while diving). */
  reach: number;
  side: Side;
  controlled: boolean;
  hasBall: boolean;
  active: boolean;
}

/** A text tag anchored to an athlete (ids, AI decisions). */
export interface OverlayLabel {
  id: string;
  pos: Vec2;
  text: string;
  side: Side;
}

/** A receiver's route as an absolute polyline. */
export interface RouteLine {
  id: string;
  routeId: string;
  /** Alignment first, then every waypoint (absolute field points). */
  points: Vec2[];
  /** Waypoints already passed (the AI's route index). */
  reached: number;
}

/** Man coverage: defender -> the receiver he is on. */
export interface ManLine {
  defenderId: string;
  receiverId: string;
  from: Vec2;
  to: Vec2;
}

/** Zone coverage: the zone's landmark box and the defender responsible. */
export interface ZoneMark {
  defenderId: string;
  zone: ZoneName;
  from: Vec2;
  center: Vec2;
  halfWidth: number;
  /** Absolute y of the zone's near and far depth edges. */
  nearY: number;
  farY: number;
}

/** Every coverage assignment on the field. */
export interface CoverageModel {
  man: ManLine[];
  zones: ZoneMark[];
}

/** One rating on the attribute card. */
export interface AttributeRow {
  key: AttributeKey;
  label: string;
  /** Effective rating this tick (fatigue / weather / injury applied). */
  value: number;
  base: number;
}

/** Attribute card of one athlete. */
export interface AttributePanel {
  athleteId: string;
  source: 'pointer' | 'controlled' | 'carrier';
  title: string;
  status: string;
  rows: AttributeRow[];
}

/** The ball and, when airborne, where it comes down. */
export interface BallModel {
  pos: Vec2;
  z: number;
  phase: BallPhase;
  kind: BallKind;
  carrierId: string | null;
  /** Where an airborne ball comes down (predictLanding) and in how many ticks. */
  landing: Vec2 | null;
  landingTicks: number | null;
  /** The throw's aim point, when there is one. */
  target: Vec2 | null;
}

/** Everything the overlays draw this frame (kinds not requested stay empty). */
export interface OverlayModel {
  kinds: OverlayKind[];
  hitboxes: HitboxShape[];
  ids: OverlayLabel[];
  routes: RouteLine[];
  coverage: CoverageModel;
  ai: OverlayLabel[];
  attributes: AttributePanel | null;
  ball: BallModel | null;
}

/** Extra data the overlays need beyond the PlayState. */
export interface OverlayInputs {
  /** Role -> materialized route (the session's LivePlayMeta.routes). */
  routes?: Record<string, RouteDef>;
  /** Fallback lookup by the assignment's route id. */
  routeById?: (id: string) => RouteDef | undefined;
  /** World point under the pointer (attributes overlay picks the athlete there). */
  pointer?: Vec2 | null;
}

/* ------------------------------------------ builders ------------------------------------------ */

/** Body radius and tackle reach for every athlete. */
export const hitboxModel = (play: PlayState): HitboxShape[] =>
  play.athletes.map((a) => ({
    id: a.id, center: vec2(a.pos.x, a.pos.y), radius: a.radius, reach: a.radius + (a.state === 'diving' ? DIVE_REACH : TACKLE_REACH),
    side: a.side, controlled: a.controlled, hasBall: a.hasBall, active: a.active,
  }));

/** '#12 WR1' (+ '*' for the controlled athlete). */
export const idLabels = (play: PlayState): OverlayLabel[] =>
  play.athletes.map((a) => ({ id: a.id, pos: vec2(a.pos.x, a.pos.y), text: `#${a.number} ${a.role}${a.controlled ? '*' : ''}`, side: a.side }));

const routeIdOf = (a: Athlete): string | undefined => {
  const asg = a.assignment as OffAssignment;
  if (asg.type === 'route') return asg.route;
  if (asg.type === 'chipRelease') return asg.releaseRoute;
  return undefined;
};

/** Play-local alignment the AI captured at the snap, else the athlete's current spot (pre-snap it IS the alignment). */
const alignmentOf = (a: Athlete, play: PlayState): Vec2 => {
  const sc = a.ai.scratch;
  if (sc.alignSet === 1) return vec2(sc.alignX ?? 0, sc.alignY ?? 0);
  return fieldToLocal(a.pos, play.ctx.ballX, play.losY, play.ctx.direction);
};

/** Routes of every active route runner, from his play-local alignment through each waypoint. */
export const routeLines = (play: PlayState, inputs: OverlayInputs = {}): RouteLine[] => {
  const out: RouteLine[] = [];
  const { ballX, direction } = play.ctx;
  for (const a of play.athletes) {
    if (a.side !== 'offense' || !a.active) continue;
    const id = routeIdOf(a);
    if (!id) continue;
    const route = inputs.routes?.[a.role] ?? inputs.routeById?.(id);
    if (!route || route.waypoints.length === 0) continue;
    const align = alignmentOf(a, play);
    const start = localToField(align, ballX, play.losY, direction);
    out.push({ id: a.id, routeId: route.id, points: [start, ...routePath(route, align, ballX, play.losY, direction)], reached: a.ai.routeIndex });
  }
  return out;
};

/** The receiver a man defender is on: the AI's current target, else his assignment's role. */
const manTargetOf = (d: Athlete, play: PlayState): Athlete | null => {
  const tracked = findAthlete(play, d.ai.targetAthleteId);
  if (tracked && tracked.side !== d.side) return tracked;
  const role = (d.assignment as DefAssignment).manTarget;
  return role ? play.athletes.find((o) => o.side !== d.side && o.role === role) ?? null : null;
};

/** Man lines and zone landmarks of the defense. */
export const coverageModel = (play: PlayState): CoverageModel => {
  const man: ManLine[] = [];
  const zones: ZoneMark[] = [];
  const dir = play.ctx.direction;
  for (const d of play.athletes) {
    if (d.side !== 'defense' || !d.active) continue;
    const asg = d.assignment as DefAssignment;
    if (asg.type === 'manCover') {
      const r = manTargetOf(d, play);
      if (r) man.push({ defenderId: d.id, receiverId: r.id, from: vec2(d.pos.x, d.pos.y), to: vec2(r.pos.x, r.pos.y) });
    } else if (asg.type === 'zone' && asg.zone) {
      const lm = zoneLandmark(asg.zone, play.losY, dir);
      zones.push({
        defenderId: d.id, zone: asg.zone, from: vec2(d.pos.x, d.pos.y), center: lm.center, halfWidth: lm.halfWidth,
        nearY: play.losY + dir * lm.depthMin, farY: play.losY + dir * lm.depthMax,
      });
    }
  }
  return { man, zones };
};

/** 'man WR1 !tackle' style: the intent's debug label plus its action, capped for the pixel font. */
export const aiLabels = (play: PlayState, maxChars = 18): OverlayLabel[] => {
  const out: OverlayLabel[] = [];
  for (const a of play.athletes) {
    const it = play.intents[a.id];
    if (!it || !a.active) continue;
    const text = `${it.debug}${it.action ? ` !${it.action}` : ''}`.toUpperCase();
    out.push({ id: a.id, pos: vec2(a.pos.x, a.pos.y), text: text.length > maxChars ? text.slice(0, maxChars) : text, side: a.side });
  }
  return out;
};

const ATTR_LABEL: Readonly<Partial<Record<AttributeKey, string>>> = {
  speed: 'SPD', acceleration: 'ACC', agility: 'AGI', strength: 'STR', awareness: 'AWR', throwPower: 'THP', throwAccuracy: 'THA',
  vision: 'VIS', carrying: 'CAR', balance: 'BAL', catching: 'CTH', hands: 'HND', routeRunning: 'RTE', release: 'REL', blocking: 'BLK',
  passRush: 'PRS', tackling: 'TAK', pursuit: 'PUR', coverage: 'COV', jumping: 'JMP', reaction: 'RCT', kickPower: 'KPW', kickAccuracy: 'KAC',
};

const COMMON_KEYS: readonly AttributeKey[] = ['speed', 'acceleration', 'agility', 'strength', 'awareness'];
const GROUP_KEYS: Readonly<Record<PositionGroup, readonly AttributeKey[]>> = {
  QB: ['throwPower', 'throwAccuracy', 'vision'], RB: ['carrying', 'balance', 'vision'], WR: ['catching', 'hands', 'routeRunning', 'release'],
  TE: ['catching', 'blocking', 'routeRunning'], OL: ['blocking', 'balance'], DL: ['passRush', 'tackling'], LB: ['tackling', 'pursuit', 'coverage'],
  DB: ['coverage', 'reaction', 'jumping'], ST: ['kickPower', 'kickAccuracy'],
};

/** Key ratings for a position: the athletic core plus the position group's skills. */
export const keyAttributesFor = (a: Pick<Athlete, 'position'>): AttributeKey[] => [...COMMON_KEYS, ...(GROUP_KEYS[POSITION_GROUP[a.position]] ?? [])];

/** Athlete whose centre is nearest the pointer, within `pickRadius` yards. */
export const athleteAt = (play: PlayState, p: Vec2, pickRadius = 1.2): Athlete | null => {
  let best: Athlete | null = null;
  let bd = pickRadius;
  for (const a of play.athletes) {
    const d = Math.hypot(a.pos.x - p.x, a.pos.y - p.y);
    if (d <= bd) {
      best = a;
      bd = d;
    }
  }
  return best;
};

/** Card for the athlete under the pointer, else the controlled one, else the ball carrier (null for none). */
export const attributePanel = (play: PlayState, pointer: Vec2 | null = null): AttributePanel | null => {
  const hovered = pointer ? athleteAt(play, pointer) : null;
  const controlled = findAthlete(play, play.controlledId);
  const carrier = findAthlete(play, play.ball.carrierId);
  const a = hovered ?? controlled ?? carrier;
  if (!a) return null;
  const source = a === hovered ? 'pointer' : a === controlled ? 'controlled' : 'carrier';
  const rows = keyAttributesFor(a).map((key) => ({ key, label: ATTR_LABEL[key] ?? key.slice(0, 3).toUpperCase(), value: Math.round(a.attrs[key]), base: Math.round(a.baseAttrs[key]) }));
  return {
    athleteId: a.id, source, title: `#${a.number} ${a.role} ${a.name}`.toUpperCase(),
    status: `FAT ${Math.round(a.fatigue * 100)}% BURST ${Math.round(a.burst * 100)}% ${a.state.toUpperCase()}`, rows,
  };
};

/** Ball position / height / phase plus the predicted landing of an airborne ball. */
export const ballModel = (play: PlayState): BallModel => {
  const b = play.ball;
  const airborne = (b.phase === 'inAir' || b.phase === 'loose') && (b.z > 0 || b.vz > 0);
  const land = airborne ? predictLanding(b, play.ctx.weather, 0) : null;
  return {
    pos: vec2(b.pos.x, b.pos.y), z: b.z, phase: b.phase, kind: b.kind, carrierId: b.carrierId,
    landing: land ? land.pos : null, landingTicks: land ? land.ticks : null, target: b.targetPos ? vec2(b.targetPos.x, b.targetPos.y) : null,
  };
};

/** Builds only the requested overlays (the rest stay empty / null). */
export const buildOverlayModel = (play: PlayState, kinds: ReadonlySet<OverlayKind>, inputs: OverlayInputs = {}): OverlayModel => ({
  kinds: [...kinds],
  hitboxes: kinds.has('hitboxes') ? hitboxModel(play) : [],
  ids: kinds.has('ids') ? idLabels(play) : [],
  routes: kinds.has('routes') ? routeLines(play, inputs) : [],
  coverage: kinds.has('coverage') ? coverageModel(play) : { man: [], zones: [] },
  ai: kinds.has('ai') ? aiLabels(play) : [],
  attributes: kinds.has('attributes') ? attributePanel(play, inputs.pointer ?? null) : null,
  ball: kinds.has('ball') ? ballModel(play) : null,
});

export { drawAttributePanel, drawDevBadge, drawOverlays, type OverlayDrawCtx } from './overlay-draw';
