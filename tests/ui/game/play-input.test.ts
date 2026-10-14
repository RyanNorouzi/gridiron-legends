import { describe, expect, it } from 'vitest';
import { TICK_DT } from '@/core/time';
import { vec2 } from '@/core/vec2';
import type { RouteDef } from '@/playbook/types';
import { Camera } from '@/ui/camera';
import { LOB_HOLD_SEC, buildPlayInput, createThrowHold, emptyPlayInput, playInputContext, throwTypeFor, type PlayInputOptions } from '@/ui/game/play-input';
import { buildPlayState, type Fixture } from '../../fixtures/play-state';
import { makeInput, pointerAt, type InputOverrides } from '../render/fake-ctx';

const camera = (rotation = 0): Camera => {
  const c = new Camera(480, 270);
  c.setRotation(rotation);
  c.zoom = 6;
  return c;
};

/** shotgun-mesh receiver order: WR3 (drag), TE1 (drag), RB (swing), WR1 (corner), WR2 (go). */
const SLOTS = ['WR3', 'TE1', 'RB', 'WR1', 'WR2'];

const opts = (side: 'home' | 'away', extra: Partial<PlayInputOptions> = {}): PlayInputOptions => ({ side, throwHold: createThrowHold(), formationSlots: SLOTS, ...extra });

const liveWithBall = (role: string, f: Fixture = buildPlayState({ userSide: 'home', controlRole: role })): Fixture => {
  const carrier = f.byRole('offense', role);
  f.state.phase = 'live';
  carrier.hasBall = true;
  f.state.ball.carrierId = carrier.id;
  f.state.ball.phase = 'held';
  f.state.ball.pos = vec2(carrier.pos.x, carrier.pos.y);
  return f;
};

const build = (f: Fixture, o: InputOverrides, po: PlayInputOptions, cam = camera()) => buildPlayInput(makeInput(o), f.state, cam, po);

describe('play input contexts', () => {
  it('classifies presnap, qb, carrier, receiver, defense, returner, kick and dead', () => {
    const f = buildPlayState({ userSide: 'home', controlRole: 'QB' });
    expect(playInputContext(f.state, 'home')).toBe('presnapOffense');
    expect(playInputContext(f.state, 'away')).toBe('presnapDefense');
    liveWithBall('QB', f);
    expect(playInputContext(f.state, 'home')).toBe('qb');
    const qb = f.byRole('offense', 'QB');
    qb.pos.y = f.state.losY + 2;
    expect(playInputContext(f.state, 'home')).toBe('carrier');
    qb.hasBall = false;
    expect(playInputContext(f.state, 'home')).toBe('receiver');
    f.state.kickMeter = { phase: 'power', cursor: 0.2, power: null, accuracy: null };
    expect(playInputContext(f.state, 'home')).toBe('kick');
    f.state.kickMeter = null;
    f.state.phase = 'dead';
    expect(playInputContext(f.state, 'home')).toBe('dead');
    const d = buildPlayState({ userSide: 'away', controlRole: 'FS' });
    d.state.phase = 'live';
    expect(playInputContext(d.state, 'away')).toBe('defense');
    const r = buildPlayState({ offensePlayId: 'kickoff-deep', defensePlayId: 'kickReturn-middle', userSide: 'away', controlRole: 'KR' });
    r.state.phase = 'live';
    expect(playInputContext(r.state, 'away')).toBe('returner');
    expect(playInputContext(r.state, 'home')).toBe('spectator');
  });
});

