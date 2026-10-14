/**
 * Matchup view-model shared by game day and the home tab's next-opponent card: both teams (logo, colours,
 * record, overall / offense / defense), who the user is, venue, a weather forecast line, the rivalry flag, the
 * rating edge and the round / week title. `nextUserGame` finds the user's next unplayed game of the phase. Pure.
 */
import type { TeamId } from '@/core/ids';
import { gameStadium, gameWeather, userSideOf } from '@/franchise/game-setup';
import { loadWeatherData } from '@/game/weather';
import { phaseLabel as seasonPhaseLabel } from '@/franchise/phase';
import { isRivalryGame } from '@/franchise/rivalries';
import type { League, ScheduledGame } from '@/franchise/types';
import type { TeamSide, WeatherState } from '@/game/types';
import type { Stadium, TeamColors } from '@/teams/types';
import { formatRecord, formatSigned, humanize, type ToneText } from '../kit/format';

/** One side of a matchup. */
export interface MatchupSide {
  teamId: TeamId;
  abbr: string;
  city: string;
  name: string;
  logoSeed: number;
  colors: TeamColors;
  record: string;
  overall: number;
  offense: number;
  defense: number;
  user: boolean;
}

/** Everything a matchup card shows. */
export interface MatchupCard {
  gameId: string;
  title: string;
  home: MatchupSide;
  away: MatchupSide;
  userSide: TeamSide | null;
  venue: string;
  /** Forecast ("Rain, 41°F, wind 12 mph"), or the indoor line for a dome / closed roof ("Dome · 68°F indoors"). */
  weather: string;
  /** True when the game is (or was) played indoors: no weather effects. */
  indoor: boolean;
  rivalry: boolean;
  playoff: boolean;
  edge: ToneText;
  /** Final score line when the game is already played. */
  final: string | null;
}

/** "Rain, 41°F, wind 12 mph" (just "Clear, 70°F" in calm weather). */
export const weatherText = (w: WeatherState): string =>
  `${humanize(w.type)}, ${Math.round(w.temperatureF)}°F${w.windMph >= 5 ? `, wind ${Math.round(w.windMph)} mph` : ''}`;

/**
 * True when a game at `stadium` in weather `w` is played indoors: always under a dome, and under a retractable roof
 * when the weather engine closed it (it then hands back still, clear, indoor-temperature conditions).
 */
export const playedIndoors = (stadium: Pick<Stadium, 'roof'>, w: WeatherState): boolean =>
  stadium.roof === 'dome'
  || (stadium.roof === 'retractable' && w.type === 'clear' && w.windMph === 0 && w.precipitation === 0 && w.temperatureF === loadWeatherData().indoorTemperatureF);

/** The forecast line: "Dome · 68°F indoors", "Roof closed · 68°F indoors" or the outdoor weatherText. */
export const forecastText = (stadium: Pick<Stadium, 'roof'>, w: WeatherState): string => {
  if (!playedIndoors(stadium, w)) return weatherText(w);
  return `${stadium.roof === 'dome' ? 'Dome' : 'Roof closed'} · ${Math.round(w.temperatureF)}°F indoors`;
};

const side = (league: League, id: TeamId, user: TeamId | null): MatchupSide => {
  const t = league.teams[id];
  if (!t) throw new Error(`matchupCard: unknown team ${id}`);
  const st = league.season.standings[id];
  return {
    teamId: id, abbr: t.abbr, city: t.city, name: t.name, logoSeed: t.logoSeed, colors: { ...t.colors }, record: st ? formatRecord(st) : '0-0',
    overall: t.overall, offense: t.offenseRating, defense: t.defenseRating, user: id === user,
  };
};

/** Title of a scheduled game: "2026 Week 5", "2026 Preseason Week 1" or the playoff round name. */
export const gameTitle = (league: League, g: ScheduledGame): string =>
  g.isPlayoff ? (league.settings.playoff.roundNames[(g.playoffRound ?? g.week) - 1] ?? `Playoffs Round ${g.week}`)
    : `${league.season.year} ${seasonPhaseLabel(g.isPreseason ? 'preseason' : 'regularSeason', g.week)}`;

/** Builds the matchup card of a scheduled game. */
export const matchupCard = (league: League, g: ScheduledGame, userTeamId: TeamId | null): MatchupCard => {
  const home = side(league, g.home, userTeamId);
  const away = side(league, g.away, userTeamId);
  const userSide = userTeamId ? userSideOf({ userTeamId }, g) : null;
  const stadium = gameStadium(league, g);
  const roof = stadium.roof === 'dome' ? ' (dome)' : stadium.roof === 'retractable' ? ' (retractable roof)' : '';
  const mine = userSide === 'away' ? away : home;
  const theirs = userSide === 'away' ? home : away;
  const diff = mine.overall - theirs.overall;
  const edge: ToneText = userSide === null ? { text: `${home.abbr} ${formatSigned(home.overall - away.overall)} OVR`, tone: 'normal' }
    : diff === 0 ? { text: 'Even matchup', tone: 'normal' }
      : { text: `${diff > 0 ? mine.abbr : theirs.abbr} ${formatSigned(Math.abs(diff))} OVR edge`, tone: diff > 0 ? 'success' : 'warning' };
  const r = g.result;
  return {
    gameId: g.id, title: gameTitle(league, g), home, away, userSide,
    venue: `${stadium.name}${roof}`,
    weather: forecastText(stadium, r ? r.weather : gameWeather(league, g)),
    indoor: playedIndoors(stadium, r ? r.weather : gameWeather(league, g)),
    rivalry: isRivalryGame(g, league), playoff: g.isPlayoff, edge,
    final: r ? `Final: ${away.abbr} ${r.awayScore} - ${home.abbr} ${r.homeScore}${r.overtime ? ' (OT)' : ''}` : null,
  };
};

/** The user's next unplayed game in the current phase (this week's first), or null. */
export const nextUserGame = (league: League, userTeamId: TeamId): ScheduledGame | null => {
  const s = league.season;
  const kind = s.phase === 'preseason' ? 'pre' : s.phase === 'regularSeason' ? 'reg' : s.phase === 'playoffs' ? 'po' : null;
  if (!kind) return null;
  const mine = s.schedule.filter((g) => g.result === null && (g.home === userTeamId || g.away === userTeamId)
    && (kind === 'po' ? g.isPlayoff : kind === 'pre' ? g.isPreseason : !g.isPlayoff && !g.isPreseason) && g.week >= s.week);
  mine.sort((a, b) => a.week - b.week);
  return mine[0] ?? null;
};
