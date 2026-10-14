/**
 * Pull-back passing input: pointer drags, the right stick and the keyboard reticle become a throw to a field SPOT
 * through the camera (any orientation), with a cancel circle, a monotone power curve, the lob switch and the
 * receiver-button throws still working.
 */
import { describe, expect, it } from 'vitest';
import { vec2, type Vec2 } from '@/core/vec2';
import { Camera } from '@/ui/camera';
import { GameSpeedGate } from '@/ui/game/game-speed';
import { buildPlayInput, createThrowHold, dropThrowHold, type PlayInputOptions } from '@/ui/game/play-input';
import {
  armRange, BULLET_MAX_YARDS, CANCEL_RADIUS_PX, latestAimPreview, MAX_PULL_PX, MIN_THROW_YARDS, pullPower, STICK_START, stickPower, throwDistance,
} from '@/ui/game/throw-aim';
import { AIM_EDGE_MARGIN, AIM_HINT_TICKS, aimEdgePoint, clampChipLeft, drawThrowAim, renderThrowAim, resetAimHint } from '@/ui/game/throw-aim-view';
import type { InputState, PointerState } from '@/ui/input/types';
import { buildPlayState, type Fixture } from '../../fixtures/play-state';
import { createFakeCtx, makeInput, type InputOverrides } from '../render/fake-ctx';
import { makeUi } from './fixtures';

const SLOTS = ['WR3', 'TE1', 'RB', 'WR1', 'WR2'];

const camera = (rotation = 0): Camera => {
  const c = new Camera(480, 270);
  c.setRotation(rotation);
  c.zoom = 6;
  return c;
};

/** A camera turned a quarter (world +y to the screen's right): proves nothing assumes an orientation. */
const quarterCamera = (): Camera => {
  const c = camera();
  const t = c.target;
  const z = c.zoom;
  c.worldToScreen = (v: Vec2): Vec2 => vec2(240 + (v.y - t.y) * z, 135 + (v.x - t.x) * z);
  c.screenToWorld = (p: Vec2): Vec2 => vec2(t.x + (p.y - 135) / z, t.y + (p.x - 240) / z);
  c.fieldAxisToWorld = (a: Vec2): Vec2 => vec2(a.y, a.x);
  return c;
};

const qbFixture = (): Fixture => {
  const f = buildPlayState({ userSide: 'home', controlRole: 'QB' });
  const qb = f.byRole('offense', 'QB');
  f.state.phase = 'live';
  qb.hasBall = true;
  f.state.ball.carrierId = qb.id;
  f.state.ball.phase = 'held';
  f.state.ball.pos = vec2(qb.pos.x, qb.pos.y);
  return f;
};

const opts = (): PlayInputOptions => ({ side: 'home', throwHold: createThrowHold(), formationSlots: SLOTS });
const ptr = (p: Vec2, down: boolean, justDown = false, justUp = false, secondary = false): PointerState => ({
  x: p.x, y: p.y, down, justDown, justUp, drag: null, ...(secondary ? { secondary: true } : {}),
});
const input = (o: InputOverrides & { aim?: Vec2 }): InputState => ({ ...makeInput(o), ...(o.aim ? { aim: o.aim } : {}) });

/** Presses at `start`, drags to `end` over a few ticks and releases there; returns the release tick's input. */
const drag = (f: Fixture, cam: Camera, o: PlayInputOptions, start: Vec2, end: Vec2, extra: { secondaryAt?: number; bulletHeld?: boolean } = {}) => {
  const b = (i: InputState) => buildPlayInput(i, f.state, cam, o);
  const bullet = extra.bulletHeld ? (['sprint'] as const) : ([] as const);
  const first = b(input({ device: 'mouse', pointer: ptr(start, true, true), pressed: ['throw1'] }));
  expect(first.throwSpot ?? null).toBeNull();
  for (let i = 1; i <= 4; i++) {
    const p = vec2(start.x + ((end.x - start.x) * i) / 4, start.y + ((end.y - start.y) * i) / 4);
    const mid = b(input({ device: 'mouse', pointer: ptr(p, true, false, false, extra.secondaryAt === i), down: ['throw1', ...bullet] }));
    expect(mid.throwSpot ?? null).toBeNull();
    expect(mid.throwTo).toBeNull();
  }
  return b(input({ device: 'mouse', pointer: ptr(end, false, false, true), released: ['throw1'], down: [...bullet] }));
};

