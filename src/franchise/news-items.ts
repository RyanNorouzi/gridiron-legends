/**
 * News produced by the season loop between two states of the League (news.ts items):
 *   - injury     the user team's players hurt for NEWS_ITEM_TUNING.injuryMinWeeks or longer (week events), worded by
 *                injuryOutlook ("out for the season" once the injury outlasts the season, "career-threatening")
 *   - trade      completed trades involving the user team, and blockbusters elsewhere (a player of
 *                blockbusterOverall or better moved); read from League.pendingTrades, idempotent by offer id
 *   - milestone  a user-team player's career regular-season total crossing a MILESTONES step this week
 *   - coaching   a head-coach change anywhere, and any staff change on the user team (before/after diff)
 * postLoopNews posts them all; advanceLeagueWeek and advanceLeaguePhase call it. Pure.
 */
import type { GameId, PlayerId, TeamId } from '@/core/ids';
import { fullName, type InjurySeverity, type Player } from '@/players/types';
import type { PlayerStatLine } from '@/statistics/types';
import type { Team } from '@/teams/types';
import { postNews, type NewsItem } from './news';
import { playoffRoundCount, scheduleWeekCount } from './settings';
import type { League, LeagueSettings, ScheduledGame, TradeAsset } from './types';
import type { WeekEvent } from './week';

/** Thresholds of the loop news. */
export const NEWS_ITEM_TUNING = Object.freeze({
  /** A user-team injury is news from this many weeks out. */
  injuryMinWeeks: 3,
  /** A trade between two other teams is news when it moves a player this good. */
  blockbusterOverall: 80,
});

/** Career milestones: a stat, its label and the totals that make news. */
export const MILESTONES: readonly { key: string; label: string; value: (l: PlayerStatLine) => number; steps: readonly number[] }[] = [
  { key: 'passYds', label: 'career passing yards', value: (l) => l.passing.yards, steps: [10000, 20000, 30000, 40000, 50000, 60000] },
  { key: 'passTd', label: 'career touchdown passes', value: (l) => l.passing.touchdowns, steps: [100, 200, 300, 400, 500] },
  { key: 'rushYds', label: 'career rushing yards', value: (l) => l.rushing.yards, steps: [5000, 10000, 15000] },
  { key: 'rushTd', label: 'career rushing touchdowns', value: (l) => l.rushing.touchdowns, steps: [50, 100, 150] },
  { key: 'recYds', label: 'career receiving yards', value: (l) => l.receiving.yards, steps: [5000, 10000, 15000] },
  { key: 'recTd', label: 'career receiving touchdowns', value: (l) => l.receiving.touchdowns, steps: [50, 100, 150] },
  { key: 'sacks', label: 'career sacks', value: (l) => l.defense.sacks, steps: [50, 100, 150] },
  { key: 'ints', label: 'career interceptions', value: (l) => l.defense.interceptions, steps: [25, 50, 75] },
];

const teamLabel = (league: League, id: TeamId | null | undefined): string => {
  const t = id ? league.teams[id] : undefined;
  return t ? `${t.city} ${t.name}` : 'another club';
};
const abbr = (league: League, id: TeamId): string => league.teams[id]?.abbr ?? '?';
const anyPlayer = (league: League, id: PlayerId | null): Player | undefined => (id ? league.players[id] ?? league.retiredPlayers[id] : undefined);

/** Calendar weeks of the season still to come after a game's week: the rest of the preseason and regular season plus every playoff round. */
export const seasonWeeksAfter = (
  settings: Pick<LeagueSettings, 'preseasonWeeks' | 'regularSeasonWeeks' | 'byeWeeks' | 'playoff' | 'conferences'>,
  game: Pick<ScheduledGame, 'isPreseason' | 'isPlayoff' | 'week' | 'playoffRound'>,
): number => {
  const playoffs = playoffRoundCount(settings);
  if (game.isPlayoff) return Math.max(0, playoffs - (game.playoffRound ?? game.week));
  const regular = scheduleWeekCount(settings);
  if (game.isPreseason) return Math.max(0, settings.preseasonWeeks - game.week) + regular + playoffs;
  return Math.max(0, regular - game.week) + playoffs;
};

/** How long an injury keeps a player out, in plain words. */
export interface InjuryOutlook {
  kind: 'dayToDay' | 'weeks' | 'season' | 'career';
  /** "day-to-day", "out 3 wks", "out for the season", "career-threatening". */
  short: string;
}

