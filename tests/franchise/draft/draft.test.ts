import { beforeAll, describe, expect, it } from 'vitest';
import { createRng } from '@/core/rng';
import type { PlayerId, TeamId } from '@/core/ids';
import { loadTeamData } from '@/teams/data';
import type { DraftState, League } from '@/franchise/types';
import { trueProspectValue } from '@/franchise/prospects';
import { minimumSalaryFor } from '@/franchise/contracts';
import { rosterErrors } from '@/franchise/roster';
import { validateLeague } from '@/save/serialize';
import {
  advanceDraft, currentPick, finishDraft, isUserOnTheClock, makePick, offseasonRosterLimit, onTheClock, openScouting,
  runDraftToEnd, simToUserPick, startDraft, weeklyScouting,
} from '@/franchise/draft';
import { setUserBoard } from '@/franchise/draft-board';
import { YEAR, makeLeague, teamIds, withAttrition, withPlayoffs, withRecords } from './helpers';

const USER_ABBR = loadTeamData()[5]!.abbr;
const SLOW = 60_000;
const prepared = (seed: number): League =>
  withAttrition(withPlayoffs(withRecords(makeLeague(seed, { userTeamAbbr: USER_ABBR }), createRng(seed + 1))).league, 5);
const capHitOf = (c: { salary: number; signingBonus: number; years: number }): number => c.salary + c.signingBonus / c.years;

