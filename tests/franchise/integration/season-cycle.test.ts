/**
 * Two full franchise cycles end to end: createLeague -> advanceWeek through the regular season and playoffs with the
 * fallback simulator -> awards -> every offseason step through runOffseasonStep with the real re-signing, free
 * agency, draft and final-cut modules (offseason-deps.ts standardOffseasonDeps, the user's roster handled by the AI)
 * -> training camp -> startNewSeason, twice. Checks league integrity, rosters and the cap after camp, champions,
 * awards, records and the Hall of Fame, the draft, retirements, determinism and the save round trip. A second suite
 * plays two cycles through the game loop's public entry points (season-loop.ts advanceLeagueWeek /
 * advanceLeaguePhase: club layer, weekly development, in-season scouting, AI trades and offseason news wired in).
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { PlayerId, TeamId } from '@/core/ids';
import { createRng } from '@/core/rng';
import { createLeague, validateLeague } from '@/franchise';
import { AWARD_ORDER } from '@/franchise/awards';
import { capSpace, leagueCapYear } from '@/franchise/contracts';
import { hofCandidates } from '@/franchise/hall-of-fame';
import { runOffseasonStep } from '@/franchise/offseason';
import { standardOffseasonDeps } from '@/franchise/offseason-deps';
import { newsKindOf } from '@/franchise/offseason-events';
import { rosterErrors } from '@/franchise/roster';
import { advanceLeaguePhase, advanceLeagueWeek } from '@/franchise/season-loop';
import { fallbackSimulator } from '@/franchise/sim-fallback';
import type { DraftState, League } from '@/franchise/types';
import { advanceWeek, isGamePhase } from '@/franchise/week';
import { deserializeLeague, serializeLeague } from '@/save/serialize';

/** What one cycle looked like at its checkpoints. */
interface CycleSnapshot {
  year: number;
  /** League when the season reached the awards phase. */
  seasonEnd: League;
  /** Weeks advanced to get there. */
  weeks: number;
  /** The completed draft (captured before the rollover drops it). */
  draft: DraftState;
  /** Players retired in this offseason (offseasonFlags.retired). */
  retired: PlayerId[];
  /** League after camp and the year rollover (next preseason). */
  rolled: League;
  /** Every warning the offseason steps raised. */
  warnings: string[];
}

const deps = standardOffseasonDeps({ manageUserTeam: true });

/** Plays one season week by week, then runs every offseason step to the next preseason. */
const runCycle = (start: League, seed: number): CycleSnapshot => {
  let league = start;
  let weeks = 0;
  while (isGamePhase(league.season.phase)) {
    league = advanceWeek(league);
    weeks++;
    if (weeks > 40) throw new Error('season did not finish');
  }
  const seasonEnd = league;
  const rng = createRng(seed);
  const warnings: string[] = [];
  let draft: DraftState | null = null;
  let retired: PlayerId[] = [];
  for (let guard = 0; league.season.phase !== 'preseason'; guard++) {
    if (guard > 10) throw new Error(`offseason stuck in ${league.season.phase}`);
    const phase = league.season.phase;
    const step = runOffseasonStep(league, rng.fork(`step:${phase}`), deps);
    warnings.push(...step.warnings);
    league = step.league;
    if (phase === 'draft') draft = league.draft;
    if (phase === 'offseason') retired = [...(league.offseasonFlags?.retired ?? [])];
  }
  if (!draft) throw new Error('the draft step did not leave a draft');
  return { year: seasonEnd.year, seasonEnd, weeks, draft, retired, rolled: league, warnings };
};

const runTwoCycles = (seed: number): CycleSnapshot[] => {
  const first = runCycle(createLeague({ seed, userTeamAbbr: 'BOS' }), seed * 10 + 1);
  const second = runCycle(first.rolled, seed * 10 + 2);
  return [first, second];
};

const SEED = 21;
let cycles: CycleSnapshot[] = [];
let final: League;

const expectValid = (league: League): void => {
  expect(validateLeague(league)).toEqual([]);
  expect(rosterErrors(league)).toEqual([]);
};

