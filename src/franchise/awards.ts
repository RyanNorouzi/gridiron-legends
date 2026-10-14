/**
 * Season awards from Season.stats + standings: MVP (production weighted by team success), OPOY, DPOY
 * (position-normalised defensive production), OROY/DROY (experience 0), COY (wins over the expectation set by
 * the preseason team rating), bestQB/bestRB/bestWR/bestDefender (production blended with the player's grade).
 * Ties always break by team win percentage, then player/team id, so results are deterministic.
 *
 * Game pace: games the user plays live may use shorter quarters than the league's simulated games. For voting only
 * (awards and All-Pro), a player's production in such a game is scaled up to the simulated game length
 * (`AwardCandidate.voteLine`); stored stats, leaders, records and the award summaries keep the real numbers.
 *
 * Also hosts what the other offseason modules share: the validated readers for src/data/awards.json (all
 * offseason tuning lives there), the production scoring tables and the OffseasonFlags helpers. Pure.
 */
import awardsJson from '@/data/awards.json';
import type { PlayerId, TeamId } from '@/core/ids';
import { clamp } from '@/core/math';
import { DEFENSIVE_POSITIONS, OFFENSIVE_POSITIONS, POSITIONS, POSITION_GROUP, fullName, type Player, type Position } from '@/players/types';
import { clonePlayerStatLine } from '@/statistics/aggregate';
import { applyDelta, isMaxStat, readStat, STAT_PATHS } from '@/statistics/apply';
import { emptyPlayerStatLine } from '@/statistics/empty';
import type { PlayerStatLine } from '@/statistics/types';
import { lookupPlayer } from './league';
import { LEAGUE_SIM_QUARTER_SEC } from './settings';
import { gamesPlayed, winPct } from './standings';
import type { AwardResult, AwardType, GameResult, League, OffseasonFlags } from './types';

/* ------------------------------------------------------------------ data */

/** Reads a nested object of src/data/awards.json by dot path; throws a descriptive error when missing. */
export const awardsSection = (path: string): Record<string, unknown> => {
  let node: unknown = awardsJson;
  for (const key of path.split('.')) {
    node = typeof node === 'object' && node !== null ? (node as Record<string, unknown>)[key] : undefined;
    if (typeof node !== 'object' || node === null || Array.isArray(node)) throw new Error(`awards.json: '${path}' must be an object`);
  }
  return node as Record<string, unknown>;
};

/** Validates that every key is a finite number (optionally within [min, max]). */
export const numberRecord = <K extends string>(raw: Record<string, unknown>, keys: readonly K[], path: string, min = -Infinity, max = Infinity): Record<K, number> => {
  const out = {} as Record<K, number>;
  for (const k of keys) {
    const v = raw[k];
    if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) throw new Error(`awards.json: ${path}.${k} must be a number in [${min}, ${max}]`);
    out[k] = v;
  }
  return out;
};

/** Validates a [lo, hi] numeric pair with lo <= hi. */
export const numberPair = (raw: unknown, path: string): [number, number] => {
  if (!Array.isArray(raw) || raw.length !== 2 || !raw.every((v) => typeof v === 'number' && Number.isFinite(v)) || (raw[0] as number) > (raw[1] as number)) {
    throw new Error(`awards.json: ${path} must be [lo, hi]`);
  }
  return [raw[0] as number, raw[1] as number];
};

const DEF_KEYS = ['tackles', 'tfl', 'sacks', 'interceptions', 'passBreakups', 'forcedFumbles', 'fumbleRecoveries', 'touchdowns'] as const;
type DefKey = (typeof DEF_KEYS)[number];

