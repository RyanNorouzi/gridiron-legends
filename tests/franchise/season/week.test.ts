import { beforeAll, describe, expect, it } from 'vitest';
import type { GameId, PlayerId, TeamId } from '@/core/ids';
import { createRng } from '@/core/rng';
import { gamesInWeek, regularSeasonGames } from '@/franchise/schedule';
import { LEAGUE_SIM_QUARTER_SEC, scheduleWeekCount } from '@/franchise/settings';
import { buildGameSetup } from '@/franchise/game-setup';
import { fallbackSimulator } from '@/franchise/sim-fallback';
import type { GameSimulator } from '@/franchise/sim-seam';
import {
  advanceToPhase, advanceWeek, advanceWeekDetailed, gamesThisWeek, injuryFromSeverity, isGamePhase, keepsPlayLog, recordUserGameResult,
  storedPlayLog, userGameThisWeek, type WeekEvent,
} from '@/franchise/week';
import { validateLeague } from '@/franchise/league';
import type { League } from '@/franchise/types';
import type { PlayLogEntry } from '@/game/types';
import type { ReviewKind } from '@/game/play-events';
import { delta } from '@/statistics/apply';
import { deserializeLeague, serializeLeague } from '@/save/serialize';
import { WEAR_TUNING } from '@/franchise/wear';
import { makeLeague, sumStandings, tinyPlayLog } from './helpers';

const countBy = (events: readonly WeekEvent[]): Record<string, number> =>
  events.reduce<Record<string, number>>((m, e) => ({ ...m, [e.type]: (m[e.type] ?? 0) + 1 }), {});

