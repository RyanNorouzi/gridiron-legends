import { describe, expect, it } from 'vitest';
import type { PlayerId, TeamId } from '@/core/ids';
import {
  HOF_CONFIG, PRE_LEAGUE_HONOURS, careerSummary, championshipsWon, foundingOverallOf, hofBreakdown, hofCandidates, hofScore, inductHallOfFamers,
  leagueFoundingYear, peakOverallOf, preLeagueAllPros, preLeagueProductionScale,
} from '@/franchise/hall-of-fame';
import { retirePlayer } from '@/franchise/retirement';
import type { AwardResult, League, SeasonSummary } from '@/franchise/types';
import { careerTotals } from '@/statistics/aggregate';
import type { CareerStats, PlayerStatLine } from '@/statistics/types';
import { atPhase, makeLeague, rostered, statLine, teamIds, withPlayer } from './helpers';

const career = (playerId: PlayerId, teamId: TeamId, firstYear: number, lines: PlayerStatLine[]): CareerStats => {
  const seasons = lines.map((line, i) => ({ playerId, teamId, year: firstYear + i, line, playoffLine: null }));
  return { playerId, seasons, totals: careerTotals(seasons) };
};

const mvp = (playerId: PlayerId, teamId: TeamId, year: number): AwardResult => ({ award: 'MVP', year, playerId, coachId: null, teamId, summary: 'MVP' });

const starLine = (): PlayerStatLine => statLine({ passing: { attempts: 590, completions: 390, yards: 4500, touchdowns: 33, interceptions: 10 } });
const journeymanLine = (): PlayerStatLine => statLine({ gamesStarted: 2, passing: { attempts: 70, completions: 40, yards: 600, touchdowns: 3, interceptions: 5 } });

/** A league (offseason phase) with a retired 15-year star QB (2 MVPs, 1 title) and a retired journeyman QB. */
const hofLeague = () => {
  let league = atPhase(makeLeague(51), 'offseason');
  const [t1, t2, t3] = teamIds(league) as [TeamId, TeamId, TeamId];
  const year = league.season.year;
  const first = year - 14;
  const star = rostered(league, t1, 'QB');
  const journeyman = rostered(league, t2, 'QB');
  league = withPlayer(league, { ...star, age: 37, progressionLog: [{ year: first + 7, overallBefore: 91, overallAfter: 94, deltas: {}, kind: 'normal' }] });
  league = withPlayer(league, { ...journeyman, age: 34, overall: 68, progressionLog: [{ year: year - 3, overallBefore: 70, overallAfter: 69, deltas: {}, kind: 'normal' }] });
  const history: SeasonSummary[] = Array.from({ length: 15 }, (_, i) => {
    const y = first + i;
    const awards = y === first + 5 || y === first + 9 ? [mvp(star.id, t1, y)] : [];
    return { year: y, champion: y === first + 9 ? t1 : t3, runnerUp: t2, mvp: awards[0]?.playerId ?? null, standings: {}, awards };
  });
  league = {
    ...league, history,
    careerStats: {
      ...league.careerStats,
      [star.id]: career(star.id, t1, first, Array.from({ length: 15 }, starLine)),
      [journeyman.id]: career(journeyman.id, t2, year - 9, Array.from({ length: 10 }, journeymanLine)),
    },
  };
  league = retirePlayer(retirePlayer(league, star.id), journeyman.id);
  return { league, star, journeyman, t1, t2 };
};