describe('a full draft run to the end', () => {
  let started: League;
  let done: League;
  let draft: DraftState;
  beforeAll(() => {
    started = startDraft(prepared(71), createRng(72));
    done = runDraftToEnd(started, createRng(73));
    draft = done.draft as DraftState;
  }, SLOW);

  it('makes all 224 picks and completes', () => {
    expect(started.draft!.order).toHaveLength(224);
    expect(draft.selections).toHaveLength(224);
    expect(draft.selections.map((s) => s.pick.overall)).toEqual(draft.selections.map((_, i) => i + 1));
    expect(new Set(draft.selections.map((s) => s.playerId)).size).toBe(224);
    expect(draft.complete).toBe(true);
    expect(draft.prospects).toEqual([]);
    expect(currentPick(draft)).toBeNull();
    for (const id of teamIds(done)) expect(draft.selections.filter((s) => s.pick.ownerTeamId === id)).toHaveLength(7);
  });

  it('puts every drafted player on his team with a rookie contract and DraftInfo', () => {
    const round1 = draft.selections.filter((s) => s.pick.round === 1);
    draft.selections.forEach((s) => {
      const p = done.players[s.playerId]!;
      const team = s.pick.ownerTeamId;
      expect(p.teamId).toBe(team);
      expect(done.teams[team]!.rosterIds).toContain(p.id);
      expect(done.freeAgentIds).not.toContain(p.id);
      expect(p.draft).toEqual({ year: YEAR, round: s.pick.round, pick: draft.order.filter((o) => o.round === s.pick.round).findIndex((o) => o.id === s.pick.id) + 1, overall: s.pick.overall, teamId: team });
      expect(p.contract).not.toBeNull();
      expect(p.contract!.signedYear).toBe(YEAR + 1);
      expect(p.contract!.yearsRemaining).toBe(p.contract!.years);
      expect(p.contract!.salary).toBeGreaterThanOrEqual(done.settings.minimumSalary);
      expect(p.experience).toBe(0);
      expect(p.rookieYear).toBe(YEAR + 1);
    });
    expect(round1.map((s) => done.players[s.playerId]!.draft!.pick)).toEqual(round1.map((_, i) => i + 1));
    const first = done.players[draft.selections[0]!.playerId]!.contract!;
    const last = done.players[draft.selections[223]!.playerId]!.contract!;
    expect(capHitOf(first)).toBeGreaterThan(capHitOf(last) * 5);
  });

  it('drafts better players earlier (by truth, on average) even though teams only see reports', () => {
    const meanValue = (round: number): number => {
      const ps = draft.selections.filter((s) => s.pick.round === round).map((s) => trueProspectValue(done.players[s.playerId]!));
      return ps.reduce((a, b) => a + b, 0) / ps.length;
    };
    expect(meanValue(1)).toBeGreaterThan(meanValue(3));
    expect(meanValue(3)).toBeGreaterThan(meanValue(7));
  });

  it('keeps rosters within the 60-man offseason limit and every roster invariant', () => {
    expect(offseasonRosterLimit(done)).toBe(60);
    for (const id of teamIds(done)) expect(done.teams[id]!.rosterIds.length).toBeLessThanOrEqual(60);
    expect(rosterErrors(done)).toEqual([]);
    expect(() => validateLeague(done)).not.toThrow();
    for (const s of draft.selections) {
      const p = done.players[s.playerId]!;
      expect(done.teams[p.teamId!]!.depthChart[p.position]).toContain(p.id);
    }
  });

  it('signs undrafted free agents to minimum deals and releases the rest to free agency', () => {
    const undrafted = draft.undrafted ?? [];
    expect(undrafted).toHaveLength(260 - 224);
    const signed = undrafted.filter((u) => u.teamId !== null);
    expect(signed.length).toBeGreaterThan(10);
    for (const u of undrafted) {
      const p = done.players[u.playerId]!;
      expect(p.draft).toBeNull();
      expect(p.teamId).toBe(u.teamId);
      if (u.teamId === null) {
        expect(done.freeAgentIds).toContain(p.id);
        expect(p.contract).toBeNull();
      } else {
        expect(u.teamId).not.toBe(done.userTeamId);
        expect(p.contract!.salary).toBe(minimumSalaryFor(0, done.settings));
        expect(p.contract!.guaranteed).toBe(0);
      }
    }
  });

  it('retires used picks, rolls the pick window forward and keeps only the user\'s reports', () => {
    for (const id of teamIds(done)) {
      const picks = done.teams[id]!.picks;
      expect(picks.some((p) => p.year <= YEAR)).toBe(false);
      expect(new Set(picks.map((p) => p.year))).toEqual(new Set([YEAR + 1, YEAR + 2, YEAR + 3]));
      expect(picks).toHaveLength(21);
    }
    expect(Object.keys(draft.reports)).toEqual([done.userTeamId]);
  });

  it('is deterministic for the same seeds', () => {
    const again = runDraftToEnd(startDraft(prepared(71), createRng(72)), createRng(73));
    expect(again.draft!.selections).toEqual(draft.selections);
    expect(again.draft!.undrafted).toEqual(draft.undrafted);
    expect(again.teams).toEqual(done.teams);
  }, SLOW);

  it('is a no-op to advance or finish a completed draft; restarting it throws', () => {
    expect(advanceDraft(done, createRng(1))).toBe(done);
    expect(finishDraft(done, createRng(1))).toBe(done);
    expect(() => startDraft(done, createRng(1))).toThrow(/already complete/);
  });
});

describe('the user on the clock', () => {
  let started: League;
  let atUser: League;
  beforeAll(() => {
    started = startDraft(prepared(81), createRng(82));
    atUser = simToUserPick(started, createRng(83));
  }, SLOW);

  it('stops the AI at the user\'s pick and requires a choice', () => {
    expect(isUserOnTheClock(atUser)).toBe(true);
    expect(onTheClock(atUser)).toBe(atUser.userTeamId);
    expect(atUser.draft!.selections.every((s) => s.pick.ownerTeamId !== atUser.userTeamId)).toBe(true);
    expect(() => advanceDraft(atUser, createRng(1))).toThrow(/user team is on the clock/);
    const stopped = runDraftToEnd(started, createRng(83), { autoPickUser: false });
    expect(stopped.draft!.currentPickIndex).toBe(atUser.draft!.currentPickIndex);
    expect(startDraft(atUser, createRng(5))).toBe(atUser);
  });

  it('drafts the user\'s explicit choice onto the user roster without reshuffling his depth chart', () => {
    const user = atUser.userTeamId as TeamId;
    const choice = atUser.draft!.prospects[atUser.draft!.prospects.length - 1]!;
    const before = atUser.teams[user]!.depthChart[choice.player.position];
    const next = advanceDraft(atUser, createRng(2), choice.player.id);
    expect(next.players[choice.player.id]!.teamId).toBe(user);
    const after = next.teams[user]!.depthChart[choice.player.position];
    expect(after.filter((id) => id !== choice.player.id)).toEqual(before);
    expect(after).toContain(choice.player.id);
    expect(() => makePick(next, choice.player.id)).toThrow(/not available/);
  });

  it('auto-picks from the user board first', () => {
    const pick = atUser.draft!.prospects[20]!.player.id;
    const boarded = { ...atUser, draft: setUserBoard(atUser.draft!, [pick]) };
    const next = advanceDraft(boarded, createRng(3), 'auto');
    expect(next.draft!.selections.at(-1)!.playerId).toBe(pick);
    expect(next.draft!.userBoard).toEqual([]);
  });

  it('validates picks and the finishing order', () => {
    expect(() => makePick(atUser, 'p_missing' as PlayerId)).toThrow(/not available/);
    expect(() => finishDraft(atUser, createRng(1))).toThrow(/picks remain/);
    expect(() => makePick(makeLeague(1), 'p_x' as PlayerId)).toThrow(/no draft in progress/);
  });
});