/**
 * The outlook of a new injury: a 0-week knock is day-to-day, an injury longer than the weeks the season has
 * left (`weeksLeft`, null when unknown) keeps him out for the season, and a career-threatening one says so.
 */
export const injuryOutlook = (weeksOut: number, severity: InjurySeverity, weeksLeft: number | null): InjuryOutlook => {
  if (severity === 'careerThreatening') return { kind: 'career', short: 'career-threatening' };
  if (weeksOut <= 0) return { kind: 'dayToDay', short: 'day-to-day' };
  const pastSeason = weeksLeft !== null && weeksOut > weeksLeft && (weeksLeft > 0 || severity === 'seasonEnding');
  if (pastSeason) return { kind: 'season', short: 'out for the season' };
  return { kind: 'weeks', short: `out ${weeksOut} wk${weeksOut === 1 ? '' : 's'}` };
};

/** Weeks the season has left after the game an injury happened in (null when the game is no longer on the schedule). */
export const weeksLeftAfterGame = (league: Pick<League, 'settings' | 'season'>, gameId: GameId): number | null => {
  const g = league.season.schedule.find((x) => x.id === gameId);
  return g ? seasonWeeksAfter(league.settings, g) : null;
};

/** Injury news for the user team from a week's events. */
export const injuryItems = (league: League, events: readonly WeekEvent[]): NewsItem[] => {
  const user = league.userTeamId;
  const out: NewsItem[] = [];
  for (const e of events) {
    if (e.type !== 'injury' || e.teamId !== user || e.weeksOut < NEWS_ITEM_TUNING.injuryMinWeeks) continue;
    const p = league.players[e.playerId];
    if (!p) continue;
    const name = `${p.position} ${fullName(p)}`;
    const o = injuryOutlook(e.weeksOut, e.severity, weeksLeftAfterGame(league, e.gameId));
    const [title, description] = o.kind === 'career'
      ? [`${name} suffers a career-threatening injury`, `${name} was badly hurt in the game: he is out for the season and may never be the same player.`]
      : o.kind === 'season'
        ? [`${name} out for the season`, `${name} was hurt in the game and will miss the rest of the season.`]
        : [`${name} out ${e.weeksOut} weeks`, `${name} was hurt in the game and is expected to miss ${e.weeksOut} weeks.`];
    out.push({ kind: 'injury', subject: `${p.id}:${e.gameId}`, playerId: p.id, title, description });
  }
  return out;
};

const assetText = (league: League, a: TradeAsset): string => {
  if (a.kind === 'pick') return `a ${a.pick.year} round ${a.pick.round} pick`;
  const p = anyPlayer(league, a.playerId);
  return p ? `${p.position} ${fullName(p)}` : 'a player';
};

/** Completed trades involving the user team, plus blockbusters elsewhere. */
export const tradeItems = (league: League): NewsItem[] => {
  const user = league.userTeamId;
  const out: NewsItem[] = [];
  for (const t of league.pendingTrades) {
    if (t.status !== 'accepted' || t.year !== league.year) continue;
    const mine = t.fromTeam === user || t.toTeam === user;
    const star = [...t.fromAssets, ...t.toAssets].some((a) => a.kind === 'player' && (anyPlayer(league, a.playerId)?.overall ?? 0) >= NEWS_ITEM_TUNING.blockbusterOverall);
    if (!mine && !star) continue;
    const us = mine ? (t.fromTeam === user ? t.fromTeam : t.toTeam) : t.fromTeam;
    const them = us === t.fromTeam ? t.toTeam : t.fromTeam;
    const gave = us === t.fromTeam ? t.fromAssets : t.toAssets;
    const got = us === t.fromTeam ? t.toAssets : t.fromAssets;
    const list = (as: readonly TradeAsset[]): string => (as.length ? as.map((a) => assetText(league, a)).join(', ') : 'nothing');
    const lead = got.find((a) => a.kind === 'player') ?? got[0] ?? gave[0];
    out.push({
      kind: 'trade', subject: t.id, playerId: lead?.kind === 'player' ? lead.playerId : null, otherTeamId: them,
      title: mine ? `Trade with ${abbr(league, them)}: ${lead ? assetText(league, lead) : 'deal done'}` : `${abbr(league, us)} and ${abbr(league, them)} swap ${lead ? assetText(league, lead) : 'assets'}`,
      description: `The ${teamLabel(league, us)} send ${list(gave)} to the ${teamLabel(league, them)} for ${list(got)}.`,
    });
  }
  return out;
};

