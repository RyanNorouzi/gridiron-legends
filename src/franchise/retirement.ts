/**
 * Retirements. Players: the yearly chance rises with age along the position's age curve (running backs go early,
 * quarterbacks and kickers late), and is shaded by stardom, a decline in the last progression pass, a low overall,
 * injuries (a career-threatening one this season forces the question at any age), contract status (money on the
 * table keeps players around; unsigned veterans walk away), a championship ("going out on top") and personality.
 * Unsigned free agents of any age who did not play all season and whose overall and potential are both below the
 * washout bars leave the game too ('washout'), so the free-agent pool does not grow without bound.
 * `retirePlayer` MOVES the record from League.players to League.retiredPlayers: roster, depth chart and free-agent
 * list are cleared through roster.ts, the contract is voided and its unamortised signing bonus accelerates into dead
 * money (existing dead money stays), and pending trades involving him are withdrawn.
 *
 * Coaches: `runCoachCarousel` ages every staff member a year, retires old coaches (kept in League.coaches with
 * teamId null because awards reference them) and hires a generated replacement for the same role. It is the
 * standalone alternative to the club layer's staff turnover (staff.ts advanceStaffYear), which the offseason
 * orchestrator uses by default. It is a no-op for a season whose staff already turned over (ClubState.staffYear,
 * set by events.ts closeClubSeason and by itself), so coaches never age twice in one offseason. Players the club
 * layer flagged 'retiring' (an honoured retirement announcement) retire at the next retirement pass. Pure;
 * randomness via the Rng.
 */
import type { CoachId, PlayerId, TeamId } from '@/core/ids';
import type { Rng } from '@/core/rng';
import { clamp, logistic } from '@/core/math';
import { ageCurve } from '@/players/development';
import { countSevereInjuries } from '@/players/injuries';
import { createNamePool } from '@/players/names';
import { PERSONALITY_TRAITS, fullName, type Player, type Position } from '@/players/types';
import { generateCoach } from '@/teams/coach-generator';
import type { Coach, Team } from '@/teams/types';
import { awardsSection, flagsFor, numberPair, numberRecord } from './awards';
import { contractEndYear, leagueCapYear, unamortizedBonus, yearsRemainingAt } from './contracts';
import { ensureClub, withClub } from './rivalries';
import { assignPlayerInPlace, beginRosterEdit } from './roster';
import type { League } from './types';

const R_KEYS = [
  'minAge', 'ageMidOffset', 'ageScale', 'maxChance', 'starOverall', 'starMultiplier', 'declineThreshold', 'declineBonus',
  'lowOverall', 'lowOverallMinAge', 'lowOverallBonus', 'careerThreateningBonus', 'severeInjuryBonus',
  'underContractMultiplier', 'freeAgentMultiplier', 'freeAgentBonus', 'championBonus', 'washoutOverall', 'washoutPotential', 'washoutChance',
] as const;

/** Retirement tuning (awards.json "retirement"). */
export interface RetirementConfig extends Record<(typeof R_KEYS)[number], number> {
  traitMultipliers: Partial<Record<(typeof PERSONALITY_TRAITS)[number], number>>;
  coach: { minAge: number; baseChance: number; perYearOver: number; maxChance: number; replacementQuality: [number, number] };
}

const loadConfig = (): RetirementConfig => {
  const raw = awardsSection('retirement');
  const traits = awardsSection('retirement.traitMultipliers');
  const traitMultipliers: RetirementConfig['traitMultipliers'] = {};
  for (const t of PERSONALITY_TRAITS) {
    const v = traits[t];
    if (v !== undefined) traitMultipliers[t] = numberRecord(traits, [t], 'retirement.traitMultipliers', 0)[t];
  }
  const coachRaw = awardsSection('retirement.coach');
  const coach = numberRecord(coachRaw, ['minAge', 'baseChance', 'perYearOver', 'maxChance'], 'retirement.coach', 0);
  const replacementQuality = numberPair(coachRaw.replacementQuality, 'retirement.coach.replacementQuality');
  return { ...numberRecord(raw, R_KEYS, 'retirement', 0), traitMultipliers, coach: { ...coach, replacementQuality } };
};

