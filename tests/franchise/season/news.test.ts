import { describe, expect, it } from 'vitest';
import type { CoachId, GameId, PlayerId } from '@/core/ids';
import { NEWS_EVENT_TYPES, newsHeadline, newsHeadlines, newsKindOf, postNews, type NewsItem } from '@/franchise/news';
import { coachingItems, injuryItems, milestoneItems, postLoopNews, tradeItems } from '@/franchise/news-items';
import { catalogTemplate, eventChoices } from '@/franchise/events-catalog';
import { autoResolveEvents } from '@/franchise/events';
import type { FranchiseEvent, League, TradeOffer } from '@/franchise/types';
import { emptyPlayerStatLine } from '@/statistics/empty';
import { byAbbr, makeLeague } from './helpers';

const base = makeLeague(31);
const bos = byAbbr(base, 'BOS');
const other = Object.values(base.teams).find((t) => t.id !== bos.id)!;
const third = Object.values(base.teams).find((t) => t.id !== bos.id && t.id !== other.id)!;
const qb = base.players[bos.rosterIds.find((id) => base.players[id]?.position === 'QB')!]!;

const item = (over: Partial<NewsItem> = {}): NewsItem => ({ kind: 'signing', subject: 's1', title: 'Big signing', description: 'd', playerId: qb.id, ...over });

describe('news items', () => {
  it('get their own types, stay out of the catalog and read the same as older borrowed-type news', () => {
    const posted = postNews(base, [item(), item({ kind: 'trade', subject: 't1', otherTeamId: other.id, title: 'Trade with X' })]);
    const fresh = posted.events.slice(base.events.length);
    expect(fresh.map((e) => e.type)).toEqual(['newsSigning', 'newsTrade']);
    for (const e of fresh) {
      expect(NEWS_EVENT_TYPES).toContain(e.type);
      expect(catalogTemplate(e.type)).toBeUndefined();
      expect(e).toMatchObject({ teamId: bos.id, resolvedChoice: 'noted', read: false });
    }
    expect(eventChoices('newsTrade').map((c) => c.id)).toEqual(['noted']);
    // Idempotent, never auto-resolved again, and older saves' borrowed types still read as news.
    expect(postNews(posted, [item()]).events).toHaveLength(posted.events.length);
    expect(autoResolveEvents(posted, 1e9).events.slice(base.events.length)).toEqual(fresh);
    const legacy: FranchiseEvent = { ...fresh[0]!, type: 'playerJump' };
    expect(newsKindOf(legacy)).toBe('signing');
    expect(postNews({ ...base, userTeamId: null }, [item()]).events).toHaveLength(base.events.length);
  });

  it('builds toned headlines, newest first, with the subject player / team', () => {
    const posted = postNews(base, [
      item(),
      item({ kind: 'injury', subject: 'i1', title: 'QB out 4 weeks' }),
      item({ kind: 'coaching', subject: 'c1', playerId: null, otherTeamId: other.id, title: `${other.abbr} name a head coach` }),
    ]);
    const lines = newsHeadlines(posted, bos.id);
    expect(lines.map((l) => l.text)).toEqual([`Coaching: ${other.abbr} name a head coach`, 'Injury: QB out 4 weeks', 'Signing: Big signing']);
    expect(lines.map((l) => l.tone)).toEqual(['warning', 'danger', 'success']);
    expect(lines[0]!.teamId).toBe(other.id);
    expect(lines[2]!.playerId).toBe(qb.id);
    expect(lines.every((l) => l.unread)).toBe(true);
    expect(newsHeadlines(posted, bos.id, 1)).toHaveLength(1);
    const catalogEvent: FranchiseEvent = { ...posted.events.at(-1)!, type: 'holdout', data: {} };
    expect(newsHeadline(catalogEvent)).toBeNull();
  });
});

