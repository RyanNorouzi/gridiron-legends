import { describe, expect, it } from 'vitest';
import { leagueCapYear } from '@/franchise/contracts';
import type { League } from '@/franchise/types';
import { teamTabs } from '@/ui/franchise/tabs-team';
import { CapTab } from '@/ui/franchise/team/cap-tab';
import { DepthTab } from '@/ui/franchise/team/depth-tab';
import { FacilitiesTab } from '@/ui/franchise/team/facilities-tab';
import { PlaybookTab } from '@/ui/franchise/team/playbook-tab';
import { RosterTab } from '@/ui/franchise/team/roster-tab';
import { StaffTab } from '@/ui/franchise/team/staff-tab';
import { fireStaff, incumbent } from '@/ui/franchise/team/staff-model';
import { createTestFranchiseContext } from '@/ui/franchise/context';
import { baseLeague, inPhase, rcFor, userId } from './helpers';

const tab = (id: string): (typeof teamTabs)[number] => {
  const t = teamTabs.find((x) => x.id === id);
  if (!t) throw new Error(id);
  return t;
};

describe('team hub tabs', () => {
  it('registers six team tabs that build their screens', () => {
    expect(teamTabs.map((t) => t.id)).toEqual(['team-roster', 'team-depth', 'team-cap', 'team-staff', 'team-facilities', 'team-playbook']);
    expect(teamTabs.every((t) => t.group === 'team')).toBe(true);
    expect(new Set(teamTabs.map((t) => t.id)).size).toBe(teamTabs.length);
    const league = baseLeague();
    const fc = createTestFranchiseContext(league);
    const kinds = [RosterTab, DepthTab, CapTab, StaffTab, FacilitiesTab, PlaybookTab];
    teamTabs.forEach((t, i) => {
      const screen = t.create(fc);
      expect(screen).toBeInstanceOf(kinds[i] as never);
      fc.stack.push(screen);
      screen.render(rcFor(fc));
      fc.stack.pop();
      expect(t.available?.(league) ?? true).toBe(true);
    });
  });
  it('badges problems the user should fix', () => {
    const league = baseLeague();
    const team = userId(league);
    for (const t of teamTabs) expect(t.badge?.(league) ?? null).toBeNull();
    const t = league.teams[team];
    if (!t) throw new Error('team');
    const year = leagueCapYear(league);
    const broken: League = {
      ...league,
      teams: { ...league.teams, [team]: { ...t, rosterIds: t.rosterIds.slice(0, 45), depthChart: { ...t.depthChart, QB: [] }, finances: { ...t.finances, deadMoney: { [year]: league.settings.salaryCap } } } },
    };
    expect(tab('team-roster').badge?.(broken)).not.toBeNull();
    expect(tab('team-depth').badge?.(broken)).toBe('!');
    expect(tab('team-cap').badge?.(broken)).toBe('!');
    const oc = incumbent(league, team, 'OC');
    if (!oc) throw new Error('oc');
    expect(tab('team-staff').badge?.(fireStaff(league, team, oc.id).league)).toBe('1');
    const off = inPhase(league, 'offseason');
    expect(tab('team-facilities').badge?.(off)).toBe('+');
    expect(tab('team-roster').badge?.({ ...league, userTeamId: null })).toBeNull();
  });
});
