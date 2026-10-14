import { describe, expect, it } from 'vitest';
import type { GameId, PlayerId } from '@/core/ids';
import { buildGameSetup } from '@/franchise/game-setup';
import { gamesInWeek } from '@/franchise/schedule';
import { fallbackSimulator } from '@/franchise/sim-fallback';
import type { GameSimulator } from '@/franchise/sim-seam';
import type { League } from '@/franchise/types';
import { advanceWeekDetailed, clubAdjustedInjury } from '@/franchise/week';
import { createGameState } from '@/game/game-state';
import type { InjuryStatus } from '@/players/types';
import type { Facilities, Team } from '@/teams/types';
import { byAbbr, makeLeague } from './helpers';

const base = makeLeague(31);
const bos = byAbbr(base, 'BOS');
const week1 = gamesInWeek(base.season.schedule, 'regularSeason', 1);
const bosGame = week1.find((g) => g.home === bos.id || g.away === bos.id)!;
const qbId = bos.depthChart.QB[0]!;

const withPlayerMorale = (league: League, id: PlayerId, morale: number, confidence: number): League => {
  const p = league.players[id]!;
  return { ...league, players: { ...league.players, [id]: { ...p, morale: { ...p.morale, morale, confidence } } } };
};
const facilities = (level: number): Facilities => ({ training: level, medical: level, scouting: level, stadium: level, development: level, analytics: level });
const withTeam = (league: League, team: Team): League => ({ ...league, teams: { ...league.teams, [team.id]: team } });

describe('game setup: morale and carried fatigue', () => {
  it('hands the game morale-scaled copies of the players and never touches the League', () => {
    const low = withPlayerMorale(base, qbId, 0, 0);
    const high = withPlayerMorale(base, qbId, 100, 100);
    const lowP = buildGameSetup(low, bosGame);
    const highP = buildGameSetup(high, bosGame);
    const side = bosGame.home === bos.id ? 'home' : 'away';
    const original = low.players[qbId]!;
    const lowQb = lowP[side].players[qbId]!;
    const highQb = highP[side].players[qbId]!;
    expect(lowQb).not.toBe(original);
    expect(lowQb.attrs.throwAccuracy).toBeLessThan(original.attrs.throwAccuracy);
    expect(highQb.attrs.throwAccuracy).toBeGreaterThan(lowQb.attrs.throwAccuracy);
    expect(lowQb.attrs.injuryResistance).toBe(original.attrs.injuryResistance);
    expect(low.players[qbId]).toEqual(withPlayerMorale(base, qbId, 0, 0).players[qbId]);
    const plain = buildGameSetup(low, bosGame, { applyMorale: false });
    expect(plain[side].players[qbId]).toBe(original);
  });

  it('passes League.fatigue for the dressed players into the setup and the initial game state', () => {
    const tired: League = { ...base, fatigue: { [qbId]: 0.4, ['p_nobody' as PlayerId]: 0.9 } };
    const setup = buildGameSetup(tired, bosGame);
    expect(setup.fatigue).toEqual({ [qbId]: 0.4 });
    expect(createGameState(setup).fatigue[qbId]).toBeCloseTo(0.4);
    const off: League = { ...tired, settings: { ...tired.settings, fatigueEnabled: false } };
    expect(buildGameSetup(off, bosGame).fatigue).toBeUndefined();
    const noFatigueRules = { ...setup, ruleset: { ...setup.ruleset, fatigue: false } };
    expect(createGameState(noFatigueRules).fatigue[qbId]).toBe(0);
    expect(buildGameSetup(base, bosGame).fatigue).toBeUndefined();
  });
});

describe('week advance: medical center and strength staff shape injuries', () => {
  const status = (weeks: number): InjuryStatus => ({ bodyArea: 'lowerBody', severity: 'moderate', weeksRemaining: weeks, permanentPenalty: null, occurredYear: 2026, occurredWeek: 1 });
  const player = { id: qbId, teamId: bos.id };
  const atLevel = (level: number): League => withTeam(base, { ...bos, facilities: facilities(level) });

  it('never prevents an injury at medical level 1 and prevents a share of them at level 5', () => {
    const ids = Array.from({ length: 400 }, (_, i) => `g_med_${i}` as GameId);
    const prevented = (league: League): number => ids.filter((g) => clubAdjustedInjury(league, player, g, status(6)) === null).length;
    expect(prevented(atLevel(1))).toBe(0);
    const share = prevented(atLevel(5)) / ids.length;
    expect(share).toBeGreaterThan(0.07);
    expect(share).toBeLessThan(0.22);
  });

  it('shortens the weeks out with better medical facilities, never below one week', () => {
    const g = 'g_med_weeks' as GameId;
    const worst = clubAdjustedInjury(atLevel(1), player, g, status(10))!;
    const ids = Array.from({ length: 20 }, (_, i) => `g_w_${i}` as GameId);
    const best = ids.map((id) => clubAdjustedInjury(atLevel(5), player, id, status(10))).find((s) => s !== null)!;
    expect(best.weeksRemaining).toBeLessThan(worst.weeksRemaining);
    expect(worst.weeksRemaining).toBeLessThanOrEqual(10);
    expect(clubAdjustedInjury(atLevel(5), player, ids.find((id) => clubAdjustedInjury(atLevel(5), player, id, status(1)) !== null)!, status(1))!.weeksRemaining).toBe(1);
    // Free agents keep the injury as rolled.
    expect(clubAdjustedInjury(base, { id: qbId, teamId: null }, g, status(10))).toEqual(status(10));
  });

  it('applies the club adjustment to the injuries of a played week', () => {
    const hurtQb: GameSimulator = (setup, opts) => {
      const r = fallbackSimulator(setup, opts);
      return { ...r, injuries: setup.id === bosGame.id ? [{ playerId: qbId, severity: 'seasonEnding', quarter: 2, playIndex: 30 }] : [] };
    };
    const play = (level: number): { weeks: number | null; eventWeeks: number | null } => {
      const league: League = { ...atLevel(level), season: { ...base.season, phase: 'regularSeason', week: 1 } };
      const r = advanceWeekDetailed(league, { simulate: hurtQb });
      const ev = r.events.find((e) => e.type === 'injury' && e.playerId === qbId);
      return { weeks: r.league.players[qbId]!.injury?.weeksRemaining ?? null, eventWeeks: ev?.type === 'injury' ? ev.weeksOut : null };
    };
    const worst = play(1);
    const best = play(5);
    expect(worst.weeks).not.toBeNull();
    expect(worst.eventWeeks).toBe(worst.weeks);
    // Same rolls (the medical rolls use their own stream): the level-5 medical center prevents it or cuts the weeks.
    if (best.weeks !== null) expect(best.weeks).toBeLessThan(worst.weeks!);
    expect(best.eventWeeks).toBe(best.weeks);
  });
});
