import { describe, expect, it } from 'vitest';
import type { PlayerId } from '@/core/ids';
import { capHit, contractEndYear, createContract, leagueCapYear, minimumSalaryFor, yearsRemainingAt } from '@/franchise/contracts';
import type { League } from '@/franchise/types';
import type { Player } from '@/players/types';
import {
  applyTag, compareKeys, compareRows, focusLabel, focusOptions, isOnTradingBlock, ownPlayer, playerActions, releaseCheck, releasePlayer,
  restructureCheck, restructurePlayer, restructurePreview, setTrainingFocus, tagOptions, tagWindowReason, toggleTradingBlock,
} from '@/ui/franchise/team/player-actions';
import { baseLeague, inPhase, userId, userPlayer, withPlayer } from './helpers';

const multiYear = (league: League): Player => userPlayer(league, undefined, (p) => {
  const c = p.contract;
  const year = leagueCapYear(league);
  return !!c && yearsRemainingAt(c, year) >= 3 && c.salary > minimumSalaryFor(p.experience, league.settings) + 1_000_000;
});

/** League in the re-signing window with `p` on an expiring deal (ends with the finished season). */
const expiringIn = (league: League, p: Player, salary = 5_000_000): League => {
  const off = inPhase(league, 'resigning');
  const contract = createContract({ salary, years: 1, guaranteed: 0, signingBonus: 0, role: 'starter', year: off.year });
  return withPlayer(off, { ...p, contract });
};

describe('restructure', () => {
  it('previews the savings and converts salary into prorated bonus', () => {
    const league = baseLeague();
    const team = userId(league);
    const p = multiYear(league);
    const check = restructureCheck(league, team, p.id);
    expect(check.ok).toBe(true);
    expect(check.max).toBe((p.contract?.salary ?? 0) - check.minimumSalary);
    const amount = 1_000_000;
    const prev = restructurePreview(league, p.id, amount);
    expect(prev.savings).toBeGreaterThan(0);
    expect(prev.years[0]?.before).toBe(capHit(p.contract, leagueCapYear(league)));
    expect(prev.years[0]?.after).toBe((prev.years[0]?.before ?? 0) - prev.savings);
    const r = restructurePlayer(league, team, p.id, amount);
    expect(r.ok).toBe(true);
    const next = r.league.players[p.id]?.contract;
    expect(next?.restructured).toBe(true);
    expect(next?.salary).toBe((p.contract?.salary ?? 0) - amount);
    expect(capHit(next, leagueCapYear(league))).toBe(prev.years[0]?.after);
    expect(prev.years[1]?.after).toBe(capHit(next, leagueCapYear(league) + 1));
    expect(prev.years).toHaveLength(yearsRemainingAt(p.contract as never, leagueCapYear(league)));
    expect(r.message).toContain('saves');
    expect(restructurePlayer(league, team, p.id, check.max + 1).ok).toBe(false);
    expect(restructurePreview(league, p.id, 0)).toEqual({ savings: 0, years: [] });
  });
  it('refuses short deals, minimum salaries and other teams', () => {
    const league = baseLeague();
    const team = userId(league);
    const p = multiYear(league);
    const oneYear = withPlayer(league, { ...p, contract: createContract({ salary: 5_000_000, years: 1, guaranteed: 0, signingBonus: 0, role: 'starter', year: league.year }) });
    expect(restructureCheck(oneYear, team, p.id).reason).toContain('two or more');
    const minimum = withPlayer(league, { ...p, contract: createContract({ salary: minimumSalaryFor(p.experience, league.settings), years: 3, guaranteed: 0, signingBonus: 0, role: 'backup', year: league.year }) });
    expect(restructureCheck(minimum, team, p.id).reason).toContain('minimum');
    const other = Object.values(league.teams).find((t) => t.id !== team);
    expect(restructureCheck(league, other?.id ?? team, p.id).ok).toBe(false);
    expect(ownPlayer(league, other?.id ?? team, p.id)).toBeNull();
  });
});

describe('release', () => {
  it('previews dead money and releases into free agency', () => {
    const league = baseLeague();
    const team = userId(league);
    const p = multiYear(league);
    const check = releaseCheck(league, team, p.id);
    expect(check.ok).toBe(true);
    expect(check.rosterAfter).toBe((league.teams[team]?.rosterIds.length ?? 0) - 1);
    expect(check.warning).toContain('minimum');
    const r = releasePlayer(league, team, p.id);
    expect(r.ok).toBe(true);
    expect(r.league.players[p.id]?.teamId).toBeNull();
    expect(r.league.freeAgentIds).toContain(p.id);
    expect(r.league.teams[team]?.rosterIds).not.toContain(p.id);
    const year = leagueCapYear(league);
    expect(r.league.teams[team]?.finances.deadMoney[year] ?? 0).toBe(check.deadThisYear);
    expect(releasePlayer(r.league, team, p.id).ok).toBe(false);
    const off = inPhase(league, 'offseason');
    expect(releaseCheck(off, team, p.id).warning).toBeNull();
  });
});

