import { beforeAll, describe, expect, it } from 'vitest';
import type { PlayerId, TeamId } from '@/core/ids';
import { canAdvancePhase, nextPhase, nextPhaseOf, openNextCapYear, phaseBlocker, phaseLabel, seasonLabel, startNewSeason } from '@/franchise/phase';
import {
  commitCareerStats, crownChampion, finalizeSeason, isSeasonFinalized, leagueLeaders, recordSeasonSummary, teamSeasonRecord,
} from '@/franchise/history';
import { validateLeague } from '@/franchise/league';
import { regularSeasonGames, validateSchedule } from '@/franchise/schedule';
import { advanceToPhase } from '@/franchise/week';
import type { DraftState, FreeAgencyState, League } from '@/franchise/types';
import { deserializeLeague, serializeLeague } from '@/save/serialize';
import { makeLeague, sumStandings, tinyPlayLog } from './helpers';

describe('labels and order', () => {
  it('labels phases and weeks', () => {
    const settings = makeLeague(2).settings;
    expect(phaseLabel('preseason', 2)).toBe('Preseason Week 2');
    expect(phaseLabel('regularSeason', 7)).toBe('Week 7');
    expect(phaseLabel('playoffs', 1, settings)).toBe('Wild Card');
    expect(phaseLabel('playoffs', 4, settings)).toBe('Championship');
    expect(phaseLabel('playoffs', 2)).toBe('Playoffs Round 2');
    expect(phaseLabel('resigning')).toBe('Re-signing');
    expect(phaseLabel('freeAgency')).toBe('Free Agency');
    expect(seasonLabel(makeLeague(2))).toBe('2026 Preseason Week 1');
  });

  it('walks SEASON_PHASE_ORDER and wraps', () => {
    expect(nextPhaseOf('preseason')).toBe('regularSeason');
    expect(nextPhaseOf('awards')).toBe('offseason');
    expect(nextPhaseOf('trainingCamp')).toBe('preseason');
  });
});

describe('guards', () => {
  const fresh = makeLeague(2);
  it('lets the preseason be skipped but not the regular season', () => {
    const skipped = nextPhase(fresh);
    expect(skipped.season).toMatchObject({ phase: 'regularSeason', week: 1 });
    expect(phaseBlocker(skipped)).toMatch(/272 regular-season game/);
    expect(canAdvancePhase(skipped)).toBe(false);
    expect(() => nextPhase(skipped)).toThrow(/cannot leave regularSeason/);
  });

  it('blocks an unfinished draft or free agency unless forced', () => {
    const fa: FreeAgencyState = { round: 1, maxRounds: 3, offers: [], signings: [] };
    const inFa: League = { ...fresh, freeAgency: fa, season: { ...fresh.season, phase: 'freeAgency', week: 0 } };
    expect(() => nextPhase(inFa)).toThrow(/free agency is still running/);
    expect(nextPhase(inFa, { force: true }).season.phase).toBe('draft');
    expect(() => nextPhase({ ...inFa, freeAgency: { ...fa, round: 3 } })).toThrow(/free agency is still running/);
    expect(nextPhase({ ...inFa, freeAgency: { ...fa, round: 4 } }).season.phase).toBe('draft');
    const draft: DraftState = { year: 2026, order: [], currentPickIndex: 0, prospects: [], selections: [], reports: {}, scouting: {}, userBoard: [], complete: false };
    const inDraft: League = { ...fresh, draft, season: { ...fresh.season, phase: 'draft', week: 0 } };
    expect(() => nextPhase(inDraft)).toThrow(/draft is not complete/);
    expect(nextPhase({ ...inDraft, draft: { ...draft, complete: true } }).season.phase).toBe('postDraft');
    expect(nextPhase(inDraft, { force: true }).season.phase).toBe('postDraft');
    expect(() => startNewSeason(fresh)).toThrow(/no champion/);
  });
});

