import formationsOffenseJson from '@/data/formations-offense.json';
import formationsDefenseJson from '@/data/formations-defense.json';
import routesJson from '@/data/routes.json';
import playsOffenseJson from '@/data/plays-offense.json';
import playsDefenseJson from '@/data/plays-defense.json';
import playbooksJson from '@/data/playbooks.json';
import { POSITIONS, type Position } from '@/players/types';
import { mirrorRoleMap } from './transform';
import {
  mirrorGap, mirrorRoute, mirrorZone,
  type DefAssignment, type DefensiveFormation, type DefensivePlay, type FormationSlot, type OffAssignment,
  type OffensiveFormation, type OffensivePlay, type Playbook, type PlaybookIssue, type RouteDef,
} from './types';

/**
 * Data-driven playbook loader. Parses src/data/*.json at the boundary, validates every cross-reference and
 * returns typed registries. `materializePlay` / `materializeDefensivePlay` resolve `flip` / `mirror` so the
 * engine and AI never see them (see the convention header in ./types.ts).
 */
export interface PlaybookRegistry {
  offensiveFormations: Record<string, OffensiveFormation>;
  defensiveFormations: Record<string, DefensiveFormation>;
  /** Authored routes plus a mirrored twin for each under `${id}${MIRROR_SUFFIX}`. */
  routes: Record<string, RouteDef>;
  offensePlays: Record<string, OffensivePlay>;
  defensePlays: Record<string, DefensivePlay>;
  playbooks: Record<string, Playbook>;
}

/** Raw (unvalidated) shape of the six data files. */
export interface RawPlaybookData {
  offensiveFormations: unknown;
  defensiveFormations: unknown;
  routes: unknown;
  offensePlays: unknown;
  defensePlays: unknown;
  playbooks: unknown;
}

/** User-authored content carried by a League save (franchise/types.ts League.custom*). */
export interface CustomPlaybookContent {
  playbooks: Playbook[];
  offense: OffensivePlay[];
  defense: DefensivePlay[];
}

export interface ResolvedPlaybook {
  playbook: Playbook;
  offense: OffensivePlay[];
  defense: DefensivePlay[];
  /** Custom plays that failed validation (excluded) and ids that could not be found. */
  issues: PlaybookIssue[];
}

/** A play with flip/mirror resolved; `routes` maps role -> concrete RouteDef for every route-running slot. */
export interface MaterializedPlay {
  play: OffensivePlay;
  formation: OffensiveFormation;
  routes: Record<string, RouteDef>;
}

export interface MaterializedDefensivePlay {
  play: DefensivePlay;
  formation: DefensiveFormation;
}

export type StrengthSide = 'left' | 'right';
export interface OffensiveStrength {
  run: StrengthSide;
  pass: StrengthSide;
}

/** Suffix of the mirrored twin registered for every authored route. */
export const MIRROR_SUFFIX = '~m';

