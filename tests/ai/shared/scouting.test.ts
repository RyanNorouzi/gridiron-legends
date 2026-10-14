import { describe, expect, it } from 'vitest';
import { createRng } from '@/core/rng';
import { emptyOutcome } from '@/game/outcome-factory';
import { getDifficulty } from '@/game/rulesets';
import type { DifficultyId, PlayLogEntry, PlayResultType, TeamSide } from '@/game/types';
import { loadPlaybookData } from '@/playbook/loader';
import type { PlaySituation } from '@/playbook/playbooks';
import type { DefensivePlay, OffensivePlay } from '@/playbook/types';
import { callDefensivePlay, defensiveCheck, formationClass, isRunStop, personnelMismatch, staffBlitzMultiplier } from '@/ai/playcalling-defense';
import { callOffensivePlay, coordinatorMultiplier, isQuickGame, type OffensiveCallState } from '@/ai/playcalling-offense';
import { adaptationFor, adaptationStrength, formationPersonnel, gameStaffTendencies, scoutDefense, scoutOffense, staffTendencies } from '@/ai/scouting';
import { makeCoach, share } from './helpers';

const reg = loadPlaybookData();
const DEF: DefensivePlay[] = Object.values(reg.defensePlays).filter((p) => !p.tags.some((t) => t === 'kickReturn' || t === 'puntReturn' || t === 'fgBlock'));
const OFF: OffensivePlay[] = Object.values(reg.offensePlays);
const diff = (id: DifficultyId) => getDifficulty(id);

const entry = (i: number, possession: TeamSide, off: string | null, def: string | null, result: PlayResultType, extra: { airYards?: number; underPressure?: boolean } = {}): PlayLogEntry => ({
  index: i, quarter: 1, clock: 800, possession, down: 1, distance: 10, ballOn: 30, ballX: 26.67, offensivePlayId: off, defensivePlayId: def,
  outcome: emptyOutcome({ result, ...(extra.airYards !== undefined && { airYards: extra.airYards }), ...(extra.underPressure !== undefined && { underPressure: extra.underPressure }) }, possession),
  scoreAfter: { home: 0, away: 0 }, review: null,
});

/** A user offense that runs out of the I-form and throws out of the gun, 12 snaps. */
const userLog = (): PlayLogEntry[] => {
  const log: PlayLogEntry[] = [];
  for (let i = 0; i < 6; i++) log.push(entry(log.length, 'home', 'iform-dive-right', '43-cover3-zone', 'run'));
  for (let i = 0; i < 6; i++) log.push(entry(log.length, 'home', 'shotgun-fourVerts', '43-cover3-zone', i % 2 ? 'pass' : 'incomplete', { airYards: 24 }));
  log.push(entry(log.length, 'away', 'shotgun-mesh', '43-cover0-lbBlitz', 'pass'));
  return log;
};

