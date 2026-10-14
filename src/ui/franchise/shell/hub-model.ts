/**
 * Pure view-models of the franchise hub: the header (team, record, date, cash, cap space, fan support), the
 * context-aware Advance options (play / sim the week, sim to a later point of the season, move an offseason
 * phase) and the user-roster blockers the hub shows before it moves the calendar. No drawing, no stack.
 */
import type { GameId, TeamId } from '@/core/ids';
import { capSpace, leagueCapYear } from '@/franchise/contracts';
import { userSideOf } from '@/franchise/game-setup';
import { nextPhaseOf, phaseLabel as seasonPhaseLabel } from '@/franchise/phase';
import { aliveTeams } from '@/franchise/playoffs';
import { userRosterIssues, type RosterRuleIssue } from '@/franchise/roster-rules';
import type { League, SeasonPhase } from '@/franchise/types';
import { isGamePhase, userGameThisWeek } from '@/franchise/week';
import type { HubTab } from '../context';
import { formatMoney, formatRecord, type Tone, type ToneText } from '../kit/format';
import type { SimTarget } from './sim-job';

/** Franchise = endless seasons with saves; season = one season ending at the championship. */
export type HubMode = 'franchise' | 'season';

/** Hub header view-model. */
export interface HubHeaderView {
  teamId: TeamId;
  abbr: string;
  teamName: string;
  /** Team name without the city (narrow headers, large text). */
  nickname?: string;
  logoSeed: number;
  colors: { primary: string; secondary: string; accent: string; helmet: string };
  record: string;
  /** "2026 Week 5" / "2026 Wild Card" / "2026 Free Agency". */
  date: string;
  phase: SeasonPhase;
  cash: ToneText;
  capSpace: ToneText;
  fans: ToneText;
}

/** The user team's current-season record text (preseason and offseason show the regular-season record). */
export const teamRecordText = (league: League, teamId: TeamId): string => {
  const s = league.season.standings[teamId];
  return s ? formatRecord(s) : '0-0';
};

/** "2026 Week 5" style date for the league's current point in time. */
export const leagueDateText = (league: League): string =>
  `${league.season.year} ${seasonPhaseLabel(league.season.phase, league.season.week, league.settings)}`;

/** Builds the hub header. Throws for an unknown team. */
export const hubHeader = (league: League, teamId: TeamId): HubHeaderView => {
  const team = league.teams[teamId];
  if (!team) throw new Error(`hubHeader: unknown team ${teamId}`);
  const space = capSpace(team, league.players, league.settings, leagueCapYear(league));
  const cash = team.finances.cash;
  const support = Math.round(team.fans.support);
  const fanTone: Tone = support >= 70 ? 'success' : support >= 40 ? 'normal' : support >= 25 ? 'warning' : 'danger';
  return {
    teamId, abbr: team.abbr, teamName: `${team.city} ${team.name}`, nickname: team.name, logoSeed: team.logoSeed, colors: { ...team.colors },
    record: teamRecordText(league, teamId), date: leagueDateText(league), phase: league.season.phase,
    cash: { text: formatMoney(cash), tone: cash < 0 ? 'danger' : 'normal' },
    capSpace: { text: formatMoney(space), tone: space < 0 ? 'danger' : space < league.settings.minimumSalary * 3 ? 'warning' : 'success' },
    fans: { text: String(support), tone: fanTone },
  };
};

/* ------------------------------------ advance ------------------------------------ */

/** What choosing an Advance option does. */
export type AdvanceAction =
  | { kind: 'play'; gameId: GameId }
  /** `autoFix`: roster blockers are fixed automatically along the way (the offseason "roster moves automated" sim). */
  | { kind: 'sim'; target: SimTarget; autoFix?: boolean }
  | { kind: 'summary' };

/** One entry of the Advance menu. */
export interface AdvanceOption {
  id: string;
  label: string;
  detail: string;
  action: AdvanceAction;
}

/** The label of the current game week ("Week 5", "Preseason Week 2", "Wild Card"). */
export const weekLabel = (league: League): string => seasonPhaseLabel(league.season.phase, league.season.week, league.settings);

/**
 * Advance options for the league's current point (first = the default):
 * - game weeks: Play (the user's unplayed game) and Sim for this week, then "sim to" the regular season / end of
 *   the regular season / end of the playoffs (and, in franchise mode, through the offseason);
 * - awards: the season summary in season mode, else the next phase;
 * - offseason phases: "Next: <phase>" and "Sim through offseason".
 */
