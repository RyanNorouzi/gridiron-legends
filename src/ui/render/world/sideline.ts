/**
 * The sideline (art bible §10.4), sorted objects between the white border and the stadium wall: each team's area
 * between the 30s (home on the west sideline, away on the east; world-fixed, so nothing jumps when the view turns)
 * with two rows of benches in the team colour, a team cooler and a cup table, 10 substitutes in their kit standing
 * and watching (the figure atlas: whatever painter chain A registered), two coaches (the head coach with a
 * clipboard); the chain crew on the east sideline with the rear stake, the stake at the line to gain and the chain
 * between them, and the down box at the line of scrimmage showing the down (game-info.ts; blank without it);
 * photographers crouched behind both end lines; heaters by the benches in the cold. Every item carries its ground
 * shadow for the shadow pass. Layout is pure (`sidelineLayout`, Node-tested).
 */
import { END_ZONE_DEPTH, FIELD_LENGTH, FIELD_WIDTH, type Direction, type TeamSide } from '@/game/types';
import type { Camera } from '../../camera';
import type { FieldViewOptions } from '../../game/field-view';
import { bodyVarFor, makeKit, type FigureBuild, type FigureKit, type FrameRequest } from '../anim';
import { FIGURE_ATLAS, resolveFigure } from '../atlas-figures';
import { drawAtlasFrame } from '../atlas';
import { darken, lighten, teamUniforms, type ResolvedPalettes } from '../palette';
import type { Facing8 } from '../sprites';
import { hashStr, TIER_SCALE, WD, type FigureTier } from '../world-layer';
import { acrossSign, alongSign, h01, pxImage } from './art';
import { worldGameInfo } from './game-info';
import { HEIGHT_SCALE } from './goalposts';
import { personSprite, type PersonKind, type PersonView } from './people';
import { stencil } from './stencil';

/** Yards outside the sideline of the substitutes, coaches, benches (two rows) and the chain crew. */
export const SUBS_YD = 3.1;
export const COACH_YD = 2.45;
export const BENCH_YD: readonly [number, number] = [4.35, 5.0];
export const CHAIN_YD = 2.45;
/** Team area along the field (the 30s). */
export const TEAM_AREA: readonly [number, number] = [40, 80];

/** A sideline item in world yards. */
export interface SidelineItem {
  kind: 'bench' | 'cooler' | 'table' | 'heater' | 'sub' | PersonKind | 'stake' | 'downBox';
  team: TeamSide | null;
  x: number;
  y: number;
  /** Bench length along the field (yd). */
  len?: number;
  /** Stable id (hash seeds, atlas fallback). */
  id: string;
}

