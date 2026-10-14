import { describe, expect, it } from 'vitest';
import { vec2 } from '@/core/vec2';
import { FIELD_LENGTH, FIELD_WIDTH, MIDDLE_X } from '@/game/types';
import { CAMERA_ZOOM, Camera, END_MARGIN, FIELD_MARGIN, KICK_BALL_LEAD_PX, KICK_MIN_ZOOM, ROT_LEFT, ROT_RIGHT, type CameraFrameContext } from '@/ui/camera';

const mid = vec2(MIDDLE_X, 60);
const ctxFor = (over: Partial<CameraFrameContext> = {}): CameraFrameContext => ({
  userSide: 'home', offense: 'home', direction: 1, ballPos: mid, controlledPos: vec2(20, 55), losY: 60, ...over,
});

describe('Camera transforms', () => {
  it('round-trips world <-> screen for both rotations and several zooms', () => {
    const cam = new Camera(480, 270);
    const points = [vec2(0, 0), vec2(53.33, 120), vec2(26.665, 60), vec2(12.5, 87.25), vec2(-3, 130)];
    for (const rotation of [ROT_RIGHT, ROT_LEFT]) {
      for (const zoom of [2, 5, 6, 9]) {
        cam.setRotation(rotation);
        cam.zoom = zoom;
        cam.target.x = 20;
        cam.target.y = 70;
        for (const p of points) {
          const back = cam.screenToWorld(cam.worldToScreen(p));
          expect(back.x).toBeCloseTo(p.x, 6);
          expect(back.y).toBeCloseTo(p.y, 6);
          const fwd = cam.worldToScreen(cam.screenToWorld(p));
          expect(fwd.x).toBeCloseTo(p.x, 6);
          expect(fwd.y).toBeCloseTo(p.y, 6);
        }
      }
    }
  });

  it('lays the field horizontally: world +y runs right (or left when flipped), world x runs down (or up)', () => {
    const cam = new Camera(480, 270);
    cam.target.x = MIDDLE_X;
    cam.target.y = 60;
    cam.zoom = 6;
    const ahead = cam.worldToScreen(vec2(MIDDLE_X, 61));
    expect(ahead.x).toBeCloseTo(240 + 6);
    expect(ahead.y).toBeCloseTo(135);
    const across = cam.worldToScreen(vec2(MIDDLE_X + 1, 60));
    expect(across.x).toBeCloseTo(240);
    expect(across.y).toBeCloseTo(135 + 6);
    cam.setRotation(ROT_LEFT);
    expect(cam.flipped).toBe(true);
    expect(cam.worldToScreen(vec2(MIDDLE_X, 61)).x).toBeCloseTo(240 - 6);
    expect(cam.worldToScreen(vec2(MIDDLE_X + 1, 60)).y).toBeCloseTo(135 - 6);
    // legacy values: 0 = not flipped, PI = flipped
    cam.setRotation(0);
    expect(cam.rotation).toBe(ROT_RIGHT);
    cam.setRotation(Math.PI);
    expect(cam.rotation).toBe(ROT_LEFT);
  });

  it('orders yard lines left to right in the attack direction for both rotations', () => {
    const cam = new Camera(480, 270);
    cam.target.x = MIDDLE_X;
    cam.target.y = 60;
    cam.zoom = 5;
    for (const direction of [1, -1] as const) {
      cam.setRotation(Camera.rotationFor(ctxFor({ direction })));
      const xs = [20, 30, 40, 50, 60, 70, 80].map((yard) => cam.worldToScreen(vec2(MIDDLE_X, 60 + direction * (yard - 50))).x);
      for (let i = 1; i < xs.length; i++) expect(xs[i] as number).toBeGreaterThan(xs[i - 1] as number);
      expect(cam.screenDirOf(direction)).toBe(1);
      expect(cam.screenDirOf(direction === 1 ? -1 : 1)).toBe(-1);
      // yard lines are vertical on screen: every point of one line shares the same screen x
      const top = cam.worldToScreen(vec2(0, 45));
      const bottom = cam.worldToScreen(vec2(FIELD_WIDTH, 45));
      expect(top.x).toBeCloseTo(bottom.x, 9);
      expect(Math.abs(bottom.y - top.y)).toBeCloseTo(FIELD_WIDTH * 5, 6);
    }
  });

  it('converts screen input axes to the field frame, flipping when rotated', () => {
    const cam = new Camera();
    // not flipped: right = +y (toward the far goal), down = +x
    expect(cam.fieldAxisToWorld(vec2(1, 0))).toEqual(vec2(0, 1));
    expect(cam.fieldAxisToWorld(vec2(0, 1))).toEqual(vec2(1, 0));
    cam.setRotation(ROT_LEFT);
    expect(cam.fieldAxisToWorld(vec2(1, 0))).toEqual(vec2(0, -1));
    expect(cam.fieldAxisToWorld(vec2(0, 1))).toEqual(vec2(-1, 0));
    expect(Object.is(cam.fieldAxisToWorld(vec2(1, 0)).x, 0)).toBe(true);
    // the axis conversion is the inverse of worldDirToScreen
    for (const rotation of [ROT_RIGHT, ROT_LEFT]) {
      cam.setRotation(rotation);
      const axis = vec2(0.6, -0.8);
      const back = cam.worldDirToScreen(cam.fieldAxisToWorld(axis));
      expect(back.x).toBeCloseTo(axis.x);
      expect(back.y).toBeCloseTo(axis.y);
      // and matches the point projection's direction
      const a = cam.worldToScreen(vec2(20, 50));
      const b = cam.worldToScreen(vec2(20.6, 49.2));
      const d = cam.worldDirToScreen(vec2(0.6, -0.8));
      expect((b.x - a.x) / cam.zoom).toBeCloseTo(d.x);
      expect((b.y - a.y) / cam.zoom).toBeCloseTo(d.y);
    }
  });

  it('reports visible bounds from viewport, zoom and target', () => {
    const cam = new Camera(480, 270);
    cam.target.x = MIDDLE_X;
    cam.target.y = 60;
    cam.zoom = 6;
    const b = cam.visibleBounds();
    expect(b.minX).toBeCloseTo(MIDDLE_X - 22.5);
    expect(b.maxX).toBeCloseTo(MIDDLE_X + 22.5);
    expect(b.minY).toBeCloseTo(60 - 40);
    expect(b.maxY).toBeCloseTo(60 + 40);
    expect(cam.isVisible(vec2(MIDDLE_X, 95))).toBe(true);
    expect(cam.isVisible(vec2(MIDDLE_X, 105))).toBe(false);
    cam.setRotation(ROT_LEFT);
    const flipped = cam.visibleBounds();
    expect(flipped).toEqual(b);
  });
});

