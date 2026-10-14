/**
 * League bootstrap: turns the 32 team templates in src/data/teams.json into Team records with
 * stadiums, coaching staffs, 53-man rosters, depth charts, draft picks and cap-compliant contracts.
 * Deterministic per seed: the same seed and options always produce the same entities.
 *
 * Team strengths are spread evenly across the league (then shuffled) so every league has
 * contenders, mid-table teams and rebuilders. Ids come from `rng.fork('ids')` via core/ids.
 */
import { createRng } from '@/core/rng';
import type { Rng } from '@/core/rng';
import { coachId, playerId, stadiumId, teamId as makeTeamId } from '@/core/ids';
import type { CoachId, PlayerId, StadiumId, TeamId } from '@/core/ids';
import { clamp, lerp } from '@/core/math';
import type { Contract, ContractRole, Player } from '@/players/types';
import { DEVELOPMENT } from '@/players/development';
import { createNamePool } from '@/players/names';
import type { NameSource } from '@/players/generator';
import { collegesInRegion, findTeamTemplate, loadColleges, loadRegions, loadTeamData } from '@/teams/data';
import type { College, Region, TeamTemplate } from '@/teams/data';
import type { Coach, DraftPick, Stadium, Team } from '@/teams/types';
import { STARTER_COUNTS, autoDepthChart, depthRank } from '@/teams/depth-chart';
import { MARKET_DEFAULTS, defaultFacilities, defaultFans, emptyTeamFinances, generateRoster } from '@/teams/generator';
import { generateStaff, headCoachOf } from '@/teams/coach-generator';
import { teamChemistry, teamRatings } from '@/teams/ratings';

/** Inputs for generateLeagueEntities. Only year and salaryCap are required. */
export interface GenerateLeagueOptions {
  /** Current league year (contracts, rookie years, first draft). */
  year: number;
  /** Salary cap in dollars. */
  salaryCap: number;
  /** Abbreviation of the user's team; omitted = every team AI-controlled. */
  userTeamAbbr?: string;
  /** Defaults to the shipped name pool. */
  names?: NameSource;
  /** Defaults to loadTeamData(). */
  templates?: readonly TeamTemplate[];
  regions?: readonly Region[];
  colleges?: readonly College[];
  /** First draft year that picks are created for (default: `year`). */
  firstPickYear?: number;
  /** Draft years of picks each team owns (default 3). */
  pickYears?: number;
  draftRounds?: number;
  playbookId?: string;
  /** Fraction of the cap each team ends up using, drawn from [lo, hi]. Default [0.92, 0.98]. */
  capUsage?: readonly [number, number];
  /** Team strength spread [lo, hi] over 0..1. Default [0.1, 0.9]. */
  strengthRange?: readonly [number, number];
}

/** Everything generateLeagueEntities produces; the franchise module wraps it into a League. */
export interface LeagueEntities {
  teams: Record<TeamId, Team>;
  players: Record<PlayerId, Player>;
  coaches: Record<CoachId, Coach>;
  stadiums: Record<StadiumId, Stadium>;
}

/** Playbook id every team starts with unless overridden. */
export const DEFAULT_PLAYBOOK_ID = 'balanced';
/** Draft years of picks each team owns at league start. */
export const DEFAULT_PICK_YEARS = 3;
/** Rounds per draft. */
export const DEFAULT_DRAFT_ROUNDS = 7;
/** Cap usage band [lo, hi] a fully priced roster is fitted into. */
export const DEFAULT_CAP_USAGE: readonly [number, number] = [0.92, 0.98];
/** Team strength ladder [lo, hi] spread across the league. */
export const DEFAULT_STRENGTH_RANGE: readonly [number, number] = [0.1, 0.9];
/** Contracts never scale up past this factor of the asking salary (weak teams simply keep cap space). */
export const MAX_CONTRACT_SCALE_UP = 1.5;
const MONEY_STEP = 10_000;

/* ------------------------------------------------------------------ contracts */

/** Salary guaranteed as a fraction of total value, by role. */
export const GUARANTEE_FRACTION: Readonly<Record<ContractRole, number>> = {
  franchise: 0.7, starter: 0.5, rotation: 0.35, backup: 0.2, developmental: 0.25,
};
/** Signing bonus as a fraction of total value, by role. */
export const BONUS_FRACTION: Readonly<Record<ContractRole, number>> = {
  franchise: 0.3, starter: 0.22, rotation: 0.12, backup: 0.05, developmental: 0.08,
};
const CONTRACT_YEARS: Readonly<Record<ContractRole, readonly [number, number]>> = {
  franchise: [3, 4], starter: [2, 4], rotation: [1, 3], backup: [1, 3], developmental: [2, 4],
};
const FRANCHISE_OVERALL = 86;

