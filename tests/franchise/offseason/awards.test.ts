import { describe, expect, it } from 'vitest';
import type { TeamId } from '@/core/ids';
import { AWARDS_CONFIG, applyAwards, awardCandidates, computeAwards, defensiveScore, flagsFor, markTask, offensiveScore, playerAwards, shortGamePaceExtras, statSummary } from '@/franchise/awards';
import { LEAGUE_SIM_QUARTER_SEC } from '@/franchise/settings';
import { clearWeather } from '@/game/weather';
import { emptyGameStats } from '@/statistics/empty';
import { allProTeam, recordAllPros, allProCount } from '@/franchise/hall-of-fame';
import type { GameResult, League } from '@/franchise/types';
import { atPhase, flatStandings, makeLeague, playedSeason, rostered, standing, statLine, teamIds, withPlayer } from './helpers';

/** A crafted awards-phase season with known statistical leaders. */
const craftedSeason = () => {
  let league = makeLeague(21);
  const [tA, tB, tC, tD, tE, tF, tG] = teamIds(league) as [TeamId, TeamId, TeamId, TeamId, TeamId, TeamId, TeamId];
  const qb1 = rostered(league, tA, 'QB');
  const qb2 = rostered(league, tB, 'QB');
  const rb = rostered(league, tC, 'RB');
  const rookieWr = rostered(league, tD, 'WR');
  const vetWr = rostered(league, tE, 'WR');
  const de = rostered(league, tF, 'DE');
  const mlb = rostered(league, tG, 'MLB');
  const rookieDe = rostered(league, tB, 'DE');
  const rookieMlb = rostered(league, tC, 'MLB');
  const partTimer = rostered(league, tD, 'QB');
  for (const p of [rookieWr, rookieDe, rookieMlb]) league = withPlayer(league, { ...p, experience: 0 });
  for (const p of [qb1, qb2, rb, vetWr, de, mlb, partTimer]) league = withPlayer(league, { ...p, experience: 5 });
  const standings = { ...flatStandings(league), [tA]: standing(tA, 13, 4), [tB]: standing(tB, 9, 8) };
  const stats = {
    [qb1.id]: statLine({ passing: { attempts: 600, completions: 410, yards: 5000, touchdowns: 40, interceptions: 8 } }),
    [qb2.id]: statLine({ passing: { attempts: 560, completions: 350, yards: 3800, touchdowns: 24, interceptions: 12 } }),
    [rb.id]: statLine({ rushing: { attempts: 300, yards: 1500, touchdowns: 10 }, receiving: { receptions: 30, yards: 200 } }),
    [rookieWr.id]: statLine({ receiving: { targets: 120, receptions: 80, yards: 1200, touchdowns: 8 } }),
    [vetWr.id]: statLine({ receiving: { targets: 110, receptions: 75, yards: 1100, touchdowns: 7 } }),
    [de.id]: statLine({ defense: { tackles: 40, sacks: 15, forcedFumbles: 2 } }),
    [mlb.id]: statLine({ defense: { tackles: 100, sacks: 1, interceptions: 1 } }),
    [rookieDe.id]: statLine({ defense: { tackles: 30, sacks: 8 } }),
    [rookieMlb.id]: statLine({ defense: { tackles: 90 } }),
    [partTimer.id]: statLine({ gamesPlayed: 3, gamesStarted: 3, passing: { attempts: 150, yards: 2500, touchdowns: 30 } }),
  };
  league = atPhase(league, 'awards', { standings, stats });
  return { league, qb1, qb2, rb, rookieWr, vetWr, de, mlb, rookieDe, rookieMlb, partTimer, tA };
};

