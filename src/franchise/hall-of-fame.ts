/**
 * Hall of Fame and All-Pro teams. `hofScore` rates a career on six parts: production (career points of the
 * position's production family, normalised by a position benchmark so an offensive tackle is not measured in
 * passing yards), awards, first-team All-Pro selections, championships, peak overall above a floor and longevity,
 * plus estimated honours for a founding veteran's seasons before the league began (PRE_LEAGUE_HONOURS).
 * A retired player is inducted when the score reaches his position's threshold (awards.json "hallOfFame");
 * induction is immediate, in the offseason he retires. Because a retired career never changes, a player who
 * falls short is never inducted later, which also makes `inductHallOfFamers` idempotent.
 * `allProTeam` picks the first team per position from season production blended with overall. Pure.
 */
import type { PlayerId, TeamId } from '@/core/ids';
import { careerTotals } from '@/statistics/aggregate';
import type { CareerStats, PlayerStatLine, SeasonStatEntry } from '@/statistics/types';
import { POSITIONS, fullName, type Player, type Position } from '@/players/types';
import { AWARD_ORDER, AWARDS_CONFIG, awardCandidates, awardsSection, flagsFor, numberRecord, playerAwards, productionScore } from './awards';
import { lookupPlayer } from './league';
import { recordsHeldBy } from './records';
import type { AwardResult, AwardType, HallOfFamer, League, LeagueRecord } from './types';

const H_KEYS = [
  'productionPoints', 'productionCap', 'allProPoints', 'championshipPoints', 'peakFloor', 'peakPoints', 'seasonPoints', 'seasonCap',
  'minSeasons', 'candidateMinExperience',
] as const;

/** Hall of Fame tuning (awards.json "hallOfFame") plus the All-Pro selection table. */
export interface HallOfFameConfig extends Record<(typeof H_KEYS)[number], number> {
  benchmarks: Record<Position, number>;
  thresholds: Record<Position, number>;
  awardPoints: Record<AwardType, number>;
  allProSlots: Record<Position, number>;
  allProOverallWeight: number;
  allProScale: Record<Position, number>;
}

const loadConfig = (): HallOfFameConfig => {
  const raw = awardsSection('hallOfFame');
  const allPro = awardsSection('allPro');
  return {
    ...numberRecord(raw, H_KEYS, 'hallOfFame', 0),
    benchmarks: numberRecord(awardsSection('hallOfFame.benchmarks'), POSITIONS, 'hallOfFame.benchmarks', 1),
    thresholds: numberRecord(awardsSection('hallOfFame.thresholds'), POSITIONS, 'hallOfFame.thresholds', 1),
    awardPoints: numberRecord(awardsSection('hallOfFame.awardPoints'), AWARD_ORDER, 'hallOfFame.awardPoints', 0),
    allProSlots: numberRecord(awardsSection('allPro.slots'), POSITIONS, 'allPro.slots', 0, 5),
    allProOverallWeight: numberRecord(allPro, ['overallWeight'], 'allPro', 0).overallWeight,
    allProScale: numberRecord(awardsSection('allPro.positionScale'), POSITIONS, 'allPro.positionScale', 0),
  };
};

/** Validated Hall of Fame / All-Pro tuning. */
export const HOF_CONFIG: HallOfFameConfig = loadConfig();

/* ---------------------------------------------------------------- scoring */

/** The parts of a Hall of Fame score. */
export interface HofBreakdown {
  production: number;
  awards: number;
  allPro: number;
  championships: number;
  peak: number;
  longevity: number;
  /** Estimated honours of a founding veteran's seasons before the league began (preLeagueAllPros). */
  preLeague: number;
  total: number;
  threshold: number;
}

/** Score parts for a career (see the module header). `allPros` = first-team All-Pro selections; `productionScale`
 *  multiplies the recorded production (pre-league seasons of a founding veteran, preLeagueProductionScale);
 *  `estimatedAllPros` = All-Pro selections credited for his pre-league seasons (preLeagueAllPros), scored as All-Pros. */
