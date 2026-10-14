import { describe, expect, it } from 'vitest';
import { advanceLeagueWeek } from '@/franchise/season-loop';
import { fallbackSimulator } from '@/franchise/sim-fallback';
import { SimJob, changedPhase, estimateSteps } from '@/ui/franchise/shell/sim-job';
import { leagueAt, userOf } from './helpers';

describe('SimJob', () => {
  it('pre-simulates one game per step and matches advanceLeagueWeek exactly', () => {
    const league = leagueAt(31, 'regularSeason');
    const job = new SimJob(league, { kind: 'week' }, { simulator: fallbackSimulator });
    expect(job.done).toBe(false);
    let steps = 0;
    while (!job.step()) {
      steps++;
      expect(job.progress).toBeLessThan(1);
    }
    const r = job.result;
    expect(r.error).toBeNull();
    expect(r.weeks).toHaveLength(1);
    expect(steps).toBe(r.weeks[0]?.games.length);
    const direct = advanceLeagueWeek(league, { simulator: fallbackSimulator });
    const scores = (l: typeof league): string[] => l.season.schedule.filter((g) => g.result).map((g) => `${g.id}:${g.result?.homeScore}-${g.result?.awayScore}`);
    expect(scores(r.league)).toEqual(scores(direct.league));
    expect(r.league.season.week).toBe(league.season.week + 1);
    const played = Object.values(r.league.season.standings).filter((s) => s.wins + s.losses + s.ties > 0);
    expect(played.length).toBeGreaterThan(20);
    expect(league.season.week).toBe(1);
  }, 20000);

  it('runs to a phase, estimates its length and reports phase changes', () => {
    const league = leagueAt(31, 'preseason');
    expect(estimateSteps(league, { kind: 'phase', phase: 'regularSeason' })).toBe(league.settings.preseasonWeeks);
    const job = new SimJob(league, { kind: 'phase', phase: 'regularSeason' }, { simulator: fallbackSimulator });
    const r = job.runToEnd();
    expect(r.league.season.phase).toBe('regularSeason');
    expect(r.weeks.length).toBe(league.settings.preseasonWeeks);
    expect(changedPhase(league, r)).toBe(true);
    expect(new SimJob(r.league, { kind: 'phase', phase: 'regularSeason' }).done).toBe(true);
  });

  it('reports every finished week and phase step to onStep, and survives a throwing listener', () => {
    const league = leagueAt(31, 'preseason');
    const seen: { week: number; phase: string; kind: string }[] = [];
    const r = new SimJob(league, { kind: 'phase', phase: 'regularSeason' }, {
      simulator: fallbackSimulator,
      onStep: (l, kind) => {
        seen.push({ week: l.season.week, phase: l.season.phase, kind });
        throw new Error('listener failure');
      },
    }).runToEnd();
    expect(r.error).toBeNull();
    expect(seen).toHaveLength(r.weeks.length);
    expect(seen.every((x) => x.kind === 'week')).toBe(true);
    expect(seen.map((x) => x.week)).toEqual(r.weeks.map((w) => w.league.season.week));
    const awards = leagueAt(32, 'awards');
    const phases: string[] = [];
    new SimJob(awards, { kind: 'nextPhase' }, { onStep: (l, kind) => phases.push(`${kind}:${l.season.phase}`) }).runToEnd();
    expect(phases).toHaveLength(1);
    expect(phases[0]).toMatch(/^phase:/);
  });

  it('applies the user result to the first week only and never half-applies a cancelled week', () => {
    const league = leagueAt(31, 'regularSeason');
    const job = new SimJob(league, { kind: 'phase', phase: 'playoffs' }, { simulator: fallbackSimulator });
    job.step();
    job.step();
    job.cancel();
    expect(job.step()).toBe(true);
    const r = job.result;
    expect(r.cancelled).toBe(true);
    expect(r.weeks).toHaveLength(0);
    expect(r.league).toBe(league);
  });

  it('fails cleanly for a week outside the game phases and steps offseason phases', () => {
    const awards = leagueAt(32, 'awards');
    const week = new SimJob(awards, { kind: 'week' });
    expect(week.done).toBe(true);
    expect(week.result.error).toMatch(/No games/);
    const next = new SimJob(awards, { kind: 'nextPhase' }).runToEnd();
    expect(next.error).toBeNull();
    expect(next.phases).toHaveLength(1);
    expect(next.league.season.phase).toBe('offseason');
    expect(next.league.season.awards.length).toBeGreaterThan(0);
    expect(userOf(next.league)).toBe(userOf(awards));
  }, 30000);
});
