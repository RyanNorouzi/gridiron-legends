import type { PlayerId } from '@/core/ids';
import { POSITION_GROUP, type Player, type Position, type PositionGroup } from '@/players/types';
import type { FormationSlot, OffensivePlay, Personnel } from '@/playbook/types';
import type { DepthSlot, Team } from '@/teams/types';
import type { GameInjury } from './types';

/**
 * Lineup selection: fills every formation slot from the team's depth chart, honouring positions with
 * sensible fallbacks (WR3 -> next WR -> TE/RB, FB from RB, OL interchange, DL/LB/DB interchange),
 * skipping injured players and rotating tired players at high-rotation positions.
 */
export interface LineupOptions {
  /** Per-game substitutions: formation role -> player (GameCommand 'substitute'). */
  overrides?: Record<string, PlayerId>;
  /** Fatigue at which a starter is rotated out when a fresher backup exists (default 0.65). */
  fatigueThreshold?: number;
  /** Backup must be at least this much fresher to rotate in (default 0.25). */
  fatigueGap?: number;
  rotate?: boolean;
  /** Index of this snap in the game (the play log length). Drives the planned backfield rotation; omit to disable it. */
  snapIndex?: number;
}

/**
 * Planned backfield rotation (a coaching plan, not fatigue): the second back takes every Nth snap, more often the
 * closer he is to the starter in overall. Even a bell-cow back with a far weaker backup sits every 7th snap, as real
 * lead backs do. Deterministic in the snap index, so games replay identically.
 */
export const backfieldRotationEvery = (starterOverall: number, backupOverall: number): number => {
  const gap = starterOverall - backupOverall;
  if (gap <= 4) return 2;
  if (gap <= 10) return 3;
  if (gap <= 18) return 5;
  return 7;
};

/** Positions that rotate when tired. */
export const ROTATION_POSITIONS: readonly Position[] = ['DE', 'DT', 'RB', 'OLB', 'WR'];

/**
 * Per-position rotation points (fatigue at which the starter comes out, and how much fresher the backup must be).
 * Backs and defensive linemen rotate the most in real football (a lead back takes roughly two thirds of the
 * backfield carries); positions not listed use the caller's / default threshold.
 */
export const POSITION_ROTATION: Readonly<Partial<Record<Position, { threshold: number; gap: number }>>> = Object.freeze({
  RB: { threshold: 0.16, gap: 0.08 },
  DE: { threshold: 0.45, gap: 0.18 },
  DT: { threshold: 0.45, gap: 0.18 },
});

/** Alternate positions tried, in order, when the depth chart at a slot's position is exhausted. */
export const FALLBACK_POSITIONS: Readonly<Record<Position, readonly Position[]>> = {
  QB: ['RB', 'WR'],
  RB: ['FB', 'WR', 'CB'],
  FB: ['RB', 'TE', 'MLB'],
  WR: ['TE', 'RB', 'CB'],
  TE: ['FB', 'WR', 'OT'],
  OT: ['OG', 'C', 'TE'],
  OG: ['OT', 'C', 'DT'],
  C: ['OG', 'OT'],
  DE: ['DT', 'OLB'],
  DT: ['DE', 'OG'],
  OLB: ['MLB', 'DE', 'SS'],
  MLB: ['OLB', 'SS'],
  CB: ['FS', 'SS', 'WR'],
  FS: ['SS', 'CB'],
  SS: ['FS', 'OLB', 'CB'],
  K: ['P'],
  P: ['K'],
};

const ROLE_POSITIONS: readonly (readonly [RegExp, Position])[] = [
  [/^QB/, 'QB'], [/^(RB|HB|TB)/, 'RB'], [/^FB/, 'FB'], [/^(WR|X$|Y$|Z$|SLOT|SL)/, 'WR'], [/^TE/, 'TE'],
  [/^(LT|RT|OT)/, 'OT'], [/^(LG|RG|OG)/, 'OG'], [/^(C|LS)$/, 'C'], [/^K$/, 'K'], [/^(P|H)$/, 'P'],
  [/^(DE|EDGE|LE|RE)/, 'DE'], [/^(DT|NT|LDT|RDT)/, 'DT'], [/^(OLB|SAM|WILL|LOLB|ROLB)/, 'OLB'], [/^(MLB|MIKE|ILB|LB)/, 'MLB'],
  [/^(CB|NCB|NB|LCB|RCB)/, 'CB'], [/^FS/, 'FS'], [/^SS/, 'SS'], [/^(KR|PR|R)$/, 'WR'], [/^G\d*$/, 'CB'], [/^KC/, 'OLB'],
];

/** Best-effort position for a formation role name (used when a formation registry is missing). */
export const inferPositionFromRole = (role: string): Position | null => {
  for (const [re, pos] of ROLE_POSITIONS) if (re.test(role)) return pos;
  return null;
};