describe('presnap offense', () => {
  it('snaps on snap or confirm and moves along the field frame', () => {
    const f = buildPlayState({ userSide: 'home', controlRole: 'QB' });
    expect(build(f, { pressed: ['snap'] }, opts('home')).snap).toBe(true);
    expect(build(f, { pressed: ['confirm'] }, opts('home')).snap).toBe(true);
    // The axis goes through the camera (whatever the field orientation is).
    const moved = build(f, { axis: vec2(0, -1) }, opts('home'));
    expect(moved.move).toEqual(camera().fieldAxisToWorld(vec2(0, -1)));
    expect(Math.hypot(moved.move.x, moved.move.y)).toBeCloseTo(1);
    expect(moved.snap).toBe(false);
  });

  it('rotated cameras flip the axis so the same screen direction is always the attack direction', () => {
    const f = buildPlayState({ userSide: 'home', controlRole: 'QB' });
    for (const axis of [vec2(1, 0), vec2(0, -1)]) {
      const plain = build(f, { axis }, opts('home')).move;
      const flipped = build(f, { axis }, opts('home'), camera(Math.PI)).move;
      expect(flipped).toEqual(camera(Math.PI).fieldAxisToWorld(axis));
      expect(flipped.x).toBeCloseTo(-plain.x);
      expect(flipped.y).toBeCloseTo(-plain.y);
    }
  });

  it('audible mode suppresses motion and maps the direction keys to audible kinds', () => {
    const f = buildPlayState({ userSide: 'home', controlRole: 'QB' });
    const a = build(f, { down: ['audible'], pressed: ['audibleManBeater'], axis: vec2(1, 0) }, opts('home'));
    expect(a.audible).toBe('manBeater');
    expect(a.move).toEqual(vec2(0, 0));
    expect(a.snap).toBe(false);
    expect(build(f, { down: ['audible'], pressed: ['audibleFlipRunPass'] }, opts('home')).audible).toBe('passToRun');
    const run = buildPlayState({ userSide: 'home', controlRole: 'QB', offensePlayId: 'iform-dive-right' });
    expect(build(run, { down: ['audible'], pressed: ['audibleFlipRunPass'] }, opts('home')).audible).toBe('runToPass');
    expect(build(f, { pressed: ['audibleManBeater'] }, opts('home')).audible).toBeNull();
  });

  it('defense pre-snap: audibles, switching and taps on defenders', () => {
    const f = buildPlayState({ userSide: 'away', controlRole: 'FS' });
    const cam = camera();
    expect(build(f, { down: ['audible'], pressed: ['defAudibleBlitz'] }, opts('away'), cam).defAudible).toBe('blitz');
    expect(build(f, { pressed: ['switchPlayer'] }, opts('away'), cam).switchPlayer).toBe(true);
    const ss = f.byRole('defense', 'SS');
    const p = cam.worldToScreen(ss.pos);
    const tapped = build(f, { device: 'touch', pointer: pointerAt(p.x, p.y - 6, true) }, opts('away'), cam);
    expect(tapped.switchPlayer).toBe(true);
    expect(tapped.switchToId).toBe(ss.id);
  });
});

