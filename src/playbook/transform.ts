import type { Vec2 } from '@/core/vec2';
import type { Direction } from '@/game/types';
import type { DefensiveFormation, FormationSlot, OffensiveFormation, RouteDef } from './types';

/**
 * Play-local <-> absolute field transforms. Play-local frame: origin at the ball on the LOS, +x = offense's
 * right, +y = downfield. Absolute: absX = ballX + dir * x, absY = losY + dir * y (see game/types.ts).
 */
export const localToField = (local: Vec2, ballX: number, losY: number, dir: Direction): Vec2 => ({
  x: ballX + dir * local.x,
  y: losY + dir * local.y,
});

export const fieldToLocal = (field: Vec2, ballX: number, losY: number, dir: Direction): Vec2 => ({
  x: dir * (field.x - ballX),
  y: dir * (field.y - losY),
});

/** Absolute position of every slot, keyed by role. Works for offensive and defensive formations. */
export const formationToField = (
  formation: Pick<OffensiveFormation, 'slots'> | Pick<DefensiveFormation, 'slots'>,
  ballX: number,
  losY: number,
  dir: Direction,
): Record<string, Vec2> => {
  const out: Record<string, Vec2> = {};
  for (const s of formation.slots) out[s.role] = localToField({ x: s.x, y: s.y }, ballX, losY, dir);
  return out;
};

/** Play-local position of a slot (helper for callers that only have the formation). */
export const slotLocal = (slot: FormationSlot): Vec2 => ({ x: slot.x, y: slot.y });

/**
 * Absolute waypoints of a route run from `alignment` (the receiver's play-local alignment). The route must
 * already be materialized (mirror/flip resolved by the loader).
 */
export const routePath = (route: RouteDef, alignment: Vec2, ballX: number, losY: number, dir: Direction): Vec2[] =>
  route.waypoints.map((w) => localToField({ x: alignment.x + w.dx, y: alignment.y + w.dy }, ballX, losY, dir));

/** Index of the primary break waypoint (the `isBreak` one, else the last waypoint). */
export const routeBreakIndex = (route: RouteDef): number => {
  const i = route.waypoints.findIndex((w) => w.isBreak);
  return i >= 0 ? i : route.waypoints.length - 1;
};

/** Absolute position of the primary break; null for an empty route. */
export const routeBreakPoint = (route: RouteDef, alignment: Vec2, ballX: number, losY: number, dir: Direction): Vec2 | null => {
  if (route.waypoints.length === 0) return null;
  const w = route.waypoints[routeBreakIndex(route)];
  if (!w) return null;
  return localToField({ x: alignment.x + w.dx, y: alignment.y + w.dy }, ballX, losY, dir);
};

/** Total path length of a route in yards (used for timing estimates). */
export const routeLength = (route: RouteDef): number => {
  let total = 0;
  let px = 0;
  let py = 0;
  for (const w of route.waypoints) {
    total += Math.hypot(w.dx - px, w.dy - py);
    px = w.dx;
    py = w.dy;
  }
  return total;
};

/** Yards downfield (play-local, along the offense's direction) of an absolute point relative to the LOS. */
export const depthFromLos = (field: Vec2, losY: number, dir: Direction): number => dir * (field.y - losY);

/** Lateral tolerance (yards) when pairing a slot with its mirror image. */
const MIRROR_PAIR_TOLERANCE = 4;

/**
 * Bijective map role -> mirror-image role for the eligible slots of a formation: same position, slot within
 * MIRROR_PAIR_TOLERANCE of (-x, y), closest pairs matched first. Slots without a distinct twin (backs at x = 0, a
 * lone TE) are omitted. Used when a defensive play is flipped so man assignments follow the receiver on the new side.
 */
export const mirrorRoleMap = (formation: Pick<OffensiveFormation, 'slots'>): Record<string, string> => {
  const slots = formation.slots.filter((s) => s.eligible);
  const pairs: { a: FormationSlot; b: FormationSlot; d: number }[] = [];
  for (let i = 0; i < slots.length; i++) {
    for (let j = i + 1; j < slots.length; j++) {
      const a = slots[i];
      const b = slots[j];
      if (a.position !== b.position) continue;
      const d = Math.hypot(a.x + b.x, a.y - b.y);
      if (d < MIRROR_PAIR_TOLERANCE) pairs.push({ a, b, d });
    }
  }
  pairs.sort((p, q) => p.d - q.d);
  const map: Record<string, string> = {};
  for (const { a, b } of pairs) {
    if (map[a.role] || map[b.role]) continue;
    map[a.role] = b.role;
    map[b.role] = a.role;
  }
  return map;
};
