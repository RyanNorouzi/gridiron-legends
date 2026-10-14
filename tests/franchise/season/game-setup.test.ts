import { describe, expect, it } from 'vitest';
import type { PlayerId } from '@/core/ids';
import { buildGameSetup, calendarWeek, coordinatorOf, gameSeed, gameStadium, gameWeather, neutralSite, userSideOf } from '@/franchise/game-setup';
import { createFallbackSimulator, fallbackLineup, fallbackSimulator } from '@/franchise/sim-fallback';
import { simResultIssues, validateSimResult, type GameSimResult } from '@/franchise/sim-seam';
import { gamesInWeek } from '@/franchise/schedule';
import { createGameState } from '@/game/game-state';
import type { GameSetup } from '@/game/types';
import type { ScheduledGame } from '@/franchise/types';
import { LEAGUE_SIM_QUARTER_SEC, LEAGUE_SIM_OVERTIME_SEC, leagueRuleset, leagueSimRuleset } from '@/franchise/settings';
import { byAbbr, makeLeague } from './helpers';

const league = makeLeague(12);
const bos = byAbbr(league, 'BOS');
const week1 = gamesInWeek(league.season.schedule, 'regularSeason', 1);
const userGame = league.season.schedule.find((g) => !g.isPreseason && (g.home === bos.id || g.away === bos.id)) as ScheduledGame;
const aiGame = week1.find((g) => g.home !== bos.id && g.away !== bos.id) as ScheduledGame;