describe('Camera rotation', () => {
  it('rotates so the offense always attacks to the right, for both possessions and with no local user', () => {
    const right = (over: Partial<CameraFrameContext>): number => {
      const cam = new Camera(480, 270);
      cam.setMode('standard', ctxFor(over));
      const ball = over.ballPos ?? mid;
      const dir = over.direction ?? 1;
      return cam.worldToScreen(vec2(ball.x, ball.y + dir * 5)).x - cam.worldToScreen(ball).x;
    };
    for (const userSide of ['home', 'away', null] as const) {
      for (const offense of ['home', 'away'] as const) {
        for (const direction of [1, -1] as const) {
          expect(right({ userSide, offense, direction })).toBeGreaterThan(0);
        }
      }
    }
    expect(Camera.rotationFor(ctxFor({ direction: 1 }))).toBe(ROT_RIGHT);
    expect(Camera.rotationFor(ctxFor({ direction: -1, userSide: 'away', offense: 'home' }))).toBe(ROT_LEFT);
  });

  it('on a kickoff or punt the local user RECEIVES, his return goes right (the kick comes in right to left)', () => {
    for (const direction of [1, -1] as const) {
      const cam = new Camera(480, 270);
      // The kicking team (home) attacks in `direction`; the user is the receiving side.
      cam.setRotation(Camera.rotationFor(ctxFor({ direction, offense: 'home', userSide: 'away', kickReturn: true })));
      expect(cam.screenDirOf(direction === 1 ? -1 : 1)).toBe(1);
      // The user kicking, a spectator, or a field goal (no return): the kicking team attacks right as before.
      expect(Camera.rotationFor(ctxFor({ direction, offense: 'home', userSide: 'home', kickReturn: true }))).toBe(direction === 1 ? ROT_RIGHT : ROT_LEFT);
      expect(Camera.rotationFor(ctxFor({ direction, offense: 'home', userSide: null, kickReturn: true }))).toBe(direction === 1 ? ROT_RIGHT : ROT_LEFT);
      expect(Camera.rotationFor(ctxFor({ direction, offense: 'home', userSide: 'away' }))).toBe(direction === 1 ? ROT_RIGHT : ROT_LEFT);
    }
  });

  it('turns the field without mirroring it: the offense\'s right-hand side is always down the screen', () => {
    for (const direction of [1, -1] as const) {
      const cam = new Camera(480, 270);
      cam.setMode('standard', ctxFor({ direction }));
      // Facing (0, direction) the right hand points to (direction, 0) in the world (x right, y up seen from above).
      const rightHand = cam.worldDirToScreen(vec2(direction, 0));
      expect(rightHand.x).toBeCloseTo(0);
      expect(rightHand.y).toBeCloseTo(1);
      // A proper rotation keeps handedness: with screen y flipped back to "up", the Jacobian's determinant is +1.
      const ex = cam.worldDirToScreen(vec2(1, 0));
      const ey = cam.worldDirToScreen(vec2(0, 1));
      expect(ex.x * -ey.y - ey.x * -ex.y).toBeCloseTo(1);
    }
  });
});