const unit = (v: Vec2): Vec2 => {
  const l = Math.hypot(v.x, v.y);
  return vec2(v.x / l, v.y / l);
};

/** Unit screen direction of a world direction at `at`. */
const screenDir = (cam: Camera, at: Vec2, world: Vec2): Vec2 => {
  const a = cam.worldToScreen(at);
  const b = cam.worldToScreen(vec2(at.x + world.x, at.y + world.y));
  return unit(vec2(b.x - a.x, b.y - a.y));
};

describe('pull-back power curve', () => {
  it('is zero inside the cancel circle, full at MAX_PULL_PX and monotone in between', () => {
    expect(pullPower(0)).toBe(0);
    expect(pullPower(CANCEL_RADIUS_PX)).toBe(0);
    expect(pullPower(MAX_PULL_PX)).toBe(1);
    expect(pullPower(MAX_PULL_PX * 3)).toBe(1);
    let prev = -1;
    for (let px = 0; px <= MAX_PULL_PX; px += 4) {
      const d = throwDistance(pullPower(px), 80);
      expect(d).toBeGreaterThanOrEqual(prev);
      prev = d;
    }
    expect(throwDistance(0, 80)).toBe(MIN_THROW_YARDS);
    expect(throwDistance(1, 80)).toBeCloseTo(armRange(80));
    expect(armRange(99)).toBeGreaterThan(armRange(40));
    expect(stickPower(STICK_START)).toBe(0);
    expect(stickPower(1)).toBe(1);
  });
});

