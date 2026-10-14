import { describe, expect, it } from 'vitest';
import { angle, angleDiff, dist, len, normalize, sub, vec2 } from '@/core/vec2';
import { findAthlete } from '@/game/athlete';
import type { PlayEngine } from '@/game/play-engine';
import type { Athlete, UserPlayInput } from '@/game/play-types';
import { getDifficulty } from '@/game/rulesets';
import { FORM_TACKLE_SPEED, formTackleSquare } from '@/game/systems/tackle';
import type { DifficultyId } from '@/game/types';
import {
  BREAKDOWN_EFFORT, receiverSlotsFor, switchControlled, userControl, userTackleAssist,
} from '@/game/user-control';
import { carrierPower } from '@/physics/contact';
import { maxSpeed } from '@/physics/speed';
import { ahead, build, clearDefense, emptyInput, scripted, toward } from './helpers';

describe('user control', () => {
  it('switchPlayer picks the nearest active defender to the ball and emits the event', () => {
    const { engine } = build({ offensePlayId: 'shotgun-mesh', defensePlayId: '43-cover3-zone', seed: 1, userSide: 'away', controlRole: 'FS' });
    expect(engine.state.controlledIds.away).toBe('def:FS');
    expect(engine.state.athletes.find((a) => a.id === 'def:FS')!.controlled).toBe(true);
    const id = switchControlled(engine.state, 'away', { ...emptyInput(), switchPlayer: true });
    expect(id).toBe('def:DT2');
    expect(engine.state.controlledIds.away).toBe('def:DT2');
    expect(engine.state.controlledId).toBe('def:DT2');
    expect(engine.state.athletes.find((a) => a.id === 'def:FS')!.controlled).toBe(false);
    expect(engine.state.athletes.find((a) => a.id === 'def:DT2')!.controlled).toBe(true);
    expect(engine.state.events.some((e) => e.type === 'switchPlayer' && e.to === 'def:DT2')).toBe(true);
  });

  it('switchToId is honoured only for an active athlete on that side', () => {
    const { engine } = build({ offensePlayId: 'shotgun-mesh', defensePlayId: '43-cover3-zone', seed: 1, userSide: 'away', controlRole: 'FS' });
    expect(switchControlled(engine.state, 'away', { ...emptyInput(), switchToId: 'off:QB' })).toBeNull();
    expect(switchControlled(engine.state, 'away', { ...emptyInput(), switchToId: 'def:CB1' })).toBe('def:CB1');
    engine.state.athletes.find((a) => a.id === 'def:CB2')!.active = false;
    expect(switchControlled(engine.state, 'away', { ...emptyInput(), switchToId: 'def:CB2' })).toBeNull();
  });

  it('maps human input to intents for the QB and a defender', () => {
    const { engine, f } = build({ offensePlayId: 'shotgun-mesh', defensePlayId: '43-cover3-zone', seed: 1, userSide: 'home', controlRole: 'QB', ruleset: 'arcade' });
    const slots = receiverSlotsFor(engine.state, { registries: f.registry });
    expect(slots[0]).toBe('WR3');
    const qb = engine.state.athletes.find((a) => a.id === 'off:QB')!;
    const pre = userControl(qb, { ...emptyInput(), snap: true }, engine.state, { receiverSlots: slots });
    expect(pre.action).toBe('snap');
    while (engine.state.ball.carrierId !== 'off:QB') engine.tick({ home: { ...emptyInput(), snap: true } });
    const throwIntent = userControl(qb, { ...emptyInput(), throwTo: 0, throwType: 'lob', move: vec2(0.5, 0), sprint: true }, engine.state, { receiverSlots: slots });
    expect(throwIntent.action).toBe('throw');
    expect(throwIntent.targetId).toBe('off:WR3');
    expect(throwIntent.throwType).toBe('lob');
    expect(throwIntent.move).toEqual(vec2(0.5, 0));
    expect(throwIntent.sprint).toBe(true);
    const away = userControl(qb, { ...emptyInput(), throwAway: true }, engine.state, { receiverSlots: slots });
    expect(away.action).toBe('throwAway');
    const fs = engine.state.athletes.find((a) => a.id === 'def:FS')!;
    const strafe = userControl(fs, { ...emptyInput(), strafe: true, move: vec2(0, 1), hitStick: true }, engine.state, { receiverSlots: slots });
    expect(strafe.action).toBe('hitStick');
    expect(['strafe', 'backpedal']).toContain(strafe.locomotion);
    expect(strafe.face).not.toBeNull();
  });

  it('control follows the ball to the runner on a handoff for a human offense', () => {
    const { engine } = build({ offensePlayId: 'iform-dive-right', defensePlayId: '43-cover3-zone', seed: 2, userSide: 'home', controlRole: 'QB', ruleset: 'arcade' }, {}, {
      decider: (a, s) => (a.id === 'off:RB' && !a.hasBall ? { ...s.intents[a.id] ?? { move: vec2(0, 0) }, move: vec2(0, s.ctx.direction), sprint: true, locomotion: 'run', face: null, action: null, targetId: null, throwType: null, throwTarget: null, kickPower: null, kickAccuracy: null, audible: null, debug: 'rb' } : { move: vec2(0, 0), sprint: false, locomotion: 'run', face: null, action: null, targetId: null, throwType: null, throwTarget: null, kickPower: null, kickAccuracy: null, audible: null, debug: 'idle' }),
    });
    let n = 0;
    while (!engine.state.events.some((e) => e.type === 'handoff') && n < 400) { engine.tick({ home: { ...emptyInput(), snap: true } }); n += 1; }
    expect(engine.state.events.some((e) => e.type === 'handoff')).toBe(true);
    expect(engine.state.controlledIds.home).toBe('off:RB');
    expect(engine.state.controlledId).toBe('off:RB');
  });

  it('a human QB who never snaps draws delay of game once the play clock expires', () => {
    const { engine } = build({ offensePlayId: 'shotgun-mesh', defensePlayId: '43-cover3-zone', seed: 2, userSide: 'home', controlRole: 'QB', ruleset: 'simulation' });
    const o = engine.run(() => ({ home: emptyInput() }), 60 * 45);
    expect(o.result).toBe('penalty');
    expect(o.penalties[0]?.foul).toBe('delayOfGame');
    expect(o.penalties[0]?.deadBall).toBe(true);
    expect(o.yards).toBe(0);
    expect(o.timeElapsed).toBe(0);
    expect(o.presnapElapsed).toBeCloseTo(40, 0);
    expect(o.stats).toHaveLength(0);
  });

  it('a human place kicker sets the meter before the snap: presses lock power and accuracy, the lock snaps it, then it kicks', () => {
    const { engine } = build({ offensePlayId: 'fieldGoal-standard', defensePlayId: 'fgBlock-middle', seed: 3, ballOn: 80, userSide: 'home', ruleset: 'arcade' }, { special: 'fieldGoal' }, { decider: () => ({ move: vec2(0, 0), sprint: false, locomotion: 'run', face: null, action: null, targetId: null, throwType: null, throwTarget: null, kickPower: null, kickAccuracy: null, audible: null, debug: 'idle' }) });
    expect(engine.state.controlledIds.home).toBe('off:K');
    expect(engine.state.kickMeter?.phase).toBe('idle');
    const press = { home: { ...emptyInput(), kickPress: true } };
    engine.tick(press);
    expect(engine.state.kickMeter?.phase).toBe('power');
    for (let i = 0; i < 40; i++) engine.tick({ home: emptyInput() });
    // The meter runs pre-snap now (H2-04): nobody snaps a place kick until the kicker has locked it.
    expect(engine.state.phase).toBe('presnap');
    engine.tick(press);
    expect(engine.state.kickMeter?.phase).toBe('accuracy');
    for (let i = 0; i < 25; i++) engine.tick({ home: emptyInput() });
    expect(engine.state.phase).toBe('presnap');
    engine.tick(press);
    expect(engine.state.kickMeter?.phase).toBe('done');
    engine.tick({ home: emptyInput() });
    expect(engine.state.phase).toBe('live');
    const o = engine.run(() => ({ home: emptyInput() }));
    expect(engine.state.events.some((e) => e.type === 'kick' && e.power === engine.state.kickMeter?.power)).toBe(true);
    expect(o.result).toBe('fieldGoal');
  });
});

