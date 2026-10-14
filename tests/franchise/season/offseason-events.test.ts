import { describe, expect, it } from 'vitest';
import type { PlayerId } from '@/core/ids';
import { createContract } from '@/franchise/contracts';
import type { OffseasonEvent } from '@/franchise/offseason';
import { newsKindOf, offseasonNewsEvents, postOffseasonEvents, postTransactionNews } from '@/franchise/offseason-events';
import type { DraftPick } from '@/teams/types';
import type { League, LeagueRecord } from '@/franchise/types';
import { emptyPlayerStatLine } from '@/statistics/empty';
import { byAbbr, makeLeague } from './helpers';

const generated = makeLeague(23);
const bos = byAbbr(generated, 'BOS');
const other = Object.values(generated.teams).find((t) => t.id !== bos.id)!;
const mine = generated.players[bos.rosterIds[0]!]!;
const theirs = Object.values(generated.players).filter((p) => p.teamId === other.id);
const star = { ...theirs[0]!, overall: 88 };
const scrub = { ...theirs[1]!, overall: 52 };
const base: League = { ...generated, players: { ...generated.players, [star.id]: star, [scrub.id]: scrub }, season: { ...generated.season, phase: 'offseason', week: 0 } };

const record: LeagueRecord = { key: 'season.passing.yards', label: 'passing yards (season)', scope: 'season', value: 5600, holderPlayerId: star.id, holderTeamId: other.id, holderName: 'A. Passer', year: 2026 };
const events: OffseasonEvent[] = [
  { type: 'retirement', playerId: mine.id, teamId: bos.id, name: 'Mine Guy', age: 35, seasons: 12 },
  { type: 'retirement', playerId: scrub.id, teamId: other.id, name: 'Scrub Guy', age: 31, seasons: 4 },
  { type: 'retirement', playerId: star.id, teamId: other.id, name: 'Star Guy', age: 36, seasons: 14 },
  { type: 'hallOfFame', inductee: { playerId: star.id, inductedYear: 2026, name: 'Star Guy', position: 'QB', seasons: 14, peakOverall: 95, championships: 2, awards: [], careerStats: emptyPlayerStatLine(), teams: [other.id] } },
  { type: 'recordBroken', record, previous: null, headline: true },
  { type: 'recordBroken', record: { ...record, key: 'game.rushing.yards' }, previous: null, headline: false },
  { type: 'award', award: { award: 'MVP', year: 2026, playerId: mine.id, coachId: null, teamId: bos.id, summary: 'MVP: the best' } },
  { type: 'award', award: { award: 'DPOY', year: 2026, playerId: star.id, coachId: null, teamId: other.id, summary: 'DPOY: not ours' } },
];

describe('offseason news adapter', () => {
  it('turns user-team and notable league events into resolved, unread news for the user feed', () => {
    const news = offseasonNewsEvents(base, events);
    const kinds = news.map((e) => newsKindOf(e));
    expect(kinds).toEqual(['retirement', 'retirement', 'hallOfFame', 'record', 'award']);
    for (const e of news) {
      expect(e.teamId).toBe(bos.id);
      expect(e.resolvedChoice).toBe('noted');
      expect(e.read).toBe(false);
      expect(e.choices.map((c) => c.id)).toEqual(['noted']);
      expect(e.year).toBe(base.season.year);
    }
    expect(news[0]!.title).toBe('Mine Guy retires');
    // News items carry their own event types (news.ts), no longer borrowed catalog types.
    expect(news.map((e) => e.type)).toEqual(['newsRetirement', 'newsRetirement', 'newsAward', 'newsRecord', 'newsAward']);
    expect(news.find((e) => newsKindOf(e) === 'record')!.description).toMatch(/5600/);
    expect(newsKindOf({ data: { subjectKey: 'ret:x:2026' } })).toBeNull();
  });

  it('posts once: re-posting the same events adds nothing', () => {
    const once = postOffseasonEvents(base, events);
    expect(once.events.length).toBe(base.events.length + offseasonNewsEvents(base, events).length);
    expect(postOffseasonEvents(once, events).events).toHaveLength(once.events.length);
    expect(postOffseasonEvents({ ...base, userTeamId: null }, events)).toEqual({ ...base, userTeamId: null });
  });

  it('reports the user team\'s big signings and early draft picks', () => {
    const fa = Object.values(base.players).filter((p) => p.teamId === null).sort((a, b) => b.overall - a.overall);
    const big = { ...fa[0]!, teamId: bos.id, overall: 80, contract: createContract({ salary: 20_000_000, years: 3, guaranteed: 0, signingBonus: 0, role: 'starter', year: 2027 }) };
    const small = { ...fa[1]!, teamId: bos.id, overall: 55, contract: createContract({ salary: 900_000, years: 1, guaranteed: 0, signingBonus: 0, role: 'backup', year: 2027 }) };
    const pick = (round: number, playerId: PlayerId, overall: number) => ({
      pick: { id: `2026-r${round}-${bos.id}`, year: 2026, round, originalTeamId: bos.id, ownerTeamId: bos.id, overall } as DraftPick, playerId,
    });
    const league: League = {
      ...base,
      players: { ...base.players, [big.id]: big, [small.id]: small },
      freeAgency: { round: 5, maxRounds: 4, offers: [], signings: [{ playerId: big.id, teamId: bos.id, round: 1 }, { playerId: small.id, teamId: bos.id, round: 2 }] },
      draft: { year: 2026, order: [], currentPickIndex: 0, prospects: [], selections: [pick(1, mine.id, 12), pick(5, scrub.id, 140)], reports: {}, scouting: {}, userBoard: [], complete: true },
    };
    const posted = postTransactionNews(league);
    const fresh = posted.events.slice(league.events.length);
    expect(fresh.map((e) => [newsKindOf(e), e.playerId])).toEqual([['signing', big.id], ['draftPick', mine.id]]);
    expect(fresh.map((e) => e.type)).toEqual(['newsSigning', 'newsDraft']);
    expect(fresh[0]!.description).toMatch(/\$[\d.]+M per year/);
    expect(fresh[1]!.description).toMatch(/pick 12 of the 2026 draft/);
    expect(postTransactionNews(posted).events).toHaveLength(posted.events.length);
  });
});