describe('pointer pull-back', () => {
  for (const [name, cam] of [['rotation 0', camera()], ['flipped', camera(Math.PI)], ['quarter turn', quarterCamera()]] as const) {
    it(`throws to a spot in the direction opposite the drag (${name})`, () => {
      const f = qbFixture();
      const qb = f.byRole('offense', 'QB');
      const attack = f.state.ctx.direction;
      for (const world of [vec2(0, attack), unit(vec2(0.5, attack))]) {
        // Screen direction of `world` from the QB; drag the other way.
        const dir = screenDir(cam, qb.pos, world);
        const start = vec2(300, 150);
        const out = drag(f, cam, opts(), start, vec2(start.x - dir.x * 50, start.y - dir.y * 50));
        expect(out.throwTo).toBeNull();
        const spot = out.throwSpot!;
        expect(spot).toBeTruthy();
        const got = unit(vec2(spot.x - qb.pos.x, spot.y - qb.pos.y));
        expect(world.x * got.x + world.y * got.y).toBeGreaterThan(0.999);
        expect(Math.hypot(spot.x - qb.pos.x, spot.y - qb.pos.y)).toBeCloseTo(throwDistance(pullPower(50), qb.attrs.throwPower), 5);
      }
    });
  }

  it('short pulls are soft short balls, long pulls deep ones; the lob switch picks a lob', () => {
    const f = qbFixture();
    const cam = camera();
    const qb = f.byRole('offense', 'QB');
    const back = screenDir(cam, qb.pos, vec2(0, -f.state.ctx.direction));
    const start = vec2(240, 135);
    const pulled = (px: number): Vec2 => vec2(start.x + back.x * px, start.y + back.y * px);
    const short = drag(f, cam, opts(), start, pulled(20));
    const deep = drag(f, cam, opts(), start, pulled(90));
    const ds = Math.hypot(short.throwSpot!.x - qb.pos.x, short.throwSpot!.y - qb.pos.y);
    const dd = Math.hypot(deep.throwSpot!.x - qb.pos.x, deep.throwSpot!.y - qb.pos.y);
    expect(ds).toBeLessThan(BULLET_MAX_YARDS);
    expect(short.throwType).toBe('bullet');
    expect(dd).toBeGreaterThan(30);
    expect(deep.throwType).toBe('touch');
    const lob = drag(f, cam, opts(), start, pulled(80), { secondaryAt: 2 });
    expect(lob.throwType).toBe('lob');
  });

  it('holding Shift (sprint) at the release makes any pull-back a bullet, even a deep ball or a lob', () => {
    const f = qbFixture();
    const cam = camera();
    const qb = f.byRole('offense', 'QB');
    const back = screenDir(cam, qb.pos, vec2(0, -f.state.ctx.direction));
    const start = vec2(240, 135);
    const pulled = (px: number): Vec2 => vec2(start.x + back.x * px, start.y + back.y * px);
    const deep = drag(f, cam, opts(), start, pulled(90), { bulletHeld: true });
    expect(Math.hypot(deep.throwSpot!.x - qb.pos.x, deep.throwSpot!.y - qb.pos.y)).toBeGreaterThan(BULLET_MAX_YARDS);
    expect(deep.throwType).toBe('bullet');
    expect(drag(f, cam, opts(), start, pulled(80), { secondaryAt: 2, bulletHeld: true }).throwType).toBe('bullet');
    // Without Shift the same deep pull stays a touch pass.
    expect(drag(f, cam, opts(), start, pulled(90)).throwType).toBe('touch');
  });

  it('the aim preview labels the throw a bullet while Shift is held', () => {
    const f = qbFixture();
    const cam = camera();
    const qb = f.byRole('offense', 'QB');
    const back = screenDir(cam, qb.pos, vec2(0, -f.state.ctx.direction));
    const start = vec2(240, 135);
    const o = opts();
    const b = (i: InputState) => buildPlayInput(i, f.state, cam, o);
    b(input({ device: 'mouse', pointer: ptr(start, true, true), pressed: ['throw1'] }));
    const far = vec2(start.x + back.x * 90, start.y + back.y * 90);
    b(input({ device: 'mouse', pointer: ptr(far, true), down: ['throw1'] }));
    expect(latestAimPreview(f.state)?.throwType).toBe('touch');
    b(input({ device: 'mouse', pointer: ptr(far, true), down: ['throw1', 'sprint'] }));
    expect(latestAimPreview(f.state)?.throwType).toBe('bullet');
  });

  it('dragging back into the start circle cancels, and a mouse press never throws to receiver 1', () => {
    const f = qbFixture();
    const cam = camera();
    const o = opts();
    const start = vec2(240, 150);
    const b = (i: InputState) => buildPlayInput(i, f.state, cam, o);
    b(input({ device: 'mouse', pointer: ptr(start, true, true), pressed: ['throw1'] }));
    b(input({ device: 'mouse', pointer: ptr(vec2(240, 210), true), down: ['throw1'] }));
    expect(latestAimPreview(f.state)?.cancelled).toBe(false);
    b(input({ device: 'mouse', pointer: ptr(vec2(242, 152), true), down: ['throw1'] }));
    expect(latestAimPreview(f.state)?.cancelled).toBe(true);
    const out = b(input({ device: 'mouse', pointer: ptr(vec2(242, 152), false, false, true), released: ['throw1'] }));
    expect(out.throwSpot ?? null).toBeNull();
    expect(out.throwTo).toBeNull();
    expect(latestAimPreview(f.state)).toBeNull();
  });

  it('draws the arc, reticle and receiver ring through the camera', () => {
    const f = qbFixture();
    const cam = camera();
    const o = opts();
    const b = (i: InputState) => buildPlayInput(i, f.state, cam, o);
    b(input({ device: 'mouse', pointer: ptr(vec2(240, 150), true, true) }));
    b(input({ device: 'mouse', pointer: ptr(vec2(240, 220), true) }));
    const preview = latestAimPreview(f.state);
    expect(preview).not.toBeNull();
    const ctx = createFakeCtx();
    drawThrowAim(ctx, cam, makeUi().rc.theme, preview, f.state);
    expect(ctx.fills.length).toBeGreaterThan(20);
  });
});

