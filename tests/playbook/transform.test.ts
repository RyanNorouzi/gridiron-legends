import { describe, expect, it } from 'vitest';
import { FIELD_WIDTH, fieldY } from '@/game/types';
import { loadPlaybookData, materializePlay } from '@/playbook/loader';
import { depthFromLos, fieldToLocal, formationToField, localToField, mirrorRoleMap, routeBreakIndex, routeBreakPoint, routeLength, routePath } from '@/playbook/transform';
import { mirrorRoute } from '@/playbook/types';

const reg = loadPlaybookData();

describe('local <-> field transforms', () => {
  it('maps play-local offsets along the attack direction', () => {
    expect(localToField({ x: 3, y: -5 }, 20, 40, 1)).toEqual({ x: 23, y: 35 });
    expect(localToField({ x: 3, y: -5 }, 20, 80, -1)).toEqual({ x: 17, y: 85 });
    expect(localToField({ x: 0, y: 0 }, 26.665, 60, -1)).toEqual({ x: 26.665, y: 60 });
  });

  it('fieldToLocal inverts localToField for both directions', () => {
    for (const dir of [1, -1] as const) {
      const p = { x: -7.5, y: 12 };
      const abs = localToField(p, 30, 55, dir);
      expect(fieldToLocal(abs, 30, 55, dir)).toEqual(p);
      expect(depthFromLos(abs, 55, dir)).toBeCloseTo(12);
    }
  });

  it('places a formation with the offense right on the correct absolute side', () => {
    const losY = fieldY(25, 1);
    const up = formationToField(reg.offensiveFormations.iForm, FIELD_WIDTH / 2, losY, 1);
    expect(up.TE1.x).toBeGreaterThan(FIELD_WIDTH / 2);
    expect(up.QB.y).toBeLessThan(losY);
    expect(up.RB.y).toBeCloseTo(losY - 7);
    const losDown = fieldY(25, -1);
    const down = formationToField(reg.offensiveFormations.iForm, FIELD_WIDTH / 2, losDown, -1);
    expect(down.TE1.x).toBeLessThan(FIELD_WIDTH / 2);
    expect(down.QB.y).toBeGreaterThan(losDown);
    expect(down.RB.y).toBeCloseTo(losDown + 7);
    const def = formationToField(reg.defensiveFormations['43'], FIELD_WIDTH / 2, losDown, -1);
    expect(def.FS.y).toBeCloseTo(losDown - 13);
    expect(Object.keys(def)).toHaveLength(11);
  });
});

describe('routes', () => {
  it('builds absolute waypoints from the receiver alignment', () => {
    const out = reg.routes.out;
    const align = { x: 16, y: -1.5 };
    const path = routePath(out, align, 20, 50, 1);
    expect(path).toHaveLength(out.waypoints.length);
    expect(path[0]).toEqual({ x: 36, y: 58.5 });
    expect(path[2].x).toBeGreaterThan(path[0].x);
    const pathDown = routePath(out, align, 20, 70, -1);
    expect(pathDown[0]).toEqual({ x: 4, y: 61.5 });
    expect(pathDown[2].x).toBeLessThan(pathDown[0].x);
  });

  it('mirrored routes break inside for left-side receivers in both directions', () => {
    const m = materializePlay(reg.offensePlays['shotgun-slants'], reg.offensiveFormations.shotgun, reg.routes);
    const wr1 = m.formation.slots.find((s) => s.role === 'WR1');
    const wr2 = m.formation.slots.find((s) => s.role === 'WR2');
    if (!wr1 || !wr2) throw new Error('slots');
    for (const dir of [1, -1] as const) {
      const ballX = 26;
      const losY = 50;
      const left = routePath(m.routes.WR1, wr1, ballX, losY, dir);
      const right = routePath(m.routes.WR2, wr2, ballX, losY, dir);
      // both slants end closer to the ball's x than they started
      expect(Math.abs(left[2].x - ballX)).toBeLessThan(Math.abs(left[0].x - ballX));
      expect(Math.abs(right[2].x - ballX)).toBeLessThan(Math.abs(right[0].x - ballX));
      expect(Math.sign(left[0].x - ballX)).toBe(-Math.sign(right[0].x - ballX));
      expect(dir * (left[2].y - losY)).toBeGreaterThan(0);
    }
  });

  it('finds the break point and route length', () => {
    const curl = reg.routes.curl;
    expect(routeBreakIndex(curl)).toBe(1);
    const bp = routeBreakPoint(curl, { x: 10, y: 0 }, 20, 40, 1);
    expect(bp).toEqual({ x: 28.5, y: 50 });
    expect(routeBreakPoint({ ...curl, waypoints: [] }, { x: 0, y: 0 }, 0, 0, 1)).toBeNull();
    const noBreak = { ...curl, waypoints: curl.waypoints.map((w) => ({ dx: w.dx, dy: w.dy })) };
    expect(routeBreakIndex(noBreak)).toBe(1);
    expect(routeLength(reg.routes.go)).toBeCloseTo(5 + Math.hypot(0.5, 10) + 20, 5);
    expect(routeLength(mirrorRoute(reg.routes.post))).toBeCloseTo(routeLength(reg.routes.post));
  });
});

describe('mirrorRoleMap', () => {
  it('pairs symmetric eligible slots bijectively and skips slots without a twin', () => {
    const shotgun = mirrorRoleMap(reg.offensiveFormations.shotgun);
    expect(shotgun.WR1).toBe('WR2');
    expect(shotgun.WR2).toBe('WR1');
    expect(shotgun.WR3).toBeUndefined();
    expect(shotgun.TE1).toBeUndefined();
    expect(shotgun.RB).toBeUndefined();
    expect(shotgun.LT).toBeUndefined();
    const twoTE = mirrorRoleMap(reg.offensiveFormations.twoTE);
    expect(twoTE).toEqual({ WR1: 'WR2', WR2: 'WR1', TE1: 'TE2', TE2: 'TE1' });
    const empty = mirrorRoleMap(reg.offensiveFormations.empty);
    expect(empty.WR1).toBe('WR2');
    expect(empty.WR3).toBe('WR4');
    expect(empty.WR5).toBeUndefined();
    const goal = mirrorRoleMap(reg.offensiveFormations.goalLine);
    expect(goal.TE1).toBe('TE2');
    expect(goal.TE3).toBeUndefined();
    expect(mirrorRoleMap({ slots: [] })).toEqual({});
  });
});