const roundMoney = (v: number): number => Math.round(v / MONEY_STEP) * MONEY_STEP;

/** Annual cap charge of a contract (salary plus prorated bonus). */
export const contractCapHit = (c: Pick<Contract, 'salary' | 'signingBonus' | 'years'>): number => c.salary + c.signingBonus / c.years;

/** Role from overall and depth rank: stars are franchise players, starters start, the young develop. */
export const contractRoleFor = (player: Pick<Player, 'overall' | 'age' | 'experience' | 'position'>, rank: number): ContractRole => {
  if (player.overall >= FRANCHISE_OVERALL) return 'franchise';
  const starterCount = STARTER_COUNTS[player.position];
  if (rank < starterCount) return 'starter';
  if (rank < starterCount + 1) return 'rotation';
  return player.age <= 24 && player.experience <= 2 ? 'developmental' : 'backup';
};

/** Contract length from role, shortened for veterans (32+ sign one- or two-year deals). */
export const rollContractYears = (rng: Rng, player: Pick<Player, 'age'>, role: ContractRole): number => {
  const [lo, hi] = CONTRACT_YEARS[role];
  const years = rng.int(lo, hi);
  return player.age >= 32 ? Math.min(years, 2) : years;
};

/** Share of multi-year deals that are in their final season at league start. */
const EXPIRING_SHARE = 0.3;

/**
 * A pre-existing contract at the player's asking salary, signed 0..years-1 seasons ago so expiries
 * are staggered across the league (roughly a third of multi-year deals expire after year one).
 */
export const draftContract = (rng: Rng, player: Player, rank: number, year: number): Contract => {
  const role = contractRoleFor(player, rank);
  const years = rollContractYears(rng, player, role);
  const yearsRemaining = years === 1 || rng.chance(EXPIRING_SHARE) ? 1 : rng.int(2, years);
  const salary = roundMoney(Math.max(player.askingSalary, DEVELOPMENT.salary.minimum));
  const total = salary * years;
  return {
    salary,
    years,
    yearsRemaining,
    guaranteed: roundMoney(total * GUARANTEE_FRACTION[role]),
    signingBonus: roundMoney(total * BONUS_FRACTION[role]),
    role,
    signedYear: year - (years - yearsRemaining),
    restructured: false,
    tag: null,
  };
};

const scaleContract = (c: Contract, factor: number): Contract => ({
  ...c,
  salary: Math.max(DEVELOPMENT.salary.minimum, roundMoney(c.salary * factor)),
  guaranteed: roundMoney(c.guaranteed * factor),
  signingBonus: roundMoney(c.signingBonus * factor),
});

/**
 * Scales a team's contracts proportionally so the cap hits total `cap * usage` (never above the
 * cap). Salaries floor at the league minimum; contracts already at the floor are left alone while
 * the rest absorb the difference. Scale-up is capped so weak teams keep cap space.
 */
export const fitContractsToCap = (contracts: readonly Contract[], cap: number, usage: number): Contract[] => {
  const target = cap * clamp(usage, 0, 1);
  const total = contracts.reduce((s, c) => s + contractCapHit(c), 0);
  if (total <= 0) return [...contracts];
  let out = contracts.map((c) => scaleContract(c, clamp(target / total, 0.05, MAX_CONTRACT_SCALE_UP)));
  for (let pass = 0; pass < 8; pass++) {
    const hit = out.reduce((s, c) => s + contractCapHit(c), 0);
    if (hit <= cap) break;
    const minimum = DEVELOPMENT.salary.minimum;
    const flexible = out.filter((c) => c.salary > minimum);
    const fixed = hit - flexible.reduce((s, c) => s + contractCapHit(c), 0);
    const room = Math.max(0, target - fixed);
    const flexibleHit = hit - fixed;
    const factor = flexibleHit > 0 ? clamp(room / flexibleHit, 0.05, 1) : 1;
    out = out.map((c) => (c.salary > minimum ? scaleContract(c, factor) : c));
  }
  return out;
};

/* --------------------------------------------------------------- strengths */

