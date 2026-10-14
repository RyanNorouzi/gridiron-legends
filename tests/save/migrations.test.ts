import { afterEach, describe, expect, it } from 'vitest';
import {
  CURRENT_GAME_SAVE_VERSION, CURRENT_SAVE_VERSION, LEAGUE_DATA_VERSION, cloneData, currentVersion, installBuiltinMigrations, listMigrations,
  migrate, registerMigration, unregisterMigration, type Migration,
} from '@/save/migrations';
import { compactLeagueStatLines } from '@/statistics/compact';
import { SaveError } from '@/save/storage';
import { clone, makeLeague } from './fixtures';

const expectSaveError = (fn: () => unknown, code: SaveError['code'], pathContains = ''): void => {
  let caught: unknown;
  try {
    fn();
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(SaveError);
  expect((caught as SaveError).code).toBe(code);
  expect((caught as SaveError).path).toContain(pathContains);
};

const v0League = (): Record<string, unknown> => {
  const raw: Record<string, unknown> = clone(makeLeague()) as unknown as Record<string, unknown>;
  delete raw.version;
  raw.freeAgents = raw.freeAgentIds;
  delete raw.freeAgentIds;
  raw.rng = { seed: raw.rngSeed, state: raw.rngState };
  delete raw.rngSeed;
  delete raw.rngState;
  delete raw.retiredPlayers;
  delete raw.careerStats;
  delete raw.playLogs;
  const season = raw.season as Record<string, unknown>;
  delete season.stats;
  delete season.playoffStats;
  const players = raw.players as Record<string, Record<string, unknown>>;
  for (const p of Object.values(players)) {
    delete p.progressionLog;
    delete p.injuryHistory;
    delete p.trainingFocus;
  }
  return raw;
};

describe('built-in league migrations', () => {
  it('v0 → v1 renames prototype fields and adds missing collections without mutating the input', () => {
    const raw = v0League();
    const snapshot = clone(raw);
    const result = migrate(raw, { target: 1 });
    expect(raw).toEqual(snapshot);
    expect(result.fromVersion).toBe(0);
    expect(result.toVersion).toBe(1);
    expect(result.applied).toHaveLength(1);
    expect(result.applied[0]).toMatch(/v0→v1/);
    const full = migrate(raw);
    expect(full.toVersion).toBe(CURRENT_SAVE_VERSION);
    expect(full.applied).toHaveLength(2);
    expect(full.applied[1]).toMatch(/v1→v2/);
    expect(raw).toEqual(snapshot);
    const d = result.data;
    expect(d.version).toBe(1);
    expect(d.freeAgentIds).toEqual(['p_fa1']);
    expect(d.freeAgents).toBeUndefined();
    expect(d.rngSeed).toBe(42);
    expect(d.rngState).toEqual(makeLeague().rngState);
    expect(d.rng).toBeUndefined();
    expect(d.retiredPlayers).toEqual({});
    expect(d.careerStats).toEqual({});
    expect(d.playLogs).toEqual({});
    const season = d.season as Record<string, unknown>;
    expect(season.stats).toEqual({});
    expect(season.playoffStats).toEqual({});
    expect(season.teamStats).toEqual(makeLeague().season.teamStats);
    const qb = (d.players as Record<string, Record<string, unknown>>).p_qb1!;
    expect(qb.progressionLog).toEqual([]);
    expect(qb.injuryHistory).toEqual([]);
    expect(qb.trainingFocus).toBeNull();
    expect(qb.teamId).toBe('t_harbor');
  });

  it('v1 → v2 stores the stat lines compact, without mutating the input', () => {
    const league = makeLeague();
    expect(league.version).toBe(LEAGUE_DATA_VERSION);
    const snapshot = clone(league);
    const result = migrate(league);
    expect(league).toEqual(snapshot);
    expect(result.fromVersion).toBe(1);
    expect(result.applied).toEqual(['league v1→v2: compact stat lines (zero fields omitted)']);
    expect(result.data).toEqual({ ...compactLeagueStatLines(clone(league) as unknown as Record<string, unknown>), version: 2 });
    const line = Object.values((result.data.season as { stats: Record<string, Record<string, unknown>> }).stats)[0]!;
    expect(Object.values(line).every((v) => v !== 0)).toBe(true);
  });

  it('v2 is the identity', () => {
    const onDisk = { ...compactLeagueStatLines(clone(makeLeague()) as unknown as Record<string, unknown>), version: 2 };
    const result = migrate(onDisk);
    expect(result.applied).toEqual([]);
    expect(result.fromVersion).toBe(2);
    expect(result.data).toEqual(onDisk);
    expect(result.data).not.toBe(onDisk);
  });

  it('rejects future or malformed versions and non-objects', () => {
    expectSaveError(() => migrate({ ...makeLeague(), version: CURRENT_SAVE_VERSION + 1 }), 'version', '$.version');
    expectSaveError(() => migrate({ version: -1 }), 'version', '$.version');
    expectSaveError(() => migrate({ version: 1.5 }), 'version', '$.version');
    expectSaveError(() => migrate({ version: '1' }), 'version', '$.version');
    expectSaveError(() => migrate(null), 'validation', '$');
    expectSaveError(() => migrate([1, 2]), 'validation', '$');
  });

  it('lists the built-in chain and reports current versions', () => {
    expect(listMigrations('league').map((m) => [m.from, m.to])).toEqual([[0, 1], [1, 2]]);
    expect(currentVersion('league')).toBe(CURRENT_SAVE_VERSION);
    expect(currentVersion('game')).toBe(CURRENT_GAME_SAVE_VERSION);
    expect(() => installBuiltinMigrations()).not.toThrow();
    expect(listMigrations('league')).toHaveLength(2);
  });
});

describe('registerMigration / ordered chains', () => {
  const step = (from: number, tag: string, extra: Partial<Migration> = {}): Migration => ({
    kind: 'game', from, to: from + 1, description: `game v${from}→v${from + 1} ${tag}`,
    apply: (raw) => ({ ...raw, trail: [...((raw.trail as string[] | undefined) ?? []), tag] }),
    ...extra,
  });

  afterEach(() => {
    for (let v = 1; v < 6; v++) unregisterMigration('game', v);
  });

  it('runs steps in version order to an explicit target', () => {
    registerMigration(step(2, 'b'));
    registerMigration(step(1, 'a'));
    registerMigration(step(3, 'c'));
    const result = migrate({ version: 1, name: 'x' }, { kind: 'game', target: 4 });
    expect(result.applied).toEqual(['game v1→v2 a', 'game v2→v3 b', 'game v3→v4 c']);
    expect(result.data).toEqual({ version: 4, name: 'x', trail: ['a', 'b', 'c'] });
    expect(migrate({ version: 3 }, { kind: 'game', target: 4 }).applied).toEqual(['game v3→v4 c']);
    expect(listMigrations('game').map((m) => m.from)).toEqual([1, 2, 3]);
  });

  it('fails when a step is missing from the chain', () => {
    registerMigration(step(2, 'b'));
    expectSaveError(() => migrate({ version: 1 }, { kind: 'game', target: 3 }), 'migration', '$.version');
  });

  it('fails when a step returns a non-object', () => {
    registerMigration(step(1, 'bad', { apply: () => 'nope' as unknown as Record<string, unknown> }));
    expectSaveError(() => migrate({ version: 1 }, { kind: 'game', target: 2 }), 'migration', '$');
  });

  it('validates registrations', () => {
    expectSaveError(() => registerMigration(step(1, 'x', { to: 3 })), 'migration');
    expectSaveError(() => registerMigration(step(-1, 'x', { to: 0 })), 'migration');
    expectSaveError(() => registerMigration(step(1.5, 'x', { to: 2.5 })), 'migration');
    registerMigration(step(1, 'first'));
    expectSaveError(() => registerMigration(step(1, 'dup')), 'migration');
    expect(unregisterMigration('game', 1)).toBe(true);
    expect(unregisterMigration('game', 1)).toBe(false);
  });

  it('cloneData deep-copies plain data', () => {
    const src = { a: [1, { b: 2 }], c: null, d: 'x' };
    const copy = cloneData(src);
    expect(copy).toEqual(src);
    expect(copy.a).not.toBe(src.a);
    expect(copy.a[1]).not.toBe(src.a[1]);
  });
});