describe('loop news', () => {
  it('reports long injuries to the user team only', () => {
    const events = [
      { type: 'injury' as const, playerId: qb.id, teamId: bos.id, severity: 'moderate' as const, weeksOut: 4, gameId: 'g1' as GameId },
      { type: 'injury' as const, playerId: qb.id, teamId: bos.id, severity: 'minor' as const, weeksOut: 1, gameId: 'g2' as GameId },
      { type: 'injury' as const, playerId: other.rosterIds[0]!, teamId: other.id, severity: 'seasonEnding' as const, weeksOut: 12, gameId: 'g3' as GameId },
    ];
    const items = injuryItems(base, events);
    expect(items).toHaveLength(1);
    expect(items[0]!.title).toMatch(/out 4 weeks/);
  });

  it('says "out for the season" when an injury outlasts the season, never a week count past it', () => {
    const game = base.season.schedule.find((g) => !g.isPreseason && !g.isPlayoff && (g.home === bos.id || g.away === bos.id))!;
    const events = [
      { type: 'injury' as const, playerId: qb.id, teamId: bos.id, severity: 'seasonEnding' as const, weeksOut: 38, gameId: game.id },
      { type: 'injury' as const, playerId: qb.id, teamId: bos.id, severity: 'careerThreatening' as const, weeksOut: 40, gameId: game.id },
    ];
    const [season, career] = injuryItems(base, events);
    expect(season!.title).toMatch(/out for the season$/);
    expect(season!.description).not.toMatch(/38/);
    expect(career!.title).toMatch(/career-threatening/);
  });

  it('reports this year\'s completed trades of the user team and blockbusters elsewhere', () => {
    const star = { ...base.players[other.rosterIds[0]!]!, overall: 90 };
    const trade = (id: string, from: string, to: string, pid: PlayerId, status: TradeOffer['status'] = 'accepted', year = base.year): TradeOffer =>
      ({ id, fromTeam: from as never, toTeam: to as never, fromAssets: [], toAssets: [{ kind: 'player', playerId: pid }], status, year, week: 1, initiatedBy: from as never });
    const league: League = {
      ...base, players: { ...base.players, [star.id]: star },
      pendingTrades: [trade('mine', bos.id, other.id, other.rosterIds[1]!), trade('big', third.id, other.id, star.id), trade('meh', third.id, other.id, other.rosterIds[2]!),
        trade('old', bos.id, other.id, other.rosterIds[3]!, 'accepted', base.year - 1), trade('open', bos.id, other.id, other.rosterIds[4]!, 'pending')],
    };
    const items = tradeItems(league);
    expect(items.map((i) => i.subject)).toEqual(['mine', 'big']);
    expect(items[0]!.title).toMatch(new RegExp(`^Trade with ${other.abbr}`));
    const once = postLoopNews(league, league);
    expect(postLoopNews(once, once).events).toHaveLength(once.events.length);
  });

  it('notices career milestones crossed this week', () => {
    const line = (yds: number) => ({ ...emptyPlayerStatLine(), passing: { ...emptyPlayerStatLine().passing, yards: yds } });
    const past = { playerId: qb.id, seasons: [{ playerId: qb.id, teamId: bos.id, year: base.season.year - 1, line: line(9_000), playoffLine: null }], totals: line(9_000) };
    const before: League = { ...base, careerStats: { ...base.careerStats, [qb.id]: past }, season: { ...base.season, stats: { [qb.id]: line(700) } } };
    const after: League = { ...before, season: { ...before.season, stats: { [qb.id]: line(1_100) } } };
    const items = milestoneItems(before, after);
    expect(items.map((i) => i.subject)).toEqual([`${qb.id}:passYds:10000`]);
    expect(items[0]!.title).toMatch(/10,000 career passing yards/);
    expect(milestoneItems(after, { ...after, season: { ...after.season, stats: { [qb.id]: line(1_200) } } })).toEqual([]);
  });

  it('reports head-coach changes anywhere and staff changes on the user team', () => {
    const coaches = Object.values(base.coaches);
    const newHc = coaches.find((c) => c.teamId === null && c.role === 'HC') ?? { ...coaches[0]!, id: 'c_newhc' as CoachId, teamId: null, role: 'HC' as const };
    const after: League = {
      ...base,
      coaches: { ...base.coaches, [newHc.id]: { ...newHc, teamId: other.id } },
      teams: { ...base.teams, [other.id]: { ...other, headCoachId: newHc.id }, [bos.id]: { ...bos, staffIds: bos.staffIds.slice(1) } },
    };
    const items = coachingItems(base, after);
    const titles = items.map((i) => i.title);
    expect(titles.some((t) => t.startsWith(`${other.abbr} name`))).toBe(true);
    const leftId = bos.staffIds[0]!;
    if (base.coaches[leftId]?.role !== 'HC') expect(titles.some((t) => t.endsWith('leaves'))).toBe(true);
    expect(coachingItems(after, after)).toEqual([]);
  });
});
