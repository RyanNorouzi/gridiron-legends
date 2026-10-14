/**
 * League group tabs of the franchise hub (group 'league'): Schedule (user schedule, scoreboard, box scores),
 * Standings (division, conference, playoff picture, bracket), Stats (leaders, team stats, advanced metrics),
 * Teams (every team's read-only page), History (record books, seasons, awards, All-Pro) and Hall of Fame
 * (inductees, watch list, career pages). The screens live in ./league/. Team links go through `fc.openTeam`,
 * which opens the one read-only TeamViewScreen (league/team-view.ts). The hub concatenates home/team/market/league
 * lists in HUB_GROUPS order.
 */
import type { HubTab } from './context';
import { latestClass } from './league/hof-model';
import { HallOfFameTab } from './league/hof-tab';
import { RecordsTab } from './league/records-tab';
import { ScheduleTab } from './league/schedule-tab';
import { StandingsTab } from './league/standings-tab';
import { StatsTab } from './league/stats-tab';
import { TeamsTab } from './league/teams-tab';

/** Hub tabs contributed by the league chain (group 'league'). */
export const leagueTabs: HubTab[] = [
  { id: 'league-schedule', label: 'Schedule', group: 'league', create: (fc) => new ScheduleTab(fc) },
  { id: 'league-standings', label: 'Standings', group: 'league', create: (fc) => new StandingsTab(fc) },
  { id: 'league-stats', label: 'Stats', group: 'league', create: (fc) => new StatsTab(fc) },
  { id: 'league-teams', label: 'Teams', group: 'league', create: (fc) => new TeamsTab(fc) },
  { id: 'league-history', label: 'History', group: 'league', create: (fc) => new RecordsTab(fc) },
  {
    id: 'league-hof', label: 'Hall of Fame', group: 'league',
    // A fresh class (inducted this league year) is flagged until the calendar rolls over.
    badge: (league) => {
      const cls = latestClass(league);
      return cls && cls.year === league.season.year ? String(cls.count) : null;
    },
    create: (fc) => new HallOfFameTab(fc),
  },
];