/** Positions a punt unit's shield (the guards and tackles in front of the punter) is manned from: they block, then cover. */
export const PUNT_SHIELD_POSITIONS: readonly Position[] = ['TE', 'FB', 'OLB', 'MLB', 'DE', 'SS'];

/** A punt shield man blocks for a beat and then has to run down and tackle: blocking, tackling and speed count alike. */
export const puntShieldScore = (p: Player): number => 0.35 * p.attrs.blocking + 0.35 * p.attrs.tackling + 0.3 * p.attrs.speed;

/** Positions kick coverage (kickoff KC slots, punt gunners) is manned from: backers, defensive backs, backs and ends. */
export const KICK_COVERAGE_POSITIONS: readonly Position[] = ['OLB', 'MLB', 'SS', 'FS', 'CB', 'RB', 'FB', 'TE', 'WR'];

/** A kickoff cover man runs 50 yards and has to finish in space: a sure tackler with speed and a pursuit angle. */
export const kickCoverageScore = (p: Player): number => 0.45 * p.attrs.tackling + 0.35 * p.attrs.speed + 0.2 * p.attrs.pursuit;

/** A punt gunner beats a double team down the sideline first: speed leads, then tackling. */
export const gunnerScore = (p: Player): number => 0.5 * p.attrs.speed + 0.3 * p.attrs.tackling + 0.2 * p.attrs.pursuit;

/** Kick-coverage roles: the kickoff's KC slots, the punt's gunners (G*) and its wings / personal protector (shield). */
const isKickoffCoverRole = (role: string): boolean => /^KC\d+$/.test(role);
const isGunnerRole = (role: string): boolean => /^G\d+$/.test(role);
const isPuntShieldRole = (role: string): boolean => /^(W\d+|PP)$/.test(role);

/** Depth-chart slot to consult first for a role (returners read the KR/PR lists). */
const depthSlotForRole = (role: string, position: Position): DepthSlot => {
  if (/^KR/.test(role)) return 'KR';
  if (/^PR/.test(role)) return 'PR';
  if (role === 'R') return 'KR';
  return position;
};

type Roster = Record<PlayerId, Player>;

const injuredSet = (injuries: readonly GameInjury[] | readonly PlayerId[]): Set<PlayerId> => {
  const out = new Set<PlayerId>();
  for (const i of injuries) out.add(typeof i === 'string' ? i : i.playerId);
  return out;
};

const rosterByPosition = (team: Team, players: Roster, position: Position): Player[] =>
  team.rosterIds.map((id) => players[id]).filter((p): p is Player => p !== undefined && p.position === position).sort((a, b) => b.overall - a.overall);

const rosterByGroup = (team: Team, players: Roster, group: PositionGroup): Player[] =>
  team.rosterIds.map((id) => players[id]).filter((p): p is Player => p !== undefined && POSITION_GROUP[p.position] === group).sort((a, b) => b.overall - a.overall);

/**
 * Fills the formation from the depth chart. Throws when the roster cannot field the formation at all.
 * Returned record is keyed by formation role.
 */
