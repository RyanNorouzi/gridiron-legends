/**
 * Contracts and cap math: the single owner of the canonical derivations documented on the Contract type
 * (players/types.ts). ui/ and save/ import these helpers instead of re-deriving them.
 *
 * YEARS. Every function takes an explicit cap year: the season a charge lands in. A contract covers the
 * seasons signedYear .. signedYear + years - 1. During the offseason phases (offseason .. trainingCamp)
 * roster moves count against NEXT season's cap, so `leagueCapYear(league)` is league.year + 1 there and
 * league.year otherwise; contracts signed in the offseason therefore start the following season. The stored
 * `yearsRemaining` is a cache of `yearsRemainingAt(contract, capYear)`; `syncYearsRemaining` refreshes it.
 *
 * Tuning lives in src/data/contract-market.json and src/data/rookie-scale.json (validated at load). Pure:
 * every function returns new objects.
 */
import marketJson from '@/data/contract-market.json';
import rookieJson from '@/data/rookie-scale.json';
import type { PlayerId } from '@/core/ids';
import { clamp } from '@/core/math';
import { adjustMorale } from '@/players/personality';
import type { Contract, ContractRole, Player, Position } from '@/players/types';
import type { Team } from '@/teams/types';
import type { League, LeagueSettings, SeasonPhase } from '@/franchise/types';

/* ------------------------------------------------------------ JSON validation */

/** Plain JSON object. */
export type JsonObject = Record<string, unknown>;

/** Asserts `v` is a plain object; throws `${file}: ${path} ...` otherwise. */
export const jsonObject = (v: unknown, file: string, path: string): JsonObject => {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new Error(`${file}: ${path} must be an object`);
  return v as JsonObject;
};

/** Asserts `v` is an array. */
export const jsonArray = (v: unknown, file: string, path: string): unknown[] => {
  if (!Array.isArray(v)) throw new Error(`${file}: ${path} must be an array`);
  return v;
};

/** Reads a finite number field within [min, max]. */
export const jsonNumber = (o: JsonObject, key: string, file: string, path: string, min = -Infinity, max = Infinity): number => {
  const v = o[key];
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) {
    throw new Error(`${file}: ${path}.${key} must be a number in [${min}, ${max}], got ${JSON.stringify(v)}`);
  }
  return v;
};

/* ------------------------------------------------------------------- data */

/** Contract-level tuning from contract-market.json. */
export interface ContractData {
  /** Cap the dollar figures in the data files were authored against; amounts scale by salaryCap / referenceCap. */
  referenceCap: number;
  /** Money is rounded to this step (dollars). */
  moneyStep: number;
  /** Veteran minimum multiplier by experience band (first band whose maxExperience >= experience). */
  minimumByExperience: { maxExperience: number; mult: number }[];
  tag: { franchiseTopN: number; transitionTopN: number; franchiseRaise: number; transitionRaise: number };
}

const MARKET_FILE = 'contract-market.json';

/** Validates the contract-level sections of contract-market.json. */
export const validateContractData = (raw: unknown): ContractData => {
  const o = jsonObject(raw, MARKET_FILE, '$');
  const minimumByExperience = jsonArray(o.minimumByExperience, MARKET_FILE, '$.minimumByExperience').map((b, i) => {
    const band = jsonObject(b, MARKET_FILE, `$.minimumByExperience[${i}]`);
    const p = `$.minimumByExperience[${i}]`;
    return { maxExperience: jsonNumber(band, 'maxExperience', MARKET_FILE, p, 0), mult: jsonNumber(band, 'mult', MARKET_FILE, p, 1, 5) };
  });
  if (minimumByExperience.length === 0) throw new Error(`${MARKET_FILE}: $.minimumByExperience must not be empty`);
  const tag = jsonObject(o.tag, MARKET_FILE, '$.tag');
  return {
    referenceCap: jsonNumber(o, 'referenceCap', MARKET_FILE, '$', 1),
    moneyStep: jsonNumber(o, 'moneyStep', MARKET_FILE, '$', 1),
    minimumByExperience: minimumByExperience.sort((a, b) => a.maxExperience - b.maxExperience),
    tag: {
      franchiseTopN: jsonNumber(tag, 'franchiseTopN', MARKET_FILE, '$.tag', 1, 50),
      transitionTopN: jsonNumber(tag, 'transitionTopN', MARKET_FILE, '$.tag', 1, 50),
      franchiseRaise: jsonNumber(tag, 'franchiseRaise', MARKET_FILE, '$.tag', 1, 3),
      transitionRaise: jsonNumber(tag, 'transitionRaise', MARKET_FILE, '$.tag', 1, 3),
    },
  };
};