describe('gamepad and keyboard aim', () => {
  it('right stick: pull and let go throws; easing it back to the centre cancels', () => {
    const f = qbFixture();
    const cam = camera();
    const o = opts();
    const qb = f.byRole('offense', 'QB');
    const b = (i: InputState) => buildPlayInput(i, f.state, cam, o);
    // Stick pulled back (away from the attack direction on screen) -> the ball goes downfield.
    const back = screenDir(cam, qb.pos, vec2(0, -f.state.ctx.direction));
    const at = (m: number): Vec2 => vec2(back.x * m, back.y * m);
    for (let t = 0; t < 5; t++) expect(b(input({ device: 'gamepad', aim: at(0.9) })).throwSpot ?? null).toBeNull();
    b(input({ device: 'gamepad', aim: at(0.3) }));
    const out = b(input({ device: 'gamepad' }));
    const spot = out.throwSpot!;
    expect(spot).toBeTruthy();
    expect(f.state.ctx.direction * (spot.y - qb.pos.y)).toBeGreaterThan(20);
    expect(Math.abs(spot.x - qb.pos.x)).toBeLessThan(0.01);
    for (let m = 0.9; m > 0; m -= 0.08) b(input({ device: 'gamepad', aim: at(m) }));
    expect(b(input({ device: 'gamepad' })).throwSpot ?? null).toBeNull();
  });

  it('keyboard: throw modifier + movement steers the reticle (the QB stands), releasing throws to it', () => {
    const f = qbFixture();
    const cam = camera();
    const o = opts();
    const b = (i: InputState) => buildPlayInput(i, f.state, cam, o);
    let last = null as ReturnType<typeof latestAimPreview>;
    for (let t = 0; t < 20; t++) {
      const r = b(input({ device: 'keyboard', down: ['throwModifier'], axis: vec2(1, 0) }));
      expect(r.move).toEqual(vec2(0, 0));
      const p = latestAimPreview(f.state)!;
      if (last) expect(p.target).not.toEqual(last.target);
      last = p;
    }
    const out = b(input({ device: 'keyboard', released: ['throwModifier'] }));
    expect(out.throwSpot).toEqual(last!.target);
    // Shift held when the modifier is let go makes the reticle throw a bullet.
    const o3 = opts();
    const b3 = (i: InputState) => buildPlayInput(i, f.state, cam, o3);
    for (let t = 0; t < 40; t++) b3(input({ device: 'keyboard', down: ['throwModifier', 'sprint'], axis: vec2(1, 0) }));
    const fired = b3(input({ device: 'keyboard', released: ['throwModifier'], down: ['sprint'] }));
    expect(fired.throwSpot).toBeTruthy();
    expect(fired.throwType).toBe('bullet');
    // Modifier + a receiver's button is still the bullet to that receiver.
    const o2 = opts();
    const b2 = (i: InputState) => buildPlayInput(i, f.state, cam, o2);
    b2(input({ device: 'keyboard', down: ['throwModifier'], axis: vec2(1, 0) }));
    b2(input({ device: 'keyboard', down: ['throwModifier'], pressed: ['throw2'], axis: vec2(1, 0) }));
    const classic = b2(input({ device: 'keyboard', down: ['throwModifier'], released: ['throw2'] }));
    expect(classic.throwTo).toBe(1);
    expect(classic.throwType).toBe('bullet');
    expect(classic.throwSpot ?? null).toBeNull();
  });
});