/** Validated retirement tuning. */
export const RETIREMENT_CONFIG: RetirementConfig = loadConfig();

/* --------------------------------------------------------------- players */

/** Age-only retirement chance: 0 below minAge, then a logistic centred just before the position's declineEnd. */
export const ageRetirementChance = (position: Position, age: number, cfg: RetirementConfig = RETIREMENT_CONFIG): number =>
  age < cfg.minAge ? 0 : logistic(age, ageCurve(position).declineEnd - cfg.ageMidOffset, 1 / cfg.ageScale);

const hadCareerThreatening = (p: Player, year: number): boolean =>
  (p.injury?.severity === 'careerThreatening' && p.injury.occurredYear >= year - 1)
  || p.injuryHistory.some((i) => i.severity === 'careerThreatening' && i.occurredYear === year);

/** One player's retirement chance this offseason (0..maxChance) and the reasons that shaped it. */
export const retirementChance = (league: League, player: Player, cfg: RetirementConfig = RETIREMENT_CONFIG): { chance: number; reasons: string[] } => {
  const reasons: string[] = [];
  const year = league.season.year;
  const veteran = player.age >= cfg.minAge;
  const ageChance = ageRetirementChance(player.position, player.age, cfg);
  let p = ageChance;
  if (p > 0.05) reasons.push('age');
  if (player.overall >= cfg.starOverall) p *= cfg.starMultiplier;
  const last = player.progressionLog[player.progressionLog.length - 1];
  if (veteran && last && last.overallBefore - last.overallAfter >= cfg.declineThreshold) {
    p += cfg.declineBonus;
    reasons.push('decline');
  }
  if (player.overall < cfg.lowOverall && player.age >= cfg.lowOverallMinAge) {
    p += cfg.lowOverallBonus;
    reasons.push('fading');
  }
  if (hadCareerThreatening(player, year)) {
    p += cfg.careerThreateningBonus;
    reasons.push('injury');
  }
  if (veteran) p += countSevereInjuries(player) * cfg.severeInjuryBonus;
  const capYear = leagueCapYear(league);
  if (player.teamId === null) {
    if (veteran) {
      p = p * cfg.freeAgentMultiplier + cfg.freeAgentBonus;
      reasons.push('unsigned');
    }
    const played = (league.season.stats[player.id]?.gamesPlayed ?? 0) + (league.season.playoffStats[player.id]?.gamesPlayed ?? 0);
    if (played === 0 && player.overall < cfg.washoutOverall && player.potential < cfg.washoutPotential) {
      p += cfg.washoutChance;
      reasons.push('washout');
    }
  } else if (player.contract && yearsRemainingAt(player.contract, capYear) > 0) {
    p *= cfg.underContractMultiplier;
  }
  if (player.teamId !== null && player.teamId === league.season.champion && player.age >= ageCurve(player.position).peakEnd) {
    p += cfg.championBonus;
    reasons.push('champion');
  }
  for (const t of player.traits) p *= cfg.traitMultipliers[t] ?? 1;
  // Past the end of his decline no contract or trait keeps a player below his raw age chance.
  if (player.age > ageCurve(player.position).declineEnd) p = Math.max(p, ageChance);
  return { chance: clamp(p, 0, cfg.maxChance), reasons };
};

/** A rolled retirement decision. */
export interface RetirementDecision {
  playerId: PlayerId;
  teamId: TeamId | null;
  chance: number;
  reasons: string[];
}

/**
 * Rolls every active player (id order, one draw each) and returns the ones who retire. Deterministic per Rng.
 * Does not change the League; apply with retirePlayers.
 */
