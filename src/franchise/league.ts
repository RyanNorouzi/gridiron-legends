/**
 * League creation and whole-league lookups/validation. createLeague wraps the teams/ league generator
 * (teams, 53-man rosters under the cap, staffs, stadiums, three years of picks) into a League with a
 * fresh Season (schedule generated, empty standings/stats), an unsigned free-agent pool, empty career
 * stats for every player and the League rng (rngSeed + rngState). Randomness flows from one seed: the
 * League rng is restored from (rngSeed, rngState), forked per step and its state written back.
 */
import { leagueId, playerId as newPlayerId, type PlayerId, type TeamId } from '@/core/ids';
import { createRng, restoreRng, type Rng } from '@/core/rng';
import { generatePlayer, type PlayerQuality } from '@/players/generator';
import { createNamePool } from '@/players/names';
import { POSITIONS, type Player } from '@/players/types';
import { loadColleges, loadRegions } from '@/teams/data';
import { ROSTER_COMPOSITION, validateDepthChart } from '@/teams/depth-chart';
import { generateLeagueEntities } from '@/teams/league-generator';
import type { Team, TeamColors } from '@/teams/types';
import { emptyCareer } from '@/statistics/aggregate';
import { emptyTeamStatLine } from '@/statistics/empty';
import type { CareerStats, TeamStatLine } from '@/statistics/types';
import { SEASON_CONFIG, assertValidSettings, defaultLeagueSettings, validateSettings, type LeagueSettingsOverrides } from './settings';
import { generateSchedule, validateSchedule, type ScheduleOptions } from './schedule';
import { emptyStandings } from './standings';
import { SEASON_PHASE_ORDER, type League, type LeagueSettings, type Season } from './types';

/** Save-format version written into new leagues (mirrors save/migrations CURRENT_SAVE_VERSION). */
export const LEAGUE_VERSION = 1;

/** A user-designed team that takes over one bundled team's slot (division, stadium, market, roster). */
export interface CustomTeamSpec {
  /** Abbreviation of the bundled team to replace; default `userTeamAbbr`, else the first team. */
  replaces?: string;
  city: string;
  name: string;
  /** 2-4 uppercase letters, unique in the league. */
  abbr: string;
  colors?: Partial<TeamColors>;
  stadiumName?: string;
  playbookId?: string;
}

/** Options for createLeague. */
export interface CreateLeagueOptions {
  seed: number;
  /** League year; default from league-settings.json. */
  year?: number;
  /** Full settings or overrides merged onto the defaults. */
  settings?: LeagueSettings | LeagueSettingsOverrides;
  userTeamAbbr?: string;
  customTeam?: CustomTeamSpec;
  name?: string;
  /** Size of the unsigned free-agent pool; default from league-settings.json. */
  freeAgentCount?: number;
}

/** Restores the League rng at its current stream position. */
export const leagueRng = (league: Pick<League, 'rngSeed' | 'rngState'>): Rng => restoreRng(league.rngSeed, league.rngState);

/** The League with `rng`'s stream position written back (new object). */
export const withRngState = (league: League, rng: Rng): League => ({ ...league, rngState: rng.getState() });

/** A player by id, active/free agent or retired. */
export const lookupPlayer = (league: Pick<League, 'players' | 'retiredPlayers'>, id: PlayerId): Player | undefined =>
  league.players[id] ?? league.retiredPlayers[id];

/** The team a player is rostered on, or null (free agent, retired, unknown). */
export const teamOf = (league: Pick<League, 'players' | 'teams'>, id: PlayerId): Team | null => {
  const teamId = league.players[id]?.teamId;
  return teamId ? (league.teams[teamId] ?? null) : null;
};

/** The user's team, or null in an all-AI league. */
export const userTeam = (league: Pick<League, 'teams' | 'userTeamId'>): Team | null =>
  league.userTeamId ? (league.teams[league.userTeamId] ?? null) : null;

/** A player's career record (an empty one when nothing is recorded yet). */
export const careerOf = (league: Pick<League, 'careerStats'>, id: PlayerId): CareerStats => league.careerStats[id] ?? emptyCareer(id);

