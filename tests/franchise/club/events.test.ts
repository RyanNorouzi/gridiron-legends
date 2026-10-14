import { describe, expect, it } from 'vitest';
import { createRng } from '@/core/rng';
import { EVENT_CATALOG, FRANCHISE_EVENT_TYPES, catalogTemplate, renderTemplate, validateEventCatalog } from '@/franchise/events-catalog';
import { addEvents, autoResolveEvents, eventRaisedAt, generateEvents, leagueClock, pendingEvents, resolveEvent } from '@/franchise/events';
import { economyScale } from '@/franchise/facilities';
import type { FranchiseEvent, FranchiseEventType, League } from '@/franchise/types';
import { clockAt, firstOf, inSeasonScenario, offseasonScenario, runOffseason, runWeeks } from './scenarios';

const { league: season, cast } = inSeasonScenario();
const week = season.season.week;
const teams = [cast.team.id, cast.other.id];
const run = runWeeks(season, Array.from({ length: 60 }, (_, i) => week + i), { teamIds: teams, records: cast.records });
const inSeasonEvents = run.batches.flat();
const off = runOffseason(offseasonScenario().league);
const subject = (e: FranchiseEvent): string => e.playerId ?? e.coachId ?? 'team';

describe('event catalog', () => {
  it('covers every event type with a valid default choice', () => {
    for (const type of FRANCHISE_EVENT_TYPES) {
      const t = EVENT_CATALOG.types[type];
      expect(t.choices.length).toBeGreaterThan(0);
      expect(t.choices.map((c) => c.id)).toContain(t.defaultChoice);
    }
    expect(() => validateEventCatalog({ limits: { maxPerWeek: 3, autoResolveWeeks: 2, keepAiEventYears: 1 }, types: {} })).toThrow(/tradeDemand/);
  });

  it('renders placeholders and leaves unknown ones alone', () => {
    expect(renderTemplate('{player} ({overall}) vs {team} {x}', { player: 'A. Smith', overall: 88, team: 'Boston' })).toBe('A. Smith (88) vs Boston {x}');
  });
});