const ROUTE_TYPES = new Set(['go', 'post', 'corner', 'out', 'in', 'dig', 'slant', 'curl', 'comeback', 'drag', 'flat', 'wheel', 'screen', 'hitch', 'seam', 'fade', 'cross', 'angle', 'stick', 'swing', 'checkRelease', 'block']);
const SCRAMBLES = new Set(['settle', 'continue', 'comeBack']);
const GAPS = new Set(['A-left', 'A-right', 'B-left', 'B-right', 'C-left', 'C-right', 'D-left', 'D-right']);
const ZONES = new Set(['deepThirdLeft', 'deepThirdMiddle', 'deepThirdRight', 'deepHalfLeft', 'deepHalfRight', 'deepQuarter1', 'deepQuarter2', 'deepQuarter3', 'deepQuarter4', 'curlFlatLeft', 'curlFlatRight', 'hookCurlLeft', 'hookCurlRight', 'flatLeft', 'flatRight', 'middleHole', 'middleHook']);
const OFF_TYPES = new Set(['qb', 'route', 'runBlock', 'passBlock', 'carry', 'leadBlock', 'chipRelease', 'kicker', 'holder', 'longSnapper', 'gunner', 'kickCoverage']);
const DEF_TYPES = new Set(['manCover', 'zone', 'blitz', 'rushGap', 'contain', 'spy', 'runFill', 'returner', 'returnBlock']);
const PLAY_TYPES = new Set(['run', 'pass', 'playAction', 'rpo', 'qbRun', 'screen', 'kneel', 'spike', 'special']);
const CONCEPTS = new Set(['insideRun', 'outsideRun', 'draw', 'screen', 'slant', 'curl', 'out', 'post', 'corner', 'go', 'cross', 'drag', 'mesh', 'fourVerts', 'playAction', 'rpo', 'qbRun', 'kneel', 'spike', 'kickoff', 'onside', 'punt', 'fieldGoal', 'extraPoint', 'fakePunt', 'fakeFieldGoal']);
const SHELLS = new Set(['cover0', 'cover1', 'cover2', 'cover3', 'cover4', 'cover6', 'cover9']);
const FAMILIES = new Set(['man', 'zone', 'match']);
const BLITZES = new Set(['none', 'lb', 'cb', 'safety', 'nickel', 'doubleAGap', 'edge', 'zone', 'allOut']);
const PERSONNEL = new Set(['10', '11', '12', '13', '20', '21', '22', '00', '23']);
const QB_ALIGNMENTS = new Set(['underCenter', 'pistol', 'shotgun']);
const TECHNIQUES = new Set(['press', 'off']);
const OFF_AUDIBLES = ['manBeater', 'zoneBeater', 'blitzBeater', 'runToPass', 'passToRun'] as const;
const DEF_AUDIBLES = ['manShift', 'zoneShift', 'blitz', 'spy'] as const;
const OL_POSITIONS = new Set<Position>(['OT', 'OG', 'C']);
const BACK_POSITIONS = new Set<Position>(['RB', 'FB']);
const RUN_TYPES = new Set(['run', 'qbRun', 'rpo']);
const PASS_TYPES = new Set(['pass', 'playAction', 'screen', 'rpo']);

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const issue = (playId: string, message: string): PlaybookIssue => ({ playId, message });

/** Shape check for a list of entities with string ids; returns the typed list or a single issue. */
const entityList = <T>(v: unknown, label: string, out: PlaybookIssue[]): T[] => {
  if (!Array.isArray(v)) {
    out.push(issue(label, `${label}: expected an array`));
    return [];
  }
  const ok: T[] = [];
  v.forEach((e, i) => {
    if (!isRecord(e) || !isStr(e.id)) out.push(issue(`${label}[${i}]`, `${label}[${i}]: entry must be an object with a string id`));
    else ok.push(e as T);
  });
  return ok;
};

const validateSlots = (id: string, slots: unknown, out: PlaybookIssue[]): FormationSlot[] => {
  if (!Array.isArray(slots)) {
    out.push(issue(id, `${id}: slots must be an array`));
    return [];
  }
  const roles = new Set<string>();
  const typed: FormationSlot[] = [];
  for (const s of slots) {
    if (!isRecord(s) || !isStr(s.role) || !isNum(s.x) || !isNum(s.y) || !POSITIONS.includes(s.position as Position)) {
      out.push(issue(id, `${id}: malformed slot ${JSON.stringify(s)}`));
      continue;
    }
    if (roles.has(s.role)) out.push(issue(id, `${id}: duplicate role ${s.role}`));
    roles.add(s.role);
    typed.push(s as unknown as FormationSlot);
  }
  if (slots.length !== 11) out.push(issue(id, `${id}: has ${slots.length} slots, expected 11`));
  return typed;
};

const validateOffensiveFormation = (f: OffensiveFormation, out: PlaybookIssue[]): void => {
  const id = `formation:${f.id}`;
  const slots = validateSlots(id, f.slots, out);
  if (!PERSONNEL.has(f.personnel)) out.push(issue(id, `${id}: invalid personnel ${f.personnel}`));
  if (!QB_ALIGNMENTS.has(f.qbAlignment)) out.push(issue(id, `${id}: invalid qbAlignment ${f.qbAlignment}`));
  const backs = slots.filter((s) => BACK_POSITIONS.has(s.position)).length;
  const tes = slots.filter((s) => s.position === 'TE').length;
  if (`${backs}${tes}` !== f.personnel) out.push(issue(id, `${id}: personnel ${f.personnel} does not match slots (${backs} backs, ${tes} TE)`));
  for (const s of slots) {
    if (s.y > 0) out.push(issue(id, `${id}: offensive slot ${s.role} must have y <= 0`));
    if (OL_POSITIONS.has(s.position) && s.eligible) out.push(issue(id, `${id}: lineman ${s.role} cannot be eligible`));
  }
  const qb = slots.find((s) => s.position === 'QB');
  if (qb) {
    if (qb.eligible) out.push(issue(id, `${id}: the QB slot is not an eligible receiver`));
    const ol = slots.filter((s) => OL_POSITIONS.has(s.position)).length;
    if (ol !== 5) out.push(issue(id, `${id}: expected 5 interior linemen, found ${ol}`));
    const eligible = slots.filter((s) => s.eligible).length;
    if (eligible !== 5) out.push(issue(id, `${id}: expected 5 eligible receivers, found ${eligible}`));
  }
};