export const hofBreakdown = (
  career: CareerStats, awards: readonly AwardResult[], championships: number, seasons: number, peakOverall: number, position: Position,
  allPros = 0, cfg: HallOfFameConfig = HOF_CONFIG, productionScale = 1, estimatedAllPros = 0,
): HofBreakdown => {
  const produced = Math.max(0, productionScore(career.totals, position, AWARDS_CONFIG)) * Math.max(0, productionScale);
  const ratio = Math.min(cfg.productionCap, produced / cfg.benchmarks[position]);
  const production = ratio * cfg.productionPoints;
  const awardPts = awards.reduce((s, a) => s + (a.playerId !== null ? cfg.awardPoints[a.award] : 0), 0);
  const allPro = allPros * cfg.allProPoints;
  const champs = championships * cfg.championshipPoints;
  const peak = Math.max(0, peakOverall - cfg.peakFloor) * cfg.peakPoints;
  const longevity = Math.min(seasons, cfg.seasonCap) * cfg.seasonPoints;
  const preLeague = Math.max(0, estimatedAllPros) * cfg.allProPoints;
  const total = Math.round((production + awardPts + allPro + champs + peak + longevity + preLeague) * 10) / 10;
  return { production, awards: awardPts, allPro, championships: champs, peak, longevity, preLeague, total, threshold: cfg.thresholds[position] };
};

/**
 * Weight of a founding veteran's pre-league seasons (Player.experience beyond his league seasons) in the production
 * part of the Hall of Fame score: each counts as this share of his average league season (no stats exist for them).
 */
export const PRE_LEAGUE_PRODUCTION_WEIGHT = 0.6;

/** Production multiplier for a career with `preLeague` unrecorded seasons on top of `seasons` recorded ones. */
export const preLeagueProductionScale = (seasons: number, preLeague: number, weight = PRE_LEAGUE_PRODUCTION_WEIGHT): number =>
  seasons > 0 && preLeague > 0 ? (seasons + weight * preLeague) / seasons : 1;

/**
 * Pre-league honours of founding veterans. The league starts with an empty trophy case, so a star who was already
 * an established pro when it began has no awards or All-Pro teams for those years and could hardly reach the Hall
 * of Fame (SIMHUNT-8: none inducted after three offseasons). Each of his last `primeSeasons` pre-league seasons is
 * credited with a share of an All-Pro selection that grows with his overall when the league began: nothing at
 * `floor`, `maxRate` from floor + span * maxRate up.
 */
export interface PreLeagueHonours {
  floor: number;
  span: number;
  maxRate: number;
  primeSeasons: number;
}

/** The pre-league honours tuning (see PreLeagueHonours / preLeagueAllPros). */
export const PRE_LEAGUE_HONOURS: Readonly<PreLeagueHonours> = Object.freeze({ floor: 82, span: 8, maxRate: 0.75, primeSeasons: 8 });

/** Estimated All-Pro selections for `preLeagueSeasons` seasons played before the league began at `foundingOverall`. */
export const preLeagueAllPros = (preLeagueSeasons: number, foundingOverall: number, h: Readonly<PreLeagueHonours> = PRE_LEAGUE_HONOURS): number => {
  const rate = Math.min(h.maxRate, Math.max(0, (foundingOverall - h.floor) / h.span));
  return Math.min(Math.max(0, preLeagueSeasons), h.primeSeasons) * rate;
};

/** The league's first season (the oldest archived season, or the current one). */
export const leagueFoundingYear = (league: Pick<League, 'history' | 'season'>): number =>
  league.history.reduce((m, h) => Math.min(m, h.year), league.season.year);

/** A player's overall when the league began: before his first logged progression since then, else his current overall. */
export const foundingOverallOf = (player: Pick<Player, 'overall' | 'progressionLog'>, foundingYear: number): number =>
  player.progressionLog.find((e) => e.year >= foundingYear)?.overallBefore ?? player.overall;

/** Hall of Fame score of a career (higher is better; compare with the position threshold). */
export const hofScore = (
  career: CareerStats, awards: readonly AwardResult[], championships: number, seasons: number, peakOverall: number, position: Position, allPros = 0,
): number => hofBreakdown(career, awards, championships, seasons, peakOverall, position, allPros).total;

/* ---------------------------------------------------------------- All-Pro */

/** One first-team All-Pro spot. */
export interface AllProSelection {
  position: Position;
  /** 1-based spot within the position. */
  rank: number;
  playerId: PlayerId;
  teamId: TeamId;
  score: number;
}

/**
 * First-team All-Pro for the current season: per position the top allPro.slots players (award-eligible seasons only)
 * by production x positionScale + overallWeight x overall; ties by player id.
 */
