import { describe, expect, it } from 'vitest';
import { Camera, CLOSE_ZOOM, ROT_LEFT } from '@/ui/camera';
import { END_ZONE_DEPTH, FIELD_LENGTH, FIELD_WIDTH } from '@/game/types';
import type { PlayEvent } from '@/game/play-events';
import { blockFrame, blockSize, crowdExcitement, flashes, rowsPerBlock, seatsPerBlock } from '@/ui/render/world/crowd-hi';
import { END_WALL, SIDE_WALL, standLayout, standScreenSide, STAND_DEPTH } from '@/ui/render/world/stadium-hi';
import { postGeometry, PYLONS } from '@/ui/render/world/goalposts';
import { sidelineLayout, TEAM_AREA } from '@/ui/render/world/sideline';
import { paintPerson } from '@/ui/render/world/people';
import { axisOf, flightOf, paintBall } from '@/ui/render/world/ball-hi';
import { windSway } from '@/ui/render/world/stadium-deco';
import { lightingSpec } from '@/ui/render/world/lighting';
import { alphaAt } from '@/ui/render/world/art';

const cam = (y: number, flipped = false): Camera => {
  const c = new Camera(480, 270);
  c.target.x = FIELD_WIDTH / 2;
  c.target.y = y;
  c.zoom = CLOSE_ZOOM.standard;
  if (flipped) c.setRotation(ROT_LEFT);
  return c;
};

describe('stadium and crowd (art bible §10.3)', () => {
  it('lays out four stands beyond the walls; the far stand turns to face the camera when the view flips', () => {
    const s = standLayout();
    expect(s.map((q) => q.id).sort()).toEqual(['east', 'north', 'south', 'west']);
    expect(s.find((q) => q.id === 'west')?.wall).toBe(-SIDE_WALL);
    expect(s.find((q) => q.id === 'north')?.wall).toBe(FIELD_LENGTH + END_WALL);
    expect(STAND_DEPTH).toBeGreaterThan(20);
    expect(standScreenSide(cam(60), 'west')).toBe('top');
    expect(standScreenSide(cam(60, true), 'west')).toBe('bottom');
    expect(standScreenSide(cam(60), 'south')).toBe('left');
    expect(standScreenSide(cam(60, true), 'south')).toBe('right');
  });

  it('blocks fewer, larger crowd blocks when zoomed out', () => {
    expect(seatsPerBlock(11)).toBe(8);
    expect(seatsPerBlock(4)).toBe(16);
    expect(rowsPerBlock(11)).toBe(1);
    expect(rowsPerBlock(3.7)).toBe(4);
    const b = blockSize('face', 8, 22, 1);
    expect(b.h).toBe(22);
    expect(blockSize('sideL', 8, 22, 2).w).toBe(44);
  });

  it('lifts the crowd on big plays (jump share 5 % -> 45 %) and lets it settle', () => {
    const td: PlayEvent[] = [{ type: 'touchdown', tick: 100, scorer: 'a', side: 'offense' }];
    expect(crowdExcitement([], 0, true)).toBeLessThan(crowdExcitement([], 0, false));
    expect(crowdExcitement(td, 100, false)).toBeCloseTo(1);
    expect(crowdExcitement(td, 100 + 60 * 4, false)).toBeLessThan(0.7);
    expect(crowdExcitement(td, 90, false)).toBeLessThan(0.2);
    const share = (e: number): number => {
      let j = 0;
      for (let i = 0; i < 4000; i++) if (blockFrame(i, 7, e) === 2) j++;
      return j / 4000;
    };
    expect(share(0)).toBeGreaterThan(0.02);
    expect(share(0)).toBeLessThan(0.09);
    expect(share(1)).toBeGreaterThan(0.38);
    expect(share(1)).toBeLessThan(0.52);
    expect(flashes(3, 0.2, 100, 100)).toHaveLength(0);
    let n = 0;
    for (let t = 0; t < 10; t += 1 / 30) n += flashes(t, 1, 100, 100).length;
    expect(n).toBeGreaterThan(30);
    expect(n).toBeLessThan(90);
  });
});