describe('Camera modes', () => {
  it('orders zoom levels: defensive < standard < zoomed < playerFollow', () => {
    const cam = new Camera();
    const zooms: Record<string, number> = {};
    for (const mode of ['defensive', 'standard', 'zoomed', 'playerFollow'] as const) {
      cam.setMode(mode, ctxFor());
      zooms[mode] = cam.zoom;
    }
    expect(zooms.defensive).toBeLessThan(zooms.standard as number);
    expect(zooms.standard).toBeLessThan(zooms.zoomed as number);
    expect(zooms.zoomed).toBeLessThan(zooms.playerFollow as number);
    expect(zooms.standard).toBe(CAMERA_ZOOM.standard);
  });

  it('standard leads the ball downfield in the attack direction', () => {
    const cam = new Camera();
    cam.setMode('standard', ctxFor({ direction: 1 }));
    expect(cam.target.y).toBeGreaterThan(60);
    cam.setMode('standard', ctxFor({ direction: -1, userSide: null }));
    cam.update(1, Infinity);
    expect(cam.target.y).toBeLessThan(60);
  });

  it('defensive pulls back and biases past the line of scrimmage', () => {
    const cam = new Camera();
    cam.setMode('defensive', ctxFor({ losY: 60, direction: 1, offense: 'away', userSide: 'home' }));
    expect(cam.target.y).toBeGreaterThan(60);
    expect(cam.zoom).toBe(CAMERA_ZOOM.defensive);
    expect(cam.visibleBounds().minY).toBeLessThan(60);
  });

  it('playerFollow centres on the controlled athlete and falls back to the ball', () => {
    const cam = new Camera();
    cam.setMode('playerFollow', ctxFor({ controlledPos: vec2(26, 55) }));
    expect(cam.target.x).toBeCloseTo(26);
    expect(cam.target.y).toBeCloseTo(55);
    cam.setMode('playerFollow', ctxFor({ controlledPos: null }));
    cam.update(1, Infinity);
    expect(cam.target.x).toBeCloseTo(mid.x);
    expect(cam.target.y).toBeCloseTo(mid.y);
  });

  it('kick shows both the kicker and the landing area', () => {
    const cam = new Camera();
    const ball = vec2(MIDDLE_X, 45);
    const landing = vec2(30, 95);
    cam.setMode('kick', ctxFor({ ballPos: ball, kickLandingPos: landing }));
    expect(cam.isVisible(ball)).toBe(true);
    expect(cam.isVisible(landing)).toBe(true);
    expect(cam.zoom).toBeLessThan(CAMERA_ZOOM.standard);
  });

  it('kick keeps the kicking line clear of the top-left score bug and shows where the ball comes down as it flies', () => {
    for (const direction of [1, -1] as const) {
      for (const [ballY, carry] of [[45, 45], [30, 45], [50, 60], [40, 75]] as const) {
        const cam = new Camera(480, 270);
        const y = direction === 1 ? ballY : FIELD_LENGTH - ballY;
        const ball = vec2(MIDDLE_X, y);
        const landing = vec2(MIDDLE_X + 4, y + direction * carry);
        cam.setMode('kick', ctxFor({ direction, ballPos: ball, losY: y, kickLandingPos: landing }));
        // retro scale: kicks never frame below KICK_MIN_ZOOM (tier-2 figures), so a long kick lands off-screen at first
        expect(cam.zoom).toBeGreaterThanOrEqual(KICK_MIN_ZOOM);
        expect(cam.zoom).toBeLessThanOrEqual(CAMERA_ZOOM.kick);
        // the score bug is ~130 px wide at normal text size: a gunner on the line near the top sideline stays clear
        expect(cam.worldToScreen(vec2(3, y)).x).toBeGreaterThan(160);
        expect(cam.worldToScreen(ball).x).toBeLessThan(240);
        const land = cam.worldToScreen(landing);
        expect(land.x).toBeGreaterThan(240);
        if (carry <= 45) expect(land.x).toBeLessThan(480);
        // the view follows the ball: halfway through the flight the landing spot is on screen
        const mid = vec2(MIDDLE_X + 2, y + (direction * carry) / 2);
        cam.setMode('kick', ctxFor({ direction, ballPos: mid, losY: y, kickLandingPos: landing }));
        cam.snap();
        const land2 = cam.worldToScreen(landing);
        expect(land2.x).toBeGreaterThan(240);
        expect(land2.x).toBeLessThan(480);
      }
    }
  });

  it('kick ignores a snap target behind the line (it frames downfield, not back toward the punter)', () => {
    for (const direction of [1, -1] as const) {
      const cam = new Camera();
      const los = 60;
      const punter = vec2(MIDDLE_X, los - direction * 15);
      cam.setMode('kick', ctxFor({ direction, ballPos: vec2(MIDDLE_X, los), losY: los, kickLandingPos: punter }));
      const ahead = (cam.target.y - los) * direction;
      // Field-scale update: the lead is the full KICK_BALL_LEAD_PX (logical px) ahead, ~13 yd at the new kick zoom (was 15+ at 4.4 px/yd).
      expect(ahead).toBeGreaterThanOrEqual(KICK_BALL_LEAD_PX / cam.zoom - 1e-9);
      expect(ahead).toBeGreaterThan(10);
      expect(cam.isVisible(punter)).toBe(true);
    }
  });

  it('simulation frames the whole field', () => {
    const cam = new Camera(480, 270);
    cam.setMode('simulation', ctxFor());
    const b = cam.visibleBounds();
    expect(b.minX).toBeLessThanOrEqual(0);
    expect(b.maxX).toBeGreaterThanOrEqual(FIELD_WIDTH);
    expect(b.minY).toBeLessThanOrEqual(0);
    expect(b.maxY).toBeGreaterThanOrEqual(FIELD_LENGTH);
  });

  it('simulation keeps the whole field framed on a small viewport while easing', () => {
    const cam = new Camera(240, 135);
    cam.setMode('simulation', ctxFor());
    for (let i = 0; i < 120; i++) cam.update(1 / 60);
    const b = cam.visibleBounds();
    expect(b.minX).toBeLessThanOrEqual(0);
    expect(b.maxX).toBeGreaterThanOrEqual(FIELD_WIDTH);
    expect(b.minY).toBeLessThanOrEqual(0);
    expect(b.maxY).toBeGreaterThanOrEqual(FIELD_LENGTH);
    expect(cam.zoom).toBeCloseTo(cam.desiredZoom, 6);
  });

  it('clampTarget keeps a view on the field and its stands (the replay broadcast angle uses it)', () => {
    const cam = new Camera(480, 270);
    const t = cam.clampTarget(vec2(-20, -30), 5);
    cam.target.x = t.x;
    cam.target.y = t.y;
    cam.zoom = 5;
    const b = cam.visibleBounds();
    expect(b.minX).toBeCloseTo(-FIELD_MARGIN);
    expect(b.minY).toBeCloseTo(-END_MARGIN);
    const mid = cam.clampTarget(vec2(MIDDLE_X, 60), 5);
    expect(mid).toEqual(vec2(MIDDLE_X, 60));
  });

  it('replay leaves the framing free', () => {
    const cam = new Camera();
    cam.setFree(vec2(5, 5), 4);
    cam.snap();
    cam.setMode('replay', ctxFor());
    cam.track(ctxFor({ ballPos: vec2(40, 100) }));
    cam.update(1, Infinity);
    expect(cam.target.x).toBe(5);
    expect(cam.target.y).toBe(5);
    expect(cam.zoom).toBe(4);
  });

  it('keeps the view on the field plus the apron (sidelines) or the end-line stands (end lines)', () => {
    const cam = new Camera(480, 270);
    cam.setMode('zoomed', ctxFor({ ballPos: vec2(0.5, 2) }));
    const b = cam.visibleBounds();
    expect(b.minX).toBeGreaterThanOrEqual(-FIELD_MARGIN - 1e-9);
    expect(b.minY).toBeGreaterThanOrEqual(-END_MARGIN - 1e-9);
    cam.setMode('zoomed', ctxFor({ ballPos: vec2(53, 119) }));
    const c = cam.visibleBounds();
    expect(c.maxX).toBeLessThanOrEqual(FIELD_WIDTH + FIELD_MARGIN + 1e-9);
    expect(c.maxY).toBeLessThanOrEqual(FIELD_LENGTH + END_MARGIN + 1e-9);
  });

  it('standard keeps the line of scrimmage clear of the top-left score bug even at the offense\'s own goal line', () => {
    for (const direction of [1, -1] as const) {
      const cam = new Camera(480, 270);
      const ball = vec2(MIDDLE_X, direction === 1 ? 12 : FIELD_LENGTH - 12);
      cam.setMode('standard', ctxFor({ direction, ballPos: ball, losY: ball.y }));
      expect(cam.worldToScreen(ball).x).toBeGreaterThan(150);
      // the offense sees plenty of field ahead: the ball sits left of centre
      expect(cam.worldToScreen(ball).x).toBeLessThan(240);
    }
  });

  it('snaps on a mode change but eases within a mode', () => {
    const cam = new Camera();
    cam.setMode('standard', ctxFor({ ballPos: vec2(MIDDLE_X, 40) }));
    const y0 = cam.target.y;
    cam.track(ctxFor({ ballPos: vec2(MIDDLE_X, 70) }));
    expect(cam.target.y).toBe(y0);
    cam.update(1 / 60);
    expect(cam.target.y).toBeGreaterThan(y0);
    expect(cam.target.y).toBeLessThan(cam.desiredTarget.y);
    for (let i = 0; i < 600; i++) cam.update(1 / 60);
    expect(cam.target.y).toBeCloseTo(cam.desiredTarget.y, 3);
    // (the along-field span is now the screen's 480-pixel width, so a spot 20 yards in would be clamped by the apron)
    cam.setMode('zoomed', ctxFor({ ballPos: vec2(MIDDLE_X, 35) }));
    expect(cam.target.y).toBeCloseTo(35);
  });

  it('follow eases monotonically and Infinity smoothing snaps', () => {
    const cam = new Camera();
    cam.target.x = 0;
    cam.target.y = 0;
    let last = 0;
    for (let i = 0; i < 10; i++) {
      cam.follow(vec2(10, 0), 1 / 60, 6);
      expect(cam.target.x).toBeGreaterThan(last);
      last = cam.target.x;
    }
    cam.follow(vec2(10, 0), 1 / 60, Infinity);
    expect(cam.target.x).toBe(10);
    cam.follow(vec2(0, 0), 0, 6);
    expect(cam.target.x).toBe(10);
    cam.follow(vec2(0, 0), -1, 6);
    expect(cam.target.x).toBe(10);
    cam.zoom = 6;
    cam.zoomTo(9, -1, 6);
    expect(cam.zoom).toBe(6);
  });

  it('shake offsets the view briefly and decays', () => {
    const cam = new Camera();
    cam.target.x = MIDDLE_X;
    cam.target.y = 60;
    const base = cam.worldToScreen(mid);
    cam.addShake(4, 0.3);
    let moved = false;
    for (let i = 0; i < 12; i++) {
      cam.update(1 / 60, Infinity);
      const p = cam.worldToScreen(mid);
      if (p.x !== base.x || p.y !== base.y) moved = true;
    }
    expect(moved).toBe(true);
    cam.update(1, Infinity);
    expect(cam.worldToScreen(mid)).toEqual(base);
  });
});