export const allProTeam = (league: League, cfg: HallOfFameConfig = HOF_CONFIG): AllProSelection[] => {
  const out: AllProSelection[] = [];
  const candidates = awardCandidates(league);
  for (const pos of POSITIONS) {
    const slots = cfg.allProSlots[pos];
    if (slots <= 0) continue;
    const scored = candidates.filter((c) => c.player.position === pos)
      .map((c) => ({ c, score: productionScore(c.voteLine, pos) * cfg.allProScale[pos] + cfg.allProOverallWeight * c.player.overall }))
      .sort((a, b) => b.score - a.score || (a.c.player.id < b.c.player.id ? -1 : 1));
    scored.slice(0, slots).forEach((s, i) => out.push({ position: pos, rank: i + 1, playerId: s.c.player.id, teamId: s.c.teamId, score: Math.round(s.score * 10) / 10 }));
  }
  return out;
};

/** Records the selections' year in offseasonFlags.allPro (idempotent per player and year). */
export const recordAllPros = (league: League, selections: readonly AllProSelection[], year = league.season.year): League => {
  const flags = flagsFor(league, league.offseasonFlags?.year ?? year);
  const allPro: Record<string, number[]> = { ...(flags.allPro ?? {}) };
  for (const s of selections) {
    const years = allPro[s.playerId] ?? [];
    if (!years.includes(year)) allPro[s.playerId] = [...years, year].sort((a, b) => a - b);
  }
  return { ...league, offseasonFlags: { ...flags, allPro } };
};

/** First-team All-Pro selections of a player. */
export const allProCount = (league: Pick<League, 'offseasonFlags'>, playerId: PlayerId): number => league.offseasonFlags?.allPro?.[playerId]?.length ?? 0;

/* ---------------------------------------------------------------- careers */

/** Champion per season year (history plus the current season once crowned). */
const championsByYear = (league: Pick<League, 'history' | 'season'>): Map<number, TeamId> => {
  const m = new Map<number, TeamId>(league.history.map((h) => [h.year, h.champion]));
  if (league.season.champion) m.set(league.season.year, league.season.champion);
  return m;
};

/** Seasons the player spent with the eventual champion. */
export const championshipsWon = (league: Pick<League, 'history' | 'season' | 'careerStats'>, playerId: PlayerId): number => {
  const champs = championsByYear(league);
  return (league.careerStats[playerId]?.seasons ?? []).filter((s) => s.teamId !== null && champs.get(s.year) === s.teamId).length;
};

/** Best overall a player ever reached (current value and every progression entry). */
export const peakOverallOf = (player: Pick<Player, 'overall' | 'progressionLog'>): number =>
  player.progressionLog.reduce((m, e) => Math.max(m, e.overallBefore, e.overallAfter), player.overall);

const seasonsPlayed = (entries: readonly SeasonStatEntry[]): number => entries.filter((s) => s.line.gamesPlayed > 0).length;

const teamsOf = (league: Pick<League, 'teams'>, entries: readonly SeasonStatEntry[]): TeamId[] => {
  const out: TeamId[] = [];
  for (const s of entries) if (s.teamId && league.teams[s.teamId] && !out.includes(s.teamId)) out.push(s.teamId);
  return out;
};

const emptyCareerOf = (playerId: PlayerId): CareerStats => ({ playerId, seasons: [], totals: careerTotals([]) });

/** Everything the UI shows on a career page. */
export interface CareerSummary {
  playerId: PlayerId;
  name: string;
  position: Position;
  retired: boolean;
  age: number;
  overall: number;
  peakOverall: number;
  seasons: number;
  /** Professional seasons including those before the league began: max(seasons, Player.experience). Founding
   *  veterans have no league stats for their earlier years; tenure keeps them eligible, credits their longevity and
   *  extrapolates their production (preLeagueProductionScale). */
  tenure: number;
  teams: TeamId[];
  totals: PlayerStatLine;
  playoffTotals: PlayerStatLine;
  bySeason: SeasonStatEntry[];
  awards: AwardResult[];
  championships: number;
  allPros: number;
  records: LeagueRecord[];
  hof: HofBreakdown;
  inducted: boolean;
}