const validateDefensiveFormation = (f: DefensiveFormation, out: PlaybookIssue[]): void => {
  const id = `formation:${f.id}`;
  const slots = validateSlots(id, f.slots, out);
  if (!isStr(f.base)) out.push(issue(id, `${id}: missing base`));
  if (!isNum(f.boxCount) || f.boxCount < 0 || f.boxCount > 11) out.push(issue(id, `${id}: invalid boxCount`));
  for (const s of slots) if (s.y <= 0) out.push(issue(id, `${id}: defensive slot ${s.role} must have y > 0`));
};

const validateRoute = (r: RouteDef, out: PlaybookIssue[]): void => {
  const id = `route:${r.id}`;
  if (!ROUTE_TYPES.has(r.type)) out.push(issue(id, `${id}: invalid type ${r.type}`));
  if (!SCRAMBLES.has(r.scramble)) out.push(issue(id, `${id}: invalid scramble ${r.scramble}`));
  if (!isNum(r.breakTime) || r.breakTime < 0) out.push(issue(id, `${id}: invalid breakTime`));
  if (!isNum(r.depth)) out.push(issue(id, `${id}: invalid depth`));
  if (!Array.isArray(r.waypoints) || r.waypoints.length === 0) out.push(issue(id, `${id}: needs at least one waypoint`));
  else if (r.waypoints.some((w) => !isRecord(w) || !isNum(w.dx) || !isNum(w.dy))) out.push(issue(id, `${id}: malformed waypoint`));
  else if (r.waypoints.filter((w) => w.isBreak).length > 1) out.push(issue(id, `${id}: more than one isBreak waypoint`));
};

const eligibleRoles = (reg: PlaybookRegistry): Set<string> => {
  const roles = new Set<string>();
  for (const f of Object.values(reg.offensiveFormations)) for (const s of f.slots) if (s.eligible) roles.add(s.role);
  return roles;
};

/** Checks assignments is an object and (when the formation is known) that it covers exactly the formation's roles. */
const validateAssignmentKeys = (playId: string, assignments: unknown, slots: FormationSlot[] | undefined, out: PlaybookIssue[]): boolean => {
  if (!isRecord(assignments)) {
    out.push(issue(playId, `${playId}: assignments must be an object`));
    return false;
  }
  if (!slots) return true;
  const roles = new Set(slots.map((s) => s.role));
  for (const role of roles) if (!(role in assignments)) out.push(issue(playId, `${playId}: slot ${role} has no assignment`));
  for (const role of Object.keys(assignments)) if (!roles.has(role)) out.push(issue(playId, `${playId}: assignment for unknown role ${role}`));
  return true;
};

