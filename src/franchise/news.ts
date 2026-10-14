/**
 * The franchise news feed: informational items in League.events with their own event types (types.ts
 * NewsEventType: newsSigning, newsTrade, newsInjury, newsRecord, newsMilestone, newsAward, newsCoaching,
 * newsRetirement, newsDraft), apart from the decision events of the catalog (events-catalog.ts).
 *
 * A news item carries a single 'noted' choice and is created already resolved (the events engine never
 * auto-resolves it or applies effects) but unread, so it shows in the inbox and counts as unread news. Its
 * data.subjectKey ("news:<kind>:<subject>:<year>") makes posting idempotent and names the precise kind (a Hall of
 * Fame induction is an award-type item of kind 'hallOfFame'). Leagues saved before the news types carry their news
 * under borrowed catalog types (retirementAnnounced, recordBroken, playerJump, rookieBreakout); newsKindOf reads
 * the kind from the subject key, so both generations read the same.
 *
 * Headline text builders (newsHeadline, newsHeadlines) turn items into one-line, toned headlines for the hub's
 * home tab and recap. Everything goes to the user team's feed (league-wide items included); leagues without a user
 * team get none. Item producers live in offseason-events.ts (offseason) and news-items.ts (weeks and phases). Pure.
 */
import type { PlayerId, TeamId } from '@/core/ids';
import { addEvents, leagueClock } from './events';
import type { FranchiseEvent, League, NewsEventType } from './types';

/** What a news item is about. */
export type NewsKind =
  | 'retirement' | 'hallOfFame' | 'record' | 'award' | 'signing' | 'draftPick' | 'trade' | 'injury' | 'milestone' | 'coaching';

/** Event type of each news kind. */
export const NEWS_TYPE: Readonly<Record<NewsKind, NewsEventType>> = Object.freeze({
  retirement: 'newsRetirement', hallOfFame: 'newsAward', record: 'newsRecord', award: 'newsAward', signing: 'newsSigning',
  draftPick: 'newsDraft', trade: 'newsTrade', injury: 'newsInjury', milestone: 'newsMilestone', coaching: 'newsCoaching',
});

/** Every news event type. */
export const NEWS_EVENT_TYPES: readonly NewsEventType[] = [
  'newsSigning', 'newsTrade', 'newsInjury', 'newsRecord', 'newsMilestone', 'newsAward', 'newsCoaching', 'newsRetirement', 'newsDraft',
];

const NEWS_PREFIX = 'news:';

/** True for an event of a news type (not for older news stored under borrowed types; see newsKindOf). */
export const isNewsType = (type: string): type is NewsEventType => (NEWS_EVENT_TYPES as readonly string[]).includes(type);

/** The news kind of a news item (either generation, see the module header); null for every other event. */
export const newsKindOf = (e: Pick<FranchiseEvent, 'data'>): NewsKind | null => {
  const key = e.data?.subjectKey;
  if (!key?.startsWith(NEWS_PREFIX)) return null;
  const kind = key.slice(NEWS_PREFIX.length).split(':')[0] as NewsKind;
  return kind in NEWS_TYPE ? kind : null;
};

/** One item before it becomes a FranchiseEvent. */
export interface NewsItem {
  kind: NewsKind;
  /** Unique within kind and season (idempotency). */
  subject: string;
  title: string;
  description: string;
  playerId: PlayerId | null;
  /** Other team the item is about (trades, coaching), for headlines. */
  otherTeamId?: TeamId;
}

/** A news item as a FranchiseEvent in `teamId`'s feed (already resolved with 'noted', unread). */
export const newsEvent = (league: League, teamId: TeamId, item: NewsItem, now: number = leagueClock(league)): FranchiseEvent => ({
  id: `news_${league.season.year}_${item.kind}_${item.subject}`,
  year: league.season.year, week: league.season.week, type: NEWS_TYPE[item.kind], teamId,
  playerId: item.playerId, coachId: null, title: item.title, description: item.description,
  choices: [{ id: 'noted', label: 'Noted', description: 'News item.' }], resolvedChoice: 'noted', read: false,
  data: {
    subjectKey: `${NEWS_PREFIX}${item.kind}:${item.subject}:${league.season.year}`, raisedAt: now, defaultChoice: 'noted',
    ...(item.otherTeamId ? { otherTeamId: item.otherTeamId } : {}),
  },
});

/** Posts items to the user team's feed, skipping any already posted (same id); no-op without a user team. */
export const postNews = (league: League, items: readonly NewsItem[]): League => {
  const user = league.userTeamId;
  if (!user || items.length === 0) return league;
  const known = new Set(league.events.map((e) => e.id));
  const now = leagueClock(league);
  const fresh: FranchiseEvent[] = [];
  for (const item of items) {
    const e = newsEvent(league, user, item, now);
    if (known.has(e.id)) continue;
    known.add(e.id);
    fresh.push(e);
  }
  return addEvents(league, fresh);
};

/* -------------------------------------------------------------- headlines */

/** Tone of a headline (the UI kit's tones). */
export type NewsTone = 'normal' | 'dim' | 'accent' | 'success' | 'warning' | 'danger' | 'info';

/** A one-line headline for a news item. */
export interface NewsHeadline {
  id: string;
  kind: NewsKind;
  text: string;
  tone: NewsTone;
  playerId?: PlayerId;
  teamId?: TeamId;
  unread: boolean;
}

const KIND_LABEL: Readonly<Record<NewsKind, string>> = {
  retirement: 'Retirement', hallOfFame: 'Hall of Fame', record: 'Record', award: 'Award', signing: 'Signing', draftPick: 'Draft',
  trade: 'Trade', injury: 'Injury', milestone: 'Milestone', coaching: 'Coaching',
};
const KIND_TONE: Readonly<Record<NewsKind, NewsTone>> = {
  retirement: 'dim', hallOfFame: 'accent', record: 'accent', award: 'accent', signing: 'success', draftPick: 'info',
  trade: 'info', injury: 'danger', milestone: 'accent', coaching: 'warning',
};

/** The headline of a news item ("Trade: ...", "Injury: ..."); null for events that are not news. */
export const newsHeadline = (e: FranchiseEvent): NewsHeadline | null => {
  const kind = newsKindOf(e);
  if (!kind) return null;
  return {
    id: e.id, kind, text: `${KIND_LABEL[kind]}: ${e.title}`, tone: KIND_TONE[kind], unread: !e.read,
    ...(e.playerId ? { playerId: e.playerId } : {}),
    ...(e.data?.otherTeamId ? { teamId: e.data.otherTeamId } : {}),
  };
};

/** The latest `max` news headlines in a team's feed, newest first (League.events is append-only in calendar order). */
export const newsHeadlines = (league: League, teamId: TeamId, max = 5): NewsHeadline[] => {
  const out: NewsHeadline[] = [];
  for (let i = league.events.length - 1; i >= 0 && out.length < max; i--) {
    const e = league.events[i] as FranchiseEvent;
    if (e.teamId !== teamId) continue;
    const h = newsHeadline(e);
    if (h) out.push(h);
  }
  return out;
};