/** A player's career summary (active or retired), or null for an unknown id. */
export const careerSummary = (league: League, playerId: PlayerId): CareerSummary | null => {
  const player = lookupPlayer(league, playerId);
  if (!player) return null;
  const career = league.careerStats[playerId] ?? emptyCareerOf(playerId);
  const awards = playerAwards(league, playerId);
  const championships = championshipsWon(league, playerId);
  const seasons = seasonsPlayed(career.seasons);
  const tenure = Math.max(seasons, player.experience);
  const peak = peakOverallOf(player);
  const allPros = allProCount(league, playerId);
  const founded = leagueFoundingYear(league);
  const preSeasons = Math.max(0, founded - player.rookieYear);
  const estimated = preSeasons > 0 ? preLeagueAllPros(preSeasons, foundingOverallOf(player, founded)) : 0;
  return {
    playerId, name: fullName(player), position: player.position, retired: player.retired || !!league.retiredPlayers[playerId],
    age: player.age, overall: player.overall, peakOverall: peak, seasons, tenure, teams: teamsOf(league, career.seasons),
    totals: career.totals, playoffTotals: careerTotals(career.seasons, true), bySeason: career.seasons, awards, championships, allPros,
    records: recordsHeldBy(league, playerId),
    hof: hofBreakdown(career, awards, championships, tenure, peak, player.position, allPros, HOF_CONFIG, preLeagueProductionScale(seasons, tenure - seasons), estimated),
    inducted: league.hallOfFame.some((h) => h.playerId === playerId),
  };
};

/** A Hall of Fame watch-list row for the UI. */
export interface HofCandidate {
  playerId: PlayerId;
  name: string;
  position: Position;
  retired: boolean;
  score: number;
  threshold: number;
  /** Retired, not yet inducted and at or above the threshold (inducted at the next pass). */
  eligible: boolean;
  breakdown: HofBreakdown;
}

/**
 * Hall of Fame watch list: retired players not inducted plus active veterans (candidateMinExperience+), best score
 * first (ties by id), at most `limit` rows.
 */
export const hofCandidates = (league: League, limit = 25, cfg: HallOfFameConfig = HOF_CONFIG): HofCandidate[] => {
  const inducted = new Set(league.hallOfFame.map((h) => h.playerId));
  const pool: Player[] = [
    ...Object.values(league.retiredPlayers).filter((p) => !inducted.has(p.id)),
    ...Object.values(league.players).filter((p) => p.experience >= cfg.candidateMinExperience),
  ];
  const rows = pool.map((p): HofCandidate => {
    const s = careerSummary(league, p.id) as CareerSummary;
    const retired = !!league.retiredPlayers[p.id];
    return {
      playerId: p.id, name: s.name, position: p.position, retired, score: s.hof.total, threshold: s.hof.threshold,
      eligible: retired && s.tenure >= cfg.minSeasons && s.hof.total >= s.hof.threshold, breakdown: s.hof,
    };
  });
  rows.sort((a, b) => b.score - a.score || (a.playerId < b.playerId ? -1 : 1));
  return rows.slice(0, Math.max(0, limit));
};

/**
 * Inducts every retired, not-yet-inducted player whose score reaches his position threshold (and who played at
 * least minSeasons, counting pre-league years: CareerSummary.tenure). Appends HallOfFamer entries (inductedYear =
 * `year`, default the season year) in id order.
 */
export const inductHallOfFamers = (league: League, year = league.season.year, cfg: HallOfFameConfig = HOF_CONFIG): { league: League; inducted: HallOfFamer[] } => {
  const already = new Set(league.hallOfFame.map((h) => h.playerId));
  const inducted: HallOfFamer[] = [];
  for (const id of (Object.keys(league.retiredPlayers) as PlayerId[]).sort()) {
    if (already.has(id)) continue;
    const s = careerSummary(league, id);
    if (!s || s.tenure < cfg.minSeasons || s.hof.total < s.hof.threshold) continue;
    inducted.push({
      playerId: id, inductedYear: year, name: s.name, position: s.position, seasons: s.seasons, peakOverall: s.peakOverall,
      championships: s.championships, awards: s.awards.map((a) => ({ ...a })), careerStats: s.totals, teams: s.teams,
    });
  }
  if (inducted.length === 0) return { league, inducted };
  return { league: { ...league, hallOfFame: [...league.hallOfFame, ...inducted] }, inducted };
};