/* ------------------------------------ Tackle assist ------------------------------------ */

/** The back runs straight downfield once he has it; every other defender clears to the sideline; the human has the FS. */
const liveOneOnOne = (difficulty: DifficultyId = 'pro', seed = 1): PlayEngine => {
  const { engine } = build({ offensePlayId: 'iform-dive-right', defensePlayId: '43-cover3-zone', seed, ruleset: 'arcade', userSide: 'away', controlRole: 'FS', difficulty }, {}, {
    decider: scripted({ 'off:RB': (a, s) => (a.hasBall ? ahead(s, 'offense') : toward(a, s.ball.pos)) }, clearDefense),
  });
  for (let n = 0; engine.state.ball.carrierId !== 'off:RB' && n < 400; n++) engine.tick({ away: emptyInput() });
  expect(engine.state.ball.carrierId).toBe('off:RB');
  return engine;
};

const athlete = (engine: PlayEngine, id: string): Athlete => findAthlete(engine.state, id)!;

/** Puts the FS `gap` yards from the back along the offense's direction (+ = in front of him) with the given velocities. */
const stage = (engine: PlayEngine, gap: number, rbVel: { x: number; y: number }, fsVel: { x: number; y: number }): { fs: Athlete; rb: Athlete } => {
  const dir = engine.state.ctx.direction;
  const rb = athlete(engine, 'off:RB');
  const fs = athlete(engine, 'def:FS');
  fs.pos = { x: rb.pos.x, y: rb.pos.y + dir * gap };
  rb.vel = { ...rbVel };
  fs.vel = { ...fsVel };
  fs.facing = angle(sub(rb.pos, fs.pos));
  return { fs, rb };
};