/** Zeroed team stat lines for every team. */
export const emptyTeamStats = (teams: Readonly<Record<TeamId, Team>>): Record<TeamId, TeamStatLine> =>
  Object.fromEntries(Object.keys(teams).map((id) => [id, emptyTeamStatLine()])) as Record<TeamId, TeamStatLine>;

/** A fresh Season for `year`: schedule generated, phase preseason (week 1, or 0 without preseason games). */
export const createSeason = (
  teams: Readonly<Record<TeamId, Team>>, settings: LeagueSettings, year: number, rng: Rng, opts: ScheduleOptions = {},
): Season => ({
  year,
  phase: 'preseason',
  week: settings.preseasonWeeks > 0 ? 1 : 0,
  schedule: generateSchedule(rng, teams, settings, year, opts),
  standings: emptyStandings(teams),
  bracket: null,
  champion: null,
  awards: [],
  stats: {},
  playoffStats: {},
  teamStats: emptyTeamStats(teams),
});

const FA_QUALITIES: readonly PlayerQuality[] = ['starter', 'rotation', 'backup', 'fringe'];
const FA_QUALITY_WEIGHTS: readonly number[] = [0.06, 0.24, 0.4, 0.3];

/** Unsigned free agents of varying quality, positions weighted like a real roster. Ids never clash with `taken`. */
export const generateFreeAgents = (rng: Rng, count: number, year: number, taken: ReadonlySet<PlayerId>): Player[] => {
  const names = createNamePool();
  const regions = loadRegions().map((r) => r.id);
  const colleges = loadColleges().map((c) => c.name);
  const weights = POSITIONS.map((p) => ROSTER_COMPOSITION[p]);
  const used = new Set(taken);
  const out: Player[] = [];
  for (let i = 0; i < count; i++) {
    const position = rng.weighted(POSITIONS, weights);
    const quality = rng.weighted(FA_QUALITIES, FA_QUALITY_WEIGHTS);
    let player = generatePlayer(rng, { position, quality, names, regions, colleges, year });
    while (used.has(player.id)) player = { ...player, id: newPlayerId(rng) };
    used.add(player.id);
    out.push(player);
  }
  return out;
};

const applyCustomTeam = (teams: Record<TeamId, Team>, stadiums: League['stadiums'], spec: CustomTeamSpec, fallbackAbbr: string | undefined): TeamId => {
  const list = Object.values(teams);
  const target = (spec.replaces ?? fallbackAbbr ?? list[0]?.abbr ?? '').toUpperCase();
  const team = list.find((t) => t.abbr === target);
  if (!team) throw new Error(`createLeague: customTeam.replaces '${target}' is not a team`);
  const abbr = spec.abbr.trim().toUpperCase();
  if (!/^[A-Z]{2,4}$/.test(abbr)) throw new Error(`createLeague: custom team abbreviation '${spec.abbr}' must be 2-4 letters`);
  if (list.some((t) => t.id !== team.id && t.abbr === abbr)) throw new Error(`createLeague: abbreviation '${abbr}' is already taken`);
  if (!spec.city.trim() || !spec.name.trim()) throw new Error('createLeague: custom team city and name are required');
  teams[team.id] = {
    ...team, city: spec.city.trim(), name: spec.name.trim(), abbr, colors: { ...team.colors, ...spec.colors },
    playbookId: spec.playbookId ?? team.playbookId,
  };
  const stadium = stadiums[team.stadiumId];
  if (stadium) stadiums[team.stadiumId] = { ...stadium, city: spec.city.trim(), name: spec.stadiumName?.trim() || stadium.name };
  return team.id;
};

const checkStructure = (teams: Readonly<Record<TeamId, Team>>, settings: LeagueSettings): void => {
  const list = Object.values(teams);
  if (list.length !== settings.teamCount) throw new Error(`createLeague: team data has ${list.length} teams but settings.teamCount is ${settings.teamCount}`);
  for (const conf of settings.conferences) {
    const divisions = new Set(list.filter((t) => t.conference === conf).map((t) => t.division));
    if (divisions.size !== settings.divisionsPerConference) {
      throw new Error(`createLeague: conference ${conf} has ${divisions.size} divisions, settings expect ${settings.divisionsPerConference}`);
    }
  }
  const stray = list.find((t) => !settings.conferences.includes(t.conference));
  if (stray) throw new Error(`createLeague: ${stray.abbr} plays in unknown conference ${stray.conference}`);
};

