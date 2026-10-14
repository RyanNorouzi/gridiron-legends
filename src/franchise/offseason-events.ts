/**
 * Offseason news for the franchise feed: adapts offseason.ts OffseasonEvents (retirements, Hall of Fame inductions,
 * record breaks, awards) and the user team's notable transactions (big free-agent signings, early draft picks) into
 * FranchiseEvents appended to League.events, so the offseason shows up in the same inbox as the season's events.
 *
 * News items are news.ts items with their own event types (newsRetirement, newsAward for awards and Hall of Fame
 * inductions, newsRecord, newsSigning, newsDraft); news.ts newsKindOf recovers the precise kind from
 * data.subjectKey ("news:<kind>:..."), which also makes posting idempotent. Everything goes to the user team's feed
 * (league-wide items included); leagues without a user team get none. Pure.
 */
import type { PlayerId, TeamId } from '@/core/ids';
import { fullName, type Player } from '@/players/types';
import { AWARD_LABELS } from './awards';
import { contractApy } from './contracts';
import { leagueClock } from './events';
import { newsEvent, postNews, type NewsItem } from './news';
import type { OffseasonEvent } from './offseason';
import type { FranchiseEvent, League } from './types';

export { newsKindOf, type NewsKind } from './news';

/** Thresholds for league-wide items and the user team's "big" transactions. */
export const NEWS_TUNING = Object.freeze({
  /** Other teams' retirees make the news from this overall. */
  notableRetirementOverall: 80,
  /** A user-team free-agent signing is news from this overall ... */
  bigSigningOverall: 75,
  /** ... or from this share of the salary cap per year. */
  bigSigningCapShare: 0.03,
  /** User-team draft picks in these rounds are news. */
  draftNewsRounds: 3,
});

const anyPlayer = (league: League, id: PlayerId | null): Player | undefined => (id ? league.players[id] ?? league.retiredPlayers[id] : undefined);
const teamName = (league: League, id: TeamId | null): string => {
  const t = id ? league.teams[id] : undefined;
  return t ? `${t.city} ${t.name}` : 'free agency';
};

/** News items for offseason events (see the module header for what makes the feed). */
const itemsFor = (league: League, user: TeamId, events: readonly OffseasonEvent[]): NewsItem[] => {
  const out: NewsItem[] = [];
  for (const e of events) {
    switch (e.type) {
      case 'retirement': {
        const p = anyPlayer(league, e.playerId);
        if (e.teamId !== user && (p?.overall ?? 0) < NEWS_TUNING.notableRetirementOverall) break;
        out.push({ kind: 'retirement', subject: e.playerId, playerId: e.playerId, title: `${e.name} retires`,
          description: `${p ? `${p.position} ` : ''}${e.name} (${teamName(league, e.teamId)}) retires at ${e.age} after ${e.seasons} season${e.seasons === 1 ? '' : 's'}.` });
        break;
      }
      case 'hallOfFame':
        out.push({ kind: 'hallOfFame', subject: e.inductee.playerId, playerId: e.inductee.playerId, title: `${e.inductee.name} enters the Hall of Fame`,
          description: `${e.inductee.position} ${e.inductee.name} is inducted into the Hall of Fame in ${e.inductee.inductedYear} after ${e.inductee.seasons} seasons (peak overall ${e.inductee.peakOverall}, ${e.inductee.championships} championship${e.inductee.championships === 1 ? '' : 's'}).` });
        break;
      case 'recordBroken': {
        if (!e.headline) break;
        const r = e.record;
        out.push({ kind: 'record', subject: `${r.key}:${r.holderPlayerId ?? r.holderTeamId ?? ''}`, playerId: anyPlayer(league, r.holderPlayerId) ? r.holderPlayerId : null,
          title: `${r.holderName} sets a record`,
          description: `${r.holderName} now holds the league ${r.scope} record for ${r.label} with ${Math.round(r.value * 10) / 10}${e.previous ? ` (previous: ${e.previous.holderName}, ${Math.round(e.previous.value * 10) / 10})` : ''}.` });
        break;
      }
      case 'award':
        if (e.award.teamId !== user) break;
        out.push({ kind: 'award', subject: e.award.award, playerId: anyPlayer(league, e.award.playerId) ? e.award.playerId : null,
          title: AWARD_LABELS[e.award.award], description: e.award.summary });
        break;
      default:
        break;
    }
  }
  return out;
};

/** The user team's big free-agent signings and early draft picks recorded in League.freeAgency / League.draft. */
const transactionItems = (league: League, user: TeamId): NewsItem[] => {
  const out: NewsItem[] = [];
  for (const s of league.freeAgency?.signings ?? []) {
    const p = league.players[s.playerId];
    if (s.teamId !== user || !p?.contract) continue;
    const apy = contractApy(p.contract);
    if (p.overall < NEWS_TUNING.bigSigningOverall && apy < NEWS_TUNING.bigSigningCapShare * league.settings.salaryCap) continue;
    out.push({ kind: 'signing', subject: p.id, playerId: p.id, title: `${fullName(p)} signs`,
      description: `${p.position} ${fullName(p)} (overall ${p.overall}) joins the ${teamName(league, user)}: ${p.contract.years} year${p.contract.years === 1 ? '' : 's'} at $${(apy / 1e6).toFixed(1)}M per year.` });
  }
  for (const s of league.draft?.selections ?? []) {
    const p = league.players[s.playerId];
    if (s.pick.ownerTeamId !== user || s.pick.round > NEWS_TUNING.draftNewsRounds || !p) continue;
    out.push({ kind: 'draftPick', subject: p.id, playerId: p.id, title: `Round ${s.pick.round}: ${fullName(p)}`,
      description: `The ${teamName(league, user)} select ${p.position} ${fullName(p)}${p.college ? ` (${p.college})` : ''} with pick ${s.pick.overall ?? '?'} of the ${league.draft?.year ?? league.year} draft.` });
  }
  return out;
};

/** News FranchiseEvents for offseason events, without adding them (for previews and tests). */
export const offseasonNewsEvents = (league: League, events: readonly OffseasonEvent[]): FranchiseEvent[] => {
  const user = league.userTeamId;
  if (!user) return [];
  const now = leagueClock(league);
  return itemsFor(league, user, events).map((item) => newsEvent(league, user, item, now));
};

/** OffseasonDeps['events']: posts the offseason events' news to League.events (idempotent per item and year). */
export const postOffseasonEvents = (league: League, events: readonly OffseasonEvent[]): League =>
  league.userTeamId ? postNews(league, itemsFor(league, league.userTeamId, events)) : league;

/** Posts the user team's big signings and early draft picks (call after free agency / the draft; idempotent). */
export const postTransactionNews = (league: League): League =>
  league.userTeamId ? postNews(league, transactionItems(league, league.userTeamId)) : league;
