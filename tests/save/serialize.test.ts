import { describe, expect, it } from 'vitest';
import { createRng, restoreRng } from '@/core/rng';
import { DEFAULT_SETTINGS } from '@/core/settings';
import type { PlayerId, TeamId } from '@/core/ids';
import {
  SaveError, deserializeGameState, deserializeLeague, estimateSize, isCompressed, packString, serializeGameState,
  serializeLeague, serializeSettings, stableStringify, unpackString, validateLeague,
} from '@/save/serialize';
import { C1, P, S1, T1, T2, clone, makeGame, makeLeague, reverseKeys } from './fixtures';

const expectSaveError = (fn: () => unknown, code: SaveError['code'], path: string): SaveError => {
  let caught: unknown;
  try {
    fn();
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(SaveError);
  const e = caught as SaveError;
  expect(e.code).toBe(code);
  expect(e.path).toBe(path);
  return e;
};

describe('stableStringify', () => {
  it('sorts keys at every level and emits compact JSON', () => {
    expect(stableStringify({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: null } })).toBe('{"a":{"c":null,"d":[3,{"y":2,"z":1}]},"b":1}');
  });

  it('is insensitive to key insertion order', () => {
    const league = makeLeague();
    expect(serializeLeague(reverseKeys(league))).toBe(serializeLeague(league));
  });

  it('rejects undefined, functions, non-finite numbers and class instances with a path', () => {
    expectSaveError(() => stableStringify({ a: { b: undefined } }), 'invalidValue', '$.a.b');
    expectSaveError(() => stableStringify({ list: [1, () => 2] }), 'invalidValue', '$.list[1]');
    expectSaveError(() => stableStringify({ n: Number.NaN }), 'invalidValue', '$.n');
    expectSaveError(() => stableStringify({ n: Number.POSITIVE_INFINITY }), 'invalidValue', '$.n');
    expectSaveError(() => stableStringify({ when: new Date(0) }), 'invalidValue', '$.when');
    expectSaveError(() => stableStringify({ 'odd key': { s: Symbol('x') } }), 'invalidValue', '$["odd key"].s');
  });
});

describe('league round trip', () => {
  it('deserialize(serialize(league)) is deep-equal, including rng state', () => {
    const league = makeLeague();
    const text = serializeLeague(league);
    expect(text.startsWith('{')).toBe(true);
    const back = deserializeLeague(text);
    expect(back).toEqual(league);
    expect(back.rngState).toEqual(league.rngState);
    expect(back.rngState).not.toEqual(createRng(42).getState()); // the fixture advanced the stream, so this is a real position
    expect(restoreRng(back.rngSeed, back.rngState).next()).toBe(restoreRng(league.rngSeed, league.rngState).next());
    expect(back).not.toBe(league);
  });

  it('round-trips through compression and auto-detects it', () => {
    const league = makeLeague();
    const packed = serializeLeague(league, { compress: true });
    expect(isCompressed(packed)).toBe(true);
    expect(deserializeLeague(packed)).toEqual(league);
  });

  it('is deterministic', () => {
    expect(serializeLeague(makeLeague())).toBe(serializeLeague(makeLeague()));
  });

  it('migrates a v0-shaped save on load', () => {
    const league = makeLeague();
    const v0 = clone(league) as unknown as Record<string, unknown>;
    delete v0.version;
    v0.freeAgents = v0.freeAgentIds;
    delete v0.freeAgentIds;
    v0.rng = { seed: v0.rngSeed, state: v0.rngState };
    delete v0.rngSeed;
    delete v0.rngState;
    delete v0.careerStats;
    expect(deserializeLeague(JSON.stringify(v0))).toEqual({ ...league, careerStats: {} });
  });

  it('rejects malformed JSON and newer versions', () => {
    expectSaveError(() => deserializeLeague('{not json'), 'parse', '$');
    expectSaveError(() => deserializeLeague(JSON.stringify({ ...makeLeague(), version: 99 })), 'version', '$.version');
  });
});