/** Everything on both sidelines and behind the end lines for a down (pure). */
export const sidelineLayout = (losY: number | null, firstDownY: number | null, dir: Direction, cold: boolean): SidelineItem[] => {
  const out: SidelineItem[] = [];
  for (const team of ['home', 'away'] as const) {
    const s = team === 'home' ? -1 : 1;
    const edge = team === 'home' ? 0 : FIELD_WIDTH;
    const at = (d: number): number => edge + s * d;
    for (const [row, d] of BENCH_YD.entries()) {
      for (let y = TEAM_AREA[0] + 2 + row; y + 5 <= TEAM_AREA[1] - 1; y += 7) out.push({ kind: 'bench', team, x: at(d), y, len: 5, id: `bench-${team}-${row}-${y}` });
    }
    out.push({ kind: 'cooler', team, x: at(4.7), y: TEAM_AREA[0] + 0.6, id: `cooler-${team}` });
    out.push({ kind: 'table', team, x: at(4.6), y: TEAM_AREA[1] - 0.8, id: `table-${team}` });
    if (cold) for (const y of [TEAM_AREA[0] + 8.5, TEAM_AREA[1] - 8]) out.push({ kind: 'heater', team, x: at(3.9), y, id: `heater-${team}-${y}` });
    for (let k = 0; k < 10; k++) {
      const y = TEAM_AREA[0] + 3 + ((k * 3.7 + h01(k * 7 + (team === 'home' ? 1 : 2)) * 2) % (TEAM_AREA[1] - TEAM_AREA[0] - 6));
      out.push({ kind: 'sub', team, x: at(SUBS_YD + h01(k * 13 + 5) * 0.7), y, id: `sub-${team}-${k}` });
    }
    out.push({ kind: 'headCoach', team, x: at(COACH_YD), y: 58.5, id: `hc-${team}` });
    out.push({ kind: 'coach', team, x: at(COACH_YD + 0.3), y: 64, id: `ac-${team}` });
  }
  // chain crew on the east sideline
  const cx = FIELD_WIDTH + CHAIN_YD;
  if (firstDownY !== null) {
    const goalToGo = dir === 1 ? firstDownY >= FIELD_LENGTH - END_ZONE_DEPTH : firstDownY <= END_ZONE_DEPTH;
    if (!goalToGo) {
      out.push({ kind: 'stake', team: null, x: cx, y: firstDownY, id: 'stake-fwd' });
      out.push({ kind: 'stake', team: null, x: cx, y: firstDownY - 10 * dir, id: 'stake-rear' });
      out.push({ kind: 'chainCrew', team: null, x: cx + 0.45, y: firstDownY, id: 'crew-fwd' });
      out.push({ kind: 'chainCrew', team: null, x: cx + 0.45, y: firstDownY - 10 * dir, id: 'crew-rear' });
    }
  }
  if (losY !== null) {
    out.push({ kind: 'downBox', team: null, x: cx, y: losY, id: 'box' });
    out.push({ kind: 'chainCrew', team: null, x: cx + 0.45, y: losY, id: 'crew-box' });
  }
  for (const [end, y] of [[0, -3.4], [1, FIELD_LENGTH + 3.4]] as const) {
    for (let k = 0; k < 4; k++) out.push({ kind: 'photographer', team: null, x: 6 + k * 12.5 + h01(end * 9 + k) * 4, y: y + (h01(k + 3 * end) - 0.5) * 0.8, id: `photo-${end}-${k}` });
  }
  return out;
};

/** A drawable sideline object: sort y (art px at the feet), its ground shadow and its painter. */
export interface SidelineDrawable { y: number; shadow: { x: number; y: number; rx: number } | null; draw: () => void }

/** Frame-level inputs of the sideline. */
export interface SidelineOptions {
  opts: FieldViewOptions;
  tier: FigureTier;
  lighting: string;
  excitement: number;
  animate: boolean;
  losY: number | null;
  firstDownY: number | null;
  dir: Direction;
}

const kitCache = new WeakMap<ResolvedPalettes, Record<TeamSide, FigureKit>>();
const kitsFor = (p: ResolvedPalettes): Record<TeamSide, FigureKit> => {
  let k = kitCache.get(p);
  if (!k) {
    const u = teamUniforms(p);
    k = { home: makeKit('home', p.home, u.home), away: makeKit('away', p.away, u.away) };
    kitCache.set(p, k);
  }
  return k;
};
const SUB_BUILDS: readonly FigureBuild[] = ['slim', 'power', 'bigO', 'back', 'bigD', 'slim', 'kick', 'power', 'bigO', 'qb'];
const lastKeys = new Map<string, string>();

type Ctx = CanvasRenderingContext2D;