/** Evenly spread strengths over `range`, shuffled and lightly jittered: a full ladder of team quality. */
export const teamStrengths = (rng: Rng, count: number, range: readonly [number, number] = DEFAULT_STRENGTH_RANGE): number[] => {
  const ladder = Array.from({ length: count }, (_, i) => lerp(range[0], range[1], count > 1 ? i / (count - 1) : 0.5));
  return rng.shuffle(ladder).map((s) => clamp(s + rng.gaussian(0, 0.02), 0, 1));
};

/* ---------------------------------------------------------------- helpers */

const stadiumLevel = (template: TeamTemplate, year: number): number => {
  const s = template.stadium;
  const atmosphere = clamp((s.atmosphere - 40) / 55, 0, 1);
  const modern = clamp((s.yearBuilt - (year - 50)) / 50, 0, 1);
  return clamp(1 + Math.round((0.5 * atmosphere + 0.5 * modern) * 4), 1, 5);
};

const buildStadium = (id: StadiumId, template: TeamTemplate, year: number): Stadium => ({
  id,
  name: template.stadium.name,
  city: template.city,
  capacity: template.stadium.capacity,
  fieldType: template.stadium.fieldType,
  roof: template.stadium.roof,
  climate: template.stadium.climate,
  atmosphere: template.stadium.atmosphere,
  level: stadiumLevel(template, year),
  yearBuilt: template.stadium.yearBuilt,
});

const buildPicks = (teamId: TeamId, firstYear: number, years: number, rounds: number): DraftPick[] => {
  const picks: DraftPick[] = [];
  for (let y = firstYear; y < firstYear + years; y++) {
    for (let r = 1; r <= rounds; r++) {
      picks.push({ id: `${y}-r${r}-${teamId}`, year: y, round: r, originalTeamId: teamId, ownerTeamId: teamId, overall: null });
    }
  }
  return picks;
};

/** Region list biased toward the team's home region (about a third of players are local). */
const regionDraw = (regions: readonly Region[], home: string): string[] => [...regions.map((r) => r.id), home, home, home];

/** College list biased toward the team's region. */
const collegeDraw = (colleges: readonly College[], home: string): string[] => {
  const local = collegesInRegion(home, colleges).map((c) => c.name);
  return [...colleges.map((c) => c.name), ...local, ...local];
};

const validateOptions = (opts: GenerateLeagueOptions): void => {
  if (!Number.isInteger(opts.year)) throw new Error('generateLeagueEntities: year must be an integer');
  if (!Number.isFinite(opts.salaryCap) || opts.salaryCap <= 0) throw new Error('generateLeagueEntities: salaryCap must be positive');
  if (opts.pickYears !== undefined && (!Number.isInteger(opts.pickYears) || opts.pickYears < 0)) throw new Error('generateLeagueEntities: pickYears must be >= 0');
  if (opts.draftRounds !== undefined && (!Number.isInteger(opts.draftRounds) || opts.draftRounds < 1)) throw new Error('generateLeagueEntities: draftRounds must be >= 1');
  if (opts.capUsage && (opts.capUsage[0] > opts.capUsage[1] || opts.capUsage[1] > 1 || opts.capUsage[0] < 0)) {
    throw new Error('generateLeagueEntities: capUsage must be [lo, hi] within 0..1');
  }
};

/* -------------------------------------------------------------- generator */

/**
 * Builds every entity a fresh league needs. `seed` may be a number or an existing Rng. Every
 * player's teamId mirrors its team's rosterIds, every coach's teamId its staff, every team sits
 * under the cap and every rival abbreviation is resolved to a TeamId.
 */
