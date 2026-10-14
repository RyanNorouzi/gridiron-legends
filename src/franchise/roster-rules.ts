/**
 * Roster rules the UI enforces before the user may move the calendar: roster size for the phase, every required
 * position staffed (teams/depth-chart STARTER_COUNTS), cap compliance for the league cap year and a usable depth
 * chart (teams/depth-chart validateDepthChart errors). `userRosterIssues` lists every finding with a severity:
 * 'blocking' issues stop season-loop.ts advanceLeaguePhase from leaving postDraft / trainingCamp (the roster the
 * season starts with) unless it is asked to auto-fix; 'warning' issues are advisory (e.g. a bloated roster in the
 * middle of the offseason, an injured starter). Pure queries.
 */
import type { TeamId } from '@/core/ids';
import { POSITIONS, type Player, type Position } from '@/players/types';
import { STARTER_COUNTS, validateDepthChart } from '@/teams/depth-chart';
import { capSpace, capYearFor } from './contracts';
import { OFFSEASON_ROSTER_EXTRA } from './roster';
import type { League, SeasonPhase } from './types';

/** Players a season roster may carry above settings.rosterSize (the 53-55 band). */
export const SEASON_ROSTER_SLACK = 2;

/** Phases whose roster must already be a legal season roster (final cuts are done). */
export const SEASON_ROSTER_PHASES: readonly SeasonPhase[] = ['postDraft', 'trainingCamp', 'preseason', 'regularSeason', 'playoffs'];

/** Phases the user cannot leave while blocking roster issues exist. */
export const ROSTER_GATED_PHASES: readonly SeasonPhase[] = ['postDraft', 'trainingCamp'];

/** Kinds of roster-rule findings. */
export type RosterRuleKind = 'rosterTooSmall' | 'rosterTooLarge' | 'emptyPosition' | 'overCap' | 'invalidDepthChart' | 'depthChartWarning' | 'unknownTeam';

/** One roster-rule finding for the UI. */
export interface RosterRuleIssue {
  kind: RosterRuleKind;
  /** 'blocking' stops the phase move out of ROSTER_GATED_PHASES; 'warning' is advisory. */
  severity: 'blocking' | 'warning';
  message: string;
  /** Position or depth slot involved, when any. */
  position?: string;
  /** Size of the problem: players missing/extra, dollars over the cap. */
  amount?: number;
}

/** Legal roster size band for a phase: [min, max] (min 0 before final cuts). */
export const rosterSizeBand = (league: Pick<League, 'settings'>, phase: SeasonPhase): [number, number] => {
  const size = league.settings.rosterSize;
  return SEASON_ROSTER_PHASES.includes(phase) ? [size, size + SEASON_ROSTER_SLACK] : [0, size + OFFSEASON_ROSTER_EXTRA];
};

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * Every roster-rule finding for a team at the league's current phase (default) or `phase`. Size, empty positions,
 * the cap and depth-chart errors are 'blocking' once the phase needs a season roster (postDraft onwards through
 * the playoffs); before that they are 'warning's the user has time to fix.
 */
export const userRosterIssues = (league: League, teamId: TeamId, phase: SeasonPhase = league.season.phase): RosterRuleIssue[] => {
  const team = league.teams[teamId];
  if (!team) return [{ kind: 'unknownTeam', severity: 'blocking', message: `unknown team ${teamId}` }];
  const strict = SEASON_ROSTER_PHASES.includes(phase);
  const level = (blocking: boolean): RosterRuleIssue['severity'] => (blocking && strict ? 'blocking' : 'warning');
  const issues: RosterRuleIssue[] = [];
  const roster = team.rosterIds.map((id) => league.players[id]).filter((p): p is Player => p !== undefined);
  const [min, max] = rosterSizeBand(league, phase);
  if (roster.length < min) issues.push({ kind: 'rosterTooSmall', severity: level(true), amount: min - roster.length, message: `${team.abbr} carries ${roster.length} players; sign ${plural(min - roster.length, 'player')} to reach ${min}` });
  if (roster.length > max) issues.push({ kind: 'rosterTooLarge', severity: level(true), amount: roster.length - max, message: `${team.abbr} carries ${roster.length} players; cut ${plural(roster.length - max, 'player')} to get to ${max}` });
  const counts = {} as Record<Position, number>;
  for (const pos of POSITIONS) counts[pos] = 0;
  for (const p of roster) if (!p.retired) counts[p.position] += 1;
  for (const pos of POSITIONS) {
    const need = STARTER_COUNTS[pos];
    if (counts[pos] < need) {
      issues.push({ kind: 'emptyPosition', severity: level(true), position: pos, amount: need - counts[pos], message: `${team.abbr} has ${counts[pos]} ${pos} on the roster; ${need} needed to field a lineup` });
    }
  }
  const year = capYearFor(league.year, phase);
  const space = capSpace(team, league.players, league.settings, year);
  if (space < 0) issues.push({ kind: 'overCap', severity: level(true), amount: -space, message: `${team.abbr} is $${Math.round(-space).toLocaleString('en-US')} over the ${year} cap` });
  for (const d of validateDepthChart(team.depthChart, roster)) {
    if (d.severity === 'error') issues.push({ kind: 'invalidDepthChart', severity: level(true), position: d.slot, message: `depth chart: ${d.message}` });
    else if (d.kind === 'injuredStarter') issues.push({ kind: 'depthChartWarning', severity: 'warning', position: d.slot, message: `depth chart: ${d.message}` });
  }
  return issues;
};

/** Only the issues that block a phase move. */
export const blockingRosterIssues = (league: League, teamId: TeamId, phase: SeasonPhase = league.season.phase): RosterRuleIssue[] =>
  userRosterIssues(league, teamId, phase).filter((i) => i.severity === 'blocking');

/** Blocking issues of the user team when the current phase is gated (empty otherwise, or without a user team). */
export const phaseRosterBlockers = (league: League): RosterRuleIssue[] =>
  league.userTeamId && ROSTER_GATED_PHASES.includes(league.season.phase) ? blockingRosterIssues(league, league.userTeamId) : [];