/** Validate a single offensive play (data or user-authored) against the registry. */
export const validateOffensivePlay = (play: OffensivePlay, reg: PlaybookRegistry): PlaybookIssue[] => {
  const out: PlaybookIssue[] = [];
  const id = play.id;
  const formation = reg.offensiveFormations[play.formation];
  if (!formation) out.push(issue(id, `${id}: unknown formation ${play.formation}`));
  if (!isStr(play.name)) out.push(issue(id, `${id}: missing name`));
  if (!PLAY_TYPES.has(play.type)) out.push(issue(id, `${id}: invalid type ${play.type}`));
  if (!CONCEPTS.has(play.concept)) out.push(issue(id, `${id}: invalid concept ${play.concept}`));
  if (!Array.isArray(play.tags) || play.tags.some((t) => !isStr(t))) out.push(issue(id, `${id}: tags must be strings`));
  const slots = formation?.slots ?? [];
  const roles = new Set(slots.map((s) => s.role));
  if (validateAssignmentKeys(id, play.assignments, formation?.slots, out)) {
    for (const [role, a] of Object.entries(play.assignments)) {
      if (!isRecord(a) || !OFF_TYPES.has(a.type)) {
        out.push(issue(id, `${id}: ${role} has an invalid assignment type`));
        continue;
      }
      if (a.type === 'route' && !a.route) out.push(issue(id, `${id}: ${role} route assignment needs a route id`));
      if (a.type === 'chipRelease' && !a.releaseRoute) out.push(issue(id, `${id}: ${role} chipRelease needs a releaseRoute`));
      for (const key of ['route', 'releaseRoute'] as const) {
        const rid = a[key];
        if (rid !== undefined && !reg.routes[rid]) out.push(issue(id, `${id}: ${role} references unknown route ${rid}`));
      }
      if (a.gap !== undefined && !GAPS.has(a.gap)) out.push(issue(id, `${id}: ${role} has invalid gap ${a.gap}`));
      if (a.fakeTo !== undefined && !roles.has(a.fakeTo)) out.push(issue(id, `${id}: ${role} fakeTo ${a.fakeTo} is not a slot`));
      if (a.type === 'route' && a.route && formation && !slots.find((s) => s.role === role)?.eligible) out.push(issue(id, `${id}: ineligible ${role} cannot run a route`));
    }
  }
  if (!roles.has(play.primary)) out.push(issue(id, `${id}: primary ${play.primary} is not a slot`));
  if (!Array.isArray(play.progression)) out.push(issue(id, `${id}: progression must be an array`));
  else for (const r of play.progression) if (!roles.has(r)) out.push(issue(id, `${id}: progression role ${r} is not a slot`));
  if (RUN_TYPES.has(play.type)) {
    if (!play.ballCarrier) out.push(issue(id, `${id}: ${play.type} plays need a ballCarrier`));
    else if (!roles.has(play.ballCarrier)) out.push(issue(id, `${id}: ballCarrier ${play.ballCarrier} is not a slot`));
    if (!play.runGap) out.push(issue(id, `${id}: ${play.type} plays need a runGap`));
  }
  if (play.runGap !== undefined && !GAPS.has(play.runGap)) out.push(issue(id, `${id}: invalid runGap ${play.runGap}`));
  if (PASS_TYPES.has(play.type) && play.dropback === undefined) out.push(issue(id, `${id}: ${play.type} plays need a dropback`));
  if (play.dropback !== undefined && (!isNum(play.dropback) || play.dropback < 0)) out.push(issue(id, `${id}: invalid dropback ${play.dropback}`));
  if ((play.type === 'playAction' || play.type === 'rpo') && !play.fakeTo) out.push(issue(id, `${id}: ${play.type} plays need fakeTo`));
  if (play.fakeTo !== undefined && !roles.has(play.fakeTo)) out.push(issue(id, `${id}: fakeTo ${play.fakeTo} is not a slot`));
  if (play.audibles) {
    for (const key of OFF_AUDIBLES) {
      const target = play.audibles[key];
      if (target === undefined) continue;
      const t = reg.offensePlays[target];
      if (!t) out.push(issue(id, `${id}: audible ${key} references unknown play ${target}`));
      else if (t.id === play.id) out.push(issue(id, `${id}: audible ${key} references itself`));
      else if (t.formation !== play.formation) out.push(issue(id, `${id}: audible ${key} -> ${target} uses a different formation`));
    }
  }
  return out;
};