describe('buildGameSetup', () => {
  const setup = buildGameSetup(league, aiGame);
  it('resolves both rosters, coaches, playbooks and the home stadium', () => {
    for (const side of ['home', 'away'] as const) {
      const team = league.teams[aiGame[side]];
      expect(setup[side].team.id).toBe(aiGame[side]);
      expect(Object.keys(setup[side].players).sort()).toEqual([...(team?.rosterIds ?? [])].sort());
      expect(setup[side].headCoach?.id).toBe(team?.headCoachId);
      const staff = (team?.staffIds ?? []).map((id) => league.coaches[id]);
      expect(setup[side].offensiveCoordinator?.id ?? null).toBe(staff.find((c) => c?.role === 'OC')?.id ?? null);
      expect(setup[side].defensiveCoordinator?.id ?? null).toBe(staff.find((c) => c?.role === 'DC')?.id ?? null);
      expect(setup[side].offensePlays.length).toBeGreaterThan(10);
      expect(setup[side].defensePlays.length).toBeGreaterThan(5);
    }
    expect(setup.stadium.id).toBe(league.teams[aiGame.home]?.stadiumId);
    expect(setup.isPlayoff).toBe(false);
    expect(setup.userSide).toBeNull();
    expect(setup.controllers).toEqual({ home: 'ai', away: 'ai' });
    expect(() => createGameState(setup)).not.toThrow();
  });

  it('copies the ruleset toggles and difficulty from the settings', () => {
    expect(setup.ruleset.injuries).toBe(true);
    const off = { ...league, settings: { ...league.settings, injuriesEnabled: false, fatigueEnabled: false } };
    const s2 = buildGameSetup(off, aiGame);
    expect(s2.ruleset.injuries).toBe(false);
    expect(s2.ruleset.fatigue).toBe(false);
    expect(s2.difficulty).toEqual(league.settings.difficulty);
  });

  it('simulated games play the calibrated full length; live user games keep the league\'s quarter length', () => {
    expect(LEAGUE_SIM_QUARTER_SEC).toBe(900);
    // A league created with 5-minute quarters (the live-play default) and penalties off.
    const short = { ...league, settings: { ...league.settings, ruleset: { ...league.settings.ruleset, quarterLengthSec: 300, overtimeLengthSec: 300, penalties: false } } };
    expect(short.settings.ruleset.quarterLengthSec).toBe(300);
    const sim = buildGameSetup(short, aiGame);
    expect(sim.ruleset.quarterLengthSec).toBe(LEAGUE_SIM_QUARTER_SEC);
    expect(sim.ruleset.overtimeLengthSec).toBe(LEAGUE_SIM_OVERTIME_SEC);
    expect(sim.ruleset).toEqual(leagueSimRuleset(short.settings));
    // Everything but the length is the league's own rules.
    expect({ ...sim.ruleset, quarterLengthSec: 0, overtimeLengthSec: 0 }).toEqual({ ...leagueRuleset(short.settings), quarterLengthSec: 0, overtimeLengthSec: 0 });
    expect(sim.ruleset.penalties).toBe(false);
    // The user's game simmed from the week (no controllers) is a simulated game too.
    expect(buildGameSetup(short, userGame).ruleset.quarterLengthSec).toBe(LEAGUE_SIM_QUARTER_SEC);
    const side = userSideOf(short, userGame) ?? 'home';
    const live = buildGameSetup(short, userGame, { userSide: side, controllers: side === 'home' ? { home: 'human', away: 'ai' } : { home: 'ai', away: 'human' } });
    expect(live.ruleset.quarterLengthSec).toBe(300);
    expect(live.ruleset).toEqual(leagueRuleset(short.settings));
  });

  it('derives a stable seed and weather per game', () => {
    expect(buildGameSetup(league, aiGame).seed).toBe(setup.seed);
    expect(setup.seed).toBe(gameSeed(league, aiGame.id));
    expect(gameSeed(league, week1[1]?.id ?? '')).not.toBe(setup.seed);
    expect(setup.weather).toEqual(gameWeather(league, aiGame));
    const dry = { ...league, settings: { ...league.settings, weatherEnabled: false } };
    expect(buildGameSetup(dry, aiGame).weather.type).toBe('clear');
    const domes = Object.values(league.teams).filter((t) => league.stadiums[t.stadiumId]?.roof === 'dome').map((t) => t.id);
    const domeGame = league.season.schedule.find((g) => domes.includes(g.home));
    if (domeGame) expect(gameWeather(league, domeGame).type).toBe('clear');
  });

  it('sets up a live user game', () => {
    const live = buildGameSetup(league, userGame, { controllers: { home: 'human', away: 'human' }, userSide: userSideOf(league, userGame) });
    const side = userSideOf(league, userGame);
    expect(side).not.toBeNull();
    expect(live.userSide).toBe(side);
    const implicit = buildGameSetup(league, userGame, { controllers: side === 'home' ? { home: 'human', away: 'ai' } : { home: 'ai', away: 'human' } });
    expect(implicit.userSide).toBe(side);
    const forced = buildGameSetup(league, aiGame, { userSide: 'away' });
    expect(forced.controllers.away).toBe('human');
    expect(() => createGameState(live)).not.toThrow();
  });

  it('uses a neutral site for the championship and a playoff calendar week', () => {
    const final: ScheduledGame = { ...aiGame, id: 'g_2026_po4_01' as ScheduledGame['id'], isPlayoff: true, playoffRound: 4, week: 4 };
    const site = gameStadium(league, final);
    expect(site.id).not.toBe(league.teams[final.home]?.stadiumId);
    expect(site.id).not.toBe(league.teams[final.away]?.stadiumId);
    expect(neutralSite(league, final, 2026)).toEqual(site);
    expect(calendarWeek(league, final)).toBe(22);
    expect(buildGameSetup(league, final).isPlayoff).toBe(true);
    const wildCard: ScheduledGame = { ...final, playoffRound: 1, week: 1 };
    expect(gameStadium(league, wildCard).id).toBe(league.teams[final.home]?.stadiumId);
  });
});

const sumOf = (r: GameSimResult, pick: (l: NonNullable<GameSimResult['stats']['players'][PlayerId]>) => number): number =>
  Object.values(r.stats.players).reduce((a, l) => a + pick(l), 0);

