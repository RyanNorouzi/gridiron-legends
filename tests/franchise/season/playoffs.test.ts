import { beforeAll, describe, expect, it } from 'vitest';
import type { TeamId } from '@/core/ids';
import {
  advanceBracket, aliveTeams, beginPlayoffs, champion, createBracket, currentRound, gamesForRound, isBracketComplete, isChampionshipRound,
  matchupsForRound, playoffResultLabel, runnerUp, schedulePlayoffRound, seedOf, type BracketResult,
} from '@/franchise/playoffs';
import { defaultLeagueSettings } from '@/franchise/settings';
import { emptyStanding } from '@/franchise/standings';
import { buildGameSetup } from '@/franchise/game-setup';
import { fallbackSimulator } from '@/franchise/sim-fallback';
import { advanceToPhase } from '@/franchise/week';
import type { BracketMatchup, League, PlayoffBracket, Standing } from '@/franchise/types';
import { makeLeague } from './helpers';

const settings = defaultLeagueSettings();
const ids = (prefix: string, n: number): TeamId[] => Array.from({ length: n }, (_, i) => `${prefix}${i + 1}` as TeamId);
const seeds = { Liberty: ids('L', 7), Frontier: ids('F', 7) };
const higherWins = (b: PlayoffBracket): BracketResult[] =>
  gamesForRound(b, currentRound(b)).filter((m) => m.winner === null).map((m) => ({ winner: m.higherSeed as TeamId, loser: m.lowerSeed as TeamId }));
const pair = (m: BracketMatchup): [TeamId | null, TeamId | null] => [m.higherSeed, m.lowerSeed];

describe('createBracket', () => {
  const bracket = createBracket(seeds, settings);
  it('gives the top seed a bye and pairs 2v7, 3v6, 4v5', () => {
    const r1 = matchupsForRound(bracket, 1).filter((m) => m.conference === 'Liberty');
    expect(r1.map(pair)).toEqual([['L1', null], ['L2', 'L7'], ['L3', 'L6'], ['L4', 'L5']]);
    expect(r1[0]?.winner).toBe('L1');
    expect(gamesForRound(bracket, 1)).toHaveLength(6);
    expect(bracket.champion).toBeNull();
    expect(seedOf(bracket, 'F3' as TeamId)).toEqual({ conference: 'Frontier', seed: 3 });
    expect(currentRound(bracket)).toBe(1);
  });

  it('rejects the wrong number of seeds', () => {
    expect(() => createBracket({ Liberty: ids('L', 6), Frontier: ids('F', 7) }, settings)).toThrow(/6 seeds/);
  });
});

