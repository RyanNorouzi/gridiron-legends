import type { TeamId } from '@/core/ids';
import { MIDDLE_X, type PlayLogEntry } from '@/game/types';
import { emptyOutcome } from '@/game/outcome-factory';
import { advanceToPhase, createLeague, type CreateLeagueOptions } from '@/franchise';
import type { League, ScheduledGame, Standing } from '@/franchise/types';
import type { Team } from '@/teams/types';
import { emptyTeamStatLine } from '@/statistics/empty';
import type { TeamStatLine } from '@/statistics/types';

/** A fresh default league (32 teams, BOS as the user team) for a seed. */
export const makeLeague = (seed = 7, opts: Partial<CreateLeagueOptions> = {}): League =>
  createLeague({ seed, userTeamAbbr: 'BOS', ...opts });

/** Plays a whole season (preseason through the championship) with the fallback simulator. */
export const playSeason = (league: League): League => advanceToPhase(league, 'awards').league;

/** Team by abbreviation (throws when missing). */
export const byAbbr = (league: League, abbr: string): Team => {
  const t = Object.values(league.teams).find((x) => x.abbr === abbr);
  if (!t) throw new Error(`no team ${abbr}`);
  return t;
};

/** Teams grouped by `Conference/Division`, each list in id order. */
export const divisionsOf = (league: League): Map<string, Team[]> => {
  const out = new Map<string, Team[]>();
  for (const t of Object.values(league.teams).sort((a, b) => (a.id < b.id ? -1 : 1))) {
    const key = `${t.conference}/${t.division}`;
    out.set(key, [...(out.get(key) ?? []), t]);
  }
  return out;
};

let gameCounter = 0;
/** A finished regular-season game between two teams with a given score. */
export const playedGame = (home: TeamId, away: TeamId, homeScore: number, awayScore: number, week = 1): ScheduledGame => ({
  id: `g_test_${++gameCounter}` as ScheduledGame['id'], week, home, away, isPlayoff: false, playoffRound: null, isPreseason: false,
  result: {
    homeScore, awayScore, overtime: false, playLogId: null, injuries: [],
    stats: { players: {}, teams: { home: emptyTeamLine(homeScore), away: emptyTeamLine(awayScore) } },
    weather: { type: 'clear', windDir: 0, windMph: 0, temperatureF: 68, precipitation: 0, visibility: 1, fieldSlick: 0 },
  },
});

const emptyTeamLine = (points: number): TeamStatLine => ({ ...emptyTeamStatLine(), points });

/** A one-entry play log (enough to exercise play-log storage). */
export const tinyPlayLog = (): PlayLogEntry[] => [{
  index: 0, quarter: 1, clock: 850, possession: 'home', down: 1, distance: 10, ballOn: 25, ballX: MIDDLE_X,
  offensivePlayId: null, defensivePlayId: null, outcome: emptyOutcome({ result: 'run', yards: 4, endBallOn: 29 }),
  scoreAfter: { home: 0, away: 0 }, review: null,
}];

/** Sum of a standing field over the league. */
export const sumStandings = (standings: Record<TeamId, Standing>, key: 'wins' | 'losses' | 'ties' | 'pointsFor' | 'pointsAgainst'): number =>
  Object.values(standings).reduce((acc, s) => acc + s[key], 0);