describe('quarterback throws', () => {
  it('a tap throws a touch pass to the slot on release, never on press', () => {
    const f = liveWithBall('QB');
    const o = opts('home');
    const pressed = build(f, { pressed: ['throw1'] }, o);
    expect(pressed.throwTo).toBeNull();
    const held = build(f, { down: ['throw1'] }, o);
    expect(held.throwTo).toBeNull();
    const released = build(f, { released: ['throw1'] }, o);
    expect(released.throwTo).toBe(0);
    expect(released.throwType).toBe('touch');
    expect(o.throwHold.action).toBeNull();
  });

  it('holding past the lob threshold lobs; the modifier makes bullets, back-shoulders and high points', () => {
    const f = liveWithBall('QB');
    const hold = (buttons: string[], ticks: number, extra: Partial<PlayInputOptions> = {}): ReturnType<typeof buildPlayInput> => {
      const o = opts('home', extra);
      const action = buttons[0] as 'throw1';
      build(f, { pressed: [action], down: buttons as ['throw1'] }, o);
      for (let i = 1; i < ticks; i++) build(f, { down: buttons as ['throw1'] }, o);
      return build(f, { released: [action] }, o);
    };
    const lobTicks = Math.ceil(LOB_HOLD_SEC / TICK_DT) + 2;
    expect(hold(['throw1'], lobTicks).throwType).toBe('lob');
    expect(hold(['throw1'], 2).throwType).toBe('touch');
    expect(hold(['throw1', 'throwModifier'], 2).throwType).toBe('bullet');
    expect(hold(['throw1', 'throwModifier'], lobTicks).throwType).toBe('highPoint');
    const bs = hold(['throw4', 'throwModifier'], 2, { routes: f.routes });
    expect(bs.throwTo).toBe(3);
    expect(bs.throwType).toBe('backShoulder');
    const go: RouteDef = { id: 'go', type: 'go', waypoints: [{ dx: 0, dy: 30 }], breakTime: 2, depth: 30, scramble: 'continue' };
    expect(hold(['throw1', 'throwModifier'], 2, { routes: { WR3: go } }).throwType).toBe('backShoulder');
    expect(throwTypeFor(0, true, false)).toBe('bullet');
    expect(throwTypeFor(LOB_HOLD_SEC, false, true)).toBe('lob');
  });

  it('holding Shift (sprint) during a receiver throw makes it a bullet, over lob, high point and back shoulder', () => {
    const f = liveWithBall('QB');
    const hold = (buttons: string[], ticks: number, extra: Partial<PlayInputOptions> = {}): ReturnType<typeof buildPlayInput> => {
      const o = opts('home', extra);
      const action = buttons[0] as 'throw1';
      build(f, { pressed: [action], down: buttons as ['throw1'] }, o);
      for (let i = 1; i < ticks; i++) build(f, { down: buttons as ['throw1'] }, o);
      return build(f, { released: [action] }, o);
    };
    const lobTicks = Math.ceil(LOB_HOLD_SEC / TICK_DT) + 2;
    expect(hold(['throw1', 'sprint'], 2).throwType).toBe('bullet');
    expect(hold(['throw1', 'sprint'], lobTicks).throwType).toBe('bullet');
    expect(hold(['throw1', 'throwModifier', 'sprint'], lobTicks).throwType).toBe('bullet');
    expect(hold(['throw4', 'throwModifier', 'sprint'], 2, { routes: f.routes }).throwType).toBe('bullet');
    expect(throwTypeFor(LOB_HOLD_SEC, true, true, true)).toBe('bullet');
    // Without Shift nothing changes.
    expect(hold(['throw1'], 2).throwType).toBe('touch');
  });

  it('reads throw-away and sprint, ignores carrier moves, and pitches only on option plays', () => {
    const f = liveWithBall('QB');
    const o = opts('home');
    const r = build(f, { pressed: ['throwAway', 'juke', 'pitch'], down: ['sprint'] }, o);
    expect(r.throwAway).toBe(true);
    expect(r.sprint).toBe(true);
    expect(r.juke).toBe(false);
    expect(r.pitch).toBe(false);
    const option = liveWithBall('QB', buildPlayState({ userSide: 'home', controlRole: 'QB', offensePlayId: 'pistol-zoneRead' }));
    expect(build(option, { pressed: ['pitch'] }, opts('home')).pitch).toBe(true);
  });

  it('touch: tapping (press + release in place) an eligible receiver throws to its slot', () => {
    const f = liveWithBall('QB');
    const cam = camera();
    const te = f.byRole('offense', 'TE1');
    const p = cam.worldToScreen(te.pos);
    // The tap throws on release (a press can also start a pull-back drag), with no throw on the press itself.
    const o = opts('home');
    const down = build(f, { device: 'touch', pointer: pointerAt(p.x, p.y - 6, true) }, o, cam);
    expect(down.throwTo).toBeNull();
    const r = build(f, { device: 'touch', pointer: { ...pointerAt(p.x, p.y - 6), justUp: true } }, o, cam);
    expect(r.throwTo).toBe(SLOTS.indexOf('TE1'));
    expect(r.throwType).toBe('touch');
    expect(r.throwSpot ?? null).toBeNull();
    const o2 = opts('home');
    build(f, { device: 'touch', pointer: pointerAt(2, 2, true) }, o2, cam);
    const miss = build(f, { device: 'touch', pointer: { ...pointerAt(2, 2), justUp: true } }, o2, cam);
    expect(miss.throwTo).toBeNull();
    expect(miss.throwSpot ?? null).toBeNull();
  });
});