describe('scouting report', () => {
  it('reads run/pass by formation, deep and quick rates, and ignores the other side and special teams', () => {
    const log = userLog();
    log.push(entry(log.length, 'home', 'punt', null, 'punt'));
    const r = scoutOffense(log, 'home');
    expect(r.samples).toBe(12);
    expect(r.passRate).toBeCloseTo(0.5, 5);
    expect(r.deepRate).toBe(1);
    const iform = reg.offensePlays['iform-dive-right']?.formation as string;
    const gun = reg.offensePlays['shotgun-fourVerts']?.formation as string;
    expect(r.formationPassRate?.[iform]).toBe(0);
    expect(r.formationPassRate?.[gun]).toBe(1);
    expect(scoutOffense([], 'home')).toEqual({ lastPlayIds: [], samples: 0 });
  });

  it('reads the defense from its calls: blitz, man, two-high and zero rates', () => {
    const log: PlayLogEntry[] = [];
    for (let i = 0; i < 4; i++) log.push(entry(i, 'away', 'shotgun-mesh', '43-cover0-lbBlitz', 'pass'));
    for (let i = 0; i < 4; i++) log.push(entry(4 + i, 'away', 'shotgun-mesh', '43-cover2-zone', 'run'));
    const d = scoutDefense(log, 'away');
    expect(d).toMatchObject({ blitzRate: 0.5, manRate: 0.5, twoHighRate: 0.5, zeroRate: 0.5, samples: 8 });
    // Unknown (custom) call ids fall back to the pressure read.
    const custom = [entry(0, 'away', 'x', 'custom-a', 'pass', { underPressure: true }), entry(1, 'away', 'x', 'custom-b', 'incomplete')];
    expect(scoutDefense(custom, 'away').blitzRate).toBe(0.5);
  });

  it('adaptation grows with difficulty and with the size of the sample', () => {
    const ids: DifficultyId[] = ['rookie', 'pro', 'allPro', 'legend'];
    const s = ids.map((id) => adaptationStrength(diff(id)));
    expect(s[0]).toBe(0);
    for (let i = 1; i < s.length; i++) expect(s[i] as number).toBeGreaterThan(s[i - 1] as number);
    expect(s[3]).toBeGreaterThan(0.95);
    expect(adaptationFor(diff('legend'), 2)).toBeLessThan(adaptationFor(diff('legend'), 12));
    expect(adaptationFor(diff('legend'), undefined)).toBe(adaptationStrength(diff('legend')));
  });

  it('staff tendencies come from the head coach, with coordinators pulling their side', () => {
    expect(staffTendencies(null)).toEqual({ passLean: 0, aggression: 0, blitzLean: 0 });
    const airRaid = staffTendencies(makeCoach({ offensiveScheme: 'airRaid', defensiveScheme: 'blitzHeavy', traits: ['aggressive'] }));
    expect(airRaid.passLean).toBeGreaterThan(0.5);
    expect(airRaid.blitzLean).toBeGreaterThan(0.8);
    expect(airRaid.aggression).toBeGreaterThan(0.5);
    const withOc = staffTendencies(makeCoach({ offensiveScheme: 'airRaid' }), makeCoach({ offensiveScheme: 'groundAndPound' }));
    expect(withOc.passLean).toBeLessThan(airRaid.passLean);
    const cautious = staffTendencies(makeCoach({ defensiveScheme: 'coverageFirst', traits: ['conservative'] }));
    expect(cautious.blitzLean).toBeLessThan(-0.5);
    // A game side's staff (GameTeamSetup shape): the coordinators count, a missing staff is neutral.
    const head = makeCoach({ offensiveScheme: 'airRaid' });
    expect(gameStaffTendencies({ headCoach: head, offensiveCoordinator: makeCoach({ offensiveScheme: 'groundAndPound' }) })).toEqual(withOc);
    expect(gameStaffTendencies({ headCoach: head })).toEqual(staffTendencies(head));
    expect(gameStaffTendencies(null)).toEqual(staffTendencies(null));
  });

  it('the AI callers use the coordinators: a blitz-minded DC brings more pressure, an air-raid OC more dropbacks', () => {
    const head = makeCoach({ defensiveScheme: 'coverageFirst', offensiveScheme: 'groundAndPound' });
    const dc = makeCoach({ defensiveScheme: 'blitzHeavy', traits: ['aggressive'] });
    const blitz = DEF.find((p) => p.blitz !== 'none') as DefensivePlay;
    const zone = DEF.find((p) => p.blitz === 'none') as DefensivePlay;
    expect(staffBlitzMultiplier(blitz, head, dc)).toBeGreaterThan(staffBlitzMultiplier(blitz, head));
    expect(staffBlitzMultiplier(zone, head, dc)).toBe(1);
    const blitzShare = (withDc: boolean): number => share(N, (i) => callDefensivePlay({ plays: DEF, situation: sit(), coach: head, defensiveCoordinator: withDc ? dc : null, difficulty: diff('pro'), rng: createRng(i) }), (p) => p.blitz !== 'none');
    expect(blitzShare(true)).toBeGreaterThan(blitzShare(false));
    const oc = makeCoach({ offensiveScheme: 'airRaid' });
    const pass = Object.values(reg.offensePlays).find((p) => p.type === 'pass') as OffensivePlay;
    const run = Object.values(reg.offensePlays).find((p) => p.type === 'run') as OffensivePlay;
    expect(coordinatorMultiplier(pass, head, oc)).toBeGreaterThan(1);
    expect(coordinatorMultiplier(run, head, oc)).toBeLessThan(1);
    expect(coordinatorMultiplier(pass, head, null)).toBe(1);
  });
});

const sit = (o: Partial<PlaySituation> = {}): PlaySituation => ({ down: 2, distance: 6, ballOn: 40, clock: 700, scoreDiff: 0, ...o });
const N = 300;

