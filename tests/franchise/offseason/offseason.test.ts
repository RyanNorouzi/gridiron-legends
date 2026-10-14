import { describe, expect, it } from 'vitest';
import type { PlayerId, TeamId } from '@/core/ids';
import { createRng } from '@/core/rng';
import { closeClubSeason } from '@/franchise/events';
import { OFFSEASON_STEP_PHASES, offseasonChecklist, runOffseason, runOffseasonPhase, runOffseasonStep, type OffseasonEvent } from '@/franchise/offseason';
import { rosterErrors } from '@/franchise/roster';
import type { League, SeasonPhase } from '@/franchise/types';
import { deserializeLeague, serializeLeague } from '@/save/serialize';
import { DEPTH_SLOTS } from '@/teams/depth-chart';
import { playedSeason } from './helpers';

/** Local consistency check on top of roster.ts rosterErrors: retirement / HOF / awards invariants. */
const consistencyIssues = (league: League): string[] => {
  const issues = rosterErrors(league).map((i) => i.message);
  const onRoster = new Set<PlayerId>();
  for (const t of Object.values(league.teams)) {
    for (const id of t.rosterIds) onRoster.add(id);
    for (const slot of DEPTH_SLOTS) for (const id of t.depthChart[slot]) if (league.retiredPlayers[id]) issues.push(`${t.abbr} depth lists retired ${id}`);
  }
  for (const id of Object.keys(league.retiredPlayers) as PlayerId[]) {
    if (league.players[id]) issues.push(`${id} is active and retired`);
    if (onRoster.has(id)) issues.push(`${id} retired but rostered`);
    if (league.freeAgentIds.includes(id)) issues.push(`${id} retired but a free agent`);
    if (!league.retiredPlayers[id]!.retired || league.retiredPlayers[id]!.teamId !== null) issues.push(`${id} retired record not flagged`);
  }
  for (const h of league.hallOfFame) if (!league.retiredPlayers[h.playerId]) issues.push(`HOF ${h.playerId} is not retired`);
  for (const t of Object.values(league.teams)) if (t.headCoachId && league.coaches[t.headCoachId]?.teamId !== t.id) issues.push(`${t.abbr} head coach not attached`);
  return issues;
};

describe('runOffseason with no-op dependencies', () => {
  it('walks every phase into the next preseason and leaves a consistent, saveable League', () => {
    const season = playedSeason(7);
    const year = season.year;
    const visited: SeasonPhase[] = [];
    let league = season;
    while (league.season.phase !== 'preseason') {
      const r = runOffseasonStep(league, createRng(`step:${league.season.phase}`));
      visited.push(r.phase);
      expect(r.next).toBe(r.league.season.phase);
      league = r.league;
    }
    expect(visited).toEqual([...OFFSEASON_STEP_PHASES]);
    expect(league.year).toBe(year + 1);
    expect(league.season.year).toBe(year + 1);
    expect(consistencyIssues(league)).toEqual([]);
    const summary = league.history.find((h) => h.year === year)!;
    expect(summary.awards.map((a) => a.award)).toContain('MVP');
    expect(summary.mvp).toBe(summary.awards.find((a) => a.award === 'MVP')?.playerId);
    const flags = league.offseasonFlags!;
    expect(flags.year).toBe(year);
    expect(flags.done).toEqual(expect.arrayContaining(['awards', 'allPro', 'records', 'retirements', 'hallOfFame', 'aging', 'contracts', 'coaches', 'progression', 'camp']));
    expect(flags.warnings.some((w) => w.startsWith('freeAgency:'))).toBe(true);
    expect(flags.warnings.some((w) => w.startsWith('draft:'))).toBe(true);
    expect(flags.retired.length).toBeGreaterThan(0);
    for (const id of flags.retired) expect(league.retiredPlayers[id]).toBeDefined();
    expect(flags.preseasonRatings?.year).toBe(year + 1);
    const vet = Object.values(season.players).find((p) => p.teamId !== null && league.players[p.id])!;
    expect(league.players[vet.id]!.age).toBe(vet.age + 1);
    expect(league.players[vet.id]!.progressionLog.at(-1)?.year).toBe(year);
    const round = deserializeLeague(serializeLeague(league));
    expect(round.offseasonFlags).toEqual(league.offseasonFlags);
    expect(Object.keys(round.retiredPlayers).length).toBe(Object.keys(league.retiredPlayers).length);
  });

  it('is deterministic and emits events of every offseason kind', () => {
    const a = runOffseason(playedSeason(7), createRng(3));
    const b = runOffseason(playedSeason(7), createRng(3));
    expect(a.league).toEqual(b.league);
    expect(a.events).toEqual(b.events);
    const kinds = new Set(a.events.map((e) => e.type));
    for (const k of ['award', 'recordBroken', 'retirement', 'progression', 'campInjury'] as const) expect(kinds.has(k)).toBe(true);
    expect(a.league.season.phase).toBe('preseason');
    expect(a.camp.length).toBe(Object.keys(a.league.teams).length);
    expect(a.progression.length).toBeGreaterThan(1000);
  });

  it('hands events to the injected events engine instead of warning', () => {
    const received: OffseasonEvent[] = [];
    const out = runOffseason(playedSeason(7), createRng(3), { events: (l, evs) => { received.push(...evs); return l; } });
    expect(received.length).toBe(out.events.length);
    expect(out.warnings.some((w) => w.startsWith('events:'))).toBe(false);
  });

  it('stops at a requested phase', () => {
    const out = runOffseason(playedSeason(7), createRng(3), {}, { stopAt: 'freeAgency' });
    expect(out.league.season.phase).toBe('freeAgency');
    expect(out.league.offseasonFlags?.done).toContain('resigning');
    expect(out.league.offseasonFlags?.done).not.toContain('freeAgency');
  });
});