/** Scoring and award tuning (validated once at load). */
export interface AwardsConfig {
  passing: Record<'yards' | 'touchdowns' | 'interceptions' | 'sacks', number>;
  rushing: Record<'yards' | 'touchdowns' | 'fumbles', number>;
  receiving: Record<'yards' | 'touchdowns' | 'receptions', number>;
  fumblesLost: number;
  defense: Record<DefKey, number>;
  defensePositionFactor: Record<Position, number>;
  blocking: Record<'gamesStarted' | 'pancakes' | 'sacksAllowed' | 'pressuresAllowed', number>;
  kicking: Record<'fgMade' | 'fgMissed' | 'xpMade' | 'xpMissed' | 'fgLong', number>;
  punting: Record<'puntYards' | 'puntsInside20', number>;
  minGamesFraction: number;
  mvp: Record<'teamBase' | 'teamWeight' | 'defenseDiscount' | 'championBonus' | 'qbFactor', number>;
  coy: Record<'winPctPerRating' | 'minWinPct' | 'maxWinPct', number>;
  best: Record<'productionWeight' | 'overallWeight', number>;
}

const loadConfig = (): AwardsConfig => {
  const prod = awardsSection('production');
  const factors = awardsSection('defense.positionFactor');
  const defensePositionFactor = {} as Record<Position, number>;
  for (const pos of POSITIONS) {
    const v = factors[pos];
    defensePositionFactor[pos] = typeof v === 'number' && v > 0 ? v : 1;
  }
  return {
    passing: numberRecord(awardsSection('production.passing'), ['yards', 'touchdowns', 'interceptions', 'sacks'], 'production.passing'),
    rushing: numberRecord(awardsSection('production.rushing'), ['yards', 'touchdowns', 'fumbles'], 'production.rushing'),
    receiving: numberRecord(awardsSection('production.receiving'), ['yards', 'touchdowns', 'receptions'], 'production.receiving'),
    fumblesLost: numberRecord(prod, ['fumblesLost'], 'production').fumblesLost,
    defense: numberRecord(awardsSection('defense.weights'), DEF_KEYS, 'defense.weights'),
    defensePositionFactor,
    blocking: numberRecord(awardsSection('blocking'), ['gamesStarted', 'pancakes', 'sacksAllowed', 'pressuresAllowed'], 'blocking'),
    kicking: numberRecord(awardsSection('kicking'), ['fgMade', 'fgMissed', 'xpMade', 'xpMissed', 'fgLong'], 'kicking'),
    punting: numberRecord(awardsSection('punting'), ['puntYards', 'puntsInside20'], 'punting'),
    minGamesFraction: numberRecord(awardsSection('eligibility'), ['minGamesFraction'], 'eligibility', 0, 1).minGamesFraction,
    mvp: numberRecord(awardsSection('mvp'), ['teamBase', 'teamWeight', 'defenseDiscount', 'championBonus', 'qbFactor'], 'mvp', 0),
    coy: numberRecord(awardsSection('coy'), ['winPctPerRating', 'minWinPct', 'maxWinPct'], 'coy', 0, 1),
    best: numberRecord(awardsSection('best'), ['productionWeight', 'overallWeight'], 'best', 0),
  };
};

/** Validated award/scoring tuning. */
export const AWARDS_CONFIG: AwardsConfig = loadConfig();

/* ------------------------------------------------------------- scoring */

/** Offensive production points: passing, rushing and receiving value minus giveaways. */
export const offensiveScore = (line: PlayerStatLine, cfg: AwardsConfig = AWARDS_CONFIG): number => {
  const p = line.passing, r = line.rushing, c = line.receiving;
  return p.yards * cfg.passing.yards + p.touchdowns * cfg.passing.touchdowns + p.interceptions * cfg.passing.interceptions
    + p.sacks * cfg.passing.sacks + r.yards * cfg.rushing.yards + r.touchdowns * cfg.rushing.touchdowns + r.fumbles * cfg.rushing.fumbles
    + c.yards * cfg.receiving.yards + c.touchdowns * cfg.receiving.touchdowns + c.receptions * cfg.receiving.receptions
    + line.fumblesLost * cfg.fumblesLost;
};

/** Defensive production points; with a position the score is normalised by the position factor (DPOY rule). */
export const defensiveScore = (line: PlayerStatLine, position?: Position, cfg: AwardsConfig = AWARDS_CONFIG): number => {
  let s = 0;
  for (const k of DEF_KEYS) s += line.defense[k] * cfg.defense[k];
  return position ? s * cfg.defensePositionFactor[position] : s;
};