describe('validateLeague', () => {
  const broken = (mutate: (l: ReturnType<typeof makeLeague>) => void): unknown => {
    const l = clone(makeLeague());
    mutate(l);
    return l;
  };

  it('catches roster ids that do not exist', () => {
    expectSaveError(() => validateLeague(broken((l) => l.teams[T1]!.rosterIds.push('p_ghost' as PlayerId))), 'validation', '$.teams.t_harbor.rosterIds[3]');
  });

  it('catches a player listed twice on one roster', () => {
    expectSaveError(() => validateLeague(broken((l) => l.teams[T1]!.rosterIds.push(P.qb1))), 'validation', '$.teams.t_harbor.rosterIds[3]');
  });

  it('catches a rostered player whose teamId disagrees', () => {
    const e = expectSaveError(() => validateLeague(broken((l) => { l.players[P.wr1]!.teamId = T2; })), 'validation', '$.teams.t_harbor.rosterIds[2]');
    expect(e.message).toContain('teamId');
  });

  it('catches a player claiming a team whose roster omits them', () => {
    expectSaveError(() => validateLeague(broken((l) => { l.players[P.fa]!.teamId = T1; l.freeAgentIds = []; })), 'validation', '$.players.p_fa1.teamId');
  });

  it('catches a free agent that still has a team', () => {
    expectSaveError(() => validateLeague(broken((l) => l.freeAgentIds.push(P.qb1))), 'validation', '$.freeAgentIds[1]');
  });

  it('catches dangling stadium, coach, rival, depth-chart and pick references', () => {
    expectSaveError(() => validateLeague(broken((l) => { l.teams[T1]!.stadiumId = 's_nowhere' as never; })), 'validation', '$.teams.t_harbor.stadiumId');
    expectSaveError(() => validateLeague(broken((l) => { l.teams[T2]!.headCoachId = 'c_nobody' as never; })), 'validation', '$.teams.t_summit.headCoachId');
    expectSaveError(() => validateLeague(broken((l) => { l.teams[T2]!.staffIds = ['c_nobody' as never]; })), 'validation', '$.teams.t_summit.staffIds[0]');
    expectSaveError(() => validateLeague(broken((l) => { l.teams[T1]!.rivalIds = ['t_mars' as TeamId]; })), 'validation', '$.teams.t_harbor.rivalIds[0]');
    expectSaveError(() => validateLeague(broken((l) => { l.teams[T1]!.depthChart.QB = [P.qb2]; })), 'validation', '$.teams.t_harbor.depthChart.QB[0]');
    expectSaveError(() => validateLeague(broken((l) => { l.teams[T1]!.picks[0]!.ownerTeamId = 't_mars' as TeamId; })), 'validation', '$.teams.t_harbor.picks[0].ownerTeamId');
  });

  it('catches id/key mismatches', () => {
    expectSaveError(() => validateLeague(broken((l) => { l.players[P.qb1]!.id = 'p_other' as PlayerId; })), 'validation', '$.players.p_qb1.id');
    expectSaveError(() => validateLeague(broken((l) => { l.coaches[C1]!.id = 'c_other' as never; })), 'validation', '$.coaches.c_ames.id');
    expectSaveError(() => validateLeague(broken((l) => { l.stadiums[S1]!.id = 's_other' as never; })), 'validation', '$.stadiums.s_harbor.id');
    expectSaveError(() => validateLeague(broken((l) => { l.season.standings[T1]!.teamId = T2; })), 'validation', '$.season.standings.t_harbor.teamId');
  });

  it('catches a player that is both active and retired', () => {
    expectSaveError(() => validateLeague(broken((l) => { l.retiredPlayers[P.qb1] = { ...l.players[P.qb1]! }; })), 'validation', '$.players.p_qb1');
  });

  it('catches season, history, record, HOF, event, career and trade references', () => {
    expectSaveError(() => validateLeague(broken((l) => { l.season.schedule[0]!.away = 't_mars' as TeamId; })), 'validation', '$.season.schedule[0].away');
    expectSaveError(() => validateLeague(broken((l) => { l.season.phase = 'bye' as never; })), 'validation', '$.season.phase');
    expectSaveError(() => validateLeague(broken((l) => { l.season.stats['p_ghost' as PlayerId] = l.season.stats[P.qb1]!; })), 'validation', '$.season.stats.p_ghost');
    expectSaveError(() => validateLeague(broken((l) => { l.userTeamId = 't_mars' as TeamId; })), 'validation', '$.userTeamId');
    expectSaveError(() => validateLeague(broken((l) => { l.history[0]!.mvp = 'p_ghost' as PlayerId; })), 'validation', '$.history[0].mvp');
    expectSaveError(() => validateLeague(broken((l) => { l.records[0]!.holderTeamId = 't_mars' as TeamId; })), 'validation', '$.records[0].holderTeamId');
    expectSaveError(() => validateLeague(broken((l) => { l.hallOfFame[0]!.playerId = 'p_ghost' as PlayerId; })), 'validation', '$.hallOfFame[0].playerId');
    expectSaveError(() => validateLeague(broken((l) => { l.events[0]!.coachId = 'c_nobody' as never; })), 'validation', '$.events[0].coachId');
    expectSaveError(() => validateLeague(broken((l) => { l.careerStats['p_ghost' as PlayerId] = l.careerStats[P.qb1]!; })), 'validation', '$.careerStats.p_ghost');
    expectSaveError(() => validateLeague(broken((l) => l.pendingTrades.push({ id: 'tr', fromTeam: T1, toTeam: 't_mars' as TeamId, fromAssets: [], toAssets: [], status: 'pending', year: 2026, week: 1, initiatedBy: T1 }))), 'validation', '$.pendingTrades[0].toTeam');
  });

  it('accepts retired players referenced by HOF/history and validates required keys and rng state', () => {
    expect(() => validateLeague(makeLeague())).not.toThrow();
    expectSaveError(() => validateLeague(broken((l) => { delete (l as unknown as Record<string, unknown>).records; })), 'validation', '$.records');
    expectSaveError(() => validateLeague(broken((l) => { l.rngState = [1, 2, 3] as never; })), 'validation', '$.rngState');
    expectSaveError(() => validateLeague(broken((l) => { l.rngState[2] = Number.NaN; })), 'validation', '$.rngState[2]');
    expectSaveError(() => validateLeague('nope'), 'validation', '$');
  });
});