/**
 * Creates a complete League. Deterministic for (seed, options). Throws on invalid settings, a team data
 * set that does not match them, an unknown user team or an invalid custom team.
 */
export const createLeague = (opts: CreateLeagueOptions): League => {
  const settings = assertValidSettings(defaultLeagueSettings(opts.settings ?? {}));
  const year = opts.year ?? SEASON_CONFIG.defaultStartYear;
  if (!Number.isInteger(year)) throw new Error('createLeague: year must be an integer');
  const rng = createRng(opts.seed);
  const id = leagueId(rng.fork('id'));
  const userAbbr = opts.customTeam ? (opts.customTeam.replaces ?? opts.userTeamAbbr) : opts.userTeamAbbr;
  const entities = generateLeagueEntities(rng.fork('entities'), {
    year, salaryCap: settings.salaryCap, draftRounds: settings.draftRounds, ...(userAbbr ? { userTeamAbbr: userAbbr } : {}),
  });
  const teams = { ...entities.teams };
  const stadiums = { ...entities.stadiums };
  let userTeamId: TeamId | null = Object.values(teams).find((t) => t.isUserControlled)?.id ?? null;
  if (opts.customTeam) {
    userTeamId = applyCustomTeam(teams, stadiums, opts.customTeam, opts.userTeamAbbr);
    for (const t of Object.values(teams)) teams[t.id] = { ...t, isUserControlled: t.id === userTeamId };
  }
  checkStructure(teams, settings);
  const players: Record<PlayerId, Player> = { ...entities.players };
  const count = opts.freeAgentCount ?? SEASON_CONFIG.freeAgentPoolSize;
  const freeAgents = generateFreeAgents(rng.fork('free-agents'), Math.max(0, count), year, new Set(Object.keys(players) as PlayerId[]));
  for (const p of freeAgents) players[p.id] = p;
  const season = createSeason(teams, settings, year, rng.fork('season'));
  const careerStats: Record<PlayerId, CareerStats> = {};
  for (const pid of Object.keys(players) as PlayerId[]) careerStats[pid] = emptyCareer(pid);
  return {
    id, name: opts.name?.trim() || SEASON_CONFIG.defaultLeagueName, settings, year, teams, players, retiredPlayers: {},
    coaches: entities.coaches, stadiums, season, freeAgentIds: freeAgents.map((p) => p.id), draft: null, freeAgency: null,
    pendingTrades: [], userTeamId, history: [], records: [], hallOfFame: [], events: [], careerStats,
    customPlaybooks: [], customOffensePlays: [], customDefensePlays: [], playLogs: {},
    rngSeed: rng.seed, rngState: rng.getState(), version: LEAGUE_VERSION,
  };
};

/**
 * Every integrity problem in a League (empty = valid): settings, roster <-> Player.teamId mirrors (both
 * ways, no player on two rosters), depth charts (only roster players; no depth-chart errors), every
 * referenced id resolving (stadiums, coaches, rivals, picks, schedule, standings, stats, careers, user
 * team), free agents unattached and listed, active/retired disjoint, and the schedule's own validity.
 */
