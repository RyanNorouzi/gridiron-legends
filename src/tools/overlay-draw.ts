/**
 * Drawing for the developer overlays: renders an OverlayModel through the camera with the field view's pixel
 * primitives (fillRect only, so the recording test context sees every pixel), plus the attribute card and the small
 * DEV status badge. No game logic lives here; see ./overlays for the model builders.
 */
import type { Vec2 } from '@/core/vec2';
import type { Camera } from '@/ui/camera';
import { fillRectAlpha, pixelArrow, pixelDashedLine, pixelEllipse, pixelLine } from '@/ui/game/pixel-draw';
import { drawText, GLYPH_H, measureText, type FillCtx } from '@/ui/render/text';
import { figureHeightLpx, tierForZoom } from '@/ui/render/world-layer';
import type { Theme } from '@/ui/theme';
import { cheatTags, overlayLabel, type DevState } from './dev-state';
import type { AttributePanel, BallModel, CoverageModel, HitboxShape, OverlayLabel, OverlayModel, RouteLine } from './overlays';

/** The drawing surface the overlays need (a CanvasRenderingContext2D satisfies it). */
export type OverlayDrawCtx = FillCtx & { globalAlpha: number };

type Project = (p: Vec2) => Vec2;

const sideColor = (theme: Theme, side: 'offense' | 'defense'): string => (side === 'offense' ? theme.colors.accent2 : theme.colors.danger);

const drawHitboxes = (ctx: OverlayDrawCtx, theme: Theme, project: Project, zoom: number, shapes: readonly HitboxShape[]): void => {
  for (const h of shapes) {
    const p = project(h.center);
    const color = h.hasBall ? theme.colors.accent : h.controlled ? theme.colors.success : sideColor(theme, h.side);
    pixelEllipse(ctx, p.x, p.y, h.radius * zoom, h.radius * zoom, h.active ? color : theme.colors.textDim);
    if (h.active) pixelEllipse(ctx, p.x, p.y, h.reach * zoom, h.reach * zoom, theme.colors.textDim);
  }
};

/** Labels above (ids) clear the figure's head at the camera's zoom tier; labels below (AI) sit under the feet. */
const drawLabels = (ctx: OverlayDrawCtx, theme: Theme, project: Project, zoom: number, labels: readonly OverlayLabel[], above: boolean): void => {
  const offset = Math.max(6, zoom * 1.1, above ? Math.ceil(figureHeightLpx(tierForZoom(zoom))) + 2 : 0);
  for (const l of labels) {
    const p = project(l.pos);
    const y = above ? p.y - offset - GLYPH_H : p.y + offset;
    drawText(ctx, l.text, p.x, y, { align: 'center', color: sideColor(theme, l.side), shadow: theme.colors.shadow });
  }
};

const drawRoutes = (ctx: OverlayDrawCtx, theme: Theme, project: Project, routes: readonly RouteLine[]): void => {
  for (const r of routes) {
    for (let i = 1; i < r.points.length; i++) {
      const a = project(r.points[i - 1] as Vec2);
      const b = project(r.points[i] as Vec2);
      const color = i <= r.reached ? theme.colors.textDim : theme.colors.accent2;
      if (i === r.points.length - 1) pixelArrow(ctx, a.x, a.y, b.x, b.y, color, 1, 3);
      else pixelLine(ctx, a.x, a.y, b.x, b.y, color, 1);
    }
  }
};

const drawCoverage = (ctx: OverlayDrawCtx, theme: Theme, project: Project, cov: CoverageModel): void => {
  for (const m of cov.man) {
    const a = project(m.from);
    const b = project(m.to);
    pixelLine(ctx, a.x, a.y, b.x, b.y, theme.colors.danger, 1);
  }
  for (const z of cov.zones) {
    const corners = [
      project({ x: z.center.x - z.halfWidth, y: z.nearY }), project({ x: z.center.x + z.halfWidth, y: z.nearY }),
      project({ x: z.center.x + z.halfWidth, y: z.farY }), project({ x: z.center.x - z.halfWidth, y: z.farY }),
    ];
    for (let i = 0; i < 4; i++) {
      const a = corners[i] as Vec2;
      const b = corners[(i + 1) % 4] as Vec2;
      pixelDashedLine(ctx, a.x, a.y, b.x, b.y, theme.colors.warning, 2, 3);
    }
    const from = project(z.from);
    const c = project(z.center);
    pixelDashedLine(ctx, from.x, from.y, c.x, c.y, theme.colors.warning, 3, 2);
    pixelEllipse(ctx, c.x, c.y, 2, 2, theme.colors.warning, true);
  }
};