export const retirementDecisions = (league: League, rng: Rng, cfg: RetirementConfig = RETIREMENT_CONFIG): RetirementDecision[] => {
  const out: RetirementDecision[] = [];
  const flags = league.club?.playerFlags ?? {};
  const announced = new Set(Object.keys(flags).filter((id) => flags[id]?.includes('retiring')));
  for (const id of (Object.keys(league.players) as PlayerId[]).sort()) {
    const p = league.players[id];
    if (!p || p.retired) continue;
    const { chance, reasons } = retirementChance(league, p, cfg);
    const roll = rng.next();
    if (announced.has(id)) out.push({ playerId: id, teamId: p.teamId, chance: 1, reasons: [...reasons, 'announced'] });
    else if (chance > 0 && roll < chance) out.push({ playerId: id, teamId: p.teamId, chance, reasons });
  }
  return out;
};

/** What the rest of the offseason needs to know about a retirement (events, HOF checks). */
export interface RetirementRecord {
  playerId: PlayerId;
  teamId: TeamId | null;
  name: string;
  position: Position;
  age: number;
  seasons: number;
  overall: number;
  /** Dead money accelerated onto teamId's cap year. */
  deadMoney: number;
}

/**
 * Retires one active player (see the module header). Idempotent for an already-retired player (League returned
 * unchanged); throws for an unknown id.
 */
export const retirePlayer = (league: League, playerId: PlayerId): League => retirePlayers(league, [playerId]).league;

/** Retires several players at once; returns the League and one RetirementRecord per player actually retired. */
export const retirePlayers = (league: League, ids: readonly PlayerId[]): { league: League; retired: RetirementRecord[] } => {
  const work = beginRosterEdit(league);
  const capYear = leagueCapYear(league);
  const retiredPlayers = { ...league.retiredPlayers };
  const records: RetirementRecord[] = [];
  for (const id of ids) {
    const player = work.players[id];
    if (!player) {
      if (retiredPlayers[id]) continue;
      throw new Error(`retirePlayer: unknown player ${id}`);
    }
    let dead = 0;
    const team = player.teamId ? work.teams[player.teamId] : undefined;
    if (team && player.contract && contractEndYear(player.contract) >= capYear) {
      dead = unamortizedBonus(player.contract, capYear);
      if (dead > 0) {
        const dm = { ...team.finances.deadMoney, [capYear]: (team.finances.deadMoney[capYear] ?? 0) + dead };
        work.teams[team.id] = { ...team, finances: { ...team.finances, deadMoney: dm } };
      }
    }
    work.players[id] = { ...player, retired: true, contract: null };
    assignPlayerInPlace(work, id, null);
    work.freeAgentIds = work.freeAgentIds.filter((x) => x !== id);
    const final = work.players[id] as Player;
    delete work.players[id];
    retiredPlayers[id] = { ...final, teamId: null, retired: true, contract: null };
    records.push({
      playerId: id, teamId: player.teamId, name: fullName(player), position: player.position, age: player.age,
      // Pre-league years count too (veterans have no league stats for them), as hall-of-fame.ts tenure does.
      seasons: Math.max(player.experience, league.careerStats[id]?.seasons.filter((s) => s.line.gamesPlayed > 0).length ?? 0),
      overall: player.overall, deadMoney: dead,
    });
  }
  if (records.length === 0) return { league, retired: [] };
  const gone = new Set<PlayerId>(records.map((r) => r.playerId));
  const involves = (o: League['pendingTrades'][number]): boolean =>
    [...o.fromAssets, ...o.toAssets].some((a) => a.kind === 'player' && gone.has(a.playerId));
  const pendingTrades = league.pendingTrades.map((o) => (o.status === 'pending' && involves(o) ? { ...o, status: 'withdrawn' as const } : o));
  let fatigue = league.fatigue;
  if (fatigue && records.some((r) => fatigue?.[r.playerId] !== undefined)) {
    fatigue = { ...fatigue };
    for (const r of records) delete fatigue[r.playerId];
  }
  return { league: { ...work, retiredPlayers, pendingTrades, ...(fatigue !== undefined ? { fatigue } : {}) }, retired: records };
};

/** Rolls and applies the offseason's retirements. */
export const runRetirements = (league: League, rng: Rng, cfg: RetirementConfig = RETIREMENT_CONFIG): { league: League; retired: RetirementRecord[] } =>
  retirePlayers(league, retirementDecisions(league, rng, cfg).map((d) => d.playerId));