describe('pull-back pass in real play conditions', () => {
  it('starts even when the press edge was dropped (game speed 0.5x skips loop ticks) or the keyboard was last used', () => {
    const f = qbFixture();
    const cam = camera();
    const qb = f.byRole('offense', 'QB');
    const back = screenDir(cam, qb.pos, vec2(0, -f.state.ctx.direction));
    const start = vec2(240, 135);
    const end = vec2(start.x + back.x * 60, start.y + back.y * 60);
    const gate = new GameSpeedGate();
    const o = opts();
    let spot: Vec2 | null = null;
    // At 0.5x every other loop tick runs no play tick: the press lands on a skipped one.
    const frames: InputState[] = [
      input({ device: 'mouse', pointer: ptr(start, false) }),
      input({ device: 'mouse', pointer: ptr(start, false) }),
      input({ device: 'mouse', pointer: ptr(start, true, true) }),
      input({ device: 'mouse', pointer: ptr(start, true) }),
      input({ device: 'mouse', pointer: ptr(end, true) }),
      input({ device: 'mouse', pointer: ptr(end, true) }),
      input({ device: 'mouse', pointer: ptr(end, false, false, true) }),
      input({ device: 'mouse', pointer: ptr(end, false) }),
      input({ device: 'mouse', pointer: ptr(end, false) }),
    ];
    for (const frame of frames) {
      for (const tick of gate.step(0.5, frame)) spot = buildPlayInput(tick, f.state, cam, o).throwSpot ?? spot;
    }
    expect(spot).not.toBeNull();
    expect(f.state.ctx.direction * (spot!.y - qb.pos.y)).toBeGreaterThan(10);
    // WASD held to scramble while the mouse drags: the keyboard is the last device, the drag still throws.
    const o2 = opts();
    const b = (i: InputState) => buildPlayInput(i, f.state, cam, o2);
    b(input({ device: 'keyboard', axis: vec2(0, 1), pointer: ptr(start, true, true) }));
    b(input({ device: 'keyboard', axis: vec2(0, 1), pointer: ptr(end, true) }));
    expect(b(input({ device: 'keyboard', axis: vec2(0, 1), pointer: ptr(end, false, false, true) })).throwSpot).toBeTruthy();
  });

  it('a pointer already held when the play reaches the QB (held through the snap) does not start an aim', () => {
    const f = qbFixture();
    const cam = camera();
    const o = opts();
    const b = (i: InputState) => buildPlayInput(i, f.state, cam, o);
    b(input({ device: 'mouse', pointer: ptr(vec2(240, 135), true) }));
    b(input({ device: 'mouse', pointer: ptr(vec2(180, 135), true) }));
    expect(latestAimPreview(f.state)).toBeNull();
    expect(b(input({ device: 'mouse', pointer: ptr(vec2(180, 135), false, false, true) })).throwSpot ?? null).toBeNull();
  });

  it('a press made while the shotgun snap is in the air becomes the pull-back once the QB has the ball', () => {
    const f = qbFixture();
    const cam = camera();
    const qb = f.byRole('offense', 'QB');
    const o = opts();
    const b = (i: InputState) => buildPlayInput(i, f.state, cam, o);
    const back = screenDir(cam, qb.pos, vec2(0, -f.state.ctx.direction));
    const start = vec2(300, 140);
    const end = vec2(start.x + back.x * 70, start.y + back.y * 70);
    qb.hasBall = false;
    f.state.ball.phase = 'inAir';
    f.state.ball.carrierId = null;
    b(input({ device: 'mouse', pointer: ptr(vec2(start.x, start.y + 30), false) }));
    b(input({ device: 'mouse', pointer: ptr(start, true, true), pressed: ['throw1'] }));
    b(input({ device: 'mouse', pointer: ptr(vec2(start.x + back.x * 30, start.y + back.y * 30), true), down: ['throw1'] }));
    expect(latestAimPreview(f.state)).toBeNull();
    qb.hasBall = true;
    f.state.ball.phase = 'held';
    f.state.ball.carrierId = qb.id;
    b(input({ device: 'mouse', pointer: ptr(end, true), down: ['throw1'] }));
    // The pull counts from where the finger / button went down.
    expect(latestAimPreview(f.state)?.startScreen).toEqual(start);
    const out = b(input({ device: 'mouse', pointer: ptr(end, false, false, true), released: ['throw1'] }));
    expect(Math.hypot(out.throwSpot!.x - qb.pos.x, out.throwSpot!.y - qb.pos.y)).toBeCloseTo(throwDistance(pullPower(70), qb.attrs.throwPower), 5);
    // The click that snapped the ball, still held when the QB gets it, never starts one.
    const o2 = opts();
    const b2 = (i: InputState) => buildPlayInput(i, f.state, cam, o2);
    f.state.phase = 'presnap';
    b2(input({ device: 'mouse', pointer: ptr(vec2(start.x, start.y + 30), false) }));
    b2(input({ device: 'mouse', pointer: ptr(start, true, true), pressed: ['throw1'] }));
    f.state.phase = 'live';
    b2(input({ device: 'mouse', pointer: ptr(end, true), down: ['throw1'] }));
    expect(latestAimPreview(f.state)).toBeNull();
    expect(b2(input({ device: 'mouse', pointer: ptr(end, false, false, true), released: ['throw1'] })).throwSpot ?? null).toBeNull();
  });

  it('a left click away from every receiver is the primary\'s throw button (its glyph); a touch tap there throws nothing', () => {
    const f = qbFixture();
    const cam = camera();
    const click = (device: 'mouse' | 'touch', ticks: number) => {
      const o = opts();
      const b = (i: InputState) => buildPlayInput(i, f.state, cam, o);
      const p = vec2(470, 12);
      b(input({ device, pointer: ptr(p, true, true), pressed: ['throw1'] }));
      for (let t = 0; t < ticks; t++) b(input({ device, pointer: ptr(p, true), down: ['throw1'] }));
      return b(input({ device, pointer: ptr(p, false, false, true), released: ['throw1'] }));
    };
    const quick = click('mouse', 2);
    expect(quick.throwTo).toBe(0);
    expect(quick.throwType).toBe('touch');
    expect(click('mouse', 20).throwType).toBe('lob');
    expect(click('touch', 2).throwTo).toBeNull();
  });

  it('a slow press on a receiver that never moves is still a tap that throws to him', () => {
    const f = qbFixture();
    const cam = camera();
    const o = opts();
    const b = (i: InputState) => buildPlayInput(i, f.state, cam, o);
    const wr = f.byRole('offense', 'TE1');
    const at = cam.worldToScreen(wr.pos);
    const p = vec2(at.x, at.y - 6);
    b(input({ device: 'touch', pointer: ptr(p, true, true) }));
    for (let t = 0; t < 25; t++) b(input({ device: 'touch', pointer: ptr(p, true) }));
    const out = b(input({ device: 'touch', pointer: ptr(p, false, false, true) }));
    expect(out.throwTo).toBe(SLOTS.indexOf('TE1'));
    expect(out.throwType).toBe('touch');
  });

  it('a screen covering the play (pause) drops the aim: letting go afterwards throws nothing', () => {
    const f = qbFixture();
    const cam = camera();
    const o = opts();
    const b = (i: InputState) => buildPlayInput(i, f.state, cam, o);
    b(input({ device: 'mouse', pointer: ptr(vec2(240, 135), true, true) }));
    b(input({ device: 'mouse', pointer: ptr(vec2(180, 135), true) }));
    expect(latestAimPreview(f.state)).not.toBeNull();
    dropThrowHold(o.throwHold);
    expect(latestAimPreview(f.state)).toBeNull();
    expect(b(input({ device: 'mouse', pointer: ptr(vec2(300, 60), false) })).throwSpot ?? null).toBeNull();
  });
});