describe('two full franchise cycles', () => {
  beforeAll(() => {
    cycles = runTwoCycles(SEED);
    final = cycles[1]!.rolled;
  }, 60_000);

  it('plays every season to a champion and rolls the year twice', () => {
    expect(cycles.map((c) => c.year)).toEqual([2026, 2027]);
    expect(final.year).toBe(2028);
    expect(final.season.phase).toBe('preseason');
    for (const c of cycles) {
      expect(c.seasonEnd.season.phase).toBe('awards');
      expect(c.seasonEnd.season.champion).not.toBeNull();
      expect(c.seasonEnd.season.schedule.every((g) => g.isPreseason || g.result !== null)).toBe(true);
      expect(c.warnings.filter((w) => /phase skipped/.test(w))).toEqual([]);
    }
    expect(final.history.map((h) => h.year)).toEqual([2026, 2027]);
    for (const [i, h] of final.history.entries()) {
      expect(h.champion).toBe(cycles[i]!.seasonEnd.season.champion);
      expect(h.runnerUp).not.toBe(h.champion);
    }
  });

  it('keeps the league valid at the end of every season and after every rollover', () => {
    for (const c of cycles) {
      expectValid(c.seasonEnd);
      expectValid(c.rolled);
    }
  });

  it('hands out every award each year', () => {
    for (const h of final.history) {
      expect(h.awards.map((a) => a.award).sort()).toEqual([...AWARD_ORDER].sort());
      for (const a of h.awards) {
        expect(a.year).toBe(h.year);
        expect(final.teams[a.teamId]).toBeDefined();
        if (a.award === 'COY') expect(a.coachId).not.toBeNull();
        else expect(a.playerId).not.toBeNull();
      }
      expect(h.mvp).toBe(h.awards.find((a) => a.award === 'MVP')?.playerId);
    }
  });

  it('keeps a record book and inducts every retiree who earned the Hall of Fame', () => {
    expect(final.records.length).toBeGreaterThan(0);
    for (const r of final.records) {
      expect(r.year).toBeGreaterThanOrEqual(2026);
      expect(r.year).toBeLessThanOrEqual(2027);
    }
    expect(hofCandidates(final, 1000).filter((c) => c.eligible)).toEqual([]);
    for (const h of final.hallOfFame) expect(final.retiredPlayers[h.playerId]).toBeDefined();
  });

  it('uses every draft pick and puts the rookies on rosters', () => {
    for (const c of cycles) {
      const d = c.draft;
      expect(d.year).toBe(c.year);
      expect(d.complete).toBe(true);
      expect(d.selections).toHaveLength(Object.keys(final.teams).length * final.settings.draftRounds);
      const after = c.rolled;
      for (const t of Object.values(after.teams)) expect(t.picks.some((p) => p.year <= c.year)).toBe(false);
      const onRoster = (id: PlayerId): boolean => (after.players[id]?.teamId ?? null) !== null;
      // Early picks always make the team; late-round picks compete with veterans at final cuts.
      for (const s of d.selections.filter((x) => x.pick.round <= 3)) expect(onRoster(s.playerId)).toBe(true);
      expect(d.selections.filter((s) => onRoster(s.playerId)).length / d.selections.length).toBeGreaterThan(0.7);
      for (const s of d.selections) {
        const p = after.players[s.playerId] ?? after.retiredPlayers[s.playerId];
        expect(p?.draft?.year).toBe(c.year);
        expect(p?.draft?.overall).toBe(s.pick.overall);
      }
    }
    const userId = final.userTeamId as TeamId;
    expect(final.teams[userId]!.rosterIds.some((id) => final.players[id]?.draft?.year === 2027)).toBe(true);
  });

  it('moves retirees into retiredPlayers', () => {
    for (const c of cycles) {
      expect(c.retired.length).toBeGreaterThan(0);
      for (const id of c.retired) {
        expect(c.rolled.players[id]).toBeUndefined();
        expect(c.rolled.retiredPlayers[id]?.retired).toBe(true);
        expect(c.rolled.retiredPlayers[id]?.teamId).toBeNull();
        expect(c.rolled.freeAgentIds).not.toContain(id);
      }
    }
    expect(Object.values(final.players).some((p) => p.retired)).toBe(false);
    const rostered = new Set(Object.values(final.teams).flatMap((t) => t.rosterIds));
    for (const id of Object.keys(final.retiredPlayers)) expect(rostered.has(id as PlayerId)).toBe(false);
  });

  it('settles every roster at 53-55 players and under the cap after camp', () => {
    for (const c of cycles) {
      const l = c.rolled;
      const year = leagueCapYear(l);
      expect(year).toBe(l.year);
      for (const t of Object.values(l.teams)) {
        expect(t.rosterIds.length, t.abbr).toBeGreaterThanOrEqual(53);
        expect(t.rosterIds.length, t.abbr).toBeLessThanOrEqual(55);
        expect(capSpace(t, l.players, l.settings, year), t.abbr).toBeGreaterThanOrEqual(0);
      }
    }
    expect(final.settings.salaryCap).toBeGreaterThan(cycles[0]!.seasonEnd.settings.salaryCap);
  });

  it('round-trips through the save format after each season', () => {
    for (const c of cycles) {
      for (const league of [c.seasonEnd, c.rolled]) {
        const text = serializeLeague(league);
        expect(serializeLeague(deserializeLeague(text))).toBe(text);
        expect(serializeLeague(deserializeLeague(serializeLeague(league, { compress: true })))).toBe(text);
      }
    }
    // Deep equality (not just canonical text) catches values JSON cannot keep, such as -0 or undefined fields.
    for (const league of [cycles[0]!.seasonEnd, final]) expect(deserializeLeague(serializeLeague(league))).toEqual(league);
  }, 60_000);

  it('is deterministic by seed', () => {
    const again = runTwoCycles(SEED);
    expect(serializeLeague(again[1]!.rolled)).toBe(serializeLeague(final));
    expect(serializeLeague(again[0]!.seasonEnd)).toBe(serializeLeague(cycles[0]!.seasonEnd));
  }, 60_000);
});