describe('hofScore', () => {
  it('rates a decorated 15-year star far above a journeyman, normalised by position', () => {
    const star = career('p_star' as PlayerId, 't_a' as TeamId, 2000, Array.from({ length: 15 }, starLine));
    const awards = [mvp('p_star' as PlayerId, 't_a' as TeamId, 2005), mvp('p_star' as PlayerId, 't_a' as TeamId, 2009)];
    const starScore = hofScore(star, awards, 1, 15, 94, 'QB');
    const jm = career('p_jm' as PlayerId, 't_b' as TeamId, 2000, Array.from({ length: 10 }, journeymanLine));
    const jmScore = hofScore(jm, [], 0, 10, 70, 'QB');
    const b = hofBreakdown(star, awards, 1, 15, 94, 'QB');
    expect(starScore).toBeGreaterThanOrEqual(b.threshold);
    expect(jmScore).toBeLessThan(b.threshold);
    expect(b.awards).toBe(24);
    expect(b.championships).toBe(3);
    expect(b.peak).toBeCloseTo(21);
    expect(b.longevity).toBe(15);
  });

  it('measures linemen by blocking production, not by skill-position stats', () => {
    const olLine = statLine({ blocking: { pancakes: 20, sacksAllowed: 2 } });
    const ol = career('p_ol' as PlayerId, 't_a' as TeamId, 2000, Array.from({ length: 13 }, () => olLine));
    const b = hofBreakdown(ol, [], 0, 13, 90, 'OT', 4);
    expect(b.production).toBeGreaterThan(35);
    expect(b.total).toBeGreaterThanOrEqual(b.threshold);
    const asQb = hofBreakdown(ol, [], 0, 13, 90, 'QB', 4);
    expect(asQb.production).toBe(0);
  });
});