describe('fallback simulator', () => {
  const setup = buildGameSetup(league, aiGame);
  const r = fallbackSimulator(setup);

  it('is deterministic for a setup and varies with the seed', () => {
    expect(createFallbackSimulator()(setup)).toEqual(r);
    const other = fallbackSimulator({ ...setup, seed: setup.seed + 1 });
    expect(other).not.toEqual(r);
  });

  it('produces a valid, internally consistent box score', () => {
    expect(simResultIssues(setup, r)).toEqual([]);
    expect(r.stats.teams.home.points).toBe(r.homeScore);
    expect(r.stats.teams.away.points).toBe(r.awayScore);
    expect(sumOf(r, (l) => l.passing.yards)).toBe(sumOf(r, (l) => l.receiving.yards));
    expect(sumOf(r, (l) => l.passing.completions)).toBe(sumOf(r, (l) => l.receiving.receptions));
    expect(sumOf(r, (l) => l.passing.touchdowns)).toBe(sumOf(r, (l) => l.receiving.touchdowns));
    expect(sumOf(r, (l) => l.passing.interceptions)).toBe(sumOf(r, (l) => l.defense.interceptions));
    expect(sumOf(r, (l) => l.passing.sacks)).toBe(sumOf(r, (l) => l.defense.sacks));
    const kicks = sumOf(r, (l) => l.kicking.fgMade * 3 + l.kicking.xpMade);
    const tds = sumOf(r, (l) => l.passing.touchdowns + l.rushing.touchdowns);
    expect(kicks + tds * 6).toBeLessThanOrEqual(r.homeScore + r.awayScore);
    expect(r.homeScore + r.awayScore - kicks - tds * 6).toBeLessThanOrEqual(8);
    for (const side of ['home', 'away'] as const) {
      for (const p of fallbackLineup(setup[side]).starters) {
        const line = r.stats.players[p.id];
        expect(line?.gamesPlayed).toBe(1);
        expect(line?.gamesStarted).toBe(1);
      }
    }
  });

  it('never ties a playoff game and respects the injury switch', () => {
    let injured = 0;
    for (let seed = 1; seed <= 60; seed++) {
      const res = fallbackSimulator({ ...setup, seed, isPlayoff: true });
      expect(res.homeScore).not.toBe(res.awayScore);
      injured += res.injuries.length;
      const dressed = { ...setup.home.players, ...setup.away.players };
      for (const i of res.injuries) expect(dressed[i.playerId]).toBeDefined();
    }
    expect(injured).toBeGreaterThan(0);
    const safe: GameSetup = { ...setup, ruleset: { ...setup.ruleset, injuries: false, fatigue: false } };
    for (let seed = 1; seed <= 20; seed++) {
      const res = fallbackSimulator({ ...safe, seed });
      expect(res.injuries).toEqual([]);
      expect(res.fatigue).toEqual({});
    }
  });

  it('keeps injured players out of the lineup', () => {
    const qb = fallbackLineup(setup.home).qb;
    expect(qb).not.toBeNull();
    const hurt = { ...setup.home.players, [qb!.id]: { ...qb!, injury: { bodyArea: 'upperBody' as const, severity: 'moderate' as const, weeksRemaining: 4, permanentPenalty: null, occurredYear: 2026, occurredWeek: 1 } } };
    const lineup = fallbackLineup({ ...setup.home, players: hurt });
    expect(lineup.qb?.id).not.toBe(qb!.id);
    expect(lineup.qb?.position).toBe('QB');
  });

  it('validateSimResult rejects unusable results', () => {
    expect(() => validateSimResult({ ...setup, isPlayoff: true }, { ...r, homeScore: 10, awayScore: 10 })).toThrow(/tied/);
    expect(() => validateSimResult(setup, { ...r, homeScore: -3 })).toThrow(/non-negative/);
    expect(() => validateSimResult(setup, { ...r, injuries: [{ playerId: 'p_ghost' as PlayerId, severity: 'minor', quarter: 1, playIndex: 1 }] })).toThrow(/unknown player/);
    const someone = Object.keys(setup.home.players)[0] as PlayerId;
    const bogus = { playerId: someone, severity: 'sprained' as never, quarter: 1, playIndex: 1 };
    expect(() => validateSimResult(setup, { ...r, injuries: [bogus] })).toThrow(/unknown severity/);
    expect(validateSimResult(setup, r)).toBe(r);
  });
});

describe('coordinatorOf', () => {
  it('finds the staff member in the role and leaves a vacant post empty', () => {
    const team = league.teams[aiGame.home];
    if (!team) throw new Error('no team');
    const oc = coordinatorOf(league, team, 'OC');
    expect(oc === null || oc.role === 'OC').toBe(true);
    const noStaff = { ...team, staffIds: team.staffIds.filter((id) => league.coaches[id]?.role !== 'DC') };
    expect(coordinatorOf(league, noStaff, 'DC')).toBeNull();
    expect(Object.values(league.teams).some((t) => coordinatorOf(league, t, 'OC') !== null)).toBe(true);
  });
});
