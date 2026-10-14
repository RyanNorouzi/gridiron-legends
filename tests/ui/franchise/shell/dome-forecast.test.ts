import { describe, expect, it } from 'vitest';
import { buildGameSetup, gameStadium, gameWeather } from '@/franchise/game-setup';
import type { League, ScheduledGame } from '@/franchise/types';
import { createGameState } from '@/game/game-state';
import { clearWeather, isAdverseWeather, loadWeatherData } from '@/game/weather';
import { simulateGame } from '@/simulation/game-sim';
import { buildBoxScore } from '@/ui/franchise/league/boxscore-model';
import { forecastText, matchupCard, playedIndoors, weatherText } from '@/ui/franchise/shell/game-day-model';
import { leagueAt, userOf } from './helpers';

const firstHomeGame = (league: League, roof: 'dome' | 'open'): ScheduledGame => {
  const g = league.season.schedule.find((x) => x.result === null && !x.isPlayoff && gameStadium(league, x).roof === roof);
  if (!g) throw new Error(`no ${roof} game`);
  return g;
};

describe('dome forecast', () => {
  const league = leagueAt(31, 'regularSeason');
  const indoorF = loadWeatherData().indoorTemperatureF;

  it('a dome game reads "Dome · 68°F indoors", never an outdoor forecast', () => {
    const g = firstHomeGame(league, 'dome');
    const card = matchupCard(league, g, userOf(league));
    expect(card.weather).toBe(`Dome · ${indoorF}°F indoors`);
    expect(card.indoor).toBe(true);
    expect(card.weather).not.toMatch(/clear/i);
    const open = matchupCard(league, firstHomeGame(league, 'open'), userOf(league));
    expect(open.indoor).toBe(false);
    expect(open.weather).toBe(weatherText(gameWeather(league, firstHomeGame(league, 'open'))));
  });

  it('forecastText handles domes, closed retractable roofs and open stadiums', () => {
    const indoor = clearWeather(indoorF);
    expect(forecastText({ roof: 'dome' }, indoor)).toBe(`Dome · ${indoorF}°F indoors`);
    expect(forecastText({ roof: 'retractable' }, indoor)).toBe(`Roof closed · ${indoorF}°F indoors`);
    const rain = { ...indoor, type: 'rain' as const, precipitation: 0.5, temperatureF: 50 };
    expect(playedIndoors({ roof: 'retractable' }, rain)).toBe(false);
    expect(forecastText({ roof: 'retractable' }, rain)).toBe('Rain, 50°F');
    expect(forecastText({ roof: 'open' }, indoor)).toBe(`Clear, ${indoorF}°F`);
  });

  it('the dome game setup (play and sim paths) carries no weather effects, and the box score says so', () => {
    const g = firstHomeGame(league, 'dome');
    for (const setup of [
      buildGameSetup(league, g),
      buildGameSetup(league, g, { userSide: 'home', controllers: { home: 'human', away: 'ai' } }),
    ]) {
      expect(setup.stadium.roof).toBe('dome');
      expect(setup.weather).toEqual(clearWeather(indoorF));
      expect(isAdverseWeather(setup.weather)).toBe(false);
      const state = createGameState(setup);
      expect(state.weather).toEqual(clearWeather(indoorF));
    }
    const played = simulateGame(buildGameSetup(league, g));
    expect(played.state.weather).toEqual(clearWeather(indoorF));
    const done: League = {
      ...league,
      season: {
        ...league.season,
        schedule: league.season.schedule.map((x) => (x.id === g.id ? {
          ...x, result: { homeScore: 10, awayScore: 7, overtime: false, weather: played.state.weather, stats: played.result.stats, injuries: [], playLogId: null },
        } : x)),
      },
    };
    expect(buildBoxScore(done, g.id)?.weather).toBe(`Dome ${indoorF}F`);
  }, 60000);
});