/** Validated contract tuning. */
export const CONTRACT_DATA: ContractData = validateContractData(marketJson);

/** One draft round of the rookie wage scale (salaries are APY at the reference cap). */
export interface RookieRoundScale {
  round: number;
  years: number;
  topSalary: number;
  bottomSalary: number;
  guaranteedFraction: number;
  bonusFraction: number;
  /** >1 front-loads the drop from the first pick of the round. */
  curve: number;
}

export interface RookieScale {
  referenceCap: number;
  picksPerRound: number;
  undraftedYears: number;
  rounds: RookieRoundScale[];
}

const ROOKIE_FILE = 'rookie-scale.json';

/** Validates rookie-scale.json: contiguous rounds from 1, top >= bottom, and each round below the previous one. */
export const validateRookieScale = (raw: unknown): RookieScale => {
  const o = jsonObject(raw, ROOKIE_FILE, '$');
  const rounds = jsonArray(o.rounds, ROOKIE_FILE, '$.rounds').map((r, i): RookieRoundScale => {
    const p = `$.rounds[${i}]`;
    const x = jsonObject(r, ROOKIE_FILE, p);
    return {
      round: jsonNumber(x, 'round', ROOKIE_FILE, p, 1, 20),
      years: jsonNumber(x, 'years', ROOKIE_FILE, p, 1, 7),
      topSalary: jsonNumber(x, 'topSalary', ROOKIE_FILE, p, 1),
      bottomSalary: jsonNumber(x, 'bottomSalary', ROOKIE_FILE, p, 1),
      guaranteedFraction: jsonNumber(x, 'guaranteedFraction', ROOKIE_FILE, p, 0, 1),
      bonusFraction: jsonNumber(x, 'bonusFraction', ROOKIE_FILE, p, 0, 1),
      curve: jsonNumber(x, 'curve', ROOKIE_FILE, p, 0.1, 5),
    };
  });
  if (rounds.length === 0) throw new Error(`${ROOKIE_FILE}: $.rounds must not be empty`);
  rounds.forEach((r, i) => {
    if (r.round !== i + 1) throw new Error(`${ROOKIE_FILE}: $.rounds[${i}].round must be ${i + 1}`);
    if (r.topSalary < r.bottomSalary) throw new Error(`${ROOKIE_FILE}: $.rounds[${i}] topSalary < bottomSalary`);
    const prev = rounds[i - 1];
    if (prev && prev.bottomSalary < r.topSalary) throw new Error(`${ROOKIE_FILE}: round ${r.round} starts above round ${prev.round} ends`);
  });
  return {
    referenceCap: jsonNumber(o, 'referenceCap', ROOKIE_FILE, '$', 1),
    picksPerRound: jsonNumber(o, 'picksPerRound', ROOKIE_FILE, '$', 1, 64),
    undraftedYears: jsonNumber(o, 'undraftedYears', ROOKIE_FILE, '$', 1, 5),
    rounds,
  };
};

/** Validated rookie wage scale. */
export const ROOKIE_SCALE: RookieScale = validateRookieScale(rookieJson);