/** Validate a single defensive play against the registry. */
export const validateDefensivePlay = (play: DefensivePlay, reg: PlaybookRegistry): PlaybookIssue[] => {
  const out: PlaybookIssue[] = [];
  const id = play.id;
  const formation = reg.defensiveFormations[play.formation];
  if (!formation) out.push(issue(id, `${id}: unknown formation ${play.formation}`));
  if (!isStr(play.name)) out.push(issue(id, `${id}: missing name`));
  if (!SHELLS.has(play.coverage)) out.push(issue(id, `${id}: invalid coverage ${play.coverage}`));
  if (!FAMILIES.has(play.family)) out.push(issue(id, `${id}: invalid family ${play.family}`));
  if (!BLITZES.has(play.blitz)) out.push(issue(id, `${id}: invalid blitz ${play.blitz}`));
  if (!Array.isArray(play.tags) || play.tags.some((t) => !isStr(t))) out.push(issue(id, `${id}: tags must be strings`));
  if (play.alignTo !== undefined && !['none', 'strength', 'passStrength'].includes(play.alignTo)) out.push(issue(id, `${id}: invalid alignTo`));
  const eligible = eligibleRoles(reg);
  if (validateAssignmentKeys(id, play.assignments, formation?.slots, out)) {
    for (const [role, a] of Object.entries(play.assignments)) {
      if (!isRecord(a) || !DEF_TYPES.has(a.type)) {
        out.push(issue(id, `${id}: ${role} has an invalid assignment type`));
        continue;
      }
      if (a.type === 'manCover' && !a.manTarget) out.push(issue(id, `${id}: ${role} manCover needs a manTarget`));
      if (a.manTarget !== undefined && !eligible.has(a.manTarget)) out.push(issue(id, `${id}: ${role} man target ${a.manTarget} is not an eligible offensive role`));
      if (a.type === 'zone' && !a.zone) out.push(issue(id, `${id}: ${role} zone assignment needs a zone`));
      if (a.zone !== undefined && !ZONES.has(a.zone)) out.push(issue(id, `${id}: ${role} has invalid zone ${a.zone}`));
      if (a.gap !== undefined && !GAPS.has(a.gap)) out.push(issue(id, `${id}: ${role} has invalid gap ${a.gap}`));
      if ((a.type === 'rushGap' || a.type === 'runFill') && !a.gap) out.push(issue(id, `${id}: ${role} ${a.type} needs a gap`));
      if (a.technique !== undefined && !TECHNIQUES.has(a.technique)) out.push(issue(id, `${id}: ${role} has invalid technique ${a.technique}`));
    }
  }
  if (play.audibles) {
    for (const key of DEF_AUDIBLES) {
      const target = play.audibles[key];
      if (target === undefined) continue;
      const t = reg.defensePlays[target];
      if (!t) out.push(issue(id, `${id}: audible ${key} references unknown play ${target}`));
      else if (t.id === play.id) out.push(issue(id, `${id}: audible ${key} references itself`));
      else if (t.formation !== play.formation) out.push(issue(id, `${id}: audible ${key} -> ${target} uses a different formation`));
    }
  }
  return out;
};

/** Validate a playbook's play references against the registry. */
export const validatePlaybook = (pb: Playbook, reg: PlaybookRegistry): PlaybookIssue[] => {
  const out: PlaybookIssue[] = [];
  const id = `playbook:${pb.id}`;
  if (!isStr(pb.name)) out.push(issue(id, `${id}: missing name`));
  for (const [key, table] of [['offensePlayIds', reg.offensePlays], ['defensePlayIds', reg.defensePlays]] as const) {
    const ids = pb[key];
    if (!Array.isArray(ids)) {
      out.push(issue(id, `${id}: ${key} must be an array`));
      continue;
    }
    for (const pid of ids) if (!table[pid]) out.push(issue(id, `${id}: ${key} references unknown play ${pid}`));
    if (new Set(ids).size !== ids.length) out.push(issue(id, `${id}: ${key} contains duplicates`));
    if (ids.length === 0) out.push(issue(id, `${id}: ${key} is empty`));
  }
  return out;
};

const index = <T extends { id: string }>(items: T[], label: string, out: PlaybookIssue[]): Record<string, T> => {
  const table: Record<string, T> = {};
  for (const it of items) {
    if (table[it.id]) out.push(issue(`${label}:${it.id}`, `${label}: duplicate id ${it.id}`));
    table[it.id] = it;
  }
  return table;
};

/** Parse + validate raw data. Returns the registry and every issue found (registry is usable only when issues is empty). */
export const buildRegistry = (raw: RawPlaybookData): { registry: PlaybookRegistry; issues: PlaybookIssue[] } => {
  const issues: PlaybookIssue[] = [];
  const offF = entityList<OffensiveFormation>(raw.offensiveFormations, 'offensiveFormations', issues);
  const defF = entityList<DefensiveFormation>(raw.defensiveFormations, 'defensiveFormations', issues);
  const routes = entityList<RouteDef>(raw.routes, 'routes', issues);
  const offP = entityList<OffensivePlay>(raw.offensePlays, 'offensePlays', issues);
  const defP = entityList<DefensivePlay>(raw.defensePlays, 'defensePlays', issues);
  const pbs = entityList<Playbook>(raw.playbooks, 'playbooks', issues);
  for (const f of offF) validateOffensiveFormation(f, issues);
  for (const f of defF) validateDefensiveFormation(f, issues);
  for (const r of routes) validateRoute(r, issues);
  const routeTable = index(routes, 'route', issues);
  for (const r of routes) routeTable[r.id + MIRROR_SUFFIX] = { ...mirrorRoute(r), id: r.id + MIRROR_SUFFIX };
  const registry: PlaybookRegistry = {
    offensiveFormations: index(offF, 'formation', issues),
    defensiveFormations: index(defF, 'formation', issues),
    routes: routeTable,
    offensePlays: index(offP, 'play', issues),
    defensePlays: index(defP, 'play', issues),
    playbooks: index(pbs, 'playbook', issues),
  };
  for (const p of offP) issues.push(...validateOffensivePlay(p, registry));
  for (const p of defP) issues.push(...validateDefensivePlay(p, registry));
  for (const pb of pbs) issues.push(...validatePlaybook(pb, registry));
  return { registry, issues };
};