/** Offensive-line points: starts and pancakes minus sacks/pressures allowed. */
export const blockingScore = (line: PlayerStatLine, cfg: AwardsConfig = AWARDS_CONFIG): number =>
  line.gamesStarted * cfg.blocking.gamesStarted + line.blocking.pancakes * cfg.blocking.pancakes
  + line.blocking.sacksAllowed * cfg.blocking.sacksAllowed + line.blocking.pressuresAllowed * cfg.blocking.pressuresAllowed;

/** Kicker points: made/missed field goals and extra points, plus range. */
export const kickingScore = (line: PlayerStatLine, cfg: AwardsConfig = AWARDS_CONFIG): number => {
  const k = line.kicking;
  return k.fgMade * cfg.kicking.fgMade + (k.fgAttempts - k.fgMade) * cfg.kicking.fgMissed + k.xpMade * cfg.kicking.xpMade
    + (k.xpAttempts - k.xpMade) * cfg.kicking.xpMissed + k.fgLong * cfg.kicking.fgLong;
};

/** Punter points: gross yardage and punts pinned inside the 20. */
export const puntingScore = (line: PlayerStatLine, cfg: AwardsConfig = AWARDS_CONFIG): number =>
  line.kicking.puntYards * cfg.punting.puntYards + line.kicking.puntsInside20 * cfg.punting.puntsInside20;

/** The production family that fits a position (raw, not position-normalised): used by All-Pro and the HOF. */
export const productionScore = (line: PlayerStatLine, position: Position, cfg: AwardsConfig = AWARDS_CONFIG): number => {
  const group = POSITION_GROUP[position];
  if (group === 'OL') return blockingScore(line, cfg);
  if (position === 'K') return kickingScore(line, cfg);
  if (position === 'P') return puntingScore(line, cfg);
  if (DEFENSIVE_POSITIONS.includes(position)) return defensiveScore(line, undefined, cfg);
  return offensiveScore(line, cfg);
};

/* ------------------------------------------------------------ summaries */

const num = (v: number): string => {
  const rounded = Number.isInteger(v) ? v : Math.round(v * 10) / 10;
  const [int, frac] = String(Math.abs(rounded)).split('.');
  return `${rounded < 0 ? '-' : ''}${(int ?? '0').replace(/\B(?=(\d{3})+(?!\d))/g, ',')}${frac ? `.${frac}` : ''}`;
};

/** Compact stat line for a position, e.g. "4,512 pass yds, 38 TD, 9 INT". */
export const statSummary = (line: PlayerStatLine, position: Position): string => {
  const p = line.passing, r = line.rushing, c = line.receiving, d = line.defense, k = line.kicking;
  const parts: string[] = [];
  if (position === 'QB') {
    parts.push(`${num(p.completions)}/${num(p.attempts)}`, `${num(p.yards)} pass yds`, `${num(p.touchdowns)} TD`, `${num(p.interceptions)} INT`);
    if (r.yards >= 150 || r.touchdowns >= 3) parts.push(`${num(r.yards)} rush yds`, `${num(r.touchdowns)} rush TD`);
  } else if (position === 'RB' || position === 'FB') {
    parts.push(`${num(r.attempts)} car`, `${num(r.yards)} rush yds`, `${num(r.touchdowns)} TD`);
    if (c.receptions > 0) parts.push(`${num(c.receptions)} rec`, `${num(c.yards)} rec yds`);
  } else if (position === 'WR' || position === 'TE') {
    parts.push(`${num(c.receptions)} rec`, `${num(c.yards)} yds`, `${num(c.touchdowns)} TD`);
  } else if (position === 'K') {
    parts.push(`${num(k.fgMade)}/${num(k.fgAttempts)} FG`, `long ${num(k.fgLong)}`, `${num(k.xpMade)}/${num(k.xpAttempts)} XP`);
  } else if (position === 'P') {
    parts.push(`${num(k.punts)} punts`, `${num(k.punts > 0 ? Math.round((k.puntYards / k.punts) * 10) / 10 : 0)} avg`, `${num(k.puntsInside20)} inside 20`);
  } else if (POSITION_GROUP[position] === 'OL') {
    parts.push(`${num(line.gamesStarted)} starts`, `${num(line.blocking.pancakes)} pancakes`, `${num(line.blocking.sacksAllowed)} sacks allowed`);
  } else {
    parts.push(`${num(d.tackles)} tkl`, `${num(d.sacks)} sacks`, `${num(d.interceptions)} INT`, `${num(d.passBreakups)} PD`, `${num(d.forcedFumbles)} FF`);
  }
  return parts.join(', ');
};

