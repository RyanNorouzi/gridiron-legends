/**
 * Team group tabs of the franchise hub (group 'team'): Roster, Depth Chart, Contracts & Cap, Staff,
 * Facilities & Finances and Playbook. Each tab's screen lives in ./team/; badges flag problems the user
 * should fix (blocking roster issues, depth-chart errors, a cap overage, staff vacancies, an available
 * facility upgrade). The hub concatenates home/team/market/league lists in HUB_GROUPS order.
 */
import { capStatus, leagueCapYear } from '@/franchise/contracts';
import { blockingRosterIssues } from '@/franchise/roster-rules';
import type { League } from '@/franchise/types';
import type { HubTab } from './context';
import { CapTab } from './team/cap-tab';
import { depthIssues } from './team/depth-model';
import { DepthTab } from './team/depth-tab';
import { facilityRows } from './team/facilities-model';
import { FacilitiesTab } from './team/facilities-tab';
import { PlaybookTab } from './team/playbook-tab';
import { RosterTab } from './team/roster-tab';
import { staffRows } from './team/staff-model';
import { StaffTab } from './team/staff-tab';

const user = (league: League): League['userTeamId'] => league.userTeamId;

/** Hub tabs contributed by the team chain (group 'team'). */
export const teamTabs: HubTab[] = [
  {
    id: 'team-roster', label: 'Roster', group: 'team',
    badge: (league) => {
      const id = user(league);
      const n = id ? blockingRosterIssues(league, id).length : 0;
      return n > 0 ? String(n) : null;
    },
    create: (fc) => new RosterTab(fc),
  },
  {
    id: 'team-depth', label: 'Depth Chart', group: 'team',
    badge: (league) => {
      const id = user(league);
      return id && depthIssues(league, id).some((i) => i.severity === 'error') ? '!' : null;
    },
    create: (fc) => new DepthTab(fc),
  },
  {
    id: 'team-cap', label: 'Contracts', group: 'team',
    badge: (league) => {
      const id = user(league);
      const team = id ? league.teams[id] : undefined;
      return team && !capStatus(team, league.players, league.settings, leagueCapYear(league)).compliant ? '!' : null;
    },
    create: (fc) => new CapTab(fc),
  },
  {
    id: 'team-staff', label: 'Staff', group: 'team',
    badge: (league) => {
      const id = user(league);
      const vacant = id ? staffRows(league, id).filter((r) => !r.coach).length : 0;
      return vacant > 0 ? String(vacant) : null;
    },
    create: (fc) => new StaffTab(fc),
  },
  {
    id: 'team-facilities', label: 'Facilities', group: 'team',
    badge: (league) => {
      const id = user(league);
      return id && facilityRows(league, id).some((r) => r.check.ok) ? '+' : null;
    },
    create: (fc) => new FacilitiesTab(fc),
  },
  { id: 'team-playbook', label: 'Playbook', group: 'team', create: (fc) => new PlaybookTab(fc) },
];