const drawBall = (ctx: OverlayDrawCtx, theme: Theme, project: Project, ball: BallModel): void => {
  const p = project(ball.pos);
  const c = theme.colors.firstDown;
  if (ball.landing) {
    const l = project(ball.landing);
    pixelDashedLine(ctx, p.x, p.y, l.x, l.y, c, 2, 2);
    pixelLine(ctx, l.x - 3, l.y - 3, l.x + 3, l.y + 3, c, 1);
    pixelLine(ctx, l.x - 3, l.y + 3, l.x + 3, l.y - 3, c, 1);
  }
  if (ball.target) {
    const t = project(ball.target);
    pixelEllipse(ctx, t.x, t.y, 3, 3, theme.colors.accent);
  }
  const ticks = ball.landingTicks !== null ? ` T${ball.landingTicks}` : '';
  drawText(ctx, `Z${ball.z.toFixed(1)}${ticks} ${ball.phase.toUpperCase()}`, p.x + 5, p.y - GLYPH_H - 4, { color: c, shadow: theme.colors.shadow });
};

/** The attribute card: title, fatigue / burst / state, then LABEL value(base) rows in two columns. */
export const drawAttributePanel = (ctx: OverlayDrawCtx, theme: Theme, panel: AttributePanel, x: number, y: number): { w: number; h: number } => {
  const size = theme.textScale;
  const line = theme.lineHeight;
  const colW = measureText('SPD 99(99)', size).width + theme.gap * 2;
  const rows = Math.ceil(panel.rows.length / 2);
  const w = Math.max(colW * 2, measureText(panel.title, size).width, measureText(panel.status, size).width) + theme.pad;
  const h = line * (2 + rows) + theme.gap;
  fillRectAlpha(ctx, x, y, w, h, theme.colors.panel, 0.85);
  drawText(ctx, panel.title, x + theme.gap, y + theme.gap, { color: theme.colors.accent, size });
  drawText(ctx, panel.status, x + theme.gap, y + theme.gap + line, { color: theme.colors.textDim, size });
  panel.rows.forEach((r, i) => {
    const cx = x + theme.gap + (i % 2) * colW;
    const cy = y + theme.gap + line * (2 + Math.floor(i / 2));
    const color = r.value < r.base ? theme.colors.warning : theme.colors.text;
    drawText(ctx, `${r.label} ${r.value}${r.value !== r.base ? `(${r.base})` : ''}`, cx, cy, { color, size });
  });
  return { w, h };
};

/** Draws every overlay present in the model. The attribute card sits at (panelX, panelY) in screen pixels. */
export const drawOverlays = (ctx: OverlayDrawCtx, camera: Camera, theme: Theme, model: OverlayModel, panelX = theme.pad, panelY = theme.pad * 5): void => {
  const project: Project = (p) => camera.worldToScreen(p);
  const zoom = camera.zoom;
  if (model.coverage.zones.length > 0 || model.coverage.man.length > 0) drawCoverage(ctx, theme, project, model.coverage);
  if (model.routes.length > 0) drawRoutes(ctx, theme, project, model.routes);
  if (model.hitboxes.length > 0) drawHitboxes(ctx, theme, project, zoom, model.hitboxes);
  if (model.ball) drawBall(ctx, theme, project, model.ball);
  if (model.ids.length > 0) drawLabels(ctx, theme, project, zoom, model.ids, true);
  if (model.ai.length > 0) drawLabels(ctx, theme, project, zoom, model.ai, false);
  if (model.attributes) drawAttributePanel(ctx, theme, model.attributes, panelX, panelY);
};

/** Small 'DEV' status line: active cheats and the overlay preset, right-aligned at (right, y). */
export const drawDevBadge = (ctx: OverlayDrawCtx, theme: Theme, state: DevState, right: number, y: number): void => {
  const parts = ['DEV', ...cheatTags(state), `OVL ${overlayLabel(state)}`];
  drawText(ctx, parts.join(' | '), right, y, { align: 'right', color: theme.colors.warning, shadow: theme.colors.shadow, size: theme.textScale });
};