describe('advanceBracket', () => {
  it('reseeds so the top remaining seed hosts the lowest', () => {
    let b = createBracket(seeds, settings);
    // Upset: L7 beats L2; everything else goes to the higher seed.
    const results = higherWins(b).map((r) => (r.winner === 'L2' ? { winner: 'L7' as TeamId, loser: 'L2' as TeamId } : r));
    b = advanceBracket(b, results, settings);
    expect(matchupsForRound(b, 2).filter((m) => m.conference === 'Liberty').map(pair)).toEqual([['L1', 'L7'], ['L3', 'L4']]);
    expect(currentRound(b)).toBe(2);
    expect(aliveTeams(b)).toHaveLength(8);
  });

  it('keeps a round open until every game has a result', () => {
    const b0 = createBracket(seeds, settings);
    const partial = advanceBracket(b0, higherWins(b0).slice(0, 2), settings);
    expect(matchupsForRound(partial, 2)).toHaveLength(0);
    expect(currentRound(partial)).toBe(1);
    expect(() => advanceBracket(b0, [{ winner: 'L2' as TeamId, loser: 'L2' as TeamId }], settings)).toThrow(/must differ/);
    expect(advanceBracket(b0, [{ winner: 'X1' as TeamId, loser: 'X2' as TeamId }], settings).matchups).toEqual(b0.matchups);
  });

  it('plays the championship between conference winners with the better record hosting, then crowns a champion', () => {
    const standings: Record<TeamId, Standing> = {
      ['L1' as TeamId]: { ...emptyStanding('L1' as TeamId), wins: 12, losses: 5 },
      ['F1' as TeamId]: { ...emptyStanding('F1' as TeamId), wins: 14, losses: 3 },
    };
    let b = createBracket(seeds, settings);
    for (let round = 1; round <= 3; round++) b = advanceBracket(b, higherWins(b), settings, standings);
    const final = matchupsForRound(b, 4);
    expect(final).toHaveLength(1);
    expect(pair(final[0] as BracketMatchup)).toEqual(['F1', 'L1']);
    expect(final[0]?.conference).toBeNull();
    expect(isChampionshipRound(settings, 4)).toBe(true);
    expect(isBracketComplete(b)).toBe(false);
    b = advanceBracket(b, [{ winner: 'L1' as TeamId, loser: 'F1' as TeamId }], settings, standings);
    expect(isBracketComplete(b)).toBe(true);
    expect(champion(b)).toBe('L1');
    expect(runnerUp(b)).toBe('F1');
    expect(aliveTeams(b)).toEqual(['L1']);
    expect(advanceBracket(b, [], settings)).toBe(b);
    const names = settings.playoff.roundNames;
    expect(playoffResultLabel(b, 'L1' as TeamId, names)).toBe('Won Championship');
    expect(playoffResultLabel(b, 'F1' as TeamId, names)).toBe('Lost Championship');
    expect(playoffResultLabel(b, 'L7' as TeamId, names)).toBe('Lost Wild Card');
    expect(playoffResultLabel(b, 'F2' as TeamId, names)).toBe('Lost Conference Championship');
    expect(playoffResultLabel(b, 'X9' as TeamId, names)).toBeNull();
  });

  it('supports a single-conference bracket without a neutral championship', () => {
    const one = defaultLeagueSettings({ conferences: ['Liberty'], playoff: { teamsPerConference: 4, byesPerConference: 0, roundNames: ['Semifinal', 'Final'] } });
    let b = createBracket({ Liberty: ids('L', 4) }, one);
    expect(gamesForRound(b, 1).map(pair)).toEqual([['L1', 'L4'], ['L2', 'L3']]);
    b = advanceBracket(b, higherWins(b), one);
    expect(gamesForRound(b, 2).map(pair)).toEqual([['L1', 'L2']]);
    expect(isChampionshipRound(one, 2)).toBe(false);
    b = advanceBracket(b, [{ winner: 'L2' as TeamId, loser: 'L1' as TeamId }], one);
    expect(champion(b)).toBe('L2');
  });
});

describe('schedulePlayoffRound', () => {
  it('creates playoff games hosted by the higher seed and stamps game ids', () => {
    const { bracket, games } = schedulePlayoffRound(createBracket(seeds, settings), 2031, 1);
    expect(games).toHaveLength(6);
    expect(games.every((g) => g.isPlayoff && g.playoffRound === 1 && g.week === 1 && !g.isPreseason)).toBe(true);
    expect(games.map((g) => g.id)).toContain('g_2031_po1_01');
    expect(games.find((g) => g.away === 'L7')?.home).toBe('L2');
    expect(gamesForRound(bracket, 1).every((m) => m.gameId !== null)).toBe(true);
    expect(schedulePlayoffRound(bracket, 2031, 1).games).toHaveLength(0);
  });
});

describe('a real bracket played with the fallback simulator', () => {
  let regular: League;
  beforeAll(() => {
    regular = advanceToPhase(makeLeague(33), 'playoffs').league;
  });

  it('beginPlayoffs refuses to start while regular-season games remain', () => {
    expect(() => beginPlayoffs(makeLeague(33))).toThrow(/unplayed/);
  });

  it('advances round by round to a champion', () => {
    let league = regular;
    expect(league.season.phase).toBe('playoffs');
    let bracket = league.season.bracket as PlayoffBracket;
    for (let round = 1; round <= 4; round++) {
      const games = league.season.schedule.filter((g) => g.isPlayoff && g.playoffRound === round);
      expect(games).toHaveLength(round === 1 ? 6 : round === 2 ? 4 : round === 3 ? 2 : 1);
      const results: BracketResult[] = games.map((g) => {
        const r = fallbackSimulator(buildGameSetup(league, g));
        expect(r.homeScore).not.toBe(r.awayScore);
        return r.homeScore > r.awayScore ? { winner: g.home, loser: g.away } : { winner: g.away, loser: g.home };
      });
      bracket = advanceBracket(bracket, results, league.settings, league.season.standings);
      if (round < 4) {
        const next = schedulePlayoffRound(bracket, league.season.year, round + 1);
        bracket = next.bracket;
        league = { ...league, season: { ...league.season, bracket, schedule: [...league.season.schedule, ...next.games] } };
      }
    }
    expect(isBracketComplete(bracket)).toBe(true);
    const champ = champion(bracket) as TeamId;
    expect(Object.values(bracket.seeds).flat()).toContain(champ);
    expect(runnerUp(bracket)).not.toBe(champ);
  });
});