describe('award scoring', () => {
  it('weights 15 sacks above 100 tackles (DPOY rule: sacks x8 + tackles x1, MLB tackles normalised x0.9)', () => {
    const sacker = statLine({ defense: { tackles: 40, sacks: 15 } });
    const tackler = statLine({ defense: { tackles: 100, sacks: 1 } });
    expect(defensiveScore(sacker, 'DE')).toBeCloseTo(40 + 15 * 8);
    expect(defensiveScore(tackler, 'MLB')).toBeCloseTo((100 + 8) * AWARDS_CONFIG.defensePositionFactor.MLB);
    expect(defensiveScore(sacker, 'DE')).toBeGreaterThan(defensiveScore(tackler, 'MLB'));
  });

  it('scores offense from yards, touchdowns and giveaways', () => {
    const qb = statLine({ passing: { yards: 5000, touchdowns: 40, interceptions: 8 } });
    expect(offensiveScore(qb)).toBeCloseTo(5000 * 0.04 + 40 * 4 - 8 * 2);
    expect(statSummary(qb, 'QB')).toContain('5,000 pass yds');
  });
});

describe('award voting pace for short live games', () => {
  it('scales production from games played at shorter quarters up to the simulated length, for voting only', () => {
    const c = craftedSeason();
    const half = LEAGUE_SIM_QUARTER_SEC / 2;
    // qb2's team played one regular-season game live at half-length quarters: 300 yards, 2 TD in it.
    const game = c.league.season.schedule.find((g) => !g.isPreseason && !g.isPlayoff)!;
    const stats = emptyGameStats();
    stats.players[c.qb2.id] = statLine({ passing: { attempts: 30, completions: 20, yards: 300, touchdowns: 2, longest: 60 } });
    const played = { homeScore: 14, awayScore: 10, overtime: false, stats, weather: clearWeather(), injuries: [], playLogId: null };
    const schedule = c.league.season.schedule.map((g) => (g.id === game.id ? { ...g, result: { ...played, quarterLengthSec: half } } : g));
    const league = { ...c.league, season: { ...c.league.season, schedule } };
    const extra = shortGamePaceExtras(league).get(c.qb2.id)!;
    expect(extra.passing.yards).toBeCloseTo(300);
    expect(extra.passing.touchdowns).toBeCloseTo(2);
    expect(extra.passing.longest).toBe(0);
    expect(extra.gamesPlayed).toBe(0);
    const cand = awardCandidates(league).find((x) => x.player.id === c.qb2.id)!;
    expect(cand.line.passing.yards).toBe(3800);
    expect(cand.voteLine.passing.yards).toBeCloseTo(4100);
    expect(cand.voteLine.passing.touchdowns).toBeCloseTo(26);
    // Stored stats are untouched and the summary still shows the real numbers.
    expect(league.season.stats[c.qb2.id]?.passing.yards).toBe(3800);
    // A full-length (or unrecorded-length) game adds nothing.
    const full = { ...league, season: { ...league.season, schedule: c.league.season.schedule.map((g) => (g.id === game.id ? { ...g, result: { ...played, quarterLengthSec: LEAGUE_SIM_QUARTER_SEC } } : g)) } };
    expect(shortGamePaceExtras(full).size).toBe(0);
    expect(shortGamePaceExtras(c.league).size).toBe(0);
    const plain = awardCandidates(c.league).find((x) => x.player.id === c.qb2.id)!;
    expect(plain.voteLine).toBe(plain.line);
    expect(computeAwards(full)).toEqual(computeAwards(c.league));
  });

  it('paces by play volume, not by the quarter ratio: a 5-minute game has about 60% of a full game\'s snaps', () => {
    const c = craftedSeason();
    const regular = c.league.season.schedule.filter((g) => !g.isPreseason && !g.isPlayoff);
    const [short, ...rest] = regular;
    const box = (plays: number) => {
      const stats = emptyGameStats();
      stats.teams.home.plays = plays;
      stats.teams.away.plays = plays;
      return { homeScore: 20, awayScore: 17, overtime: false, stats, weather: clearWeather(), injuries: [], playLogId: null };
    };
    const shortBox = box(40);
    shortBox.stats.players[c.qb2.id] = statLine({ passing: { attempts: 30, completions: 20, yards: 300, touchdowns: 2 } });
    const results = new Map<string, GameResult>([[short!.id, { ...shortBox, quarterLengthSec: LEAGUE_SIM_QUARTER_SEC / 3 }]]);
    // Simulated full-length games average 64 plays a side; one old result with no length recorded counts as full length.
    rest.slice(0, 20).forEach((g, i) => results.set(g.id, { ...box(i % 2 === 0 ? 60 : 68), quarterLengthSec: LEAGUE_SIM_QUARTER_SEC }));
    results.set(rest[20]!.id, box(64));
    const schedule = c.league.season.schedule.map((g) => (results.has(g.id) ? { ...g, result: results.get(g.id)! } : g));
    const league = { ...c.league, season: { ...c.league.season, schedule } };
    // 64 / 40 = 1.6x volume: +60%, not the +200% the 3x quarter ratio would credit.
    const extra = shortGamePaceExtras(league).get(c.qb2.id)!;
    expect(extra.passing.yards).toBeCloseTo(300 * 0.6);
    expect(extra.passing.touchdowns).toBeCloseTo(2 * 0.6);
    // A short game that somehow ran at full volume earns nothing; the quarter ratio caps a very slow one.
    const withShortPlays = (plays: number) => {
      const r = results.get(short!.id)!;
      const result = { ...r, stats: { ...r.stats, teams: box(plays).stats.teams } };
      return { ...league, season: { ...league.season, schedule: schedule.map((g) => (g.id === short!.id ? { ...g, result } : g)) } };
    };
    expect(shortGamePaceExtras(withShortPlays(70)).size).toBe(0);
    expect(shortGamePaceExtras(withShortPlays(10)).get(c.qb2.id)!.passing.yards).toBeCloseTo(600);
  });
});