describe('carrier, receiver, defense, returner, kick, dead', () => {
  it('carrier moves: juke/spin/stiff-arm/hurdle, dive for backs, slide for quarterbacks', () => {
    const f = liveWithBall('RB', buildPlayState({ userSide: 'home', controlRole: 'RB' }));
    const r = build(f, { pressed: ['juke', 'spin', 'stiffArm', 'hurdle', 'dive'], down: ['sprint'] }, opts('home'));
    expect(r).toMatchObject({ juke: true, spin: true, stiffArm: true, hurdle: true, dive: true, sprint: true, slide: false, throwTo: null });
    const q = liveWithBall('QB');
    q.byRole('offense', 'QB').pos.y = q.state.losY + 3;
    const s = build(q, { pressed: ['dive'] }, opts('home'));
    expect(s.slide).toBe(true);
    expect(s.dive).toBe(false);
  });

  it('receivers can sprint, go up for the ball and dive', () => {
    const f = buildPlayState({ userSide: 'home', controlRole: 'WR1' });
    f.state.phase = 'live';
    f.state.ball.phase = 'inAir';
    f.state.ball.kind = 'pass';
    const r = build(f, { pressed: ['jumpSwat', 'dive', 'juke'], down: ['sprint'] }, opts('home'));
    expect(r).toMatchObject({ jumpSwat: true, dive: true, sprint: true, juke: false });
  });

  it('defenders: sprint aliases, strafe, tackle family, switch by button or tap', () => {
    const f = buildPlayState({ userSide: 'away', controlRole: 'FS' });
    f.state.phase = 'live';
    const cam = camera(Math.PI);
    const r = build(f, { pressed: ['tackle', 'hitStick', 'strip', 'jumpSwat', 'switchPlayer'], down: ['defSprint', 'strafe'] }, opts('away'), cam);
    expect(r).toMatchObject({ tackle: true, hitStick: true, strip: true, jumpSwat: true, switchPlayer: true, sprint: true, strafe: true, fairCatch: false });
    const cb = f.byRole('defense', 'CB1');
    const p = cam.worldToScreen(cb.pos);
    const t = build(f, { device: 'touch', pointer: pointerAt(p.x, p.y - 6, true) }, opts('away'), cam);
    expect(t.switchToId).toBe(cb.id);
    const self = cam.worldToScreen(f.byRole('defense', 'FS').pos);
    expect(build(f, { device: 'touch', pointer: pointerAt(self.x, self.y - 6, true) }, opts('away'), cam).switchToId).toBeNull();
  });

  it('returners fair catch by button or by tapping the airborne kick', () => {
    const f = buildPlayState({ offensePlayId: 'kickoff-deep', defensePlayId: 'kickReturn-middle', userSide: 'away', controlRole: 'KR' });
    f.state.phase = 'live';
    expect(build(f, { pressed: ['fairCatch'] }, opts('away')).fairCatch).toBe(false);
    f.state.ball.phase = 'inAir';
    f.state.ball.kind = 'kickoff';
    f.state.ball.z = 6;
    expect(build(f, { pressed: ['fairCatch'] }, opts('away')).fairCatch).toBe(true);
    const cam = camera();
    const p = cam.worldToScreen(f.state.ball.pos);
    const t = build(f, { device: 'touch', pointer: pointerAt(p.x, p.y - cam.zoom * 3, true) }, opts('away'), cam);
    expect(t.fairCatch).toBe(true);
    expect(t.switchToId).toBeNull();
  });

  it('kick meter: presses and lateral aim only', () => {
    const f = buildPlayState({ offensePlayId: 'fieldGoal-standard', userSide: 'home', controlRole: 'K' });
    f.state.kickMeter = { phase: 'power', cursor: 0.3, power: null, accuracy: null };
    const r = build(f, { pressed: ['kick'], axis: vec2(2, -1) }, opts('home'));
    expect(r.kickPress).toBe(true);
    // Only the across-field (world x) part of the camera-mapped axis aims, turned into kicker-relative aim (world x times
    // the attack direction, so the landing follows the stick either way the kick goes) and clamped to -1..1.
    const world = camera().fieldAxisToWorld(vec2(2, -1));
    expect(r.move).toEqual(vec2(Math.max(-1, Math.min(1, world.x * f.state.ctx.direction)), 0));
    expect(build(f, { pressed: ['confirm'] }, opts('home')).kickPress).toBe(true);
    expect(build(f, { pressed: ['snap'] }, opts('home')).snap).toBe(false);
  });

  it('kick aim follows the stick on screen whichever way the kick goes', () => {
    for (const direction of [1, -1] as const) {
      const f = buildPlayState({ offensePlayId: 'fieldGoal-standard', userSide: 'home', controlRole: 'K', direction });
      f.state.kickMeter = { phase: 'power', cursor: 0.3, power: null, accuracy: null };
      const cam = camera();
      cam.setRotation(direction === 1 ? 0 : Math.PI);
      const r = build(f, { axis: vec2(0, 1) }, opts('home'), cam);
      // kickBall turns aim a into a landing shift of a * direction in world x: it must match the stick's world x.
      const world = cam.fieldAxisToWorld(vec2(0, 1));
      expect(Math.sign(r.move.x * direction), `direction ${direction}`).toBe(Math.sign(world.x));
    }
  });

  it('dead plays produce an empty input and clear any pending hold', () => {
    const f = liveWithBall('QB');
    const o = opts('home');
    build(f, { pressed: ['throw2'], down: ['throw2'] }, o);
    expect(o.throwHold.action).toBe(1);
    f.state.phase = 'dead';
    expect(build(f, { down: ['throw2', 'sprint'], axis: vec2(1, 1) }, o)).toEqual(emptyPlayInput());
    expect(o.throwHold.action).toBeNull();
  });
});