/** The bundled data files as raw input (exported for tests and tooling). */
export const bundledPlaybookData = (): RawPlaybookData => ({
  offensiveFormations: formationsOffenseJson,
  defensiveFormations: formationsDefenseJson,
  routes: routesJson,
  offensePlays: playsOffenseJson,
  defensePlays: playsDefenseJson,
  playbooks: playbooksJson,
});

/** Validate raw data without throwing. */
export const validatePlaybookData = (raw: RawPlaybookData = bundledPlaybookData()): PlaybookIssue[] => buildRegistry(raw).issues;

let cached: PlaybookRegistry | null = null;

/** Load and validate the bundled playbook data (cached). Throws a descriptive error listing every issue. */
export const loadPlaybookData = (): PlaybookRegistry => {
  if (cached) return cached;
  const { registry, issues } = buildRegistry(bundledPlaybookData());
  if (issues.length) throw new Error(`Playbook data invalid (${issues.length} issues):\n  ${issues.map((i) => i.message).join('\n  ')}`);
  cached = registry;
  return registry;
};

/** Drop the cached registry (tests). */
export const resetPlaybookCache = (): void => {
  cached = null;
};

const flipSlots = <F extends { slots: FormationSlot[] }>(f: F): F => ({ ...f, slots: f.slots.map((s) => ({ ...s, x: -s.x })) });
/** Shallow copy without the loader-resolved flags. */
const omit = <T extends object, K extends keyof T>(obj: T, keys: K[]): Omit<T, K> => Object.fromEntries(Object.entries(obj).filter(([k]) => !keys.includes(k as K))) as Omit<T, K>;

/** Resolve a route id to its (optionally mirrored) definition; the mirrored twin comes from the registry when present. */
export const resolveRoute = (routes: Record<string, RouteDef>, id: string, mirrored: boolean): RouteDef => {
  const isTwin = id.endsWith(MIRROR_SUFFIX);
  const baseId = isTwin ? id.slice(0, -MIRROR_SUFFIX.length) : id;
  const base = routes[baseId];
  if (!base) throw new Error(`Unknown route ${id}`);
  if (mirrored === isTwin) return base;
  return routes[baseId + MIRROR_SUFFIX] ?? { ...mirrorRoute(base), id: baseId + MIRROR_SUFFIX };
};

/** Resolve `flip` and per-assignment `mirror` into a plain play + formation + concrete routes. */
export const materializePlay = (play: OffensivePlay, formation: OffensiveFormation, routes: Record<string, RouteDef>): MaterializedPlay => {
  const flip = play.flip === true;
  const assignments: Record<string, OffAssignment> = {};
  const roleRoutes: Record<string, RouteDef> = {};
  for (const [role, a] of Object.entries(play.assignments)) {
    const mirrored = (a.mirror === true) !== flip;
    const next: OffAssignment = { type: a.type };
    if (a.gap) next.gap = flip ? mirrorGap(a.gap) : a.gap;
    if (a.fakeTo) next.fakeTo = a.fakeTo;
    if (a.releaseRoute) {
      const r = resolveRoute(routes, a.releaseRoute, mirrored);
      next.releaseRoute = r.id;
      roleRoutes[role] = r;
    }
    if (a.route) {
      const r = resolveRoute(routes, a.route, mirrored);
      next.route = r.id;
      roleRoutes[role] = r;
    }
    assignments[role] = next;
  }
  const out: OffensivePlay = { ...omit(play, ['flip']), assignments };
  if (flip && out.runGap) out.runGap = mirrorGap(out.runGap);
  return { play: out, formation: flip ? flipSlots(formation) : formation, routes: roleRoutes };
};