describe('franchise cycles with the club layer, in-season scouting and AI trades wired in', () => {
  it('keeps every week valid and ends each offseason with settled rosters', () => {
    let league = createLeague({ seed: 9, userTeamAbbr: 'BOS' });
    const rng = createRng(4);
    let trades = 0;
    let news = 0;
    for (const year of [2026, 2027]) {
      let classSize = 0;
      while (isGamePhase(league.season.phase)) {
        const { phase, week } = league.season;
        const before = league.pendingTrades.filter((t) => t.status === 'accepted').length;
        const r = advanceLeagueWeek(league, { rng: rng.fork(`week:${year}:${phase}:${week}`), simulator: fallbackSimulator });
        league = r.league;
        expect(r.brokenRecords).toEqual(r.events.flatMap((e) => (e.type === 'record' ? [{ record: e.record, previous: e.previous }] : [])));
        trades += Math.max(0, league.pendingTrades.filter((t) => t.status === 'accepted').length - before);
        // The class is opened when the regular season starts and scouted every regular-season week.
        if (league.season.phase === 'regularSeason') {
          expect(league.draft?.year).toBe(year);
          classSize = league.draft!.prospects.length;
        }
        expectValid(league);
      }
      expect(classSize).toBeGreaterThan(0);
      expect(league.season.champion).not.toBeNull();
      expect(league.events.some((e) => e.teamId === league.userTeamId && e.year === year)).toBe(true);
      while (league.season.phase !== 'preseason') {
        const phase = league.season.phase;
        const step = advanceLeaguePhase(league, rng.fork(`offseason:${year}:${phase}`), deps);
        expect(step.blockedBy).toEqual([]);
        expect(step.phase).toBe(phase);
        league = step.league;
        if (phase === 'draft') {
          expect(league.draft!.year).toBe(year);
          // the class scouted all season is the one drafted (selections + undrafted cover it)
          expect(league.draft!.selections.length + (league.draft!.undrafted?.length ?? 0)).toBe(classSize);
        }
      }
      news += league.events.filter((e) => newsKindOf(e) !== null && e.year === year).length;
      expectValid(league);
      const capYear = leagueCapYear(league);
      for (const t of Object.values(league.teams)) {
        expect(t.rosterIds.length, t.abbr).toBeGreaterThanOrEqual(53);
        expect(t.rosterIds.length, t.abbr).toBeLessThanOrEqual(55);
        expect(capSpace(t, league.players, league.settings, capYear), t.abbr).toBeGreaterThanOrEqual(0);
      }
    }
    expect(trades).toBeGreaterThan(0);
    // Offseason news (retirements, Hall of Fame, records, the user's picks) reached the user's feed.
    expect(news).toBeGreaterThan(0);
    const text = serializeLeague(league);
    expect(serializeLeague(deserializeLeague(text))).toBe(text);
  }, 60_000);
});