/* ------------------------------------------------------------- awards */

/** Award order in results. */
export const AWARD_ORDER: readonly AwardType[] = ['MVP', 'OPOY', 'DPOY', 'OROY', 'DROY', 'COY', 'bestQB', 'bestRB', 'bestWR', 'bestDefender'];

/** Display names. */
export const AWARD_LABELS: Readonly<Record<AwardType, string>> = {
  MVP: 'Most Valuable Player', OPOY: 'Offensive Player of the Year', DPOY: 'Defensive Player of the Year',
  OROY: 'Offensive Rookie of the Year', DROY: 'Defensive Rookie of the Year', COY: 'Coach of the Year',
  bestQB: 'Best Quarterback', bestRB: 'Best Running Back', bestWR: 'Best Wide Receiver', bestDefender: 'Best Defender',
};

/** An award-eligible season: the player, the team he is credited to and his regular-season line. */
export interface AwardCandidate {
  player: Player;
  teamId: TeamId;
  /** The real regular-season line (what summaries show). */
  line: PlayerStatLine;
  /** The line voting scores: `line` with production from short live games paced up to the simulated length. */
  voteLine: PlayerStatLine;
}

/** Summed counting stats only (games played/started and the `longest` maxima are not production volume). */
const PACED_PATHS = STAT_PATHS.filter((p) => p.includes('.') && !isMaxStat(p));

/** Mean offensive plays per side in a result (0 when the box score has none). */
const playsPerSide = (r: GameResult): number => (r.stats.teams.home.plays + r.stats.teams.away.plays) / 2;

/** A result played at full length (results without a recorded length count as full length). */
const isFullLength = (r: GameResult, fullQuarterSec: number): boolean => {
  const q = r.quarterLengthSec;
  return q === undefined || !(q > 0) || q >= fullQuarterSec;
};

/**
 * The extra production voting credits for regular-season games played at shorter quarters than simulated games,
 * per player: each such game's line times (volume ratio - 1). The volume ratio is the season's mean plays per side
 * in full-length games over the plays per side of that game: the huddle tempo scales with the quarter, so a
 * 5-minute game has about 60% of a full game's snaps, not a third. It never exceeds the quarter-length ratio (also
 * the fallback when either play count is missing) and is never below 1. Empty when every game was played at full
 * length.
 */
export const shortGamePaceExtras = (league: Pick<League, 'season'>, fullQuarterSec: number = LEAGUE_SIM_QUARTER_SEC): Map<PlayerId, PlayerStatLine> => {
  const extras = new Map<PlayerId, PlayerStatLine>();
  const regular = league.season.schedule.filter((g) => g.result && !g.isPlayoff && !g.isPreseason);
  if (regular.every((g) => isFullLength(g.result as GameResult, fullQuarterSec))) return extras;
  let refSum = 0;
  let refCount = 0;
  for (const g of regular) {
    const r = g.result as GameResult;
    if (isFullLength(r, fullQuarterSec) && playsPerSide(r) > 0) {
      refSum += playsPerSide(r);
      refCount++;
    }
  }
  const reference = refCount > 0 ? refSum / refCount : 0;
  for (const g of regular) {
    const r = g.result as GameResult;
    if (isFullLength(r, fullQuarterSec)) continue;
    const byClock = fullQuarterSec / (r.quarterLengthSec as number);
    const played = playsPerSide(r);
    const factor = Math.max(0, (reference > 0 && played > 0 ? Math.min(byClock, reference / played) : byClock) - 1);
    if (factor <= 0) continue;
    for (const [id, line] of Object.entries(r.stats.players) as [PlayerId, PlayerStatLine][]) {
      let extra = extras.get(id);
      for (const path of PACED_PATHS) {
        const v = readStat(line, path);
        if (v === 0) continue;
        if (!extra) {
          extra = emptyPlayerStatLine();
          extras.set(id, extra);
        }
        applyDelta(extra, path, v * factor);
      }
    }
  }
  return extras;
};