describe('posts, pylons, sideline, people, ball (art bible §10.2, §10.4, §10.7)', () => {
  it('puts the crossbar over the end line and leans the uprights away from the field', () => {
    const c = cam(10);
    const g = postGeometry(c, 0);
    expect(g.barA.x).toBe(g.barB.x);
    expect(g.tipA.x).toBeLessThan(g.barA.x);
    expect(g.tipA.y).toBeLessThan(g.barA.y);
    expect(postGeometry(cam(10, true), 0).tipA.x).toBeGreaterThan(postGeometry(cam(10, true), 0).barA.x);
    expect(PYLONS).toHaveLength(8);
  });

  it('lays out team areas between the 30s and the chain 10 yd long (none when goal to go)', () => {
    const items = sidelineLayout(40, 50, 1, false);
    for (const b of items.filter((i) => i.kind === 'bench')) {
      expect(b.y).toBeGreaterThanOrEqual(TEAM_AREA[0]);
      expect(b.y + (b.len ?? 0)).toBeLessThanOrEqual(TEAM_AREA[1]);
    }
    const home = items.filter((i) => i.team === 'home');
    for (const i of home) expect(i.x).toBeLessThan(0);
    const stakes = items.filter((i) => i.kind === 'stake').map((i) => i.y).sort((a, b) => a - b);
    expect(stakes).toEqual([40, 50]);
    expect(items.filter((i) => i.kind === 'sub')).toHaveLength(20);
    expect(sidelineLayout(105, FIELD_LENGTH - END_ZONE_DEPTH, 1, false).some((i) => i.kind === 'stake')).toBe(false);
    expect(sidelineLayout(40, 50, 1, true).some((i) => i.kind === 'heater')).toBe(true);
  });

  it('paints civilians standing on their feet anchor, and the ball along its flight', () => {
    for (const kind of ['coach', 'headCoach', 'chainCrew', 'photographer'] as const) {
      const p = paintPerson(kind, 'front', '#c02020', 1, 0, 2);
      let lowest = -1;
      for (let y = 0; y < p.px.h; y++) for (let x = 0; x < p.px.w; x++) if (alphaAt(p.px, x, y) > 0) lowest = Math.max(lowest, y);
      expect(lowest).toBe(p.ay - 1);
    }
    const flat = paintBall(0, 1, 0);
    const upright = paintBall(2, 1, 0);
    const extent = (px: ReturnType<typeof paintBall>): { w: number; h: number } => {
      let x0 = 99; let x1 = -1; let y0 = 99; let y1 = -1;
      for (let y = 0; y < px.h; y++) for (let x = 0; x < px.w; x++) if (alphaAt(px, x, y) > 0) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
      return { w: x1 - x0 + 1, h: y1 - y0 + 1 };
    };
    expect(extent(flat).w).toBeGreaterThan(extent(flat).h);
    expect(extent(upright).h).toBeGreaterThan(extent(upright).w);
    expect(axisOf(1, 0)).toBe(0);
    expect(axisOf(0, 1)).toBe(2);
    expect(axisOf(-1, 1)).toBe(3);
    const ev: PlayEvent[] = [{ type: 'throw', tick: 10, thrower: 'q', target: 'r', throwType: 'bullet', airYards: 10, difficulty: 0.5 }, { type: 'kick', tick: 50, kicker: 'k', kind: 'punt', power: 1, accuracy: 1 }];
    expect(flightOf(ev, 20)).toMatchObject({ kind: 'spiral', bullet: true });
    expect(flightOf(ev, 60).kind).toBe('tumble');
  });

  it('casts one shadow by day, four at night; flags sway harder in wind', () => {
    expect(lightingSpec('day').shadows).toHaveLength(1);
    expect(lightingSpec('night').shadows).toHaveLength(4);
    expect(lightingSpec(undefined).shadows).toHaveLength(1);
    const w = (mph: number): number => Math.max(...Array.from({ length: 50 }, (_, i) => Math.abs(windSway({ type: 'wind', windDir: 0, windMph: mph, temperatureF: 60, precipitation: 0, visibility: 1, fieldSlick: 0 }, i * 0.1, 0))));
    expect(w(25)).toBeGreaterThan(w(2));
  });
});