/* --------------------------------------------------------------- coaches */

/** A coach retirement and the hire that replaced him. */
export interface CoachMove {
  retiredId: CoachId;
  teamId: TeamId;
  role: Coach['role'];
  /** The coach hired into the role, or null when the role was left open (the club layer never hires for the user). */
  replacementId: CoachId | null;
}

/** A coach's retirement chance for the coming year (by age). */
export const coachRetirementChance = (coach: Pick<Coach, 'age'>, cfg: RetirementConfig = RETIREMENT_CONFIG): number => {
  const c = cfg.coach;
  return clamp(coach.age < c.minAge ? c.baseChance : c.baseChance + c.perYearOver * (coach.age - c.minAge + 1), 0, c.maxChance);
};

/**
 * Ages every non-retired coach one year, retires staff members by coachRetirementChance and hires a generated
 * replacement for each vacated role (head coaches set new schemes; assistants inherit the head coach's). Retired
 * coaches stay in League.coaches with teamId null and are listed in offseasonFlags.retiredCoaches and
 * club.retiredCoachIds; club.staffYear records the season (a second call for it is a no-op).
 */
export const runCoachCarousel = (league: League, rng: Rng, cfg: RetirementConfig = RETIREMENT_CONFIG): { league: League; moves: CoachMove[] } => {
  if (league.club?.staffYear === league.season.year) return { league, moves: [] };
  const flags = flagsFor(league, league.season.year);
  const alreadyRetired = new Set<CoachId>([...(flags.retiredCoaches ?? []), ...((league.club?.retiredCoachIds ?? []) as CoachId[])]);
  const coaches: Record<CoachId, Coach> = {};
  for (const [id, c] of Object.entries(league.coaches) as [CoachId, Coach][]) coaches[id] = alreadyRetired.has(id) ? c : { ...c, age: c.age + 1 };
  const teams: Record<TeamId, Team> = { ...league.teams };
  const names = createNamePool();
  const moves: CoachMove[] = [];
  for (const team of Object.values(league.teams).sort((a, b) => (a.id < b.id ? -1 : 1))) {
    for (const cid of [...team.staffIds].sort()) {
      const coach = coaches[cid];
      if (!coach || coach.teamId !== team.id || rng.next() >= coachRetirementChance(coach, cfg)) continue;
      coaches[cid] = { ...coach, teamId: null };
      const current = teams[team.id] as Team;
      const head = current.headCoachId && current.headCoachId !== cid ? coaches[current.headCoachId] : undefined;
      const hireRng = rng.fork(`hire:${team.id}:${coach.role}`);
      let hire = generateCoach(hireRng, coach.role, {
        names, teamId: team.id, quality: hireRng.range(cfg.coach.replacementQuality[0], cfg.coach.replacementQuality[1]),
        ...(head && coach.role !== 'HC' ? { offensiveScheme: head.offensiveScheme, defensiveScheme: head.defensiveScheme } : {}),
      });
      while (coaches[hire.id]) hire = { ...hire, id: `${hire.id}x` as CoachId };
      coaches[hire.id] = hire;
      teams[team.id] = {
        ...current,
        staffIds: [...current.staffIds.filter((x) => x !== cid), hire.id],
        headCoachId: current.headCoachId === cid ? hire.id : current.headCoachId,
      };
      moves.push({ retiredId: cid, teamId: team.id, role: coach.role, replacementId: hire.id });
    }
  }
  const retiredCoaches = [...new Set([...(flags.retiredCoaches ?? []), ...moves.map((m) => m.retiredId)])];
  const club = ensureClub(league);
  const next = withClub({ ...league, coaches, teams, offseasonFlags: { ...flags, retiredCoaches } }, {
    retiredCoachIds: [...club.retiredCoachIds, ...moves.map((m) => m.retiredId as string)], staffYear: league.season.year,
  });
  return { league: next, moves };
};