describe('the defense adapts to what the user calls (more at higher difficulty)', () => {
  const report = scoutOffense(userLog(), 'home');
  const iform = reg.offensePlays['iform-dive-right']?.formation as string;
  const gun = reg.offensePlays['shotgun-fourVerts']?.formation as string;
  const callIn = (id: DifficultyId, formation: string, i: number): DefensivePlay =>
    callDefensivePlay({ plays: DEF, situation: sit(), coach: null, difficulty: diff(id), rng: createRng(i), offenseTendencies: report, offenseFormation: formation });
  const runStopShare = (id: DifficultyId, formation: string): number => share(N, (i) => callIn(id, formation, i), isRunStop);
  const lightShare = (id: DifficultyId, formation: string): number =>
    share(N, (i) => callIn(id, formation, i), (p) => formationClass(p.formation) === 'nickel' || formationClass(p.formation) === 'dime');
  const twoHighShare = (id: DifficultyId): number =>
    share(N, (i) => callDefensivePlay({ plays: DEF, situation: sit(), coach: null, difficulty: diff(id), rng: createRng(i), offenseTendencies: report, offenseFormation: gun }),
      (p) => p.coverage === 'cover2' || p.coverage === 'cover4' || p.coverage === 'cover6');

  it('loads the box against the formation the user runs from and plays pass out of the one he throws from', () => {
    expect(runStopShare('legend', iform)).toBeGreaterThan(2 * runStopShare('legend', gun));
    const legendGap = lightShare('legend', gun) - lightShare('legend', iform);
    // Rookie ignores the report: only the personnel he sees moves the call.
    const rookieGap = lightShare('rookie', gun) - lightShare('rookie', iform);
    expect(legendGap).toBeGreaterThan(rookieGap + 0.1);
  });

  it('answers a deep-shot diet with two-high shells, legend far more than rookie', () => {
    expect(twoHighShare('legend')).toBeGreaterThan(twoHighShare('rookie') + 0.08);
  });

  it('checks out of a personnel mismatch at the line, reliably at legend', () => {
    const dime = DEF.find((p) => formationClass(p.formation) === 'dime') as DefensivePlay;
    const heavy = OFF.find((p) => formationPersonnel(p.formation) === '22' || formationPersonnel(p.formation) === '23') as OffensivePlay;
    expect(personnelMismatch(dime, formationPersonnel(heavy.formation))).toBe('tooLight');
    const fixed = (id: DifficultyId): number => share(N, (i) => defensiveCheck(dime, { plays: DEF, situation: sit({ distance: 2 }), coach: null, difficulty: diff(id), rng: createRng(i), offenseFormation: heavy.formation }).play,
      (p) => personnelMismatch(p, formationPersonnel(heavy.formation)) === null);
    expect(fixed('legend')).toBeGreaterThan(0.75);
    expect(fixed('rookie')).toBeLessThan(fixed('legend') - 0.3);
    // No mismatch, no check (and no die rolled).
    const cover3 = reg.defensePlays['43-cover3-zone'] as DefensivePlay;
    const rng = createRng(5);
    const before = rng.getState();
    expect(defensiveCheck(cover3, { plays: DEF, situation: sit(), coach: null, difficulty: diff('legend'), rng, offenseFormation: heavy.formation })).toEqual({ play: cover3, checked: false });
    expect(rng.getState()).toEqual(before);
  });
});

describe('the offense attacks what the defense shows', () => {
  const blitzLog: PlayLogEntry[] = [];
  for (let i = 0; i < 10; i++) blitzLog.push(entry(i, 'away', 'shotgun-mesh', i % 2 ? '43-cover0-lbBlitz' : '34-cover0-allOut', 'pass', { underPressure: true }));
  const report = scoutDefense(blitzLog, 'away');
  const state: OffensiveCallState = { down: 2, distance: 7, ballOn: 40, clock: { quarter: 2, secondsRemaining: 700 }, scoreDiff: 0, timeouts: 3 };
  const hot = (p: OffensivePlay): boolean => p.concept === 'screen' || isQuickGame(p);
  const hotShare = (id: DifficultyId): number =>
    share(N, (i) => callOffensivePlay({ plays: OFF, state, coach: null, difficulty: diff(id), rng: createRng(i), defenseTendencies: report }), hot);

  it('throws hot (screens and the quick game) against a blitzing defense, legend more than rookie', () => {
    expect(report.blitzRate).toBe(1);
    expect(hotShare('legend')).toBeGreaterThan(hotShare('rookie') + 0.08);
  });

  it('with no report the difficulty alone does not tilt the mix toward hot throws', () => {
    const none = (id: DifficultyId): number => share(N, (i) => callOffensivePlay({ plays: OFF, state, coach: null, difficulty: diff(id), rng: createRng(i) }), hot);
    expect(hotShare('legend') - none('legend')).toBeGreaterThan(0.08);
  });
});