describe('a full season with the fallback simulator', () => {
  let start: League;
  let end: League;
  let events: WeekEvent[] = [];
  const injurySnapshots: Map<PlayerId, number>[] = [];
  let afterPreseason: League;

  beforeAll(() => {
    start = makeLeague(5);
    let league = start;
    for (let i = 0; i < 40 && isGamePhase(league.season.phase); i++) {
      const r = advanceWeekDetailed(league);
      events.push(...r.events);
      league = r.league;
      if (league.season.phase === 'regularSeason' && league.season.week === 1) afterPreseason = league;
      injurySnapshots.push(new Map(Object.values(league.players).filter((p) => p.injury).map((p) => [p.id, p.injury?.weeksRemaining ?? 0])));
    }
    end = league;
  });

  it('ends in the awards phase with a crowned champion', () => {
    expect(end.season.phase).toBe('awards');
    expect(end.season.week).toBe(0);
    const champ = end.season.champion as TeamId;
    expect(champ).not.toBeNull();
    expect(end.season.bracket?.champion).toBe(champ);
    expect(end.teams[champ]?.championships).toBe(1);
    expect(Object.values(end.teams).reduce((a, t) => a + t.championships, 0)).toBe(1);
    const hc = end.teams[champ]?.headCoachId;
    if (hc) expect(end.coaches[hc]?.championships).toBe((start.coaches[hc]?.championships ?? 0) + 1);
    expect(end.season.schedule.every((g) => g.result !== null || g.isPreseason)).toBe(true);
    expect(end.season.schedule.filter((g) => g.isPlayoff)).toHaveLength(13);
  });

  it('keeps the standings balanced and complete', () => {
    const s = end.season.standings;
    expect(sumStandings(s, 'wins')).toBe(sumStandings(s, 'losses'));
    expect(sumStandings(s, 'pointsFor')).toBe(sumStandings(s, 'pointsAgainst'));
    for (const st of Object.values(s)) expect(st.wins + st.losses + st.ties).toBe(17);
    const regular = regularSeasonGames(end.season.schedule);
    expect(sumStandings(s, 'pointsFor')).toBe(regular.reduce((a, g) => a + (g.result?.homeScore ?? 0) + (g.result?.awayScore ?? 0), 0));
  });

  it('accumulates regular-season, playoff and team stats', () => {
    const stats = Object.values(end.season.stats);
    expect(stats.length).toBeGreaterThan(32 * 20);
    expect(Math.max(...stats.map((l) => l.passing.yards))).toBeGreaterThan(2500);
    expect(Math.max(...stats.map((l) => l.gamesPlayed))).toBe(17);
    expect(Object.keys(end.season.playoffStats).length).toBeGreaterThan(100);
    const teamPoints = Object.values(end.season.teamStats).reduce((a, t) => a + t.points, 0);
    expect(teamPoints).toBe(sumStandings(end.season.standings, 'pointsFor'));
    expect(Object.keys(afterPreseason.season.stats)).toHaveLength(0);
    expect(sumStandings(afterPreseason.season.standings, 'wins')).toBe(0);
    expect(afterPreseason.season.schedule.filter((g) => g.isPreseason).every((g) => g.result !== null)).toBe(true);
  });

  it('populates game, season, live career and team records', () => {
    const scopes = new Set(end.records.map((r) => r.scope));
    // Career marks now track committed careers plus the season so far every week (SIMHUNT-5: the Career page
    // showed last season's values until rollover), so the first season's book holds career records too.
    expect(scopes).toEqual(new Set(['game', 'season', 'career', 'team']));
    const season = end.records.find((r) => r.key === 'passingYards.season');
    expect(season?.value).toBe(Math.max(...Object.values(end.season.stats).map((l) => l.passing.yards)));
    expect(end.records.find((r) => r.key === 'team.championships')?.holderTeamId).toBe(end.season.champion);
    expect(events.some((e) => e.type === 'record')).toBe(true);
    // The league's first season only sets running bests: none of them is a headline.
    expect(events.filter((e) => e.type === 'record' && e.headline)).toEqual([]);
  });

  it('injures players and counts injuries down week by week', () => {
    expect(events.filter((e) => e.type === 'injury').length).toBeGreaterThan(50);
    expect(events.filter((e) => e.type === 'recovered').length).toBeGreaterThan(20);
    let checked = 0;
    for (let w = 0; w + 1 < injurySnapshots.length; w++) {
      const now = injurySnapshots[w] as Map<PlayerId, number>, next = injurySnapshots[w + 1] as Map<PlayerId, number>;
      for (const [id, weeks] of now) {
        if (weeks < 2 || !next.has(id)) continue;
        const later = next.get(id) as number;
        if (later <= weeks) {
          expect(later).toBe(weeks - 1);
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(10);
    const hurt = Object.values(end.players).filter((p) => p.injury);
    expect(hurt.every((p) => p.injury && p.injury.occurredYear === 2026)).toBe(true);
    expect(Object.values(end.players).some((p) => p.injuryHistory.length > 0)).toBe(true);
  });

  it('emits results, phase changes, playoff and clinch events', () => {
    const c = countBy(events);
    expect(c.gameResult).toBe(end.season.schedule.length);
    expect(c.phaseChange).toBe(3);
    expect(c.playoffsSet).toBe(1);
    expect(c.playoffAdvance).toBe(13);
    expect(c.champion).toBe(1);
    expect(c.clinch).toBeGreaterThan(0);
    expect(events.filter((e) => e.type === 'gameResult' && e.userGame).length).toBe(3 + 17 + end.season.schedule.filter((g) => g.isPlayoff && (g.home === end.userTeamId || g.away === end.userTeamId)).length);
  });

  it('leaves a valid league that survives a save round trip', () => {
    expect(validateLeague(end)).toEqual([]);
    const restored = deserializeLeague(serializeLeague(end));
    expect(restored).toEqual(end);
  });

  it('does not mutate earlier league states', () => {
    expect(Object.keys(start.season.stats)).toHaveLength(0);
    expect(start.season.schedule.every((g) => g.result === null)).toBe(true);
    expect(sumStandings(start.season.standings, 'wins')).toBe(0);
    expect(Object.values(start.players).every((p) => p.injury === null)).toBe(true);
  });

  it('refuses to advance outside game phases', () => {
    expect(() => advanceWeek(end)).toThrow(/awards phase/);
    expect(gamesThisWeek(end)).toEqual([]);
  });
});

describe('week mechanics', () => {
  const base = makeLeague(9);
  const inRegular = advanceToPhase(base, 'regularSeason').league;

  it('is deterministic by seed and independent of callbacks', () => {
    const a = advanceWeek(advanceWeek(inRegular));
    const seen: string[] = [];
    const b = advanceWeek(advanceWeek(inRegular, { onGame: (g) => seen.push(g.id) }), { onEvent: () => undefined });
    expect(b).toEqual(a);
    expect(seen).toHaveLength(16);
    expect(advanceWeek(advanceToPhase(makeLeague(10), 'regularSeason').league)).not.toEqual(advanceWeek(inRegular));
  });

  it('advances the League rng unless an explicit rng is supplied', () => {
    const own = advanceWeek(inRegular);
    expect(own.rngState).not.toEqual(inRegular.rngState);
    const injected = advanceWeek(inRegular, { rng: createRng(1) });
    expect(injected.rngState).toEqual(inRegular.rngState);
  });

  it('stores a live user result and applies it when the week advances', () => {
    const game = userGameThisWeek(inRegular);
    expect(game).not.toBeNull();
    const g = game!;
    const sim = fallbackSimulator(buildGameSetup(inRegular, g));
    // A live result arrives without line teams (the in-game GameState does not know them): recording stamps them.
    const { playerTeams: _noTeams, ...liveStats } = sim.stats;
    const live = { ...sim, stats: liveStats, homeScore: sim.stats.teams.home.points, playLog: tinyPlayLog() };
    const recorded = recordUserGameResult(inRegular, g.id, live);
    const stored = recorded.season.schedule.find((x) => x.id === g.id)?.result;
    expect(stored?.playLogId).toBe(g.id);
    const setup = buildGameSetup(inRegular, g);
    for (const pid of Object.keys(stored!.stats.players) as PlayerId[]) {
      expect(stored!.stats.playerTeams?.[pid]).toBe(pid in setup.home.players ? g.home : g.away);
    }
    expect(recorded.playLogs[g.id]).toHaveLength(1);
    expect(recorded.season.standings).toEqual(inRegular.season.standings);
    const simulated: string[] = [];
    const spy: GameSimulator = (setup, opts) => {
      simulated.push(setup.id);
      return fallbackSimulator(setup, opts);
    };
    const after = advanceWeek(recorded, { simulate: spy });
    expect(simulated).not.toContain(g.id);
    expect(simulated).toHaveLength(15);
    const final = after.season.schedule.find((x) => x.id === g.id)?.result;
    expect(final?.homeScore).toBe(live.homeScore);
    const userId = inRegular.userTeamId as TeamId;
    expect((after.season.standings[userId]?.wins ?? 0) + (after.season.standings[userId]?.losses ?? 0) + (after.season.standings[userId]?.ties ?? 0)).toBe(1);
    expect(() => recordUserGameResult(recorded, g.id, live)).toThrow(/already has a result/);
    expect(() => recordUserGameResult(inRegular, 'g_nope' as GameId, live)).toThrow(/unknown game/);
    const later = gamesInWeek(inRegular.season.schedule, 'regularSeason', 3)[0];
    expect(() => recordUserGameResult(inRegular, later!.id, live)).toThrow(/not scheduled this week/);
  });

  it('stores the quarter length each game was played at: live length for the user, simulated length for the rest', () => {
    const short = { ...inRegular, settings: { ...inRegular.settings, ruleset: { ...inRegular.settings.ruleset, quarterLengthSec: 300 } } };
    const g = userGameThisWeek(short)!;
    const sim = fallbackSimulator(buildGameSetup(short, g));
    const recorded = recordUserGameResult(short, g.id, sim);
    expect(recorded.season.schedule.find((x) => x.id === g.id)?.result?.quarterLengthSec).toBe(300);
    const explicit = recordUserGameResult(short, g.id, { ...sim, quarterLengthSec: 120 });
    expect(explicit.season.schedule.find((x) => x.id === g.id)?.result?.quarterLengthSec).toBe(120);
    const after = advanceWeek(recorded);
    const week1 = after.season.schedule.filter((x) => x.week === g.week && !x.isPreseason && x.result);
    expect(week1.length).toBeGreaterThan(1);
    for (const x of week1) expect(x.result?.quarterLengthSec).toBe(x.id === g.id ? 300 : LEAGUE_SIM_QUARTER_SEC);
  });

  it("can require the user's game to be played live first", () => {
    expect(() => advanceWeek(inRegular, { userGame: 'require' })).toThrow(/must be played first/);
  });

  it('keeps play-by-play only for user and playoff games', () => {
    const withLogs: GameSimulator = (setup, opts) => ({ ...fallbackSimulator(setup, opts), playLog: tinyPlayLog() });
    const after = advanceWeek(inRegular, { simulate: withLogs });
    const week = gamesInWeek(after.season.schedule, 'regularSeason', 1);
    for (const g of week) {
      const keep = keepsPlayLog(after, g);
      expect(g.result?.playLogId ?? null).toBe(keep ? g.id : null);
      expect(g.id in after.playLogs).toBe(keep);
    }
    expect(Object.keys(after.playLogs)).toHaveLength(week.filter((g) => keepsPlayLog(after, g)).length);
  });

  const CALL_KIND: ReviewKind = 'catch';
  it('stores play logs without per-play stat deltas and fatigue maps (the box score holds the stats)', () => {
    const heavy = (): PlayLogEntry[] => tinyPlayLog().map((e) => {
      const outcome = { ...e.outcome, stats: [delta(e.outcome.ballCarrierId ?? ('p_x' as PlayerId), 'rushing.yards', 4)], fatigueAfter: { ['p_x' as PlayerId]: 0.2 } };
      return { ...e, outcome: { ...outcome, review: { call: { kind: CALL_KIND, tick: 10, athleteId: null, confidence: 0.6 }, ifOverturned: { ...outcome, review: null } } } };
    });
    const after = advanceWeek(inRegular, { simulate: (setup, opts) => ({ ...fallbackSimulator(setup, opts), playLog: heavy() }) });
    const kept = Object.values(after.playLogs);
    expect(kept.length).toBeGreaterThan(0);
    for (const log of kept) {
      const e = log[0]!;
      expect(e.outcome.stats).toEqual([]);
      expect(e.outcome.fatigueAfter).toEqual({});
      expect(e.outcome.review?.ifOverturned.stats).toEqual([]);
      expect(e.outcome.review?.ifOverturned.fatigueAfter).toEqual({});
      expect({ ...e, outcome: { ...e.outcome, review: null } }).toEqual({ ...heavy()[0]!, outcome: { ...heavy()[0]!.outcome, stats: [], fatigueAfter: {}, review: null } });
    }
    expect(storedPlayLog(heavy())).toEqual(Object.values(after.playLogs)[0]);
  });

  it('rejects simulator results that break the rules', () => {
    const cheat: GameSimulator = (setup) => ({ ...fallbackSimulator(setup), homeScore: -1 });
    expect(() => advanceWeek(inRegular, { simulate: cheat })).toThrow(/invalid result/);
  });

  it('carries season wear from the snaps (not the end-of-game fatigue) only when fatigue is enabled', () => {
    // End-of-game exhaustion is shed over a week of rest; only the workload's wear carries (wear.ts).
    const tired: GameSimulator = (setup) => {
      const r = fallbackSimulator(setup);
      const fatigue = Object.fromEntries(Object.keys(setup.home.players).slice(0, 3).map((id) => [id, 1]));
      return { ...r, fatigue };
    };
    const on = advanceWeek(inRegular, { simulate: tired });
    const worn = Object.entries(on.fatigue ?? {});
    expect(worn.length).toBeGreaterThan(100);
    expect(worn.every(([, f]) => f > 0 && f <= WEAR_TUNING.max)).toBe(true);
    const { fatigue: _dropped, ...withoutFatigue } = inRegular;
    expect(Object.keys(_dropped ?? {}).length).toBeGreaterThan(0); // preseason snaps already left some wear
    const offLeague: League = { ...withoutFatigue, settings: { ...inRegular.settings, fatigueEnabled: false } };
    expect(advanceWeek(offLeague, { simulate: tired }).fatigue).toBeUndefined();
  });

  it('turns an in-game injury into a franchise injury record', () => {
    const rng = createRng(4);
    const minor = injuryFromSeverity(rng, 'minor', 2026, 3);
    expect(minor.weeksRemaining).toBeLessThanOrEqual(1);
    expect(minor.permanentPenalty).toBeNull();
    const severe = injuryFromSeverity(rng, 'careerThreatening', 2026, 3);
    expect(severe.weeksRemaining).toBeGreaterThanOrEqual(24);
    expect(Object.values(severe.permanentPenalty ?? {}).every((v) => v < 0)).toBe(true);
    expect(severe).toMatchObject({ occurredYear: 2026, occurredWeek: 3, severity: 'careerThreatening' });
  });

  it('moves from the last regular-season week straight into seeded playoffs', () => {
    const last = scheduleWeekCount(inRegular.settings);
    const r = advanceToPhase(inRegular, 'playoffs');
    expect(r.league.season.phase).toBe('playoffs');
    expect(r.league.season.week).toBe(1);
    expect(r.events.filter((e) => e.type === 'gameResult')).toHaveLength(272);
    expect(new Set(r.games.map((g) => g.week)).size).toBe(last);
    expect(gamesThisWeek(r.league)).toHaveLength(6);
  });
});