export const advanceOptions = (league: League, teamId: TeamId, mode: HubMode = 'franchise'): AdvanceOption[] => {
  const s = league.season;
  const out: AdvanceOption[] = [];
  const simTo = (phase: SeasonPhase, label: string, detail: string, autoFix = false): void => {
    if (s.phase !== phase) out.push({ id: `simTo:${phase}`, label, detail, action: { kind: 'sim', target: { kind: 'phase', phase }, ...(autoFix ? { autoFix } : {}) } });
  };
  if (isGamePhase(s.phase)) {
    const wk = weekLabel(league);
    const game = userGameThisWeek(league);
    if (game && !game.result) {
      const side = userSideOf(league, game);
      const opp = league.teams[side === 'home' ? game.away : game.home];
      const where = side === 'home' ? 'vs' : 'at';
      out.push({ id: 'play', label: `Play ${wk} ${where} ${opp?.abbr ?? '?'}`, detail: 'Go to game day', action: { kind: 'play', gameId: game.id } });
      out.push({ id: 'simWeek', label: `Sim ${wk}`, detail: 'Simulate your game and the rest of the week', action: { kind: 'sim', target: { kind: 'week' } } });
    } else {
      const why = s.phase === 'playoffs' ? (s.bracket && aliveTeams(s.bracket).includes(teamId) ? 'Your team has a bye' : 'Your season is over') : 'Your team has a bye';
      out.push({ id: 'simWeek', label: `Sim ${wk}`, detail: why, action: { kind: 'sim', target: { kind: 'week' } } });
    }
    if (s.phase === 'preseason') simTo('regularSeason', 'Sim to regular season', 'Skip the rest of the preseason');
    if (s.phase !== 'playoffs') simTo('playoffs', 'Sim to end of regular season', 'Every game is simulated, yours too');
    simTo('awards', 'Sim to end of playoffs', 'Until a champion is crowned');
    if (mode === 'franchise') simTo('preseason', 'Sim through offseason', 'Into next season (roster moves automated)', true);
    return out;
  }
  if (mode === 'season') {
    return [{ id: 'summary', label: 'Season summary', detail: 'The champion, awards and your season', action: { kind: 'summary' } }];
  }
  const next = nextPhaseOf(s.phase);
  out.push({ id: 'nextPhase', label: `Next: ${seasonPhaseLabel(next)}`, detail: phaseDetail(s.phase), action: { kind: 'sim', target: { kind: 'nextPhase' } } });
  if (mode === 'franchise') simTo('preseason', 'Sim through offseason', 'Run every remaining offseason phase (roster moves automated)', true);
  return out;
};

const PHASE_DETAIL: Partial<Record<SeasonPhase, string>> = {
  awards: 'Hand out the season awards',
  offseason: 'Retirements, progression and the Hall of Fame',
  resigning: 'Unsigned players become free agents',
  freeAgency: 'Close free agency',
  draft: 'Finish the draft',
  postDraft: 'Final cuts, then training camp',
  trainingCamp: 'Start the new season',
};

/** One-line description of what leaving `phase` does. */
export const phaseDetail = (phase: SeasonPhase): string => PHASE_DETAIL[phase] ?? 'Continue';

/* ------------------------------------ blockers ----------------------------------- */

/** Blocking roster issues of the user team right now (the hub offers auto-fix / go to roster). */
export const rosterBlockers = (league: League, teamId: TeamId): RosterRuleIssue[] =>
  userRosterIssues(league, teamId).filter((i) => i.severity === 'blocking');

/** Short multi-line summary of issues for a dialog (at most `max` lines plus "+N more"). */
export const blockerSummary = (issues: readonly RosterRuleIssue[], max = 3): string => {
  const lines = issues.slice(0, max).map((i) => i.message);
  if (issues.length > max) lines.push(`+${issues.length - max} more`);
  return lines.join('. ');
};

/** Id of the hub tab that manages the roster (an id containing "roster", else the first team tab), or null. */
export const rosterTabId = (tabs: readonly Pick<HubTab, 'id' | 'group'>[]): string | null =>
  tabs.find((t) => t.id === 'roster')?.id ?? tabs.find((t) => t.id.toLowerCase().includes('roster'))?.id ?? tabs.find((t) => t.group === 'team')?.id ?? null;