/** `line` plus its pace extra (the same object when there is none). */
const withExtra = (line: PlayerStatLine, extra: PlayerStatLine | undefined): PlayerStatLine => {
  if (!extra) return line;
  const out = clonePlayerStatLine(line);
  for (const path of PACED_PATHS) applyDelta(out, path, readStat(extra, path));
  return out;
};

/** Regular-season length used for eligibility: the most games any team played (settings when nobody has). */
export const seasonGameCount = (league: Pick<League, 'season' | 'settings'>): number => {
  let max = 0;
  for (const s of Object.values(league.season.standings)) max = Math.max(max, gamesPlayed(s));
  return max > 0 ? max : league.settings.regularSeasonWeeks;
};

/** Players with a regular-season line, a team to credit and at least minGamesFraction of the season played. */
export const awardCandidates = (league: League, cfg: AwardsConfig = AWARDS_CONFIG): AwardCandidate[] => {
  const minGames = Math.ceil(cfg.minGamesFraction * seasonGameCount(league));
  const year = league.season.year;
  const extras = shortGamePaceExtras(league);
  const out: AwardCandidate[] = [];
  for (const id of (Object.keys(league.season.stats) as PlayerId[]).sort()) {
    const line = league.season.stats[id];
    const player = lookupPlayer(league, id);
    if (!line || !player || line.gamesPlayed < minGames) continue;
    const credited = league.careerStats[id]?.seasons.find((s) => s.year === year)?.teamId ?? null;
    const teamId = player.teamId ?? credited;
    if (!teamId || !league.teams[teamId]) continue;
    out.push({ player, teamId, line, voteLine: withExtra(line, extras.get(id)) });
  }
  return out;
};

const teamPct = (league: League, teamId: TeamId): number => {
  const s = league.season.standings[teamId];
  return s ? winPct(s) : 0.5;
};

const recordText = (league: League, teamId: TeamId): string => {
  const s = league.season.standings[teamId];
  if (!s) return '';
  return s.ties > 0 ? `${s.wins}-${s.losses}-${s.ties}` : `${s.wins}-${s.losses}`;
};

interface Scored { c: AwardCandidate; score: number }

/** Highest score; ties by team win pct (desc) then player id (asc). Null when nobody scored above zero. */
const top = (league: League, rows: readonly Scored[]): Scored | null => {
  let best: Scored | null = null;
  for (const r of rows) {
    if (!(r.score > 0)) continue;
    if (!best || r.score > best.score) { best = r; continue; }
    if (r.score < best.score) continue;
    const a = teamPct(league, r.c.teamId), b = teamPct(league, best.c.teamId);
    if (a > b || (a === b && r.c.player.id < best.c.player.id)) best = r;
  }
  return best;
};

/** Production relative to the group leader blended with the player's overall (the "best at position" grade). */
const blended = (rows: readonly Scored[], cfg: AwardsConfig): Scored[] => {
  const leader = Math.max(0, ...rows.map((r) => r.score));
  if (leader <= 0) return [];
  return rows.map((r) => ({ c: r.c, score: cfg.best.productionWeight * (Math.max(0, r.score) / leader) * 100 + cfg.best.overallWeight * r.c.player.overall }));
};

const playerAward = (league: League, award: AwardType, pick: Scored | null): AwardResult | null => {
  if (!pick) return null;
  const { player, teamId, line } = pick.c;
  const team = league.teams[teamId];
  const rec = recordText(league, teamId);
  const summary = `${AWARD_LABELS[award]}: ${player.position} ${fullName(player)} (${team?.abbr ?? teamId}) - ${statSummary(line, player.position)}${rec ? `; team ${rec}` : ''}`;
  return { award, year: league.season.year, playerId: player.id, coachId: null, teamId, summary };
};