describe('idempotency', () => {
  it('re-running any phase\'s work does not apply it twice', () => {
    let league = playedSeason(7);
    while (league.season.phase !== 'preseason') {
      const first = runOffseasonPhase(league, createRng(1));
      const second = runOffseasonPhase(first.league, createRng(2));
      expect(second.league).toEqual(first.league);
      expect(second.events).toEqual([]);
      league = runOffseasonStep(first.league, createRng(3)).league;
    }
  });

  it('calls injected dependencies once per phase with the phase work', () => {
    const calls: string[] = [];
    const dep = (name: string) => (l: League): League => { calls.push(`${name}:${l.season.phase}`); return l; };
    const deps = { aiResign: dep('resign'), runFreeAgency: dep('fa'), runDraft: dep('draft'), postDraft: dep('post') };
    let league = playedSeason(7);
    while (league.season.phase !== 'preseason') {
      league = runOffseasonPhase(league, createRng(1), deps).league;
      league = runOffseasonStep(league, createRng(2), deps).league;
    }
    expect(calls).toEqual(['resign:resigning', 'fa:freeAgency', 'draft:draft', 'post:postDraft']);
    expect(league.offseasonFlags?.warnings.some((w) => /dependency injected; phase skipped/.test(w))).toBe(false);
  });

  it('refuses to run in a game phase', () => {
    const inSeason = { ...playedSeason(7), season: { ...playedSeason(7).season, phase: 'regularSeason' as const } };
    expect(() => runOffseasonPhase(inSeason, createRng(1))).toThrow(/not an offseason phase/);
  });
});

describe('coach step (club layer)', () => {
  const inOffseason = (): League => runOffseasonStep(playedSeason(7), createRng(1)).league;

  it('ages coaches exactly one year, and not again when the integrator already closed the club season', () => {
    const offseason = inOffseason();
    const direct = runOffseasonPhase(offseason, createRng(2)).league;
    const kept = Object.values(offseason.coaches).filter((c) => direct.coaches[c.id]);
    expect(kept.length).toBeGreaterThan(100);
    for (const c of kept) expect(direct.coaches[c.id]!.age).toBe(c.age + 1);
    const closed = closeClubSeason(offseason, createRng(5)).league;
    const after = runOffseasonPhase(closed, createRng(2)).league;
    for (const c of Object.values(closed.coaches)) if (after.coaches[c.id]) expect(after.coaches[c.id]!.age).toBe(c.age);
    expect(rosterErrors(after)).toEqual([]);
  });

  it('reports staff retirements and keeps the retired coaches resolvable for events and saves', () => {
    const offseason = inOffseason();
    const [t1] = Object.keys(offseason.teams).sort() as TeamId[];
    const hc = offseason.teams[t1!]!.headCoachId!;
    const old: League = { ...offseason, coaches: { ...offseason.coaches, [hc]: { ...offseason.coaches[hc]!, age: 80 } } };
    const r = runOffseasonPhase(old, createRng(2));
    const ev = r.events.find((e) => e.type === 'coachRetirement' && e.coachId === hc);
    expect(ev).toMatchObject({ type: 'coachRetirement', teamId: t1 });
    expect(r.league.coaches[hc]).toMatchObject({ teamId: null });
    expect(r.league.club?.retiredCoachIds).toContain(hc);
    expect(r.league.offseasonFlags?.retiredCoaches).toContain(hc);
    expect(r.league.teams[t1!]!.headCoachId).not.toBe(hc);
    expect(r.league.teams[t1!]!.staffIds).not.toContain(hc);
    expect(deserializeLeague(serializeLeague(r.league)).coaches[hc]).toBeDefined();
  });
});

describe('offseasonChecklist', () => {
  it('tracks done, pending and upcoming work with user details', () => {
    const season = playedSeason(7);
    const atAwards = offseasonChecklist(season);
    expect(atAwards.find((i) => i.key === 'awards')?.status).toBe('pending');
    expect(atAwards.find((i) => i.key === 'camp')?.status).toBe('upcoming');
    const offseason = runOffseasonStep(season, createRng(1)).league;
    const list = offseasonChecklist(offseason);
    expect(list.filter((i) => i.phase === 'awards').every((i) => i.status === 'done')).toBe(true);
    expect(list.find((i) => i.key === 'retirements')?.status).toBe('pending');
    const afterWork = offseasonChecklist(runOffseasonPhase(offseason, createRng(2)).league);
    expect(afterWork.find((i) => i.key === 'retirements')?.status).toBe('done');
    expect(afterWork.find((i) => i.key === 'retirements')?.detail).toMatch(/\d+ retired/);
    expect(afterWork.find((i) => i.key === 'contracts')?.detail).toMatch(/expiring league-wide; next cap \$\d+M/);
    expect(afterWork.find((i) => i.key === 'resigning')?.detail).toMatch(/expiring contract/);
    const skipped = runOffseasonStep(runOffseasonStep(offseason, createRng(3)).league, createRng(4)).league;
    const sk = offseasonChecklist(skipped);
    expect(sk.find((i) => i.key === 'resigning')?.status).toBe('done');
    expect(sk.some((i) => i.status === 'info' && /no aiResign dependency/.test(i.detail))).toBe(true);
    const inSeason = { ...season, season: { ...season.season, phase: 'regularSeason' as const } };
    expect(offseasonChecklist(inSeason)).toEqual([]);
  });
});