/** Career regular-season line to date: finished seasons plus this season's table. */
const careerToDate = (league: League, id: PlayerId, value: (l: PlayerStatLine) => number): number => {
  const year = league.season.year;
  const past = (league.careerStats[id]?.seasons ?? []).reduce((s, e) => s + (e.year === year ? 0 : value(e.line)), 0);
  const now = league.season.stats[id];
  return past + (now ? value(now) : 0);
};

/** Milestones the user team's players crossed between `before` and `after`. */
export const milestoneItems = (before: League, after: League): NewsItem[] => {
  const user = after.userTeamId;
  const team = user ? after.teams[user] : undefined;
  if (!team) return [];
  const out: NewsItem[] = [];
  for (const id of team.rosterIds) {
    if (before.season.stats[id] === after.season.stats[id]) continue;
    const p = after.players[id];
    if (!p) continue;
    for (const m of MILESTONES) {
      const was = careerToDate(before, id, m.value);
      const now = careerToDate(after, id, m.value);
      const step = [...m.steps].reverse().find((s) => was < s && now >= s);
      if (step === undefined) continue;
      out.push({ kind: 'milestone', subject: `${id}:${m.key}:${step}`, playerId: id, title: `${fullName(p)} reaches ${step.toLocaleString('en-US')} ${m.label}`,
        description: `${p.position} ${fullName(p)} passed ${step.toLocaleString('en-US')} ${m.label} this week (${Math.round(now).toLocaleString('en-US')} and counting).` });
    }
  }
  return out;
};

const coachName = (league: League, id: string | null | undefined): string => {
  const c = id ? league.coaches[id as keyof League['coaches']] : undefined;
  return c ? `${c.firstName} ${c.lastName}` : 'nobody';
};

/** Head-coach changes anywhere and every staff change on the user team between `before` and `after`. */
export const coachingItems = (before: League, after: League): NewsItem[] => {
  const out: NewsItem[] = [];
  const year = after.season.year;
  for (const team of Object.values(after.teams) as Team[]) {
    const old = before.teams[team.id];
    if (!old) continue;
    if (old.headCoachId !== team.headCoachId) {
      const hired = team.headCoachId;
      out.push({
        kind: 'coaching', subject: `${team.id}:HC:${hired ?? 'none'}:${old.headCoachId ?? 'none'}`, playerId: null, otherTeamId: team.id,
        title: hired ? `${team.abbr} name ${coachName(after, hired)} head coach` : `${team.abbr} part ways with ${coachName(before, old.headCoachId)}`,
        description: hired
          ? `The ${teamLabel(after, team.id)} hand the head-coaching job to ${coachName(after, hired)}${old.headCoachId ? `, replacing ${coachName(before, old.headCoachId)}` : ''} (${year}).`
          : `The ${teamLabel(after, team.id)} are looking for a new head coach after ${coachName(before, old.headCoachId)} left.`,
      });
    }
    if (team.id !== after.userTeamId) continue;
    const had = new Set(old.staffIds);
    const has = new Set(team.staffIds);
    for (const id of team.staffIds) {
      const c = after.coaches[id];
      if (had.has(id) || !c || c.role === 'HC') continue;
      out.push({ kind: 'coaching', subject: `${team.id}:in:${id}`, playerId: null, otherTeamId: team.id, title: `New ${c.role}: ${coachName(after, id)}`,
        description: `${coachName(after, id)} joins the ${teamLabel(after, team.id)} staff as ${c.role}.` });
    }
    for (const id of old.staffIds) {
      const c = before.coaches[id];
      if (has.has(id) || !c || c.role === 'HC') continue;
      out.push({ kind: 'coaching', subject: `${team.id}:out:${id}`, playerId: null, otherTeamId: team.id, title: `${c.role} ${coachName(before, id)} leaves`,
        description: `${coachName(before, id)} is no longer on the ${teamLabel(after, team.id)} staff.` });
    }
  }
  return out;
};

/** Posts the loop news between two League states (week events optional) to the user team's feed. */
export const postLoopNews = (before: League, after: League, events: readonly WeekEvent[] = []): League =>
  after.userTeamId ? postNews(after, [...injuryItems(after, events), ...tradeItems(after), ...milestoneItems(before, after), ...coachingItems(before, after)]) : after;