describe('tags', () => {
  it('opens only in the offseason for expiring deals, once per team, within the cap', () => {
    const league = baseLeague();
    const team = userId(league);
    const [a, b] = league.teams[team]?.rosterIds.map((id) => league.players[id] as Player).filter((p) => p.position === 'WR') ?? [];
    if (!a || !b) throw new Error('two WRs');
    expect(tagWindowReason(league, team, a.id)).toContain('offseason');
    let off = expiringIn(expiringIn(league, a), b);
    expect(contractEndYear(off.players[a.id]?.contract ?? a.contract as never)).toBeLessThan(leagueCapYear(off));
    expect(tagWindowReason(off, team, a.id)).toBeNull();
    const options = tagOptions(off, team, a.id);
    expect(options.map((o) => o.kind)).toEqual(['franchise', 'transition']);
    expect(options.every((o) => o.ok)).toBe(true);
    expect(options[0]?.salary ?? 0).toBeGreaterThanOrEqual(options[1]?.salary ?? 0);
    const r = applyTag(off, team, a.id, 'franchise');
    expect(r.ok).toBe(true);
    const tagged = r.league.players[a.id]?.contract;
    expect(tagged?.tag).toBe('franchise');
    expect(tagged?.years).toBe(1);
    expect(tagged?.signedYear).toBe(leagueCapYear(off));
    expect(tagged?.guaranteed).toBe(tagged?.salary);
    off = r.league;
    expect(tagWindowReason(off, team, a.id)).toBe('Already tagged this offseason');
    expect(tagWindowReason(off, team, b.id)).toContain('already used');
    expect(applyTag(off, team, b.id, 'transition').ok).toBe(false);
    const current = multiYear(league);
    expect(tagWindowReason(inPhase(league, 'resigning'), team, current.id)).toContain('expiring');
    const fa = { ...expiringIn(league, a), freeAgency: { round: 1, maxRounds: 3, offers: [], signings: [] } };
    expect(tagWindowReason(fa, team, a.id)).toContain('before free agency');
  });
  it('refuses a tag that breaks the cap', () => {
    const league = baseLeague();
    const team = userId(league);
    const a = userPlayer(league, 'CB');
    const off = expiringIn(league, a);
    const t = off.teams[team];
    if (!t) throw new Error('team');
    const year = leagueCapYear(off);
    const broke: League = { ...off, teams: { ...off.teams, [team]: { ...t, finances: { ...t.finances, deadMoney: { [year]: off.settings.salaryCap * 2, [year + 1]: off.settings.salaryCap * 2 } } } } };
    const options = tagOptions(broke, team, a.id);
    expect(options.every((o) => !o.ok && (o.reason ?? '').startsWith('Cap:'))).toBe(true);
    expect(applyTag(broke, team, a.id, 'franchise').reason).toContain('Cap:');
    expect(applyTag(broke, team, 'p_missing' as PlayerId, 'franchise').ok).toBe(false);
  });
});

describe('flags, focus and comparison', () => {
  it('toggles the trading block and sets a valid training focus', () => {
    const league = baseLeague();
    const team = userId(league);
    const qb = userPlayer(league, 'QB');
    const on = toggleTradingBlock(league, team, qb.id);
    expect(on.ok).toBe(true);
    expect(isOnTradingBlock(on.league, qb.id)).toBe(true);
    const off = toggleTradingBlock(on.league, team, qb.id);
    expect(isOnTradingBlock(off.league, qb.id)).toBe(false);
    expect(off.league.club?.playerFlags[qb.id]).toBeUndefined();
    const opts = focusOptions(qb);
    expect(opts[0]?.id).toBe('balanced');
    expect(opts.map((o) => o.id)).toContain('throwAccuracy');
    const set = setTrainingFocus(league, team, qb.id, 'throwAccuracy');
    expect(set.league.players[qb.id]?.trainingFocus).toBe('throwAccuracy');
    expect(focusLabel(set.league.players[qb.id] as Player)).toBe('Throw Accuracy');
    expect(setTrainingFocus(set.league, team, qb.id, null).league.players[qb.id]?.trainingFocus).toBeNull();
    const bad = opts.some((o) => o.id === 'kickPower') ? null : setTrainingFocus(league, team, qb.id, 'kickPower');
    if (bad) expect(bad.ok).toBe(false);
  });
  it('compares the position group and lists every action', () => {
    const league = baseLeague();
    const team = userId(league);
    const wr = userPlayer(league, 'WR');
    const rows = compareRows(league, team, wr.id);
    expect(rows.length).toBeGreaterThan(1);
    expect(rows.filter((r) => r.self)).toHaveLength(1);
    expect(rows.every((r) => league.players[r.id]?.position === 'WR')).toBe(true);
    expect(compareKeys(wr)).toHaveLength(4);
    const actions = playerActions(league, team, wr.id);
    expect(actions.map((a) => a.id)).toEqual(['extend', 'restructure', 'release', 'tag', 'block', 'focus', 'compare']);
    expect(actions.find((a) => a.id === 'tag')?.enabled).toBe(false);
    expect(actions.find((a) => a.id === 'extend')?.detail.text).toContain('Asks');
    const other = Object.values(league.teams).find((t) => t.id !== team);
    const theirs = other?.rosterIds[0];
    expect(playerActions(league, team, theirs as PlayerId)).toEqual([]);
    expect(compareRows(league, team, 'p_missing' as PlayerId)).toEqual([]);
  });
});