const at = (fs: Athlete, rb: Athlete, extra: Partial<UserPlayInput> = {}): UserPlayInput => ({ ...emptyInput(), move: normalize(sub(rb.pos, fs.pos)), sprint: true, ...extra });

describe('user tackle assist', () => {
  it('breaks the defender down on a carrier coming at him: no burst, 80% effort, and the tackle button wraps', () => {
    const engine = liveOneOnOne();
    const dir = engine.state.ctx.direction;
    const { fs, rb } = stage(engine, 2.5, { x: 0, y: dir * 9 }, { x: 0, y: -dir * 8 });
    const intent = userControl(fs, at(fs, rb, { tackle: true }), engine.state, { receiverSlots: [] });
    expect(intent.sprint).toBe(false);
    expect(len(intent.move)).toBeLessThanOrEqual(BREAKDOWN_EFFORT + 1e-9);
    expect(intent.action).toBe('tackle');
    expect(intent.targetId).toBe('off:RB');
  });

  it('never lunges at a carrier running toward the defender, but lays out for one getting away', () => {
    const engine = liveOneOnOne();
    const dir = engine.state.ctx.direction;
    for (const gap of [1.5, 2, 2.3]) {
      const { fs, rb } = stage(engine, gap, { x: 0, y: dir * 9 }, { x: 0, y: -dir * 6 });
      expect(userControl(fs, at(fs, rb, { tackle: true }), engine.state, { receiverSlots: [] }).action).toBe('tackle');
    }
    // Behind him and not gaining: the lunge is the only way to get him.
    const { fs, rb } = stage(engine, -1.8, { x: 0, y: dir * 9 }, { x: 0, y: dir * 7 });
    const chase = userControl(fs, at(fs, rb, { tackle: true }), engine.state, { receiverSlots: [] });
    expect(chase.action).toBe('dive');
    expect(chase.sprint).toBe(true);
  });

  it('a hit-stick press commits the defender to the full-speed hit (no breakdown)', () => {
    const engine = liveOneOnOne();
    const dir = engine.state.ctx.direction;
    const { fs, rb } = stage(engine, 2.5, { x: 0, y: dir * 9 }, { x: 0, y: -dir * 8 });
    expect(userControl(fs, at(fs, rb, { hitStick: true }), engine.state, { receiverSlots: [] }).sprint).toBe(true);
    const next = userControl(fs, at(fs, rb), engine.state, { receiverSlots: [] });
    expect(next.sprint).toBe(true);
    expect(len(next.move)).toBeCloseTo(1, 6);
  });

  it('through the engine the user meets the runner under control and square, without leaving his feet, for a form tackle', () => {
    let wraps = 0;
    for (let seed = 1; seed <= 6; seed++) {
      const engine = liveOneOnOne('pro', seed);
      const top = maxSpeed(athlete(engine, 'def:FS').attrs.speed);
      let prev: { speed: number; off: number } | null = null;
      while (!engine.isDead) {
        const fs = athlete(engine, 'def:FS');
        const rb = athlete(engine, 'off:RB');
        const d = dist(fs.pos, rb.pos);
        const snap = { speed: len(fs.vel), off: Math.abs(angleDiff(fs.facing, angle(sub(rb.pos, fs.pos)))) };
        const before = engine.state.events.length;
        engine.tick({ away: at(fs, rb, { tackle: d <= 1.6 }) });
        const contact = engine.state.events.slice(before).find((e) => (e.type === 'tackle' && e.tackler === 'def:FS') || ((e.type === 'brokenTackle' || e.type === 'missedTackle') && e.defender === 'def:FS'));
        if (!contact) {
          expect(athlete(engine, 'def:FS').state).not.toBe('diving');
          prev = snap;
          continue;
        }
        expect(prev).not.toBeNull();
        expect(prev!.speed).toBeLessThanOrEqual(FORM_TACKLE_SPEED * top);
        expect(prev!.off).toBeLessThanOrEqual(formTackleSquare(getDifficulty('pro').userTackleAssist ?? 0));
        if (contact.type === 'tackle') {
          expect(contact.kind).toBe('wrap');
          wraps += 1;
        }
        break;
      }
    }
    expect(wraps).toBeGreaterThanOrEqual(3);
  });

  it('scales with userTackleAssist: rookie reads the cut further and gets more forgiveness than legend', () => {
    const [rookie, legend] = [getDifficulty('rookie'), getDifficulty('legend')];
    expect(rookie.userTackleAssist!).toBeGreaterThan(legend.userTackleAssist!);
    expect(formTackleSquare(rookie.userTackleAssist!)).toBeGreaterThan(formTackleSquare(legend.userTackleAssist!));
    const lateral = (id: DifficultyId): number => {
      const engine = liveOneOnOne(id);
      expect(userTackleAssist(engine.state)).toBe(getDifficulty(id).userTackleAssist);
      const dir = engine.state.ctx.direction;
      // The back cuts hard to +x while still coming at the FS.
      const { fs, rb } = stage(engine, 2.5, { x: 6, y: dir * 6 }, { x: 0, y: -dir * 7 });
      return userControl(fs, at(fs, rb), engine.state, { receiverSlots: [] }).move.x;
    };
    expect(lateral('rookie')).toBeGreaterThan(lateral('legend'));
    // Reading the move takes its bonus away in the contest; a stumble is never forgiven.
    const rb = athlete(liveOneOnOne(), 'off:RB');
    rb.state = 'juking';
    expect(carrierPower(rb, rookie.userTackleAssist)).toBeLessThan(carrierPower(rb, legend.userTackleAssist));
    expect(carrierPower(rb, 0)).toBeGreaterThan(carrierPower(rb, 1));
    rb.state = 'stumbling';
    expect(carrierPower(rb, 1)).toBe(carrierPower(rb, 0));
  });
});