describe('in-game aim cue', () => {
  it('names the aim control under the QB early in a pass play until the player has aimed once', () => {
    resetAimHint();
    const f = qbFixture();
    const cam = camera();
    const theme = makeUi().rc.theme;
    const dim = (hint: string | null): number => {
      const ctx = createFakeCtx();
      renderThrowAim(ctx, cam, theme, f.state, 'home', hint);
      return ctx.fillsWith(theme.colors.textDim).length;
    };
    expect(dim(null)).toBe(0);
    expect(dim('DRAG BACK')).toBeGreaterThan(0);
    f.state.tick = f.state.snapTick + AIM_HINT_TICKS + 1;
    expect(dim('DRAG BACK')).toBe(0);
    f.state.tick = f.state.snapTick + 10;
    // Aim once: the cue retires for good.
    const o = opts();
    buildPlayInput(input({ device: 'mouse', pointer: ptr(vec2(240, 135), true, true) }), f.state, cam, o);
    buildPlayInput(input({ device: 'mouse', pointer: ptr(vec2(180, 135), true) }), f.state, cam, o);
    renderThrowAim(createFakeCtx(), cam, theme, f.state, 'home', 'DRAG BACK');
    dropThrowHold(o.throwHold);
    expect(dim('DRAG BACK')).toBe(0);
    resetAimHint();
  });
});