const coachOfTheYear = (league: League, cfg: AwardsConfig): AwardResult | null => {
  const flags = league.offseasonFlags?.preseasonRatings;
  const snapshot = flags && flags.year === league.season.year ? flags.ratings : null;
  const teams = Object.values(league.teams).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const ratingOf = (id: TeamId, fallback: number): number => snapshot?.[id] ?? fallback;
  const mean = teams.reduce((s, t) => s + ratingOf(t.id, t.overall), 0) / Math.max(1, teams.length);
  type Case = { teamId: TeamId; delta: number; wins: number; expected: number };
  let best: Case | null = null;
  let bestWinning: Case | null = null;
  const better = (c: Case, b: Case | null): boolean => !b || c.delta > b.delta || (c.delta === b.delta && c.wins > b.wins);
  for (const t of teams) {
    const s = league.season.standings[t.id];
    if (!t.headCoachId || !league.coaches[t.headCoachId] || !s || gamesPlayed(s) === 0) continue;
    const expectedPct = clamp(0.5 + (ratingOf(t.id, t.overall) - mean) * cfg.coy.winPctPerRating, cfg.coy.minWinPct, cfg.coy.maxWinPct);
    const expected = expectedPct * gamesPlayed(s);
    const c: Case = { teamId: t.id, delta: s.wins + s.ties / 2 - expected, wins: s.wins, expected };
    if (better(c, best)) best = c;
    if (winPct(s) >= 0.5 && better(c, bestWinning)) bestWinning = c;
  }
  // A coach with a winning (or .500) season is preferred; a losing one wins only when nobody broke even.
  best = bestWinning ?? best;
  if (!best) return null;
  const team = league.teams[best.teamId];
  const coach = team?.headCoachId ? league.coaches[team.headCoachId] : undefined;
  if (!team || !coach) return null;
  const summary = `${AWARD_LABELS.COY}: ${coach.firstName} ${coach.lastName} led the ${team.city} ${team.name} to ${recordText(league, team.id)} `
    + `(expected ${Math.round(best.expected * 10) / 10} wins, ${best.delta >= 0 ? '+' : ''}${Math.round(best.delta * 10) / 10})`;
  return { award: 'COY', year: league.season.year, playerId: null, coachId: coach.id, teamId: team.id, summary };
};

/**
 * The season's awards in AWARD_ORDER (awards nobody qualifies for are omitted). Rules:
 * - MVP: max(offensive score [x qbFactor for quarterbacks], defenseDiscount x normalised defensive score) x
 *   (teamBase + teamWeight x win% [+ champion bonus]).
 * - OPOY / DPOY: best offensive score / best position-normalised defensive score (offensive / defensive positions).
 * - OROY / DROY: the same among players with experience 0.
 * - COY: head coach whose team beat its expected wins (from the preseason rating snapshot, else Team.overall) by the
 *   most, among teams at .500 or better (all teams when none is).
 * - bestQB / bestRB (RB+FB) / bestWR / bestDefender: production relative to the position leader blended with overall.
 */
export const computeAwards = (league: League, cfg: AwardsConfig = AWARDS_CONFIG): AwardResult[] => {
  const all = awardCandidates(league, cfg);
  const offense = all.filter((c) => OFFENSIVE_POSITIONS.includes(c.player.position));
  const defense = all.filter((c) => DEFENSIVE_POSITIONS.includes(c.player.position));
  const off = (list: readonly AwardCandidate[]): Scored[] => list.map((c) => ({ c, score: offensiveScore(c.voteLine, cfg) }));
  const def = (list: readonly AwardCandidate[]): Scored[] => list.map((c) => ({ c, score: defensiveScore(c.voteLine, c.player.position, cfg) }));
  const champion = league.season.champion;
  const mvpRows = all.map((c) => {
    const offense = offensiveScore(c.voteLine, cfg) * (c.player.position === 'QB' ? cfg.mvp.qbFactor : 1);
    const production = Math.max(offense, cfg.mvp.defenseDiscount * defensiveScore(c.voteLine, c.player.position, cfg));
    const team = cfg.mvp.teamBase + cfg.mvp.teamWeight * teamPct(league, c.teamId) + (champion === c.teamId ? cfg.mvp.championBonus : 0);
    return { c, score: production * team };
  });
  const rookies = (list: readonly AwardCandidate[]): AwardCandidate[] => list.filter((c) => c.player.experience === 0);
  const at = (positions: readonly Position[]): AwardCandidate[] => offense.filter((c) => positions.includes(c.player.position));
  const results: (AwardResult | null)[] = [
    playerAward(league, 'MVP', top(league, mvpRows)),
    playerAward(league, 'OPOY', top(league, off(offense))),
    playerAward(league, 'DPOY', top(league, def(defense))),
    playerAward(league, 'OROY', top(league, off(rookies(offense)))),
    playerAward(league, 'DROY', top(league, def(rookies(defense)))),
    coachOfTheYear(league, cfg),
    playerAward(league, 'bestQB', top(league, blended(off(at(['QB'])), cfg))),
    playerAward(league, 'bestRB', top(league, blended(off(at(['RB', 'FB'])), cfg))),
    playerAward(league, 'bestWR', top(league, blended(off(at(['WR'])), cfg))),
    playerAward(league, 'bestDefender', top(league, blended(def(defense), cfg))),
  ];
  return results.filter((r): r is AwardResult => r !== null);
};