export const generateLeagueEntities = (seed: number | Rng, opts: GenerateLeagueOptions): LeagueEntities => {
  validateOptions(opts);
  const rng = typeof seed === 'number' ? createRng(seed) : seed;
  const idsRng = rng.fork('ids');
  const templates = opts.templates ?? loadTeamData();
  const regions = opts.regions ?? loadRegions();
  const colleges = opts.colleges ?? loadColleges();
  const names = opts.names ?? createNamePool();
  const userAbbr = opts.userTeamAbbr?.toUpperCase();
  if (userAbbr !== undefined && !findTeamTemplate(userAbbr, templates)) {
    throw new Error(`generateLeagueEntities: unknown user team '${opts.userTeamAbbr}'`);
  }
  const capUsage = opts.capUsage ?? DEFAULT_CAP_USAGE;
  const strengths = teamStrengths(rng, templates.length, opts.strengthRange);

  const teams: Record<TeamId, Team> = {};
  const players: Record<PlayerId, Player> = {};
  const coaches: Record<CoachId, Coach> = {};
  const stadiums: Record<StadiumId, Stadium> = {};
  const idsByAbbr = new Map<string, TeamId>();
  for (const t of templates) idsByAbbr.set(t.abbr, makeTeamId(idsRng));

  templates.forEach((template, index) => {
    const id = idsByAbbr.get(template.abbr) as TeamId;
    const strength = strengths[index] ?? 0.5;
    const market = MARKET_DEFAULTS[template.marketSize];
    let sid = stadiumId(idsRng);
    while (stadiums[sid]) sid = stadiumId(idsRng);
    const stadium = buildStadium(sid, template, opts.year);
    stadiums[stadium.id] = stadium;

    // Ids come from independent forks per team, so a clash is astronomically rare but must never corrupt the league.
    const staff = generateStaff(rng.fork(`staff:${template.abbr}`), id, { names, quality: clamp(0.2 + strength * 0.6 + rng.gaussian(0, 0.08), 0, 1) })
      .map((c) => (coaches[c.id] ? { ...c, id: coachId(idsRng) } : c));
    for (const c of staff) coaches[c.id] = c;
    const head = headCoachOf(staff);

    const rosterRng = rng.fork(`roster:${template.abbr}`);
    let roster = generateRoster(rosterRng, {
      quality: strength, names, year: opts.year,
      regions: regionDraw(regions, template.region),
      colleges: collegeDraw(colleges, template.region),
    });
    roster = roster.map((p) => (players[p.id] ? { ...p, id: playerId(idsRng) } : p));
    const depthChart = autoDepthChart(roster);
    const contractRng = rng.fork(`contracts:${template.abbr}`);
    const drafted = roster.map((p) => draftContract(contractRng, p, depthRank(depthChart, p.position, p.id), opts.year));
    const usage = contractRng.range(capUsage[0], capUsage[1]);
    const fitted = fitContractsToCap(drafted, opts.salaryCap, usage);
    roster = roster.map((p, i) => ({ ...p, teamId: id, contract: fitted[i] ?? null }));
    for (const p of roster) players[p.id] = p;

    const ratings = teamRatings(roster, depthChart);
    const facilityBase = market.facilityLevel + (strength > 0.7 ? 1 : 0);
    const facilities = defaultFacilities(facilityBase);
    for (const key of Object.keys(facilities) as (keyof typeof facilities)[]) {
      facilities[key] = clamp(facilities[key] + rng.int(-1, 1), 1, 5);
    }
    const fans = defaultFans(template.marketSize);
    fans.support = clamp(Math.round(fans.support + (strength - 0.5) * 24), 0, 100);
    fans.excitement = clamp(Math.round(40 + strength * 30 + rng.int(-5, 5)), 0, 100);
    fans.attendancePct = clamp(Math.round((0.72 + strength * 0.2 + fans.support / 500) * 100) / 100, 0.5, 1);

    teams[id] = {
      id,
      city: template.city,
      name: template.name,
      abbr: template.abbr,
      conference: template.conference,
      division: template.division,
      colors: { ...template.colors },
      logoSeed: template.logoSeed,
      stadiumId: stadium.id,
      rosterIds: roster.map((p) => p.id),
      depthChart,
      headCoachId: head?.id ?? null,
      staffIds: staff.map((c) => c.id),
      playbookId: opts.playbookId ?? DEFAULT_PLAYBOOK_ID,
      rivalIds: template.rivalAbbrs.map((abbr) => idsByAbbr.get(abbr)).filter((r): r is TeamId => r !== undefined),
      picks: buildPicks(id, opts.firstPickYear ?? opts.year, opts.pickYears ?? DEFAULT_PICK_YEARS, opts.draftRounds ?? DEFAULT_DRAFT_ROUNDS),
      finances: emptyTeamFinances(opts.salaryCap, { cash: market.cash, ticketPrice: market.ticketPrice }),
      facilities,
      fans,
      history: [],
      championships: 0,
      chemistry: teamChemistry(roster),
      overall: ratings.overall,
      offenseRating: ratings.offense,
      defenseRating: ratings.defense,
      region: template.region,
      marketSize: template.marketSize,
      isUserControlled: template.abbr === userAbbr,
    };
  });

  return { teams, players, coaches, stadiums };
};

/** Sum of the current cap hits of a team's roster. */
export const rosterCapHit = (team: Pick<Team, 'rosterIds'>, players: Readonly<Record<PlayerId, Player>>): number =>
  team.rosterIds.reduce((s, id) => {
    const contract = players[id]?.contract;
    return s + (contract ? contractCapHit(contract) : 0);
  }, 0);