export const selectLineup = (
  team: Team,
  players: Roster,
  formation: { slots: readonly FormationSlot[] },
  fatigue: Record<PlayerId, number>,
  injuries: readonly GameInjury[] | readonly PlayerId[] = [],
  opts: LineupOptions = {},
): Record<string, Player> => {
  const threshold = opts.fatigueThreshold ?? 0.65;
  const gap = opts.fatigueGap ?? 0.25;
  const rotate = opts.rotate ?? true;
  const injured = injuredSet(injuries);
  const roster = new Set<PlayerId>(team.rosterIds);
  const used = new Set<PlayerId>();
  const available = (id: PlayerId | undefined): Player | null => {
    if (!id || !roster.has(id)) return null;
    const p = players[id];
    if (!p || used.has(id) || injured.has(id) || p.injury !== null || p.retired) return null;
    return p;
  };
  const candidatesAt = (slot: DepthSlot, position: Position): Player[] => {
    const chart = (team.depthChart[slot] ?? []).map(available).filter((p): p is Player => p !== null);
    if (chart.length > 0) return chart;
    return rosterByPosition(team, players, position).filter((p) => available(p.id) !== null);
  };
  const pickRotating = (cands: Player[], position: Position): Player | null => {
    const starter = cands[0];
    if (!starter) return null;
    if (!rotate || !ROTATION_POSITIONS.includes(position)) return starter;
    const f0 = fatigue[starter.id] ?? 0;
    const pos = opts.fatigueThreshold === undefined ? POSITION_ROTATION[position] : undefined;
    if (f0 < (pos?.threshold ?? threshold)) {
      const backup = cands[1];
      if (position === 'RB' && backup && opts.snapIndex !== undefined) {
        const every = backfieldRotationEvery(starter.overall, backup.overall);
        if (every > 0 && opts.snapIndex % every === every - 1) return backup;
      }
      return starter;
    }
    const fresher = cands.slice(1).find((p) => (fatigue[p.id] ?? 0) <= f0 - (pos?.gap ?? gap));
    return fresher ?? starter;
  };

  const lineup: Record<string, Player> = {};
  // Manual overrides claim their players first, so an override naming a depth starter moves him to that role
  // (the depth chart then fills the role he would have taken) instead of being silently ignored.
  for (const slot of formation.slots) {
    const manual = available(opts.overrides?.[slot.role]);
    if (manual) {
      used.add(manual.id);
      lineup[slot.role] = manual;
    }
  }
  // A punt's interior line is not the offensive line (starting guards and tackles who then cannot run down and tackle
  // anyone): teams man it with tight ends, backs and linebackers who block first and then cover.
  const puntUnit = formation.slots.some((sl) => sl.role === 'P');
  const bestOf = (positions: readonly Position[], score: (p: Player) => number): Player | null => {
    let best: Player | null = null;
    for (const id of team.rosterIds) {
      const p = available(id);
      if (p && positions.includes(p.position) && (!best || score(p) > score(best))) best = p;
    }
    return best;
  };
  const shieldMan = (): Player | null => bestOf(PUNT_SHIELD_POSITIONS, puntShieldScore);
  // Kick coverage is manned by the roster's best cover men (sure tacklers with speed), not the depth-chart starter at
  // whatever position the formation slot names (a starting tight end or tailback on kickoff coverage).
  const kickoffUnit = formation.slots.some((sl) => sl.role === 'K') && formation.slots.some((sl) => isKickoffCoverRole(sl.role));
  const coverMan = (role: string): Player | null => {
    if (kickoffUnit && isKickoffCoverRole(role)) return bestOf(KICK_COVERAGE_POSITIONS, kickCoverageScore);
    if (puntUnit && isGunnerRole(role)) return bestOf(KICK_COVERAGE_POSITIONS, gunnerScore);
    if (puntUnit && isPuntShieldRole(role)) return shieldMan();
    return null;
  };
  for (const slot of formation.slots) {
    if (lineup[slot.role]) continue;
    const cover = coverMan(slot.role);
    if (cover) {
      used.add(cover.id);
      lineup[slot.role] = cover;
      continue;
    }
    if (puntUnit && (slot.position === 'OG' || slot.position === 'OT')) {
      const shield = shieldMan();
      if (shield) {
        used.add(shield.id);
        lineup[slot.role] = shield;
        continue;
      }
    }
    let chosen: Player | null = pickRotating(candidatesAt(depthSlotForRole(slot.role, slot.position), slot.position), slot.position);
    if (!chosen && depthSlotForRole(slot.role, slot.position) !== slot.position) chosen = pickRotating(candidatesAt(slot.position, slot.position), slot.position);
    if (!chosen) {
      for (const alt of FALLBACK_POSITIONS[slot.position]) {
        chosen = candidatesAt(alt, alt)[0] ?? null;
        if (chosen) break;
      }
    }
    if (!chosen) chosen = rosterByGroup(team, players, POSITION_GROUP[slot.position]).find((p) => available(p.id) !== null) ?? null;
    if (!chosen) chosen = team.rosterIds.map(available).find((p): p is Player => p !== null) ?? null;
    if (!chosen) throw new Error(`selectLineup: ${team.abbr} cannot fill role "${slot.role}" (${slot.position}); roster exhausted`);
    used.add(chosen.id);
    lineup[slot.role] = chosen;
  }
  return lineup;
};

/** Personnel grouping (RB count, TE count) of a play from its formation slots, or from role names. */
export const personnelFor = (play: OffensivePlay, formation?: { slots: readonly FormationSlot[]; personnel?: Personnel }): Personnel => {
  if (formation?.personnel) return formation.personnel;
  const positions: Position[] = formation
    ? formation.slots.map((s) => s.position)
    : Object.keys(play.assignments).map(inferPositionFromRole).filter((p): p is Position => p !== null);
  const rb = positions.filter((p) => p === 'RB' || p === 'FB').length;
  const te = positions.filter((p) => p === 'TE').length;
  const code = `${Math.min(rb, 2)}${Math.min(te, 3)}`;
  const valid: readonly Personnel[] = ['10', '11', '12', '13', '20', '21', '22', '00', '23'];
  return (valid as readonly string[]).includes(code) ? (code as Personnel) : '11';
};

/** Players in a lineup as an id list (for fatigue bookkeeping and snap counts). */
export const lineupIds = (lineup: Record<string, Player>): PlayerId[] => Object.values(lineup).map((p) => p.id);
