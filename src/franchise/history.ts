/**
 * Season history, careers and records. `crownChampion` runs when the championship game ends;
 * `finalizeSeason` runs once per season (idempotent, keyed by the year in League.history) when the league
 * leaves the awards phase or rolls over: it appends the SeasonSummary and every team's TeamSeasonRecord,
 * credits head coaches' career records, folds Season.stats / playoffStats into careerStats and checks
 * career records. Weekly record checks (game, season, live career and team scopes) live here too. Pure.
 */
import type { PlayerId, TeamId } from '@/core/ids';
import { fullName } from '@/players/types';
import { seasonToCareer } from '@/statistics/aggregate';
import { emptyPlayerStatLine } from '@/statistics/empty';
import { leaders, type LeaderEntry, type LeaderQualifier } from '@/statistics/leaders';
import { TEAM_RECORD_KEYS, candidatesFromStats, checkRecords, type BrokenRecord, type RecordCandidate } from '@/statistics/records';
import type { CareerStats, PlayerStatLine, StatPath } from '@/statistics/types';
import type { TeamSeasonRecord } from '@/teams/types';
import { careerOf, lookupPlayer } from './league';
import { playoffResultLabel, runnerUp, seedOf } from './playoffs';
import { careerRecordCandidates } from './records';
import { emptyStanding } from './standings';
import type { League, ScheduledGame, Season, SeasonSummary } from './types';

/** Records checked, plus the League with the updated record book. */
export interface RecordUpdate {
  league: League;
  broken: BrokenRecord[];
}

const nameOf = (league: League) => (id: PlayerId): string => {
  const p = lookupPlayer(league, id);
  return p ? fullName(p) : String(id);
};
const teamIdOf = (league: League) => (id: PlayerId): TeamId | null => lookupPlayer(league, id)?.teamId ?? null;
const teamName = (league: League, id: TeamId): string => {
  const t = league.teams[id];
  return t ? `${t.city} ${t.name}` : String(id);
};

/** Top `n` players of the season (regular season by default) on a stat path. */
export const leagueLeaders = (
  season: Pick<Season, 'stats' | 'playoffStats'>, path: StatPath, n: number, opts: { playoffs?: boolean; qualifier?: LeaderQualifier } = {},
): LeaderEntry[] => leaders(opts.playoffs ? season.playoffStats : season.stats, path, n, opts.qualifier);

/**
 * Checks game-scope records for finished games (player lines and team points), season-scope records for
 * the regular-season totals, career records for committed careers plus the season so far (so the career
 * book is current mid-season, not only after rollover) and team win streaks. Preseason games never count.
 */
export const checkWeekRecords = (league: League, finished: readonly ScheduledGame[]): RecordUpdate => {
  const year = league.season.year;
  const candidates: RecordCandidate[] = [];
  for (const g of finished) {
    if (!g.result || g.isPreseason) continue;
    candidates.push(...candidatesFromStats('game', g.result.stats.players, year, nameOf(league), teamIdOf(league)));
    for (const [side, teamId] of [['home', g.home], ['away', g.away]] as const) {
      candidates.push({ scope: 'team', teamId, name: teamName(league, teamId), year, values: { [TEAM_RECORD_KEYS.pointsGame]: g.result.stats.teams[side].points } });
    }
  }
  candidates.push(...candidatesFromStats('season', league.season.stats, year, nameOf(league), teamIdOf(league)));
  candidates.push(...careerRecordCandidates(league));
  for (const s of Object.values(league.season.standings)) {
    if (s.streak > 0) candidates.push({ scope: 'team', teamId: s.teamId, name: teamName(league, s.teamId), year, values: { [TEAM_RECORD_KEYS.winStreak]: s.streak } });
  }
  const { updated, broken } = checkRecords(league.records, candidates);
  return { league: broken.length ? { ...league, records: updated } : league, broken };
};