/** Rounds money to the data step (whole dollars). */
export const roundMoney = (v: number): number => Math.round(v / CONTRACT_DATA.moneyStep) * CONTRACT_DATA.moneyStep;

/* -------------------------------------------------------------- cap years */

/** Phases between one season's awards and the next preseason; moves there count against next season's cap. */
export const OFFSEASON_PHASES: readonly SeasonPhase[] = ['offseason', 'resigning', 'freeAgency', 'draft', 'postDraft', 'trainingCamp'];

/** Cap year for a league year and phase (see the module header). */
export const capYearFor = (year: number, phase: SeasonPhase): number => (OFFSEASON_PHASES.includes(phase) ? year + 1 : year);

/** Cap year that roster moves made right now count against. New contracts start in this season. */
export const leagueCapYear = (league: Pick<League, 'year' | 'season'>): number => capYearFor(league.year, league.season.phase);

/** June-1 style cutoff: releases after the draft and during the season split their dead money over two years. */
export const isPostJuneCutoff = (phase: SeasonPhase): boolean => !['offseason', 'resigning', 'freeAgency', 'draft'].includes(phase);

/* ------------------------------------------------------------ contract math */

/** Last season the contract covers. */
export const contractEndYear = (c: Pick<Contract, 'signedYear' | 'years'>): number => c.signedYear + c.years - 1;

/** Seasons left counting `year` itself (years when the deal has not started yet, 0 once it has ended). */
export const yearsRemainingAt = (c: Pick<Contract, 'signedYear' | 'years'>, year: number): number =>
  clamp(c.signedYear + c.years - year, 0, c.years);

/** True when the contract covers `year`. */
export const isActiveIn = (c: Pick<Contract, 'signedYear' | 'years'>, year: number): boolean =>
  year >= c.signedYear && year <= contractEndYear(c);

/** Average annual value: salary plus the prorated bonus (what one season costs against the cap). */
export const contractApy = (c: Pick<Contract, 'salary' | 'signingBonus' | 'years'>): number =>
  c.salary + (c.years > 0 ? c.signingBonus / c.years : 0);

/** Cap charge in `year`: salary + signingBonus / years while the contract covers the year, else 0. */
export const capHit = (c: Contract | null | undefined, year: number): number =>
  c && isActiveIn(c, year) ? Math.round(contractApy(c)) : 0;

/**
 * Dead money if the player were released in `year`: the unamortised bonus plus guaranteed salary not yet
 * paid (bonus * yr / years + max(0, guaranteed - salary * (years - yr)), yr = seasons left incl. `year`).
 */
export const deadMoney = (c: Contract | null | undefined, year: number): number => {
  if (!c || year > contractEndYear(c)) return 0;
  const yr = yearsRemainingAt(c, year);
  return Math.round((c.signingBonus * yr) / c.years + Math.max(0, c.guaranteed - c.salary * (c.years - yr)));
};

/** Bonus not yet charged to the cap from `year` on. */
export const unamortizedBonus = (c: Contract, year: number): number => Math.round((c.signingBonus * yearsRemainingAt(c, year)) / c.years);

/** Contract with the cached yearsRemaining refreshed for `year` (same object when already current). */
export const syncYearsRemaining = (c: Contract, year: number): Contract => {
  const yr = yearsRemainingAt(c, year);
  return yr === c.yearsRemaining ? c : { ...c, yearsRemaining: yr };
};

/* ----------------------------------------------------------------- team cap */

/** Sum of the roster's cap hits in `year`. */
export const teamCapHit = (team: Pick<Team, 'rosterIds'>, players: Readonly<Record<PlayerId, Player>>, year: number): number =>
  team.rosterIds.reduce((s, id) => s + capHit(players[id]?.contract, year), 0);

/** Dead money booked against `year`. */
export const teamDeadMoney = (team: Pick<Team, 'finances'>, year: number): number => team.finances.deadMoney[year] ?? 0;

