import { describe, expect, it } from 'vitest';
import type { PlayerId, TeamId } from '@/core/ids';
import { assignPlayer } from '@/franchise/roster';
import { blockingRosterIssues, phaseRosterBlockers, rosterSizeBand, userRosterIssues } from '@/franchise/roster-rules';
import type { League, SeasonPhase } from '@/franchise/types';
import { byAbbr, makeLeague } from './helpers';

const base = makeLeague(17);
const bos = byAbbr(base, 'BOS');
const at = (league: League, phase: SeasonPhase): League => ({ ...league, season: { ...league.season, phase, week: 0 } });
const kinds = (league: League, id: TeamId = bos.id): string[] => blockingRosterIssues(league, id).map((i) => i.kind).sort();
const release = (league: League, ids: readonly PlayerId[]): League => ids.reduce((l, id) => assignPlayer(l, id, null), league);

describe('userRosterIssues', () => {
  it('finds nothing wrong with a freshly generated roster', () => {
    expect(bos.rosterIds.length).toBeGreaterThanOrEqual(53);
    expect(kinds(base)).toEqual([]);
    expect(kinds(at(base, 'trainingCamp'))).toEqual([]);
  });

  it('uses the 53-55 band once final cuts are due and a loose ceiling earlier in the offseason', () => {
    expect(rosterSizeBand(base, 'trainingCamp')).toEqual([53, 55]);
    expect(rosterSizeBand(base, 'regularSeason')).toEqual([53, 55]);
    const [min, max] = rosterSizeBand(base, 'freeAgency');
    expect(min).toBe(0);
    expect(max).toBeGreaterThan(55);
  });

  it('blocks a short roster, an empty position and the depth chart that cannot field it', () => {
    const kickers = bos.rosterIds.filter((id) => base.players[id]?.position === 'K');
    const extras = bos.rosterIds.filter((id) => base.players[id]?.position === 'CB').slice(0, 2);
    const short = at(release(base, [...kickers, ...extras]), 'postDraft');
    const issues = userRosterIssues(short, bos.id);
    expect(issues.find((i) => i.kind === 'emptyPosition')).toMatchObject({ severity: 'blocking', position: 'K', amount: 1 });
    expect(issues.some((i) => i.kind === 'invalidDepthChart' && i.position === 'K' && i.severity === 'blocking')).toBe(true);
    const size = short.teams[bos.id]!.rosterIds.length;
    expect(size).toBeLessThan(53);
    expect(issues.find((i) => i.kind === 'rosterTooSmall')).toMatchObject({ severity: 'blocking', amount: 53 - size });
    // The same holes are only warnings while the offseason still has time to fix them.
    expect(blockingRosterIssues(at(short, 'freeAgency'), bos.id)).toEqual([]);
    expect(userRosterIssues(at(short, 'freeAgency'), bos.id).some((i) => i.kind === 'emptyPosition' && i.severity === 'warning')).toBe(true);
  });

  it('blocks a bloated roster and a team over the cap', () => {
    const fa = Object.values(base.players).filter((p) => p.teamId === null).slice(0, 4);
    let big: League = base;
    for (const p of fa) big = assignPlayer(big, p.id, bos.id);
    const extra = big.teams[bos.id]!.rosterIds.length - 55;
    expect(extra).toBeGreaterThan(0);
    expect(userRosterIssues(big, bos.id).find((i) => i.kind === 'rosterTooLarge')).toMatchObject({ severity: 'blocking', amount: extra });
    const team = base.teams[bos.id]!;
    const broke = at({ ...base, teams: { ...base.teams, [bos.id]: { ...team, finances: { ...team.finances, deadMoney: { ...team.finances.deadMoney, [base.year + 1]: 400_000_000 } } } } }, 'trainingCamp');
    const over = userRosterIssues(broke, bos.id).find((i) => i.kind === 'overCap');
    expect(over).toMatchObject({ severity: 'blocking' });
    expect(over!.amount).toBeGreaterThan(0);
    expect(over!.message).toMatch(new RegExp(`over the ${base.year + 1} cap`));
  });

  it('gates only postDraft and trainingCamp, and only for the user team', () => {
    const kickers = bos.rosterIds.filter((id) => base.players[id]?.position === 'K');
    const broken = release(base, kickers);
    expect(phaseRosterBlockers(at(broken, 'trainingCamp')).length).toBeGreaterThan(0);
    expect(phaseRosterBlockers(at(broken, 'postDraft')).length).toBeGreaterThan(0);
    expect(phaseRosterBlockers(at(broken, 'freeAgency'))).toEqual([]);
    expect(phaseRosterBlockers(at({ ...broken, userTeamId: null }, 'trainingCamp'))).toEqual([]);
    expect(userRosterIssues(base, 'nope' as TeamId)[0]?.kind).toBe('unknownTeam');
  });
});