/** True for a broken record that deserves a headline (a new holder, not a holder extending his own mark). */
export const isNewRecordHolder = (b: BrokenRecord): boolean =>
  b.previous === null || b.previous.year !== b.record.year || b.previous.holderPlayerId !== b.record.holderPlayerId || b.previous.holderTeamId !== b.record.holderTeamId;

/**
 * Record bases whose value is a single play or kick (longest play, longest field goal): their season and career
 * marks are the same feat as the single-game mark, so only the game-scope record is news (one headline, not three).
 */
export const PEAK_RECORD_BASES: ReadonlySet<string> = new Set(['longestPlay', 'fgLong']);

/** League-era seasons (the record's own season included) a career record needs before passing it is news. */
export const CAREER_RECORD_NEWS_MIN_SEASONS = 3;

/**
 * True when a broken record is news (headlines, recap lines, inbox items), not just a record-book update.
 * The book starts empty, so nothing is news until it holds a mark from a completed season: in a league's
 * first season every "record" is only the season's running best. A first holder (nothing beaten) is never
 * news, nor a holder raising his own mark within the same season. Season and career marks are news only when
 * the mark beaten stood since an earlier season (two players trading a mark back and forth all season stays
 * quiet after the first break); single-game and team feats are news whenever a new holder sets them. Career
 * records also need another player to pass the holder in a league era of CAREER_RECORD_NEWS_MIN_SEASONS.
 * Single-play marks (PEAK_RECORD_BASES) are news at game scope only.
 */
export const isRecordNews = (league: Pick<League, 'history'>, b: Pick<BrokenRecord, 'record' | 'previous'>): boolean => {
  const r = b.record;
  const prev = b.previous;
  if (!prev) return false;
  if (r.scope !== 'game' && r.scope !== 'team' && PEAK_RECORD_BASES.has(r.key.split('.')[0] ?? '')) return false;
  // A player's mark belongs to the player, whatever team he played for since.
  const sameHolder = r.holderPlayerId !== null ? prev.holderPlayerId === r.holderPlayerId : prev.holderPlayerId === null && prev.holderTeamId === r.holderTeamId;
  const standing = prev.year < r.year;
  if (sameHolder && !standing) return false;
  const completed = new Set(league.history.filter((h) => h.year < r.year).map((h) => h.year)).size;
  if (completed === 0 && !standing) return false;
  if (r.scope === 'season') return standing;
  if (r.scope === 'career') return standing && !sameHolder && Math.max(completed, r.year - prev.year) + 1 >= CAREER_RECORD_NEWS_MIN_SEASONS;
  return true;
};

/** Crowns the champion: Season/bracket champion, team + head coach championship counts, championship record. */
export const crownChampion = (league: League, championId: TeamId): RecordUpdate => {
  const team = league.teams[championId];
  if (!team) throw new Error(`crownChampion: unknown team ${championId}`);
  const crowned = { ...team, championships: team.championships + 1 };
  const coaches = { ...league.coaches };
  const hc = team.headCoachId ? coaches[team.headCoachId] : undefined;
  if (hc) coaches[hc.id] = { ...hc, championships: hc.championships + 1 };
  const bracket = league.season.bracket ? { ...league.season.bracket, champion: championId } : null;
  const next: League = { ...league, teams: { ...league.teams, [championId]: crowned }, coaches, season: { ...league.season, champion: championId, bracket } };
  const { updated, broken } = checkRecords(next.records, [
    { scope: 'team', teamId: championId, name: teamName(next, championId), year: next.season.year, values: { [TEAM_RECORD_KEYS.championships]: crowned.championships } },
  ]);
  return { league: broken.length ? { ...next, records: updated } : next, broken };
};

/** One team's line for the season (W/L/T, playoff finish, title). */
export const teamSeasonRecord = (league: League, teamId: TeamId): TeamSeasonRecord => {
  const s = league.season.standings[teamId] ?? emptyStanding(teamId);
  const bracket = league.season.bracket;
  return {
    year: league.season.year, wins: s.wins, losses: s.losses, ties: s.ties,
    madePlayoffs: bracket !== null && seedOf(bracket, teamId) !== null,
    playoffResult: playoffResultLabel(bracket, teamId, league.settings.playoff.roundNames),
    champion: league.season.champion === teamId,
  };
};