/**
 * Stores the season's awards: Season.awards keeps other years' entries and replaces this year's; a SeasonSummary
 * already written for the year (history finalised before awards ran) gets the awards and MVP patched in.
 * Idempotent: running it twice yields the same League contents.
 */
export const applyAwards = (league: League, awards: readonly AwardResult[] = computeAwards(league)): League => {
  const year = league.season.year;
  const own = awards.filter((a) => a.year === year).map((a) => ({ ...a }));
  const seasonAwards = [...league.season.awards.filter((a) => a.year !== year), ...own];
  const mvp = own.find((a) => a.award === 'MVP')?.playerId ?? null;
  const history = league.history.map((h) => (h.year === year ? { ...h, mvp, awards: own.map((a) => ({ ...a })) } : h));
  return { ...league, season: { ...league.season, awards: seasonAwards }, history };
};

/** Every award a player has won (history plus the current season), de-duplicated by (award, year), oldest first. */
export const playerAwards = (league: Pick<League, 'history' | 'season'>, playerId: PlayerId): AwardResult[] => {
  const seen = new Set<string>();
  const out: AwardResult[] = [];
  for (const a of [...league.history.flatMap((h) => h.awards), ...league.season.awards]) {
    if (a.playerId !== playerId) continue;
    const key = `${a.award}:${a.year}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(a);
  }
  return out.sort((a, b) => a.year - b.year || AWARD_ORDER.indexOf(a.award) - AWARD_ORDER.indexOf(b.award));
};

/* ------------------------------------------------------- offseason flags */

/** Flags for season `year`: the current ones when they belong to that year, else a fresh set keeping persistent fields. */
export const flagsFor = (league: Pick<League, 'offseasonFlags'>, year: number): OffseasonFlags => {
  const f = league.offseasonFlags;
  if (f && f.year === year) return f;
  return {
    year, done: [], warnings: [], retired: [], expiring: [],
    ...(f?.preseasonRatings ? { preseasonRatings: f.preseasonRatings } : {}),
    ...(f?.allPro ? { allPro: f.allPro } : {}),
    ...(f?.retiredCoaches ? { retiredCoaches: f.retiredCoaches } : {}),
    ...(f?.lastWeeklyDevelopment ? { lastWeeklyDevelopment: f.lastWeeklyDevelopment } : {}),
  };
};

/** True when offseason task `key` already ran for season `year`. */
export const isTaskDone = (league: Pick<League, 'offseasonFlags'>, year: number, key: string): boolean =>
  league.offseasonFlags?.year === year && league.offseasonFlags.done.includes(key);

/** The League with task `key` marked done for `year` (and optional flag field updates merged in). */
export const markTask = (league: League, year: number, key: string, patch: Partial<Omit<OffseasonFlags, 'year' | 'done'>> = {}): League => {
  const f = flagsFor(league, year);
  return { ...league, offseasonFlags: { ...f, ...patch, done: f.done.includes(key) ? f.done : [...f.done, key] } };
};