describe('inductHallOfFamers', () => {
  it('inducts the star (2 MVPs, a title) and not the journeyman; a second pass is a no-op', () => {
    const { league, star, journeyman, t1 } = hofLeague();
    const { league: out, inducted } = inductHallOfFamers(league);
    expect(inducted.map((h) => h.playerId)).toEqual([star.id]);
    const h = inducted[0]!;
    expect(h).toMatchObject({ name: `${star.firstName} ${star.lastName}`, position: 'QB', seasons: 15, championships: 1, peakOverall: 94, teams: [t1], inductedYear: league.season.year });
    expect(h.awards.map((a) => a.award)).toEqual(['MVP', 'MVP']);
    expect(h.careerStats.passing.yards).toBe(15 * 4500);
    expect(out.hallOfFame.map((x) => x.playerId)).not.toContain(journeyman.id);
    const again = inductHallOfFamers(out);
    expect(again.inducted).toEqual([]);
    expect(again.league).toBe(out);
  });

  it('lists candidates and career summaries for the UI', () => {
    const { league, star, journeyman } = hofLeague();
    const rows = hofCandidates(league, 50);
    const top = rows.find((r) => r.playerId === star.id);
    expect(top).toMatchObject({ retired: true, eligible: true });
    expect(rows.find((r) => r.playerId === journeyman.id)?.eligible ?? false).toBe(false);
    expect(rows[0]?.playerId).toBe(star.id);
    const s = careerSummary(league, star.id)!;
    expect(s.seasons).toBe(15);
    expect(s.awards).toHaveLength(2);
    expect(s.championships).toBe(1);
    expect(s.hof.total).toBeGreaterThanOrEqual(s.hof.threshold);
    expect(championshipsWon(league, star.id)).toBe(1);
    expect(peakOverallOf(league.retiredPlayers[star.id]!)).toBe(94);
    expect(careerSummary(league, 'p_missing' as PlayerId)).toBeNull();
    const inducted = inductHallOfFamers(league).league;
    expect(careerSummary(inducted, star.id)?.inducted).toBe(true);
    expect(hofCandidates(inducted, 50).some((r) => r.playerId === star.id)).toBe(false);
  });

  it('counts a founding veteran\'s pre-league seasons (Player.experience) toward eligibility and longevity', () => {
    const build = (experience: number) => {
      let league = atPhase(makeLeague(52), 'offseason');
      const [t1] = teamIds(league) as [TeamId];
      const year = league.season.year;
      const star = rostered(league, t1, 'QB');
      league = withPlayer(league, { ...star, age: 35, experience, progressionLog: [{ year: year - 1, overallBefore: 93, overallAfter: 94, deltas: {}, kind: 'normal' }] });
      const history: SeasonSummary[] = Array.from({ length: 3 }, (_, i) => {
        const y = year - 2 + i;
        return { year: y, champion: t1, runnerUp: t1, mvp: star.id, standings: {}, awards: [mvp(star.id, t1, y)] };
      });
      league = { ...league, history, careerStats: { ...league.careerStats, [star.id]: career(star.id, t1, year - 2, Array.from({ length: 3 }, starLine)) } };
      return { league: retirePlayer(league, star.id), star };
    };
    const vet = build(12);
    const s = careerSummary(vet.league, vet.star.id)!;
    expect(s.seasons).toBe(3);
    expect(s.tenure).toBe(12);
    expect(s.hof.longevity).toBe(12);
    expect(preLeagueProductionScale(3, 9)).toBeCloseTo(2.8);
    expect(preLeagueProductionScale(3, 0)).toBe(1);
    expect(preLeagueProductionScale(0, 5)).toBe(1);
    const unscaled = hofBreakdown(vet.league.careerStats[vet.star.id]!, s.awards, s.championships, 12, 94, 'QB', s.allPros);
    expect(s.hof.production).toBeCloseTo(Math.min(HOF_CONFIG.productionCap * HOF_CONFIG.productionPoints, unscaled.production * 2.8));
    expect(inductHallOfFamers(vet.league).inducted.map((h) => h.playerId)).toEqual([vet.star.id]);
    const young = build(3);
    expect(careerSummary(young.league, young.star.id)!.tenure).toBe(3);
    expect(inductHallOfFamers(young.league).inducted).toEqual([]);
  });

  it('credits a founding star\'s pre-league seasons with estimated honours, so he can reach the Hall after one league season', () => {
    const build = (foundingOverall: number, preLeague: number) => {
      let league = atPhase(makeLeague(53), 'offseason');
      const [t1, t2] = teamIds(league) as [TeamId, TeamId];
      const year = league.season.year;
      const de = rostered(league, t1, 'DE');
      league = withPlayer(league, {
        ...de, age: 31, experience: preLeague + 1, rookieYear: year - preLeague,
        progressionLog: [{ year, overallBefore: foundingOverall, overallAfter: foundingOverall - 2, deltas: {}, kind: 'decline' }],
      });
      const line = statLine({ defense: { tackles: 45, sacks: 7 } });
      league = {
        ...league, history: [{ year, champion: t2, runnerUp: t1, mvp: null, standings: {}, awards: [] }],
        careerStats: { ...league.careerStats, [de.id]: career(de.id, t1, year, [line]) },
      };
      return { league: retirePlayer(league, de.id), id: de.id };
    };
    expect(preLeagueAllPros(8, 95)).toBeCloseTo(PRE_LEAGUE_HONOURS.maxRate * PRE_LEAGUE_HONOURS.primeSeasons);
    expect(preLeagueAllPros(20, 95)).toBeCloseTo(preLeagueAllPros(PRE_LEAGUE_HONOURS.primeSeasons, 95));
    expect(preLeagueAllPros(8, PRE_LEAGUE_HONOURS.floor)).toBe(0);
    expect(preLeagueAllPros(0, 99)).toBe(0);
    const star = build(95, 8);
    const s = careerSummary(star.league, star.id)!;
    expect(s.hof.preLeague).toBeCloseTo(preLeagueAllPros(8, 95) * HOF_CONFIG.allProPoints);
    expect(s.hof.total).toBeGreaterThanOrEqual(s.hof.threshold);
    expect(inductHallOfFamers(star.league).inducted.map((h) => h.playerId)).toEqual([star.id]);
    // A merely solid founder earns no pre-league honours and stays out.
    const solid = build(78, 8);
    expect(careerSummary(solid.league, solid.id)!.hof.preLeague).toBe(0);
    expect(inductHallOfFamers(solid.league).inducted).toEqual([]);
    // Players who entered the league after it began have no pre-league seasons.
    expect(leagueFoundingYear({ history: [], season: { ...star.league.season, year: 2031 } })).toBe(2031);
    expect(leagueFoundingYear(star.league)).toBe(star.league.season.year);
    expect(foundingOverallOf({ overall: 70, progressionLog: [] }, 2030)).toBe(70);
  });

  it('keeps inducted players resolvable for saves (retired players only)', () => {
    const { league } = hofLeague();
    const out: League = inductHallOfFamers(league).league;
    for (const h of out.hallOfFame) {
      expect(out.retiredPlayers[h.playerId]).toBeDefined();
      expect(out.players[h.playerId]).toBeUndefined();
    }
  });
});