describe('traded picks and the scouting season', () => {
  it('sends the player to the pick\'s current owner', () => {
    const base = startDraft(prepared(91), createRng(92));
    const firstPick = base.draft!.order[0]!;
    const original = firstPick.originalTeamId;
    const receiver = teamIds(base).find((t) => t !== original && t !== base.userTeamId)!;
    const moved = base.teams[original]!.picks.find((p) => p.id === firstPick.id)!;
    const traded: League = {
      ...base,
      teams: {
        ...base.teams,
        [original]: { ...base.teams[original]!, picks: base.teams[original]!.picks.filter((p) => p.id !== firstPick.id) },
        [receiver]: { ...base.teams[receiver]!, picks: [...base.teams[receiver]!.picks, { ...moved, ownerTeamId: receiver }] },
      },
    };
    expect(onTheClock(traded)).toBe(receiver);
    const next = advanceDraft(traded, createRng(1), 'auto');
    const sel = next.draft!.selections[0]!;
    expect(sel.pick.ownerTeamId).toBe(receiver);
    expect(next.players[sel.playerId]!.teamId).toBe(receiver);
    expect(next.players[sel.playerId]!.draft!.teamId).toBe(receiver);
    expect(next.teams[receiver]!.picks.some((p) => p.id === firstPick.id)).toBe(false);
  }, SLOW);

  it('banks the user\'s weekly points, lets AI teams spend theirs, and reuses the scouted class at the draft', () => {
    const open = openScouting(prepared(95), createRng(96));
    expect(openScouting(open, createRng(97))).toBe(open);
    const scouted = weeklyScouting(open, createRng(98), 3);
    const d = scouted.draft!;
    const user = scouted.userTeamId as TeamId;
    expect(d.scouting[user]!.pointsAvailable).toBeGreaterThan(0);
    expect(Object.keys(d.scouting[user]!.invested)).toHaveLength(0);
    const ai = teamIds(scouted).find((t) => t !== user)!;
    expect(Object.keys(d.scouting[ai]!.invested).length).toBeGreaterThan(3);
    expect(d.scouting[ai]!.pointsAvailable).toBeLessThan(d.scouting[user]!.pointsAvailable);
    const started = startDraft(scouted, createRng(99));
    expect(started.draft!.prospects.map((p) => p.player.id)).toEqual(d.prospects.map((p) => p.player.id));
    expect(started.draft!.scouting[ai]!.invested).toEqual(d.scouting[ai]!.invested);
    expect(started.draft!.prospects.every((p) => p.proDay !== null)).toBe(true);
    expect(started.draft!.order).toHaveLength(224);
    expect(() => weeklyScouting(makeLeague(1), createRng(1))).toThrow(/no open 2026 draft class/);
    expect(() => weeklyScouting({ ...scouted, year: YEAR + 1 }, createRng(1))).toThrow(/no open 2027 draft class/);
  }, SLOW);
});