/** Cap room in `year`: salaryCap + capCarryover - roster hits - dead money (settings.salaryCap is that year's cap). */
export const capSpace = (
  team: Pick<Team, 'rosterIds' | 'finances'>, players: Readonly<Record<PlayerId, Player>>,
  settings: Pick<LeagueSettings, 'salaryCap'>, year: number,
): number => settings.salaryCap + team.finances.capCarryover - teamCapHit(team, players, year) - teamDeadMoney(team, year);

/** One season of a cap projection. */
export interface CapYearProjection {
  year: number;
  cap: number;
  committed: number;
  deadMoney: number;
  space: number;
}

/**
 * Cap room for `years` seasons from `fromYear` (whose cap is settings.salaryCap), growing the cap by
 * capGrowthRate per year. Carryover only counts in the first year.
 */
export const projectedCapSpace = (
  team: Pick<Team, 'rosterIds' | 'finances'>, players: Readonly<Record<PlayerId, Player>>,
  settings: Pick<LeagueSettings, 'salaryCap' | 'capGrowthRate'>, fromYear: number, years = 3,
): CapYearProjection[] =>
  Array.from({ length: Math.max(0, years) }, (_, i) => {
    const year = fromYear + i;
    const cap = Math.round(settings.salaryCap * Math.pow(1 + settings.capGrowthRate, i)) + (i === 0 ? team.finances.capCarryover : 0);
    const committed = teamCapHit(team, players, year);
    const dead = teamDeadMoney(team, year);
    return { year, cap, committed, deadMoney: dead, space: cap - committed - dead };
  });

/** Cap compliance snapshot for one year. */
export interface CapStatus extends CapYearProjection {
  compliant: boolean;
  overBy: number;
}

/** Compliance check: a team is compliant when its cap space in `year` is >= 0. */
export const capStatus = (
  team: Pick<Team, 'rosterIds' | 'finances'>, players: Readonly<Record<PlayerId, Player>>,
  settings: Pick<LeagueSettings, 'salaryCap' | 'capGrowthRate'>, year: number,
): CapStatus => {
  const [p] = projectedCapSpace(team, players, settings, year, 1);
  const proj = p as CapYearProjection;
  return { ...proj, compliant: proj.space >= 0, overBy: Math.max(0, -proj.space) };
};

/* ---------------------------------------------------------------- creation */

/** Negotiated terms: base salary per year, length, guaranteed salary, signing bonus (prorated), role. */
export interface ContractTerms {
  salary: number;
  years: number;
  guaranteed: number;
  signingBonus: number;
  role: ContractRole;
}

export interface CreateContractInput extends ContractTerms {
  /** First season covered (the cap year the deal starts in). */
  year: number;
  tag?: Contract['tag'];
}

/** Longest contract the league allows. */
export const MAX_CONTRACT_YEARS = 7;

/** Builds a validated Contract (whole dollars, guaranteed capped at total salary). Throws on invalid terms. */
export const createContract = (input: CreateContractInput): Contract => {
  const { salary, years, guaranteed, signingBonus, role, year } = input;
  if (!Number.isInteger(years) || years < 1 || years > MAX_CONTRACT_YEARS) throw new Error(`createContract: years must be 1..${MAX_CONTRACT_YEARS}, got ${years}`);
  for (const [k, v] of [['salary', salary], ['guaranteed', guaranteed], ['signingBonus', signingBonus]] as const) {
    if (!Number.isFinite(v) || v < 0) throw new Error(`createContract: ${k} must be a non-negative number, got ${v}`);
  }
  if (!Number.isInteger(year)) throw new Error(`createContract: year must be an integer, got ${year}`);
  const s = Math.round(salary);
  return {
    salary: s, years, yearsRemaining: years, guaranteed: Math.min(Math.round(guaranteed), s * years),
    signingBonus: Math.round(signingBonus), role, signedYear: year, restructured: false, tag: input.tag ?? null,
  };
};