export const validateLeague = (league: League): string[] => {
  const issues: string[] = validateSettings(league.settings).map((i) => `settings: ${i}`);
  const push = (msg: string): void => {
    issues.push(msg);
  };
  if (league.version !== LEAGUE_VERSION) push(`version ${league.version} (expected ${LEAGUE_VERSION})`);
  if (league.rngState.length !== 4) push('rngState must have 4 entries');
  const rosterOwner = new Map<PlayerId, TeamId>();
  for (const [key, t] of Object.entries(league.teams) as [TeamId, Team][]) {
    if (t.id !== key) push(`team ${key} has id ${t.id}`);
    if (!league.stadiums[t.stadiumId]) push(`${t.abbr}: unknown stadium ${t.stadiumId}`);
    if (t.headCoachId && !league.coaches[t.headCoachId]) push(`${t.abbr}: unknown head coach ${t.headCoachId}`);
    for (const c of t.staffIds) if (!league.coaches[c]) push(`${t.abbr}: unknown staff member ${c}`);
    for (const r of t.rivalIds) if (!league.teams[r]) push(`${t.abbr}: unknown rival ${r}`);
    for (const pk of t.picks) if (!league.teams[pk.originalTeamId] || !league.teams[pk.ownerTeamId]) push(`${t.abbr}: pick ${pk.id} references an unknown team`);
    const roster: Player[] = [];
    for (const pid of t.rosterIds) {
      const p = league.players[pid];
      if (!p) push(`${t.abbr}: roster player ${pid} does not exist`);
      else if (p.teamId !== t.id) push(`${t.abbr}: roster player ${pid} has teamId ${String(p.teamId)}`);
      if (rosterOwner.has(pid)) push(`${pid} is on the rosters of ${rosterOwner.get(pid)} and ${t.id}`);
      rosterOwner.set(pid, t.id);
      if (p) roster.push(p);
    }
    const onRoster = new Set(t.rosterIds);
    for (const [slot, ids] of Object.entries(t.depthChart)) for (const pid of ids) if (!onRoster.has(pid)) push(`${t.abbr}: depth chart ${slot} lists ${pid} who is not on the roster`);
    for (const d of validateDepthChart(t.depthChart, roster)) if (d.severity === 'error') push(`${t.abbr}: depth chart ${d.message}`);
  }
  const freeAgents = new Set(league.freeAgentIds);
  for (const [key, p] of Object.entries(league.players) as [PlayerId, Player][]) {
    if (p.id !== key) push(`player ${key} has id ${p.id}`);
    if (league.retiredPlayers[key]) push(`player ${key} is both active and retired`);
    if (p.teamId !== null && rosterOwner.get(key) !== p.teamId) push(`player ${key} claims team ${p.teamId} but is not on its roster`);
    if (p.teamId === null && !freeAgents.has(key)) push(`unattached player ${key} is not in freeAgentIds`);
  }
  for (const pid of league.freeAgentIds) if (league.players[pid]?.teamId !== null) push(`free agent ${pid} is missing or attached to a team`);
  for (const c of Object.values(league.coaches)) if (c.teamId !== null && !league.teams[c.teamId]) push(`coach ${c.id} references unknown team ${c.teamId}`);
  if (league.userTeamId !== null && !league.teams[league.userTeamId]) push(`unknown user team ${league.userTeamId}`);
  const s = league.season;
  if (!SEASON_PHASE_ORDER.includes(s.phase)) push(`unknown season phase ${s.phase}`);
  if (s.year !== league.year) push(`season year ${s.year} does not match league year ${league.year}`);
  for (const i of validateSchedule(s.schedule, league.teams, league.settings)) push(`schedule: ${i}`);
  for (const [tid, st] of Object.entries(s.standings)) if (!league.teams[tid as TeamId] || st.teamId !== tid) push(`standings entry ${tid} is invalid`);
  const known = (pid: string): boolean => !!lookupPlayer(league, pid as PlayerId);
  for (const pid of [...Object.keys(s.stats), ...Object.keys(s.playoffStats)]) if (!known(pid)) push(`season stats reference unknown player ${pid}`);
  for (const tid of Object.keys(s.teamStats)) if (!league.teams[tid as TeamId]) push(`team stats reference unknown team ${tid}`);
  for (const [pid, c] of Object.entries(league.careerStats)) if (!known(pid) || c.playerId !== pid) push(`career stats entry ${pid} is invalid`);
  return issues;
};

/** Returns the league when valid; throws one error listing every issue otherwise. */
export const assertValidLeague = (league: League): League => {
  const issues = validateLeague(league);
  if (issues.length > 0) throw new Error(`Invalid league:\n  ${issues.slice(0, 25).join('\n  ')}${issues.length > 25 ? `\n  ...and ${issues.length - 25} more` : ''}`);
  return league;
};