describe('packString / unpackString', () => {
  const cases: [string, string][] = [
    ['empty', ''], ['single', 'a'], ['run', 'aaaaaaaaaaaa'], ['alternating', 'abababababab'],
    ['unicode', 'héllo wörld ✓ 日本語 😀 — ünïcödé'],
    ['code-range chars', Array.from({ length: 600 }, (_, i) => String.fromCharCode(0x100 + i * 7)).join('')],
    ['repeated unicode phrase', '日本語テキスト,'.repeat(200)],
    ['surrogate pairs adjacent', '😀😀😀😁😀😀'],
  ];
  for (const [name, text] of cases) {
    it(`round-trips ${name}`, () => {
      const packed = packString(text);
      expect(isCompressed(packed)).toBe(true);
      expect(unpackString(packed)).toBe(text);
      for (let i = 0; i < packed.length; i++) {
        const cu = packed.charCodeAt(i);
        expect(cu >= 0xd800 && cu <= 0xdfff && !text.includes(packed[i]!)).toBe(false);
      }
    });
  }

  it('round-trips a long pseudo-random text that forces dictionary resets (incl. escaped chars)', () => {
    const rng = createRng(7);
    const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789 ,.{}[]:"' + 'äöüéñ日本';
    let s = '';
    const parts: string[] = [];
    for (let i = 0; i < 400_000; i++) parts.push(alphabet[rng.int(0, alphabet.length - 1)]!);
    s = parts.join('');
    expect(unpackString(packString(s))).toBe(s);
  });

  it('shrinks league JSON substantially', () => {
    const json = serializeLeague(makeLeague());
    const packed = packString(json);
    expect(packed.length).toBeLessThan(json.length * 0.5);
    expect(unpackString(packed)).toBe(json);
  });

  it('rejects corrupt input', () => {
    expect(() => unpackString('not packed')).toThrow(SaveError);
    expect(() => unpackString('GLZ1:x:')).toThrow(SaveError);
    const packed = packString('hello hello hello');
    expect(() => unpackString(packed.slice(0, -1))).toThrow(/length/);
    expect(() => unpackString(`${packed}${String.fromCharCode(0x100 + 50_000)}`)).toThrow(SaveError);
  });
});

describe('estimateSize', () => {
  it('reports utf16 bytes by default and utf8 on request', () => {
    expect(estimateSize('abc')).toBe(6);
    expect(estimateSize('a', 'utf8')).toBe(1);
    expect(estimateSize('é', 'utf8')).toBe(2);
    expect(estimateSize('日', 'utf8')).toBe(3);
    expect(estimateSize('😀', 'utf8')).toBe(4);
    expect(estimateSize('a😀é', 'utf8')).toBe(7);
  });
});

describe('game state and settings', () => {
  it('round-trips a mid-game state, compressed or not', () => {
    const game = makeGame();
    expect(deserializeGameState(serializeGameState(game))).toEqual(game);
    expect(deserializeGameState(serializeGameState(game, { compress: true }))).toEqual(game);
  });

  it('validates game structure', () => {
    const game = makeGame();
    expectSaveError(() => deserializeGameState(JSON.stringify({ ...game, version: 7 })), 'version', '$.version');
    expectSaveError(() => deserializeGameState(JSON.stringify({ ...game, away: game.home })), 'validation', '$.away');
    expectSaveError(() => deserializeGameState(JSON.stringify({ ...game, phase: 'lunch' })), 'validation', '$.phase');
    expectSaveError(() => deserializeGameState(JSON.stringify({ ...game, direction: 0 })), 'validation', '$.direction');
    expectSaveError(() => deserializeGameState(JSON.stringify({ ...game, score: { home: 1 } })), 'validation', '$.score.away');
    expectSaveError(() => deserializeGameState(JSON.stringify({ ...game, stats: { players: {}, teams: { home: {} } } })), 'validation', '$.stats.teams.away');
  });

  it('serializes settings with sorted keys', () => {
    const text = serializeSettings(DEFAULT_SETTINGS);
    expect(text.startsWith('{"animations":true,"audio":{"commentary":0.8,"crowd":1,"master":0.8')).toBe(true);
    expect(JSON.parse(text)).toEqual(DEFAULT_SETTINGS);
  });
});