/** Splits an APY into terms: `bonusFraction` of the total value as signing bonus, `guaranteeFraction` of the salary guaranteed. */
export const termsFromApy = (apy: number, years: number, role: ContractRole, guaranteeFraction: number, bonusFraction: number): ContractTerms => {
  const bonus = roundMoney(apy * years * clamp(bonusFraction, 0, 1));
  const salary = Math.max(0, roundMoney(apy - bonus / years));
  return { salary, years, guaranteed: roundMoney(salary * years * clamp(guaranteeFraction, 0, 1)), signingBonus: bonus, role };
};

/** Veteran minimum for a player with `experience` seasons. */
export const minimumSalaryFor = (experience: number, settings: Pick<LeagueSettings, 'minimumSalary'>): number => {
  const bands = CONTRACT_DATA.minimumByExperience;
  const band = bands.find((b) => experience <= b.maxExperience) ?? bands[bands.length - 1];
  return roundMoney(settings.minimumSalary * (band?.mult ?? 1));
};

/** A non-guaranteed minimum deal (backup role) starting in `year`. */
export const minimumContract = (
  player: Pick<Player, 'experience'>, year: number, settings: Pick<LeagueSettings, 'minimumSalary'>, years = 1,
): Contract => createContract({ salary: minimumSalaryFor(player.experience, settings), years, guaranteed: 0, signingBonus: 0, role: 'backup', year });

/* ----------------------------------------------------------- rookie scale */

/** Round-scale entry for a round (rounds past the table reuse the last one). */
const rookieRound = (round: number): RookieRoundScale => {
  const r = ROOKIE_SCALE.rounds[clamp(Math.floor(round), 1, ROOKIE_SCALE.rounds.length) - 1];
  if (!r) throw new Error(`rookie scale: no data for round ${round}`);
  return r;
};

/** Round and pick-in-round for an overall pick number. */
export const pickInRoundFromOverall = (overall: number, picksPerRound: number): { round: number; pickInRound: number } => ({
  round: Math.floor((overall - 1) / picksPerRound) + 1,
  pickInRound: ((overall - 1) % picksPerRound) + 1,
});

/** Rookie APY for a slot, scaled to `salaryCap`: non-increasing in round and pick. */
export const rookieScaleApy = (round: number, pickInRound: number, salaryCap: number): number => {
  const r = rookieRound(round);
  const t = clamp((pickInRound - 1) / Math.max(1, ROOKIE_SCALE.picksPerRound - 1), 0, 1);
  const apy = r.bottomSalary + (r.topSalary - r.bottomSalary) * Math.pow(1 - t, r.curve);
  return roundMoney((apy * salaryCap) / ROOKIE_SCALE.referenceCap);
};

/** Slotted rookie contract (developmental role) for a drafted player, starting in `year`. */
export const rookieContract = (
  round: number, pickInRound: number, year: number, settings: Pick<LeagueSettings, 'salaryCap' | 'minimumSalary'>,
): Contract => {
  const r = rookieRound(round);
  const apy = Math.max(rookieScaleApy(round, pickInRound, settings.salaryCap), minimumSalaryFor(0, settings));
  return createContract({ ...termsFromApy(apy, r.years, 'developmental', r.guaranteedFraction, r.bonusFraction), year });
};

/** Undrafted free-agent deal: rookie minimum, no guarantees, ROOKIE_SCALE.undraftedYears long. */
export const undraftedContract = (year: number, settings: Pick<LeagueSettings, 'minimumSalary'>): Contract =>
  createContract({ salary: minimumSalaryFor(0, settings), years: ROOKIE_SCALE.undraftedYears, guaranteed: 0, signingBonus: 0, role: 'developmental', year });

/* ------------------------------------------------------ extension/restructure */

/**
 * Replaces the player's contract with a new deal starting in `year`. The old contract's unamortised bonus
 * rolls into the new proration and its unpaid guaranteed salary stays guaranteed. Morale gets a 'contract' lift.
 */