/** The visible sideline objects this frame. */
export const sidelineDrawables = (ctx: Ctx, camera: Camera, o: SidelineOptions): SidelineDrawable[] => {
  const v = camera.visibleBounds();
  const scale = TIER_SCALE[o.tier];
  const ppy = camera.zoom * WD;
  const hs = ppy * HEIGHT_SCALE;
  const cold = (o.opts.weather?.temperatureF ?? 60) < 40;
  const items = sidelineLayout(o.losY, o.firstDownY, o.dir, cold);
  const out: SidelineDrawable[] = [];
  const kits = kitsFor(o.opts.palettes);
  const topSide = (x: number): boolean => (x < FIELD_WIDTH / 2 ? -1 : 1) * acrossSign(camera) < 0;
  for (const it of items) {
    if (it.x < v.minX - 3 || it.x > v.maxX + 3 || it.y < v.minY - 6 || it.y > v.maxY + 6) continue;
    const p = camera.worldToScreen({ x: it.x, y: it.y });
    const x = Math.round(p.x * WD);
    const y = Math.round(p.y * WD);
    const color = it.team ? o.opts.palettes[it.team].primary : '#888888';
    const top = topSide(it.x);
    const seed = hashStr(it.id);
    if (it.kind === 'bench') {
      const len = Math.round((it.len ?? 5) * ppy);
      const depth = Math.max(3, Math.round(0.5 * ppy));
      const legs = Math.max(2, Math.round(0.35 * hs));
      const alongS = alongSign(camera);
      const x0 = alongS > 0 ? x : x - len;
      out.push({ y, shadow: null, draw: () => {
        ctx.fillStyle = 'rgba(8,20,10,0.28)';
        ctx.fillRect(x0 + 2, y - Math.round(depth / 2) + 1, len, depth);
        ctx.fillStyle = '#23252c';
        ctx.fillRect(x0 + 1, y - Math.round(depth / 2) - legs + depth - 1, 2, legs);
        ctx.fillRect(x0 + len - 3, y - Math.round(depth / 2) - legs + depth - 1, 2, legs);
        ctx.fillStyle = darken(color, 0.3);
        ctx.fillRect(x0, y - Math.round(depth / 2) - legs, len, depth);
        ctx.fillStyle = color;
        ctx.fillRect(x0, y - Math.round(depth / 2) - legs, len, Math.max(2, depth - 2));
        ctx.fillStyle = lighten(color, 0.25);
        ctx.fillRect(x0, y - Math.round(depth / 2) - legs, len, 1);
      } });
      continue;
    }
    if (it.kind === 'cooler' || it.kind === 'table' || it.kind === 'heater') {
      const w = Math.max(4, Math.round((it.kind === 'table' ? 1.4 : 0.7) * ppy));
      const h = Math.max(4, Math.round((it.kind === 'table' ? 0.55 : it.kind === 'heater' ? 0.9 : 0.75) * hs));
      out.push({ y, shadow: { x, y, rx: w * 0.55 }, draw: () => {
        const l = x - Math.round(w / 2);
        if (it.kind === 'cooler') {
          ctx.fillStyle = darken(color, 0.4); ctx.fillRect(l - 1, y - h - 1, w + 2, h + 1);
          ctx.fillStyle = color; ctx.fillRect(l, y - h, w, h);
          ctx.fillStyle = darken(color, 0.2); ctx.fillRect(l + w - 2, y - h, 2, h);
          ctx.fillStyle = '#f4f4ee'; ctx.fillRect(l, y - h, w, Math.max(2, Math.round(h * 0.22)));
          ctx.fillRect(l, y - Math.round(h * 0.45), w, 1);
        } else if (it.kind === 'table') {
          ctx.fillStyle = '#2a2c33'; ctx.fillRect(l + 1, y - h, 1, h); ctx.fillRect(l + w - 2, y - h, 1, h);
          ctx.fillStyle = '#e8e8e0'; ctx.fillRect(l, y - h - 2, w, 3);
          ctx.fillStyle = color;
          for (let k = 2; k < w - 2; k += 3) ctx.fillRect(l + k, y - h - 4, 2, 2);
        } else {
          ctx.fillStyle = '#2a2c33'; ctx.fillRect(l, y - h, w, h);
          const glow = o.animate ? 0.7 + 0.3 * Math.sin(o.opts.time * 3 + seed) : 0.85;
          ctx.fillStyle = `rgba(255,140,40,${glow.toFixed(2)})`;
          for (let k = 2; k < h - 1; k += 2) ctx.fillRect(l + 1, y - h + k, w - 2, 1);
        }
      } });
      continue;
    }
    if (it.kind === 'stake' || it.kind === 'downBox') {
      const ph = Math.round(2.3 * hs);
      const pw = Math.max(2, Math.round(ppy * 0.08));
      out.push({ y, shadow: { x, y, rx: Math.max(3, ppy * 0.25) }, draw: () => {
        ctx.fillStyle = '#16171c'; ctx.fillRect(x - pw, y - ph, pw * 2, ph);
        ctx.fillStyle = '#e8e8e0'; ctx.fillRect(x - pw + 1, y - ph, Math.max(1, pw * 2 - 2), ph);
        for (let k = 4; k < ph; k += 8) { ctx.fillStyle = '#16171c'; ctx.fillRect(x - pw, y - ph + k, pw * 2, 3); }
        const bw = Math.max(6, Math.round(ppy * 0.6));
        const bh = Math.max(5, Math.round(ppy * 0.45));
        const by = y - ph - bh;
        ctx.fillStyle = '#16171c'; ctx.fillRect(x - Math.round(bw / 2) - 1, by - 1, bw + 2, bh + 2);
        if (it.kind === 'stake') {
          ctx.fillStyle = o.opts.theme.colors.firstDown; ctx.fillRect(x - Math.round(bw / 2), by, bw, bh);
        } else {
          ctx.fillStyle = o.opts.theme.colors.los; ctx.fillRect(x - Math.round(bw / 2), by, bw, bh);
          const down = worldGameInfo()?.down;
          if (down && down >= 1 && down <= 4 && bh >= 7) {
            const d = stencil({ text: String(down), height: bh - 2, color: '#f4f4ee' });
            const img = pxImage(d);
            if (img) ctx.drawImage(img, x - Math.round(d.w / 2), by + 1);
          }
        }
      } });
      continue;
    }
    if (it.kind === 'sub') {
      const k = Number(it.id.split('-')[2] ?? 0);
      const build = SUB_BUILDS[k % SUB_BUILDS.length] as FigureBuild;
      const facing: Facing8 = top ? (h01(seed) < 0.3 ? 'sw' : h01(seed) > 0.7 ? 'se' : 's') : h01(seed) < 0.3 ? 'nw' : h01(seed) > 0.7 ? 'ne' : 'n';
      const frame = o.animate ? Math.floor(o.opts.time * 2 + (seed % 7)) % 2 : 0;
      const req: FrameRequest = {
        clip: o.excitement > 0.75 && k % 3 === 0 ? 'celebrateLeap' : 'idle', frame, facing, build, bodyVar: bodyVarFor(build, undefined), tier: o.tier,
        kit: kits[it.team ?? 'home'], skin: seed % 6, number: 10 + (seed % 89), ball: false, accessory: seed, lighting: o.lighting,
      };
      out.push({ y, shadow: { x, y, rx: 7 * scale }, draw: () => {
        const fig = resolveFigure(FIGURE_ATLAS, req, lastKeys.get(it.id) ?? null);
        if (!fig) return;
        lastKeys.set(it.id, fig.key);
        drawAtlasFrame(ctx, fig.frame, x, y);
        fig.painter.decorate?.(ctx, fig.frame, req, x, y);
      } });
      continue;
    }
    // civilians
    const view: PersonView = it.kind === 'photographer' ? ((it.y < FIELD_LENGTH / 2 ? 1 : -1) * alongSign(camera) > 0 ? 'right' : 'left') : top ? 'front' : 'back';
    const excited = it.kind === 'coach' || it.kind === 'headCoach' ? o.excitement > 0.7 : false;
    const frame = (o.animate ? (excited ? 2 : Math.floor(o.opts.time * 1.3 + (seed % 5)) % 2) : 0) as 0 | 1 | 2;
    const sprite = personSprite(it.kind as PersonKind, view, it.team ? color : '#2b2d35', scale, frame, seed % 5);
    out.push({ y, shadow: { x, y, rx: 6 * scale }, draw: () => {
      const img = pxImage(sprite.px);
      if (img) ctx.drawImage(img, x - sprite.ax, y - sprite.ay);
    } });
  }
  // the chain between the stakes, at knee height
  if (o.firstDownY !== null) {
    const fwd = items.find((i) => i.id === 'stake-fwd');
    const rear = items.find((i) => i.id === 'stake-rear');
    if (fwd && rear) {
      const a = camera.worldToScreen({ x: fwd.x, y: fwd.y });
      const b = camera.worldToScreen({ x: rear.x, y: rear.y });
      const cy = Math.round(a.y * WD - 0.5 * hs);
      out.push({ y: Math.round(a.y * WD) - 0.5, shadow: null, draw: () => {
        const x0 = Math.round(Math.min(a.x, b.x) * WD);
        const x1 = Math.round(Math.max(a.x, b.x) * WD);
        ctx.fillStyle = '#3c3e46';
        for (let x = x0; x < x1; x += 3) ctx.fillRect(x, cy + (((x - x0) / 3) % 2 === 0 ? 0 : 1), 2, 1);
      } });
    }
  }
  return out;
};