describe('computeAwards', () => {
  it('picks the statistically best players and writes stat-line summaries', () => {
    const c = craftedSeason();
    const awards = computeAwards(c.league);
    const by = Object.fromEntries(awards.map((a) => [a.award, a]));
    expect(by.MVP?.playerId).toBe(c.qb1.id);
    expect(by.MVP?.summary).toContain('5,000 pass yds');
    expect(by.MVP?.summary).toContain('40 TD');
    expect(by.MVP?.summary).toContain('13-4');
    expect(by.OPOY?.playerId).toBe(c.qb1.id);
    expect(by.DPOY?.playerId).toBe(c.de.id);
    expect(by.DPOY?.summary).toContain('15 sacks');
    expect(by.OROY?.playerId).toBe(c.rookieWr.id);
    expect(by.OROY?.summary).toContain('1,200 yds');
    expect(by.DROY?.playerId).toBe(c.rookieDe.id);
    expect(by.bestQB?.playerId).toBe(c.qb1.id);
    expect(by.bestRB?.playerId).toBe(c.rb.id);
    expect(by.bestRB?.summary).toContain('1,500 rush yds');
    expect(by.bestWR?.playerId).toBe(c.rookieWr.id);
    expect(by.bestDefender?.playerId).toBe(c.de.id);
    for (const a of awards) {
      expect(a.year).toBe(c.league.season.year);
      expect(c.league.teams[a.teamId]).toBeDefined();
    }
  });

  it('ignores players below the games-played minimum', () => {
    const c = craftedSeason();
    const ids = computeAwards(c.league).map((a) => a.playerId);
    expect(ids).not.toContain(c.partTimer.id);
  });

  it('gives Coach of the Year to the team that beat its rating by the most', () => {
    const c = craftedSeason();
    const weakest = Object.values(c.league.teams).sort((a, b) => a.overall - b.overall || (a.id < b.id ? -1 : 1))[0]!;
    const league: League = { ...c.league, season: { ...c.league.season, standings: { ...c.league.season.standings, [weakest.id]: standing(weakest.id, 12, 5) } } };
    const coy = computeAwards(league).find((a) => a.award === 'COY');
    expect(coy?.teamId).toBe(weakest.id);
    expect(coy?.coachId).toBe(weakest.headCoachId);
    expect(coy?.playerId).toBeNull();
    expect(coy?.summary).toContain('12-5');
  });

  it('uses the camp rating snapshot as the COY expectation when present', () => {
    const c = craftedSeason();
    const [strong] = teamIds(c.league) as [TeamId];
    const standings = { ...c.league.season.standings, [strong]: standing(strong, 12, 5) };
    const ratings = Object.fromEntries(teamIds(c.league).map((id) => [id, id === strong ? 40 : 80]));
    const snap = markTask({ ...c.league, season: { ...c.league.season, standings } }, c.league.season.year - 1, 'camp', { preseasonRatings: { year: c.league.season.year, ratings } });
    expect(computeAwards(snap).find((a) => a.award === 'COY')?.teamId).toBe(strong);
  });

  it('breaks ties deterministically by team record, then id', () => {
    const c = craftedSeason();
    const same = c.league.season.stats[c.qb1.id]!;
    const stats = { ...c.league.season.stats, [c.qb2.id]: same };
    const tied = { ...c.league, season: { ...c.league.season, stats } };
    const mvp1 = computeAwards(tied).find((a) => a.award === 'OPOY');
    expect(mvp1?.playerId).toBe(c.qb1.id); // 13-4 beats 9-8 with identical lines
    const standings = { ...tied.season.standings, [c.qb1.teamId as TeamId]: standing(c.qb1.teamId as TeamId, 9, 8) };
    const even = { ...tied, season: { ...tied.season, standings } };
    const winner = computeAwards(even).find((a) => a.award === 'OPOY')?.playerId;
    expect(winner).toBe([c.qb1.id, c.qb2.id].sort()[0]);
    expect(computeAwards(even)).toEqual(computeAwards(even));
  });
});