export const extend = (player: Player, terms: ContractTerms, year: number): Player => {
  const old = player.contract;
  let rolled = 0;
  let unpaidGuarantee = 0;
  if (old && year <= contractEndYear(old)) {
    const yr = yearsRemainingAt(old, year);
    rolled = unamortizedBonus(old, year);
    unpaidGuarantee = Math.max(0, old.guaranteed - old.salary * (old.years - yr));
  }
  const contract = createContract({ ...terms, guaranteed: Math.max(terms.guaranteed, unpaidGuarantee), signingBonus: terms.signingBonus + rolled, year });
  return { ...player, contract, morale: adjustMorale(player, { type: 'contract' }) };
};

/**
 * The same deal re-based to start in `year` (a season it covers): only the seasons left, the unamortised bonus
 * and the unpaid guarantees. Cap hits and dead money from `year` on are unchanged; the input comes back as-is
 * when `year` is its first season or outside it.
 */
export const rebaseContract = (c: Contract, year: number): Contract => {
  if (year <= c.signedYear || year > contractEndYear(c)) return c;
  const yr = yearsRemainingAt(c, year);
  return {
    ...c, years: yr, yearsRemaining: yr, signedYear: year, signingBonus: unamortizedBonus(c, year),
    guaranteed: Math.max(0, c.guaranteed - c.salary * (c.years - yr)),
  };
};

/** Options for restructures: the salary floor and the cap year it happens in (mid-deal restructures re-base first). */
export interface RestructureOptions {
  minimumSalary?: number;
  /** Cap year of the restructure; after the first season the new bonus is prorated over the seasons left only. */
  year?: number;
}

const restructureBase = (c: Contract, year: number | undefined): Contract => (year === undefined ? c : rebaseContract(c, year));

/** Largest salary conversion allowed (two or more seasons left, salary kept at or above `minimumSalary`). */
export const maxRestructureAmount = (c: Contract, minimumSalary = 0, year?: number): number =>
  (restructureBase(c, year).years >= 2 ? Math.max(0, c.salary - minimumSalary) : 0);

/** Per-season cap saving of converting `amount` of salary into prorated bonus (in `year` when given). */
export const restructureSavings = (c: Contract, amount: number, year?: number): number =>
  Math.round(amount * (1 - 1 / restructureBase(c, year).years));

/**
 * Converts `amount` of salary into signing bonus (salary -= X, signingBonus += X, restructured = true). With
 * `opts.year` past the first season the deal is re-based to that year first, so the new bonus is prorated over
 * the seasons left and no money escapes the cap.
 */
export const restructure = (c: Contract, amount: number, opts: RestructureOptions = {}): Contract => {
  if (!Number.isFinite(amount) || amount <= 0) throw new Error(`restructure: amount must be positive, got ${amount}`);
  const base = restructureBase(c, opts.year);
  const max = maxRestructureAmount(base, opts.minimumSalary ?? 0);
  if (amount > max) throw new Error(`restructure: amount ${amount} exceeds the convertible ${max}`);
  const salary = Math.round(base.salary - amount);
  return { ...base, salary, signingBonus: Math.round(base.signingBonus + amount), guaranteed: Math.min(base.guaranteed, salary * base.years), restructured: true };
};

/* ------------------------------------------------------------------ release */

/** Dead money of a release in `year`, split June-1 style when `postDeadline` (this year's proration now, the rest next year). */
export const releaseDeadMoneySplit = (c: Contract, year: number, postDeadline: boolean): { thisYear: number; nextYear: number } => {
  const total = deadMoney(c, year);
  const yr = yearsRemainingAt(c, year);
  if (!postDeadline || yr <= 1) return { thisYear: total, nextYear: 0 };
  const nextYear = Math.round((c.signingBonus * (yr - 1)) / c.years);
  return { thisYear: total - nextYear, nextYear };
};

