import { describe, expect, it } from 'vitest';
import type { PlayerId, TeamId } from '@/core/ids';
import type { Player } from '@/players/types';
import { chemistryFor, lineupChemistry, pairChemistry, seasonsWithTeam } from '@/game/chemistry';
import { buildPlayContext } from '@/game/play-context';
import { throwDifficulty } from '@/game/systems/passing';
import { createRng } from '@/core/rng';
import { simulatePlay } from '@/simulation/fast-sim';
import { buildPlayState } from '../fixtures/play-state';
import { makeCtx, PASS_PLAYS, DEF_PLAYS, variantOf } from '../simulation/helpers';
import { makeSetup, situation, OFFENSE_PLAYS, DEFENSE_PLAYS } from './fixtures';

const TEAM = 't_home' as TeamId;
type Tenure = Pick<Player, 'id' | 'rookieYear' | 'experience' | 'draft' | 'contract' | 'teamId'>;
const player = (id: string, joined: number, drafted = false): Tenure => ({
  id: id as PlayerId, rookieYear: drafted ? joined : 2020, experience: 2030 - (drafted ? joined : 2020), teamId: TEAM,
  draft: drafted ? { year: joined, round: 1, pick: 1, overall: 1, teamId: TEAM } : null,
  contract: { salary: 1, years: 3, yearsRemaining: 2, guaranteed: 0, signingBonus: 0, role: 'starter', signedYear: joined, restructured: false, tag: null },
});

describe('QB-receiver chemistry', () => {
  it('grows with the seasons a pair has shared on the roster and with team chemistry', () => {
    const qb = player('qb', 2024, true);
    expect(seasonsWithTeam(qb, TEAM)).toBe(6);
    const newcomer = player('wr-new', 2030);
    const veteran = player('wr-vet', 2026);
    expect(seasonsWithTeam(newcomer, TEAM)).toBe(0);
    const cold = pairChemistry(qb, newcomer, TEAM);
    const warm = pairChemistry(qb, veteran, TEAM);
    expect(warm).toBeGreaterThan(cold + 0.4);
    expect(cold).toBeLessThan(0.5);
    expect(pairChemistry(qb, veteran, TEAM, 90)).toBeGreaterThan(warm);
    expect(pairChemistry(qb, veteran, TEAM, 10)).toBeLessThan(warm);
    expect(chemistryFor(undefined, 'x' as PlayerId)).toBe(0.5);
    expect(chemistryFor({ ['x' as PlayerId]: 0.9 }, 'x' as PlayerId)).toBe(0.9);
  });

  it('the play context carries the lineup QB\'s chemistry with every teammate on the field', () => {
    const setup = makeSetup();
    const s = situation(setup, { possession: 'home' });
    const play = OFFENSE_PLAYS.find((p) => p.id === 'pass-curl')!;
    const ctx = buildPlayContext(s, setup, play, DEFENSE_PLAYS[0]!, createRng(1));
    const qb = ctx.offenseLineup['QB']!;
    const map = ctx.passChemistry!;
    expect(map[qb.id]).toBeUndefined();
    for (const [role, p] of Object.entries(ctx.offenseLineup)) if (role !== 'QB') expect(map[p.id]).toBeGreaterThanOrEqual(0);
    expect(lineupChemistry(ctx.offenseLineup, setup.home.team.id, setup.home.team.chemistry)).toEqual(map);
  });

  it('the live throw is harder to a receiver the QB has no chemistry with', () => {
    const fx = buildPlayState({ offensePlayId: 'shotgun-mesh', defensePlayId: '43-cover3-zone', seed: 3 });
    const s = fx.state;
    const qb = s.athletes.find((a) => a.id === 'off:QB')!;
    const wr = s.athletes.find((a) => a.id === 'off:WR2')!;
    const aim = { x: wr.pos.x, y: wr.pos.y + 10 * s.ctx.direction };
    s.ctx = { ...s.ctx, passChemistry: { [wr.playerId]: 0 } };
    const cold = throwDifficulty(s, qb, wr, aim, 'bullet').difficulty;
    s.ctx = { ...s.ctx, passChemistry: { [wr.playerId]: 1 } };
    const synced = throwDifficulty(s, qb, wr, aim, 'bullet').difficulty;
    expect(cold - synced).toBeCloseTo(0.12, 5);
  });

  it('the statistical model completes more passes for a pair in sync than for strangers', () => {
    const rate = (chem: number): number => {
      let att = 0;
      let comp = 0;
      PASS_PLAYS.forEach((p, pi) => DEF_PLAYS.forEach((d, di) => {
        const base = makeCtx({ offensePlayId: p, defensePlayId: d, seed: pi * 31 + di });
        const map: Record<PlayerId, number> = {};
        for (const pl of Object.values(base.offenseLineup)) map[pl.id] = chem;
        for (let v = 0; v < 3; v++) {
          const o = simulatePlay(variantOf(base, v, { passChemistry: map }));
          if (o.result === 'pass' || o.result === 'incomplete' || o.result === 'interception') { att++; if (o.result === 'pass') comp++; }
        }
      }));
      return comp / att;
    };
    expect(rate(1) - rate(0)).toBeGreaterThan(0.03);
  });
});