/** The season summary for League.history. Throws until a champion is crowned. */
export const recordSeasonSummary = (league: League): SeasonSummary => {
  const s = league.season;
  if (!s.champion) throw new Error(`recordSeasonSummary: season ${s.year} has no champion yet`);
  const second = runnerUp(s.bracket);
  if (!second) throw new Error(`recordSeasonSummary: season ${s.year} has no runner-up`);
  const standings: SeasonSummary['standings'] = {};
  for (const id of Object.keys(league.teams) as TeamId[]) {
    const st = s.standings[id] ?? emptyStanding(id);
    standings[id] = { wins: st.wins, losses: st.losses, ties: st.ties };
  }
  return {
    year: s.year, champion: s.champion, runnerUp: second,
    mvp: s.awards.find((a) => a.award === 'MVP' && a.year === s.year)?.playerId ?? null,
    standings, awards: s.awards.map((a) => ({ ...a })),
  };
};

/** True once finalizeSeason has run for the current season. */
export const isSeasonFinalized = (league: Pick<League, 'history' | 'season'>): boolean => league.history.some((h) => h.year === league.season.year);

/** Folds the season's regular-season and playoff lines into every player's career (idempotent per year). */
export const commitCareerStats = (league: League): League => {
  const s = league.season;
  const ids = new Set<PlayerId>([...(Object.keys(s.stats) as PlayerId[]), ...(Object.keys(s.playoffStats) as PlayerId[])]);
  if (ids.size === 0) return league;
  const careerStats: Record<PlayerId, CareerStats> = { ...league.careerStats };
  for (const id of ids) {
    if (!lookupPlayer(league, id)) continue;
    const line: PlayerStatLine = s.stats[id] ?? emptyPlayerStatLine();
    const career = careerOf(league, id);
    // Keep the team already credited for this year: offseason moves must not rewrite where a season was played.
    const teamId = career.seasons.find((e) => e.year === s.year)?.teamId ?? lookupPlayer(league, id)?.teamId ?? null;
    careerStats[id] = seasonToCareer(career, s.year, teamId, line, s.playoffStats[id] ?? null);
  }
  return { ...league, careerStats };
};

/**
 * Closes the season's books once: SeasonSummary into League.history, TeamSeasonRecord into every
 * Team.history (replacing any entry for the year), head-coach career wins/losses, career stats and career
 * records. A second call for the same year is a no-op. Requires a champion.
 */
export const finalizeSeason = (league: League): RecordUpdate => {
  if (isSeasonFinalized(league)) return { league, broken: [] };
  const summary = recordSeasonSummary(league);
  const year = league.season.year;
  const teams = { ...league.teams };
  const coaches = { ...league.coaches };
  for (const t of Object.values(league.teams)) {
    const rec = teamSeasonRecord(league, t.id);
    teams[t.id] = { ...t, history: [...t.history.filter((h) => h.year !== year), rec].sort((a, b) => a.year - b.year) };
    const hc = t.headCoachId ? coaches[t.headCoachId] : undefined;
    if (hc) coaches[hc.id] = { ...hc, careerWins: hc.careerWins + rec.wins, careerLosses: hc.careerLosses + rec.losses };
  }
  const withBooks = commitCareerStats({ ...league, teams, coaches, history: [...league.history.filter((h) => h.year !== year), summary].sort((a, b) => a.year - b.year) });
  const totals: Record<PlayerId, PlayerStatLine> = {};
  for (const [id, c] of Object.entries(withBooks.careerStats) as [PlayerId, CareerStats][]) if (c.seasons.length > 0) totals[id] = c.totals;
  const { updated, broken } = checkRecords(withBooks.records, candidatesFromStats('career', totals, year, nameOf(withBooks), teamIdOf(withBooks)));
  return { league: broken.length ? { ...withBooks, records: updated } : withBooks, broken };
};