/** Which side (offense perspective) the offensive formation is strong to, for run (TE side) and pass (receiver count). */
export const offensiveStrength = (formation: OffensiveFormation): OffensiveStrength => {
  let te = 0;
  let wide = 0;
  for (const s of formation.slots) {
    if (Math.abs(s.x) < 2) continue;
    if (s.position === 'TE') te += Math.sign(s.x);
    if (s.eligible) wide += Math.sign(s.x);
  }
  const pass: StrengthSide = wide !== 0 ? (wide > 0 ? 'right' : 'left') : te < 0 ? 'left' : 'right';
  const run: StrengthSide = te !== 0 ? (te > 0 ? 'right' : 'left') : pass;
  return { run, pass };
};

/**
 * Resolve `flip` / `alignTo` into a plain defensive play + formation. Data is authored strong-RIGHT. When the play
 * ends up flipped and `offense` is given, man targets are re-pointed at the mirror-image receiver (WR1 <-> WR2, TE1
 * <-> TE2, see transform.mirrorRoleMap) so the flipped corner covers the receiver now on its side.
 */
export const materializeDefensivePlay = (
  play: DefensivePlay,
  formation: DefensiveFormation,
  strength?: OffensiveStrength,
  offense?: Pick<OffensiveFormation, 'slots'>,
): MaterializedDefensivePlay => {
  const alignFlip = strength !== undefined && ((play.alignTo === 'strength' && strength.run === 'left') || (play.alignTo === 'passStrength' && strength.pass === 'left'));
  const flip = (play.flip === true) !== alignFlip;
  const roleMap = flip && offense ? mirrorRoleMap(offense) : {};
  const assignments: Record<string, DefAssignment> = {};
  for (const [role, a] of Object.entries(play.assignments)) {
    const next: DefAssignment = { ...a };
    if (flip && a.gap) next.gap = mirrorGap(a.gap);
    if (flip && a.zone) next.zone = mirrorZone(a.zone);
    if (flip && a.manTarget && roleMap[a.manTarget]) next.manTarget = roleMap[a.manTarget];
    assignments[role] = next;
  }
  return { play: { ...omit(play, ['flip', 'alignTo']), assignments }, formation: flip ? flipSlots(formation) : formation };
};

/**
 * Resolve a playbook id to concrete plays. Bundled data wins over custom content on id collisions; custom plays
 * are validated and excluded (with issues) when invalid. Throws when the playbook id is unknown everywhere.
 */
export const resolvePlaybook = (id: string, custom?: CustomPlaybookContent): ResolvedPlaybook => {
  const reg = loadPlaybookData();
  const playbook = reg.playbooks[id] ?? custom?.playbooks.find((p) => p.id === id);
  if (!playbook) throw new Error(`Unknown playbook ${id}`);
  const issues: PlaybookIssue[] = [];
  const byId = <T extends { id: string }>(items: T[] | undefined): Record<string, T> => Object.fromEntries((items ?? []).map((p) => [p.id, p]));
  /** Registry view for validating custom plays: custom audible targets resolve, bundled ids still win. */
  const view: PlaybookRegistry = {
    ...reg,
    offensePlays: { ...byId(custom?.offense), ...reg.offensePlays },
    defensePlays: { ...byId(custom?.defense), ...reg.defensePlays },
  };
  const pick = <T extends { id: string }>(ids: string[], table: Record<string, T>, extra: T[] | undefined, validate: (p: T) => PlaybookIssue[]): T[] => {
    const out: T[] = [];
    for (const pid of ids) {
      const bundled = table[pid];
      if (bundled) {
        out.push(bundled);
        continue;
      }
      const c = extra?.find((p) => p.id === pid);
      if (!c) {
        issues.push(issue(pid, `${pid}: play not found in data or custom content`));
        continue;
      }
      const errs = validate(c);
      if (errs.length) issues.push(...errs);
      else out.push(c);
    }
    return out;
  };
  return {
    playbook,
    offense: pick(playbook.offensePlayIds, reg.offensePlays, custom?.offense, (p) => validateOffensivePlay(p, view)),
    defense: pick(playbook.defensePlayIds, reg.defensePlays, custom?.defense, (p) => validateDefensivePlay(p, view)),
    issues,
  };
};