describe('aim captions near the screen edge', () => {
  it('keeps a caption inside the screen and centred when it fits', () => {
    expect(clampChipLeft(240, 40, 480)).toBe(220);
    expect(clampChipLeft(470, 40, 480)).toBe(480 - AIM_EDGE_MARGIN - 40);
    expect(clampChipLeft(-30, 40, 480)).toBe(AIM_EDGE_MARGIN);
  });

  it('points at an off-screen landing spot from the edge on the line of the throw', () => {
    expect(aimEdgePoint(vec2(100, 135), vec2(300, 100), 480, 270)).toBeNull();
    const e = aimEdgePoint(vec2(100, 135), vec2(900, 135), 480, 270)!;
    expect(e.y).toBeCloseTo(135);
    expect(e.x).toBeLessThan(480);
    expect(e.x).toBeGreaterThan(460);
    const up = aimEdgePoint(vec2(100, 135), vec2(500, -200), 480, 270)!;
    expect(up.y).toBeGreaterThanOrEqual(0);
    expect(up.x).toBeGreaterThan(100);
    expect(up.x).toBeLessThan(480);
    // On the segment from the passer toward the spot.
    const t = (up.x - 100) / 400;
    expect(up.y).toBeCloseTo(135 + (-335) * t);
  });

  it('draws the caption of an off-screen spot inside the screen', () => {
    const f = qbFixture();
    const cam = camera();
    const o = opts();
    const b = (i: InputState) => buildPlayInput(i, f.state, cam, o);
    b(input({ device: 'mouse', pointer: ptr(vec2(240, 150), true, true) }));
    b(input({ device: 'mouse', pointer: ptr(vec2(240, 220), true) }));
    const preview = latestAimPreview(f.state)!;
    const theme = makeUi().rc.theme;
    for (const target of [vec2(preview.from.x + 30, preview.from.y + 80), vec2(preview.from.x - 40, preview.from.y - 60)]) {
      expect(aimEdgePoint(cam.worldToScreen(preview.from), cam.worldToScreen(target), 480, 270)).not.toBeNull();
      const ctx = createFakeCtx();
      drawThrowAim(ctx, cam, theme, { ...preview, target }, f.state);
      // The caption chip: the tall shadow-coloured slab (the ground track's dashes are only a pixel or two).
      const slabs = ctx.fills.filter((r) => r.color.toLowerCase() === theme.colors.shadow.toLowerCase() && r.h >= theme.glyphH);
      expect(slabs.length).toBeGreaterThan(0);
      for (const r of slabs) {
        expect(r.x).toBeGreaterThanOrEqual(0);
        expect(r.x + r.w).toBeLessThanOrEqual(480);
        expect(r.y).toBeGreaterThanOrEqual(0);
        expect(r.y + r.h).toBeLessThanOrEqual(270);
      }
    }
  });
});
