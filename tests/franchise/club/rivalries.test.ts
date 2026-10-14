import { describe, expect, it } from 'vitest';
import {
  RIVALRY_TUNING, ensureClub, isRivalryGame, rivalryEffects, rivalryIntensity, rivalryKey, rivalryLedgerEntry, topRivals, updateRivalryLedger, withClub,
} from '@/franchise/rivalries';
import { clubLeague, divisionPair, finishedGame } from './helpers';

const league = clubLeague();
const { a, b, far } = divisionPair(league);

describe('club state access', () => {
  it('ensureClub fills every field without touching the league', () => {
    expect(league.club).toBeUndefined();
    const club = ensureClub(league);
    expect(club.rivalries).toEqual({});
    expect(club.tenure).toEqual({});
    expect(club.retiredCoachIds).toEqual([]);
    const next = withClub(league, { ownerSubsidy: { [a.id]: 5 } });
    expect(next.club?.ownerSubsidy[a.id]).toBe(5);
    expect(next.club?.rivalries).toEqual({});
    expect(league.club).toBeUndefined();
  });
});

describe('rivalries', () => {
  it('flags division games as rivalry games and leaves far-away non-rivals alone', () => {
    expect(rivalryIntensity(league, a.id, b.id)).toBeGreaterThanOrEqual(RIVALRY_TUNING.threshold);
    expect(isRivalryGame({ home: a.id, away: b.id }, league)).toBe(true);
    expect(isRivalryGame({ home: b.id, away: a.id }, league)).toBe(true);
    expect(isRivalryGame({ home: a.id, away: far.id }, league)).toBe(false);
    expect(rivalryIntensity(league, a.id, a.id)).toBe(0);
  });

  it('named rivals from the team data add to the structural intensity', () => {
    const t = Object.values(league.teams).find((x) => x.rivalIds.length > 0);
    const r = t?.rivalIds[0] ? league.teams[t.rivalIds[0]] : undefined;
    expect(t && r).toBeTruthy();
    if (!t || !r) return;
    const R = RIVALRY_TUNING;
    const structure = t.conference === r.conference ? (t.division === r.division ? R.division : R.conference) : 0;
    expect(rivalryIntensity(league, t.id, r.id)).toBe(structure + R.named);
    expect(isRivalryGame({ home: t.id, away: r.id }, league)).toBe(structure + R.named >= R.threshold);
  });

  it('intensity grows with close games and playoff meetings', () => {
    const base = rivalryIntensity(league, a.id, far.id);
    const close = [1, 2, 3].map((w) => finishedGame(a.id, far.id, 24, 21, { week: w }));
    const afterClose = updateRivalryLedger(league, close);
    expect(rivalryIntensity(afterClose, a.id, far.id)).toBe(base + 3 * RIVALRY_TUNING.perCloseGame);
    const blowout = updateRivalryLedger(league, [finishedGame(a.id, far.id, 45, 3)]);
    expect(rivalryIntensity(blowout, a.id, far.id)).toBe(base);
    const playoff = updateRivalryLedger(afterClose, [finishedGame(far.id, a.id, 17, 10, { isPlayoff: true, playoffRound: 2, week: 2 })]);
    // Four meetings (a 3-1 series) also earn half of the even-series bonus.
    const R = RIVALRY_TUNING;
    expect(rivalryIntensity(playoff, a.id, far.id)).toBe(base + 4 * R.perCloseGame + R.perPlayoffMeeting + Math.round((1 - 2 / 4) * R.balance));
    expect(isRivalryGame({ home: a.id, away: far.id }, playoff)).toBe(rivalryIntensity(playoff, a.id, far.id) >= RIVALRY_TUNING.threshold);
  });

  it('the ledger records the series from the sorted pair and never counts a game twice', () => {
    const g1 = finishedGame(a.id, b.id, 20, 17, { week: 3 });
    const g2 = finishedGame(b.id, a.id, 30, 10, { week: 9 });
    const g3 = finishedGame(a.id, b.id, 13, 13, { week: 12, overtime: true });
    let l = updateRivalryLedger(league, [g1]);
    l = updateRivalryLedger(l, [g1]);
    l = updateRivalryLedger(l, [g2, g3]);
    const e = rivalryLedgerEntry(l, b.id, a.id);
    expect(e).not.toBeNull();
    if (!e) return;
    expect(Object.keys(l.club?.rivalries ?? {})).toEqual([rivalryKey(a.id, b.id)]);
    expect(e.meetings).toBe(3);
    expect(e.closeGames).toBe(2);
    expect(e.ties).toBe(1);
    const aIndex = e.teams[0] === a.id ? 0 : 1;
    expect(e.wins[aIndex]).toBe(1);
    expect(e.wins[1 - aIndex]).toBe(1);
    expect(e.lastMargin).toBe(0);
    expect(e.lastYear).toBe(league.season.year);
  });

  it('preseason and unplayed games are ignored', () => {
    const pre = finishedGame(a.id, b.id, 10, 7, { isPreseason: true });
    const unplayed = { ...finishedGame(a.id, b.id, 0, 0), result: null };
    expect(updateRivalryLedger(league, [pre, unplayed])).toBe(league);
  });

  it('rivalry effects are neutral below the threshold and scale above it', () => {
    expect(rivalryEffects(RIVALRY_TUNING.threshold - 1)).toEqual({ fanMultiplier: 1, attendanceBoost: 0, atmosphereBonus: 0, moraleMultiplier: 1 });
    const mid = rivalryEffects(50);
    const hot = rivalryEffects(100);
    expect(hot.fanMultiplier).toBeGreaterThan(mid.fanMultiplier);
    expect(hot.attendanceBoost).toBeCloseTo(0.1);
    expect(hot.moraleMultiplier).toBeCloseTo(1.5);
    expect(hot.atmosphereBonus).toBe(8);
  });

  it('topRivals lists the division opponents among the strongest rivalries', () => {
    const top = topRivals(league, a.id, 3);
    expect(top).toHaveLength(3);
    expect(top.map((t) => t.teamId)).toContain(b.id);
    expect(top[0]?.intensity).toBeGreaterThanOrEqual(top[2]?.intensity ?? 0);
  });
});