describe('applyAwards / All-Pro', () => {
  it('stores awards on the season idempotently and patches an existing history summary', () => {
    const c = craftedSeason();
    const once = applyAwards(c.league);
    expect(once.season.awards.filter((a) => a.award === 'MVP')).toHaveLength(1);
    expect(applyAwards(once)).toEqual(once);
    expect(playerAwards(once, c.qb1.id).map((a) => a.award)).toEqual(['MVP', 'OPOY', 'bestQB']);
    const withHistory: League = {
      ...c.league,
      history: [{ year: c.league.season.year, champion: c.tA, runnerUp: teamIds(c.league)[1]!, mvp: null, standings: {}, awards: [] }],
    };
    const patched = applyAwards(withHistory);
    expect(patched.history[0]?.mvp).toBe(c.qb1.id);
    expect(patched.history[0]?.awards.length).toBe(patched.season.awards.length);
  });

  it('selects a first-team All-Pro per position and records the years once', () => {
    const c = craftedSeason();
    const team = allProTeam(c.league);
    expect(team.find((s) => s.position === 'QB')?.playerId).toBe(c.qb1.id);
    expect(team.find((s) => s.position === 'DE' && s.rank === 1)?.playerId).toBe(c.de.id);
    expect(team.filter((s) => s.position === 'WR').map((s) => s.playerId)).toEqual([c.rookieWr.id, c.vetWr.id]);
    const once = recordAllPros(c.league, team);
    const twice = recordAllPros(once, team);
    expect(allProCount(twice, c.qb1.id)).toBe(1);
    expect(flagsFor(twice, c.league.season.year).allPro?.[c.qb1.id]).toEqual([c.league.season.year]);
  });

  it('hands out nothing before any game is played and every award after a simulated season', () => {
    expect(computeAwards(atPhase(makeLeague(5), 'awards'))).toEqual([]);
    const awards = computeAwards(playedSeason(7));
    expect(awards.map((a) => a.award)).toEqual(['MVP', 'OPOY', 'DPOY', 'OROY', 'DROY', 'COY', 'bestQB', 'bestRB', 'bestWR', 'bestDefender']);
    expect(awards.every((a) => a.summary.length > 20)).toBe(true);
  });
});