describe('season close and rollover', () => {
  let awards: League;
  let offseason: League;
  let rolled: League;
  beforeAll(() => {
    awards = advanceToPhase(makeLeague(4), 'awards').league;
    const userGame = awards.season.schedule.find((g) => g.home === awards.userTeamId && !g.isPreseason);
    const staleGame = awards.season.schedule.find((g) => !g.isPlayoff && g.home !== awards.userTeamId && g.away !== awards.userTeamId);
    awards = { ...awards, playLogs: { [userGame!.id]: tinyPlayLog(), [staleGame!.id]: tinyPlayLog(), g_2019_rs01_01: tinyPlayLog() } };
    offseason = nextPhase(awards);
    let l = offseason;
    while (l.season.phase !== 'trainingCamp') l = nextPhase(l);
    rolled = nextPhase(l);
  });

  it('closes the books when leaving the awards phase', () => {
    expect(offseason.season.phase).toBe('offseason');
    expect(isSeasonFinalized(offseason)).toBe(true);
    const summary = offseason.history[0];
    expect(summary).toMatchObject({ year: 2026, champion: awards.season.champion });
    expect(summary?.runnerUp).not.toBe(summary?.champion);
    expect(Object.keys(summary?.standings ?? {})).toHaveLength(32);
    const champ = offseason.teams[awards.season.champion as TeamId];
    expect(champ?.history.at(-1)).toMatchObject({ year: 2026, madePlayoffs: true, champion: true, playoffResult: 'Won Championship' });
    const records = Object.values(offseason.teams).map((t) => t.history.at(-1));
    expect(records.filter((r) => r?.madePlayoffs)).toHaveLength(14);
    expect(records.filter((r) => !r?.madePlayoffs).every((r) => r?.playoffResult === null)).toBe(true);
    expect(records.filter((r) => r?.playoffResult?.startsWith('Lost'))).toHaveLength(13);
    const hc = champ?.headCoachId;
    if (hc) expect(offseason.coaches[hc]?.careerWins).toBe((awards.coaches[hc]?.careerWins ?? 0) + (champ?.history.at(-1)?.wins ?? 0));
  });

  it('grows the cap on entering the offseason (the cap year of next season), once', () => {
    expect(awards.settings.salaryCap).toBe(225_000_000);
    expect(offseason.settings.salaryCap).toBe(236_250_000);
    expect(offseason.settings.salaryCapYear).toBe(2027);
    expect(rolled.settings.salaryCap).toBe(236_250_000);
    expect(openNextCapYear(offseason)).toBe(offseason);
    // A league not yet stamped (an older save) grows once from its own cap.
    expect(openNextCapYear(awards).settings.salaryCap).toBe(236_250_000);
  });

  it('commits season stats into careers and checks career records', () => {
    const [id, line] = Object.entries(awards.season.stats)[0] as [PlayerId, (typeof awards.season.stats)[PlayerId]];
    const career = offseason.careerStats[id];
    expect(career?.seasons).toHaveLength(1);
    expect(career?.seasons[0]?.line).toEqual(line);
    expect(career?.totals).toEqual(line);
    expect(offseason.records.some((r) => r.scope === 'career')).toBe(true);
  });

  it('finalizeSeason is idempotent', () => {
    const again = finalizeSeason(offseason).league;
    expect(again.history).toEqual(offseason.history);
    expect(again.teams).toEqual(offseason.teams);
    expect(again.coaches).toEqual(offseason.coaches);
    expect(again.careerStats).toEqual(offseason.careerStats);
    expect(commitCareerStats(again).careerStats).toEqual(offseason.careerStats);
  });

  it('summarises teams and leaders', () => {
    const champ = awards.season.champion as TeamId;
    expect(teamSeasonRecord(awards, champ).champion).toBe(true);
    expect(recordSeasonSummary(awards).champion).toBe(champ);
    const top = leagueLeaders(awards.season, 'passing.yards', 5);
    expect(top).toHaveLength(5);
    expect(top[0]?.value).toBeGreaterThanOrEqual(top[4]?.value ?? 0);
    expect(leagueLeaders(awards.season, 'rushing.yards', 3, { playoffs: true })).toHaveLength(3);
    expect(() => recordSeasonSummary(makeLeague(4))).toThrow(/no champion/);
    const crowned = crownChampion(makeLeague(4), champ).league;
    expect(crowned.teams[champ]?.championships).toBe(1);
    expect(crowned.records.find((r) => r.key === 'team.championships')?.value).toBe(1);
  });

  it('rolls into a new season', () => {
    expect(rolled.year).toBe(2027);
    expect(rolled.season).toMatchObject({ year: 2027, phase: 'preseason', week: 1, champion: null, bracket: null, stats: {}, playoffStats: {} });
    expect(sumStandings(rolled.season.standings, 'wins')).toBe(0);
    expect(validateSchedule(rolled.season.schedule, rolled.teams, rolled.settings)).toEqual([]);
    expect(regularSeasonGames(rolled.season.schedule).every((g) => g.result === null && g.id.startsWith('g_2027_'))).toBe(true);
    expect(rolled.settings.salaryCap).toBe(236_250_000);
    for (const t of Object.values(rolled.teams)) {
      expect(t.picks.some((p) => p.year === 2026)).toBe(false);
      expect(t.picks.filter((p) => p.year === 2029 && p.originalTeamId === t.id)).toHaveLength(7);
      expect(new Set(t.picks.map((p) => p.year))).toEqual(new Set([2027, 2028, 2029]));
    }
    expect(rolled.history).toHaveLength(1);
    expect(Object.values(rolled.teams).every((t) => t.history.length === 1)).toBe(true);
    expect(rolled.draft).toBeNull();
    expect(rolled.freeAgency).toBeNull();
    expect(rolled.rngState).not.toEqual(awards.rngState);
  });

  it('prunes play logs and heals short injuries over the offseason', () => {
    const userGame = awards.season.schedule.find((g) => g.home === awards.userTeamId && !g.isPreseason);
    expect(Object.keys(rolled.playLogs)).toEqual([userGame?.id]);
    const hurtBefore = Object.values(awards.players).filter((p) => p.injury);
    expect(hurtBefore.length).toBeGreaterThan(0);
    for (const p of hurtBefore) {
      const after = rolled.players[p.id]?.injury ?? null;
      if ((p.injury?.weeksRemaining ?? 0) <= 24) expect(after).toBeNull();
      else expect(after?.weeksRemaining).toBe((p.injury?.weeksRemaining ?? 0) - 24);
    }
  });

  it('produces a valid, saveable league that can play the next season', () => {
    expect(validateLeague(rolled)).toEqual([]);
    expect(deserializeLeague(serializeLeague(rolled))).toEqual(rolled);
    const next = advanceToPhase(rolled, 'awards').league;
    expect(next.season.champion).not.toBeNull();
    const closed = nextPhase(next);
    expect(closed.history.map((h) => h.year)).toEqual([2026, 2027]);
    expect(Object.values(closed.careerStats).some((c) => c.seasons.length === 2)).toBe(true);
  });
});