describe('systemic triggers', () => {
  it('crafted states trigger every event type across the simulated weeks', () => {
    const seen = new Set<FranchiseEventType>([...inSeasonEvents, ...off.events].map((e) => e.type));
    const missing = FRANCHISE_EVENT_TYPES.filter((t) => !seen.has(t));
    expect(missing).toEqual([]);
  });

  it('in-season triggers point at the right subjects', () => {
    expect(firstOf(inSeasonEvents, 'tradeDemand').playerId).toBe(cast.star.id);
    expect(firstOf(inSeasonEvents, 'extensionRequest').playerId).toBe(cast.extension.id);
    expect(firstOf(inSeasonEvents, 'lockerRoomConflict').playerId).toBe(cast.hotHead.id);
    expect(firstOf(inSeasonEvents, 'injury').playerId).toBe(cast.hurt.id);
    // The outlook reads naturally for every severity (never 'miss about 20 weeks (season-ending ...)').
    expect(firstOf(inSeasonEvents, 'injury').description).toMatch(/ (is expected to miss about \d+ weeks?|is out for the season) \(/);
    expect(firstOf(inSeasonEvents, 'targetsRequest').playerId).toBe(cast.wr1.id);
    expect(firstOf(inSeasonEvents, 'unhappyPlayer').playerId).toBe(cast.benched.id);
    expect(firstOf(inSeasonEvents, 'recordBroken').playerId).toBe(cast.wr1.id);
    expect(firstOf(inSeasonEvents, 'winningStreak').teamId).toBe(cast.other.id);
    expect(firstOf(inSeasonEvents, 'losingStreak').teamId).toBe(cast.team.id);
    expect(firstOf(inSeasonEvents, 'rivalryGame').data?.otherTeamId).toBe(cast.opponent);
    expect(firstOf(inSeasonEvents, 'coachDisagreement').coachId).not.toBeNull();
    const sponsor = firstOf(inSeasonEvents, 'sponsorOffer');
    expect(sponsor.data?.amount).toBeGreaterThan(0);
    expect(sponsor.description).toMatch(/\$/);
    const trade = firstOf(inSeasonEvents, 'tradeDemand');
    expect(trade.title).toContain(cast.star.lastName);
    expect(trade.description).toContain('2-5');
    expect(trade.choices.map((c) => c.id)).toEqual(['meet', 'ignore', 'shop']);
  });

  it('offseason triggers come from progression, age and contracts', () => {
    const { cast: oc } = offseasonScenario();
    const byType = (t: FranchiseEventType): string | null => firstOf(off.events, t).playerId;
    expect(byType('rookieBreakout')).toBe(oc.rookie.id);
    expect(byType('playerJump')).toBe(oc.jumper.id);
    expect(byType('playerSlump')).toBe(oc.slumper.id);
    expect(byType('veteranDecline')).toBe(oc.decliner.id);
    expect(off.events.some((e) => e.type === 'retirementAnnounced' && e.playerId === oc.retiree.id)).toBe(true);
    expect(byType('holdout')).toBe(oc.holdout.id);
    expect(firstOf(off.events, 'holdout').data?.amount).toBe(12_000_000);
    // Progression news is once-only per entry.
    expect(off.events.filter((e) => e.type === 'rookieBreakout')).toHaveLength(1);
  });

  it('nothing fires for a quiet, healthy, winning team', () => {
    const calm = generateEvents(inSeasonScenario().league, week, createRng(1), { teamIds: [cast.other.id], brokenRecords: [] });
    expect(calm.every((e) => ['winningStreak', 'sponsorOffer', 'rivalryGame'].includes(e.type))).toBe(true);
  });
});

describe('rate limiting', () => {
  it('at most maxPerWeek events per team per week, one per type', () => {
    for (const batch of run.batches) {
      for (const id of teams) {
        const mine = batch.filter((e) => e.teamId === id);
        expect(mine.length).toBeLessThanOrEqual(EVENT_CATALOG.limits.maxPerWeek);
        expect(new Set(mine.map((e) => e.type)).size).toBe(mine.length);
      }
    }
    expect(run.batches[0]?.filter((e) => e.teamId === cast.team.id)).toHaveLength(3);
  });

  it('the most important events go first', () => {
    const first = (run.batches[0] ?? []).filter((e) => e.teamId === cast.team.id).map((e) => e.type);
    expect(first[0]).toBe('tradeDemand');
    expect(first[1]).toBe('lockerRoomConflict');
  });

  it('respects per-subject and per-team cooldowns and once-only keys', () => {
    for (const e of inSeasonEvents) {
      const tpl = catalogTemplate(e.type)!;
      const later = inSeasonEvents.filter((x) => x !== e && x.type === e.type && x.teamId === e.teamId && eventRaisedAt(x) > eventRaisedAt(e));
      for (const x of later) {
        const gap = eventRaisedAt(x) - eventRaisedAt(e);
        expect(gap).toBeGreaterThanOrEqual(tpl.teamCooldownWeeks);
        if (subject(x) === subject(e)) expect(gap).toBeGreaterThanOrEqual(tpl.cooldownWeeks);
        if (e.data?.subjectKey) expect(x.data?.subjectKey).not.toBe(e.data.subjectKey);
      }
    }
    const trades = inSeasonEvents.filter((e) => e.type === 'tradeDemand');
    expect(trades.length).toBeGreaterThan(1);
    expect(eventRaisedAt(trades[1] as FranchiseEvent) - eventRaisedAt(trades[0] as FranchiseEvent)).toBe(EVENT_CATALOG.types.tradeDemand.cooldownWeeks);
  });

  it('is deterministic for a seed and does not touch the league', () => {
    const again = runWeeks(season, Array.from({ length: 60 }, (_, i) => week + i), { teamIds: teams, records: cast.records });
    expect(again.batches.flat().map((e) => e.id)).toEqual(inSeasonEvents.map((e) => e.id));
    expect(season.events).toEqual([]);
    expect(new Set(inSeasonEvents.map((e) => e.id)).size).toBe(inSeasonEvents.length);
  });
});

describe('resolving events', () => {
  const firstBatch = run.batches[0] ?? [];
  const withFirst = addEvents(season, firstBatch);
  const trade = firstOf(firstBatch, 'tradeDemand');

  it('meeting a disgruntled star lifts him but costs a little chemistry', () => {
    const l = resolveEvent(withFirst, trade.id, 'meet');
    expect(l.players[cast.star.id]?.morale.morale).toBe(40);
    expect(l.players[cast.star.id]?.morale.coachRelationship).toBe(44);
    expect(l.club?.chemistryBonus?.[cast.team.id]).toBe(-1);
    expect(l.teams[cast.team.id]?.chemistry).toBe((season.teams[cast.team.id]?.chemistry ?? 0) - 1);
    const done = l.events.find((e) => e.id === trade.id);
    expect(done?.resolvedChoice).toBe('meet');
    expect(done?.read).toBe(true);
    expect(pendingEvents(l, cast.team.id).map((e) => e.id)).not.toContain(trade.id);
  });

  it('shopping him flags the trade block; ignoring him sours him', () => {
    expect(resolveEvent(withFirst, trade.id, 'shop').club?.playerFlags[cast.star.id]).toContain('tradeBlock');
    const ignored = resolveEvent(withFirst, trade.id, 'ignore');
    expect(ignored.players[cast.star.id]?.morale.morale).toBe(24);
    expect(ignored.club?.playerFlags[cast.star.id]).toContain('disgruntled');
  });

  it('money, fans, injuries and the depth chart respond to choices', () => {
    const all = run.league;
    const sponsor = firstOf(inSeasonEvents, 'sponsorOffer');
    const cash = all.teams[sponsor.teamId]?.finances.cash ?? 0;
    const accepted = resolveEvent(all, sponsor.id, 'accept');
    expect(accepted.teams[sponsor.teamId]?.finances.cash).toBe(cash + (sponsor.data?.amount ?? 0));
    expect(accepted.teams[sponsor.teamId]?.finances.seasonRevenue.sponsors).toBe((all.teams[sponsor.teamId]?.finances.seasonRevenue.sponsors ?? 0) + (sponsor.data?.amount ?? 0));
    const negotiated = [1, 2, 3, 4, 5, 6].map((s) => resolveEvent(all, sponsor.id, 'negotiate', createRng(s)).teams[sponsor.teamId]?.finances.cash ?? 0);
    expect(new Set(negotiated).size).toBe(2);
    expect(resolveEvent(all, sponsor.id, 'negotiate', createRng(3)).teams[sponsor.teamId]?.finances.cash).toBe(negotiated[2]);
    const unrest = firstOf(inSeasonEvents, 'fanUnrest');
    const discounted = resolveEvent(all, unrest.id, 'discount');
    expect(discounted.teams[cast.team.id]?.finances.ticketPrice).toBe(Math.round((all.teams[cast.team.id]?.finances.ticketPrice ?? 0) * 0.9));
    expect(discounted.teams[cast.team.id]?.fans.support).toBe(34);
    const injury = firstOf(inSeasonEvents, 'injury');
    expect(resolveEvent(all, injury.id, 'rush').players[cast.hurt.id]?.injury?.weeksRemaining).toBe(2);
    const specialist = resolveEvent(all, injury.id, 'specialist');
    expect(specialist.players[cast.hurt.id]?.injury?.weeksRemaining).toBe(3);
    expect(specialist.teams[cast.team.id]?.finances.cash).toBe((all.teams[cast.team.id]?.finances.cash ?? 0) - Math.round((300_000 * economyScale(all.settings)) / 10_000) * 10_000);
    const unhappy = firstOf(inSeasonEvents, 'unhappyPlayer');
    expect(resolveEvent(all, unhappy.id, 'start').teams[cast.team.id]?.depthChart.CB[0]).toBe(cast.benched.id);
    const streak = firstOf(inSeasonEvents, 'winningStreak');
    const party = resolveEvent(all, streak.id, 'celebrate');
    const someone = all.teams[cast.other.id]?.rosterIds[0];
    if (someone) expect(party.players[someone]?.morale.morale).toBe(Math.min(100, (all.players[someone]?.morale.morale ?? 0) + 3));
  });

  it('rejects unknown events, unknown choices and double resolution', () => {
    expect(() => resolveEvent(withFirst, 'nope', 'meet')).toThrow(/unknown event/);
    expect(() => resolveEvent(withFirst, trade.id, 'bribe')).toThrow(/no choice/);
    const once = resolveEvent(withFirst, trade.id, 'meet');
    expect(() => resolveEvent(once, trade.id, 'meet')).toThrow(/already resolved/);
  });

  it('effects on a player who left the team are skipped', () => {
    const gone: League = { ...withFirst, players: { ...withFirst.players, [cast.star.id]: { ...withFirst.players[cast.star.id]!, teamId: null } } };
    expect(resolveEvent(gone, trade.id, 'meet').players[cast.star.id]?.morale.morale).toBe(30);
  });
});

describe('auto-resolution', () => {
  it('unresolved events take their default choice after two weeks', () => {
    const l = addEvents(season, run.batches[0] ?? []);
    const raised = clockAt(season, week);
    const early = autoResolveEvents(l, raised + 1);
    expect(pendingEvents(early, cast.team.id)).toHaveLength(pendingEvents(l, cast.team.id).length);
    const late = autoResolveEvents(l, raised + EVENT_CATALOG.limits.autoResolveWeeks);
    expect(pendingEvents(late)).toHaveLength(0);
    for (const e of late.events) {
      expect(e.resolvedChoice).toBe(catalogTemplate(e.type)!.defaultChoice);
      expect(e.data?.autoResolved).toBe(true);
    }
    // tradeDemand defaults to 'ignore': the star sours.
    expect(late.players[cast.star.id]?.morale.morale).toBe(24);
    expect(late.club?.playerFlags[cast.star.id]).toContain('disgruntled');
    expect(leagueClock(season)).toBe(raised);
  });
});

describe('flags feed back into the triggers', () => {
  it('a star already on the trade block stops demanding a trade', () => {
    const shopped = resolveEvent(addEvents(season, run.batches[0] ?? []), firstOf(run.batches[0] ?? [], 'tradeDemand').id, 'shop');
    const later = generateEvents(shopped, week + 20, createRng(3), { teamIds: [cast.team.id] });
    expect(later.some((e) => e.type === 'tradeDemand' && e.playerId === cast.star.id)).toBe(false);
  });
});
