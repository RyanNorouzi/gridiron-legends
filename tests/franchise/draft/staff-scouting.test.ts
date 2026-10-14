import { describe, expect, it } from 'vitest';
import { createRng } from '@/core/rng';
import type { CoachId, TeamId } from '@/core/ids';
import { createNamePool } from '@/players/names';
import { loadColleges, loadRegions } from '@/teams/data';
import type { Team } from '@/teams/types';
import { classScoutingBudget, createDraftState, weeklyScouting, openScouting } from '@/franchise/draft';
import { facilityEffects } from '@/franchise/facilities';
import { generateDraftClass } from '@/franchise/prospects';
import { generateReport, grantScoutingPoints, reportRng, scoutingEntry } from '@/franchise/scouting';
import { staffEffects } from '@/franchise/staff';
import type { League, Prospect } from '@/franchise/types';
import { makeLeague } from './helpers';

const withFacilities = (league: League, teamId: TeamId, scouting: number, analytics: number): League => {
  const t = league.teams[teamId] as Team;
  return { ...league, teams: { ...league.teams, [teamId]: { ...t, facilities: { ...t.facilities, scouting, analytics } } } };
};

const withScout = (league: League, team: Team, rating: number): League => {
  const coaches: League['coaches'] = { ...league.coaches };
  for (const id of team.staffIds) {
    const c = coaches[id];
    if (c && (c.role === 'Scout' || c.role === 'HC')) coaches[id as CoachId] = { ...c, ratings: { ...c.ratings, scouting: rating } };
  }
  return { ...league, coaches };
};

const prospects: Prospect[] = generateDraftClass(createRng(91), 2026, { teamCount: 32, draftRounds: 7 }, {
  colleges: loadColleges(), regions: loadRegions(), names: createNamePool(),
});

describe('scouting staff and facility bonuses', () => {
  it('open each class with a budget from the scouting facility and the staff scouting bonus', () => {
    const base = makeLeague(12);
    const id = (Object.keys(base.teams) as TeamId[]).sort()[0]!;
    const rich = withScout(withFacilities(base, id, 5, 1), base.teams[id]!, 95);
    const poor = withScout(withFacilities(base, id, 1, 1), base.teams[id]!, 10);
    const richTeam = rich.teams[id]!;
    expect(classScoutingBudget(rich, richTeam)).toBe(Math.round(facilityEffects(richTeam).scoutingPoints + staffEffects(rich, richTeam).scoutingBonus));
    expect(classScoutingBudget(rich, richTeam)).toBeGreaterThan(50);
    expect(classScoutingBudget(poor, poor.teams[id]!)).toBe(0);
    const draft = createDraftState(rich, createRng(3), { prospects });
    expect(scoutingEntry(draft, id).pointsAvailable).toBe(classScoutingBudget(rich, richTeam));
    expect(scoutingEntry(draft, id).accuracy).toBe(facilityEffects(richTeam).scoutingAccuracy);
  });

  it('records the analytics accuracy every week and rebuilds reports when it changes', () => {
    const base = makeLeague(12);
    const id = (Object.keys(base.teams) as TeamId[]).sort()[0]!;
    const opened = openScouting(withFacilities(base, id, 3, 1), createRng(4), { prospects });
    const before = opened.draft!.reports[id]!;
    const upgraded = withFacilities(opened, id, 3, 5);
    const week = weeklyScouting(upgraded, createRng(5));
    expect(scoutingEntry(week.draft!, id).accuracy).toBe(facilityEffects(upgraded.teams[id]!).scoutingAccuracy);
    const pid = prospects[0]!.player.id;
    expect(week.draft!.reports[id]![pid]!.confidence).toBeGreaterThanOrEqual(before[pid]!.confidence);
    const same = grantScoutingPoints(week.draft!, id, 1, scoutingEntry(week.draft!, id).scoutQuality ?? 50);
    expect(scoutingEntry(same, id).accuracy).toBe(scoutingEntry(week.draft!, id).accuracy);
  });

  it('analytics accuracy tightens reports: smaller errors, narrower ranges, higher confidence', () => {
    const err = (accuracy: number): { err: number; width: number; conf: number } => {
      let e = 0;
      let w = 0;
      let c = 0;
      for (const p of prospects) {
        const r = generateReport(reportRng(9, 't_x' as TeamId, p.player.id), p, 10, 50, false, { bias: 1.6, accuracy });
        e += Math.abs((r.overallRange[0] + r.overallRange[1]) / 2 - p.player.overall);
        w += r.overallRange[1] - r.overallRange[0];
        c += r.confidence;
      }
      return { err: e / prospects.length, width: w / prospects.length, conf: c / prospects.length };
    };
    const none = err(0);
    const best = err(facilityEffects({ facilities: { training: 1, medical: 1, scouting: 1, stadium: 1, development: 1, analytics: 5 } }).scoutingAccuracy);
    expect(best.err).toBeLessThan(none.err * 0.92);
    expect(best.width).toBeLessThan(none.width);
    expect(best.conf).toBeGreaterThan(none.conf);
  });
});
