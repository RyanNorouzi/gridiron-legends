import { describe, expect, it } from 'vitest';
import { vec2 } from '@/core/vec2';
import { idleIntent } from '@/game/engine-api';
import { TACKLE_REACH } from '@/game/systems/tackle';
import { zoneLandmark } from '@/playbook/zones';
import { Camera } from '@/ui/camera';
import { createTheme } from '@/ui/theme';
import { DEFAULT_SETTINGS } from '@/core/settings';
import { createDevState, OVERLAY_KINDS, toggleCheat } from '@/tools/dev-state';
import {
  aiLabels, athleteAt, attributePanel, ballModel, buildOverlayModel, coverageModel, drawDevBadge, drawOverlays, hitboxModel, idLabels, keyAttributesFor, routeLines,
} from '@/tools/overlays';
import { buildPlayState } from '../fixtures/play-state';
import { createFakeCtx } from '../ui/render/fake-ctx';

const fixture = () => buildPlayState({ offensePlayId: 'shotgun-mesh', defensePlayId: '43-cover1-man', seed: 4, userSide: 'home', controlRole: 'QB' });

describe('overlay models', () => {
  it('hitboxes carry body radius and tackle reach; ids label number and role', () => {
    const f = fixture();
    const boxes = hitboxModel(f.state);
    expect(boxes).toHaveLength(f.state.athletes.length);
    const qb = boxes.find((b) => b.id === 'off:QB')!;
    expect(qb.controlled).toBe(true);
    expect(qb.reach).toBeCloseTo(qb.radius + TACKLE_REACH);
    const labels = idLabels(f.state);
    const wr = f.byRole('offense', 'WR2');
    expect(labels.find((l) => l.id === wr.id)?.text).toBe(`#${wr.number} WR2`);
    expect(labels.find((l) => l.id === 'off:QB')?.text.endsWith('*')).toBe(true);
  });

  it('routes start at each route runner and follow routePath', () => {
    const f = fixture();
    const lines = routeLines(f.state, { routes: f.routes });
    const ids = lines.map((l) => l.id).sort();
    expect(ids).toEqual(['off:RB', 'off:TE1', 'off:WR1', 'off:WR2', 'off:WR3']);
    const wr2 = lines.find((l) => l.id === 'off:WR2')!;
    const a = f.byRole('offense', 'WR2');
    expect(wr2.routeId).toBe(f.routes.WR2!.id);
    expect(wr2.points[0]!.x).toBeCloseTo(a.pos.x);
    expect(wr2.points[0]!.y).toBeCloseTo(a.pos.y);
    expect(wr2.points.length).toBe(f.routes.WR2!.waypoints.length + 1);
    // A go route runs downfield (direction +1).
    expect(wr2.points[wr2.points.length - 1]!.y).toBeGreaterThan(a.pos.y + 10);
    // The id lookup fallback finds the same route.
    const viaId = routeLines(f.state, { routeById: (id) => Object.values(f.routes).find((r) => r.id === id) });
    expect(viaId.map((l) => l.id).sort()).toEqual(ids);
    expect(routeLines(f.state)).toEqual([]);
  });

  it('coverage draws man lines to the covered receiver and zone landmarks', () => {
    const f = fixture();
    const cov = coverageModel(f.state);
    const manDefs = f.state.athletes.filter((a) => a.side === 'defense' && a.assignment.type === 'manCover');
    const zoneDefs = f.state.athletes.filter((a) => a.side === 'defense' && a.assignment.type === 'zone');
    expect(cov.man).toHaveLength(manDefs.length);
    expect(cov.zones).toHaveLength(zoneDefs.length);
    expect(manDefs.length).toBeGreaterThan(0);
    for (const m of cov.man) {
      const d = f.athlete(m.defenderId);
      const target = f.athlete(m.receiverId);
      expect(target.side).toBe('offense');
      expect(target.role).toBe((d.assignment as { manTarget?: string }).manTarget);
      expect(m.to).toEqual(target.pos);
    }
    const z = cov.zones[0]!;
    const lm = zoneLandmark(z.zone, f.state.losY, 1);
    expect(z.center).toEqual(lm.center);
    expect(z.farY - z.nearY).toBeCloseTo(lm.depthMax - lm.depthMin);
  });

  it('AI labels show each intent debug label and action', () => {
    const f = fixture();
    f.state.intents['def:FS'] = { ...idleIntent('deep middle'), action: 'jump' };
    f.state.intents['off:QB'] = idleIntent('read #2');
    const labels = aiLabels(f.state);
    expect(labels.find((l) => l.id === 'def:FS')?.text).toBe('DEEP MIDDLE !JUMP');
    expect(labels.find((l) => l.id === 'off:QB')?.text).toBe('READ #2');
    expect(labels).toHaveLength(2);
  });

  it('attributes follow the pointer, else the controlled athlete', () => {
    const f = fixture();
    const qbPanel = attributePanel(f.state)!;
    expect(qbPanel.source).toBe('controlled');
    expect(qbPanel.athleteId).toBe('off:QB');
    expect(qbPanel.rows.map((r) => r.key)).toEqual(keyAttributesFor({ position: 'QB' }));
    expect(qbPanel.rows.map((r) => r.key)).toContain('throwPower');
    const cb = f.state.athletes.find((a) => a.position === 'CB')!;
    expect(athleteAt(f.state, vec2(cb.pos.x + 0.3, cb.pos.y))?.id).toBe(cb.id);
    const cbPanel = attributePanel(f.state, vec2(cb.pos.x + 0.3, cb.pos.y))!;
    expect(cbPanel.source).toBe('pointer');
    expect(cbPanel.rows.find((r) => r.key === 'coverage')?.value).toBe(Math.round(cb.attrs.coverage));
    expect(cbPanel.title).toContain(`#${cb.number}`);
  });

  it('ball model predicts the landing point of a ball in the air', () => {
    const f = fixture();
    const held = ballModel(f.state);
    expect(held.landing).toBeNull();
    const b = f.state.ball;
    b.phase = 'inAir';
    b.kind = 'pass';
    b.z = 2;
    b.vz = 6;
    b.vel = { x: 0, y: 15 };
    b.targetPos = { x: b.pos.x, y: b.pos.y + 20 };
    const flying = ballModel(f.state);
    expect(flying.landing).not.toBeNull();
    expect(flying.landing!.y).toBeGreaterThan(b.pos.y + 10);
    expect(flying.landingTicks).toBeGreaterThan(30);
    expect(flying.target).toEqual(b.targetPos);
  });

  it('buildOverlayModel only fills the requested overlays and the draw functions paint them', () => {
    const f = fixture();
    const none = buildOverlayModel(f.state, new Set());
    expect(none.hitboxes).toEqual([]);
    expect(none.attributes).toBeNull();
    expect(none.ball).toBeNull();
    const all = buildOverlayModel(f.state, new Set(OVERLAY_KINDS), { routes: f.routes, pointer: null });
    expect(all.hitboxes.length).toBe(22);
    expect(all.routes.length).toBe(5);
    expect(all.coverage.man.length).toBeGreaterThan(0);
    expect(all.attributes?.athleteId).toBe('off:QB');
    expect(all.ball).not.toBeNull();
    const theme = createTheme(DEFAULT_SETTINGS);
    const camera = new Camera(480, 270);
    camera.target.x = f.state.ball.pos.x;
    camera.target.y = f.state.ball.pos.y;
    const ctx = createFakeCtx();
    drawOverlays(ctx, camera, theme, none);
    expect(ctx.fills).toHaveLength(0);
    drawOverlays(ctx, camera, theme, all);
    expect(ctx.fillsWith(theme.colors.danger).length).toBeGreaterThan(0);
    expect(ctx.fillsWith(theme.colors.warning).length).toBeGreaterThan(0);
    expect(ctx.fillsWith(theme.colors.panel).length).toBe(1);
    ctx.reset();
    drawDevBadge(ctx, theme, toggleCheat(createDevState(true), 'godMode'), 470, 4);
    expect(ctx.fillsWith(theme.colors.warning).length).toBeGreaterThan(20);
  });
});