export interface ReleaseResult {
  /** Team with the dead money booked (roster membership is roster.ts's job). */
  team: Team;
  /** Player with the contract cleared. */
  player: Player;
  deadThisYear: number;
  deadNextYear: number;
  /** Cap hit removed this year minus the dead money charged this year. */
  capSavings: number;
}

/** Releases a contracted player of `team`: books dead money on the team's finances and clears the contract. */
export const release = (team: Team, player: Player, year: number, opts: { postDeadline?: boolean } = {}): ReleaseResult => {
  if (player.teamId !== team.id) throw new Error(`release: player ${player.id} is not on team ${team.id}`);
  const c = player.contract;
  const split = c ? releaseDeadMoneySplit(c, year, opts.postDeadline ?? false) : { thisYear: 0, nextYear: 0 };
  const dm = { ...team.finances.deadMoney };
  if (split.thisYear > 0) dm[year] = (dm[year] ?? 0) + split.thisYear;
  if (split.nextYear > 0) dm[year + 1] = (dm[year + 1] ?? 0) + split.nextYear;
  return {
    team: { ...team, finances: { ...team.finances, deadMoney: dm } },
    player: { ...player, contract: null },
    deadThisYear: split.thisYear,
    deadNextYear: split.nextYear,
    capSavings: capHit(c, year) - split.thisYear,
  };
};

/* --------------------------------------------------------------------- tags */

export type TagKind = 'franchise' | 'transition';

/** Mean APY of the `topN` richest contracts at `position` (0 when nobody at the position is under contract). */
export const positionAverageSalary = (players: Iterable<Player> | Readonly<Record<string, Player>>, position: Position, topN: number): number => {
  const list = Symbol.iterator in Object(players) ? [...(players as Iterable<Player>)] : Object.values(players as Record<string, Player>);
  const top = list.filter((p) => p.position === position && p.contract).map((p) => contractApy(p.contract as Contract))
    .sort((a, b) => b - a).slice(0, Math.max(1, topN));
  return top.length === 0 ? 0 : Math.round(top.reduce((s, v) => s + v, 0) / top.length);
};

/** Tag salary: the position average (top 5 franchise / top 10 transition) or a raise on his current APY, whichever is higher. */
export const tagSalary = (player: Player, positionAverage: number, kind: TagKind): number => {
  const raise = kind === 'franchise' ? CONTRACT_DATA.tag.franchiseRaise : CONTRACT_DATA.tag.transitionRaise;
  return roundMoney(Math.max(positionAverage, player.contract ? contractApy(player.contract) * raise : 0));
};

const tagContract = (player: Player, positionAverage: number, kind: TagKind, year: number): Contract => {
  const salary = tagSalary(player, positionAverage, kind);
  return createContract({ salary, years: 1, guaranteed: salary, signingBonus: 0, role: kind === 'franchise' ? 'franchise' : 'starter', year, tag: kind });
};

/** Fully guaranteed one-year franchise tag starting in `year` (positionAverage = top-5 APY at his position). */
export const franchiseTag = (player: Player, positionAverage: number, year: number): Contract => tagContract(player, positionAverage, 'franchise', year);

/** Fully guaranteed one-year transition tag starting in `year` (positionAverage = top-10 APY at his position). */
export const transitionTag = (player: Player, positionAverage: number, year: number): Contract => tagContract(player, positionAverage, 'transition', year);

/** League-wide position average used by a tag of `kind`. */
export const tagPositionAverage = (league: Pick<League, 'players'>, position: Position, kind: TagKind): number =>
  positionAverageSalary(league.players, position, kind === 'franchise' ? CONTRACT_DATA.tag.franchiseTopN : CONTRACT_DATA.tag.transitionTopN);

/* ----------------------------------------------------------------- expiring */

/** Players whose contracts end with season `year` or earlier (they need a new deal before next season). */
export const expiring = (players: Iterable<Player>, year: number): Player[] =>
  [...players].filter((p) => p.contract !== null && contractEndYear(p.contract) <= year);
