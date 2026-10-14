/**
 * Stadium dressing (art bible §10.3), drawn after the bowl: the LED ribbon board along the far stand's club level
 * (team-colour chevrons scrolling, flashing on big plays), team banners hanging from it that sway with the wind, the
 * roof band beyond the bowl (a dome's dark truss roof, a retractable roof's open slot, open-air: the upper rim with
 * a lamp row), four light towers at the corners (lit with bloom at night) and the scoreboard above the north end
 * (team panels, and the score / quarter when a screen publishes them through game-info.ts). No brands, no sponsor
 * text: only the teams' own colours and abbreviations.
 */
import { FIELD_LENGTH, FIELD_WIDTH, MIDDLE_X, type WeatherState } from '@/game/types';
import type { Camera } from '../../camera';
import { darken, lighten, textColorOn } from '../palette';
import type { StadiumView } from '../stadium';
import { WD } from '../world-layer';
import { alongSign, artRect, onScreen, pxImage, type ArtRect } from './art';
import { worldGameInfo } from './game-info';
import { END_WALL, SIDE_WALL, STAND_DEPTH } from './stadium-hi';
import { stencil, type Turn } from './stencil';

type Ctx = CanvasRenderingContext2D;

/** Options of the stadium dressing. */
export interface StadiumDecoOptions {
  time: number;
  animate: boolean;
  excitement: number;
  homeAccent: string;
  awayAbbr: string;
  homeAbbr: string;
  night: boolean;
  weather: WeatherState | null;
}

/** Wind sway (-1..1) of a banner / flag at `phase` (pure). */
export const windSway = (weather: WeatherState | null, time: number, phase: number): number => {
  const mph = weather?.windMph ?? 3;
  const k = Math.min(1, mph / 20);
  return Math.sin(time * (1.5 + k * 4) + phase) * (0.25 + 0.75 * k);
};

/** LED ribbon board + banners on the far stand's club band. */
const drawRibbon = (ctx: Ctx, camera: Camera, club: ArtRect, view: StadiumView, o: StadiumDecoOptions): void => {
  const h = Math.max(3, Math.round(club.h * 0.34));
  const y = club.y + Math.max(1, Math.round(club.h * 0.08));
  ctx.fillStyle = '#0c0d12';
  ctx.fillRect(club.x, y - 1, club.w, h + 2);
  const cell = Math.max(2, Math.round(camera.zoom * 0.6));
  const o0 = Math.round(camera.worldToScreen({ x: 0, y: 0 }).x * WD);
  const scroll = o.animate ? Math.floor(o.time * 24) : 0;
  const hot = o.excitement > 0.55 && o.animate && Math.floor(o.time * 6) % 2 === 0;
  const a = hot ? '#fff3b0' : view.homeColor;
  const b = hot ? view.homeColor : o.homeAccent;
  for (let x = club.x - ((((club.x - o0) % cell) + cell) % cell); x < club.x + club.w; x += cell) {
    const k = Math.floor((x - o0 + scroll) / cell);
    const chevron = ((k % 8) + 8) % 8;
    ctx.fillStyle = chevron < 3 ? a : chevron < 4 ? '#f4f4ee' : b;
    ctx.fillRect(x, y, cell - 1, h);
  }
  // banners hanging below the ribbon every 15 yd
  if (camera.zoom < 3.5) return;
  const bw = Math.max(4, Math.round(camera.zoom * WD * 1.4));
  const bh = Math.max(6, Math.round(camera.zoom * WD * 2.3));
  for (let wy = 5; wy <= FIELD_LENGTH - 5; wy += 15) {
    const c = camera.worldToScreen({ x: 0, y: wy });
    const cx = Math.round(c.x * WD);
    if (cx + bw < 0 || cx - bw > 960) continue;
    const top = y + h + 1;
    const sway = o.animate ? Math.round(windSway(o.weather, o.time, wy * 0.7) * 2) : 0;
    const main = wy % 30 === 5 ? view.homeColor : o.homeAccent;
    for (let r = 0; r < bh; r++) {
      const dx = Math.round((sway * r) / bh);
      ctx.fillStyle = r < 2 ? '#20222a' : r === bh - 1 ? darken(main, 0.3) : main;
      ctx.fillRect(cx - Math.round(bw / 2) + dx, top + r, bw, 1);
    }
    ctx.fillStyle = main === view.homeColor ? o.homeAccent : view.homeColor;
    const cy = top + Math.round(bh * 0.55);
    const s = Math.max(2, Math.round(bw * 0.3));
    for (let i = 0; i < s; i++) ctx.fillRect(cx - s + i + Math.round((sway * 0.55)), cy - i, 2, 1);
    for (let i = 0; i < s; i++) ctx.fillRect(cx + i + Math.round((sway * 0.55)), cy - s + 1 + i, 2, 1);
  }
};

/** Light towers at the four corners: a mast rising up the screen and a lamp bank (bright with bloom at night). */
const drawTowers = (ctx: Ctx, camera: Camera, o: StadiumDecoOptions, dome: boolean): void => {
  if (dome) return;
  const d = STAND_DEPTH + 1.5;
  const hs = camera.zoom * WD * 0.68;
  for (const x of [-SIDE_WALL - d, FIELD_WIDTH + SIDE_WALL + d]) {
    for (const y of [-END_WALL - d + 3, FIELD_LENGTH + END_WALL + d - 3]) {
      const p = camera.worldToScreen({ x, y });
      const bx = Math.round(p.x * WD);
      const by = Math.round(p.y * WD);
      const mast = Math.round(16 * hs);
      if (bx < -80 || bx > 1040 || by < -40 || by - mast > 580) continue;
      const w = Math.max(2, Math.round(camera.zoom * 0.5));
      ctx.fillStyle = '#6f7480';
      ctx.fillRect(bx - w, by - mast, w * 2, mast);
      ctx.fillStyle = '#a8adb8';
      ctx.fillRect(bx - w, by - mast, 1, mast);
      const lw = Math.max(6, Math.round(camera.zoom * WD * 2.2));
      const lh = Math.max(4, Math.round(camera.zoom * WD * 1.2));
      ctx.fillStyle = '#2a2d36';
      ctx.fillRect(bx - Math.round(lw / 2), by - mast - lh, lw, lh);
      const cols = 4;
      const rows = 3;
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const lx = bx - Math.round(lw / 2) + 1 + Math.round(((lw - 2) * c) / cols);
          const ly = by - mast - lh + 1 + Math.round(((lh - 2) * r) / rows);
          const cw = Math.max(1, Math.round((lw - 2) / cols) - 1);
          const ch = Math.max(1, Math.round((lh - 2) / rows) - 1);
          if (o.night) {
            ctx.fillStyle = 'rgba(255,244,200,0.18)';
            ctx.fillRect(lx - 2, ly - 2, cw + 4, ch + 4);
          }
          ctx.fillStyle = o.night ? '#fffbe8' : '#c9ccd2';
          ctx.fillRect(lx, ly, cw, ch);
        }
      }
    }
  }
};

/** The roof band / rim beyond the bowl. */
const drawRoof = (ctx: Ctx, camera: Camera, view: StadiumView, o: StadiumDecoOptions): void => {
  const v = camera.visibleBounds();
  const d = STAND_DEPTH;
  const rimYd = view.roof === 'open' ? 1 : 8;
  const boxes = [
    { x: -SIDE_WALL - d - rimYd, y: -END_WALL - d - rimYd, w: rimYd, h: FIELD_LENGTH + 2 * (END_WALL + d + rimYd) },
    { x: FIELD_WIDTH + SIDE_WALL + d, y: -END_WALL - d - rimYd, w: rimYd, h: FIELD_LENGTH + 2 * (END_WALL + d + rimYd) },
    { x: -SIDE_WALL - d, y: -END_WALL - d - rimYd, w: FIELD_WIDTH + 2 * (SIDE_WALL + d), h: rimYd },
    { x: -SIDE_WALL - d, y: FIELD_LENGTH + END_WALL + d, w: FIELD_WIDTH + 2 * (SIDE_WALL + d), h: rimYd },
  ];
  const roof = view.roof === 'dome' ? '#262a33' : view.roof === 'retractable' ? '#2e323c' : '#4a4f5a';
  // everything beyond the rim: the dark outside of the stadium
  const far = 400;
  const outer = [
    { x: -SIDE_WALL - d - rimYd - far, y: -far, w: far, h: FIELD_LENGTH + 2 * far },
    { x: FIELD_WIDTH + SIDE_WALL + d + rimYd, y: -far, w: far, h: FIELD_LENGTH + 2 * far },
    { x: -far, y: -END_WALL - d - rimYd - far, w: FIELD_WIDTH + 2 * far, h: far },
    { x: -far, y: FIELD_LENGTH + END_WALL + d + rimYd, w: FIELD_WIDTH + 2 * far, h: far },
  ];
  ctx.fillStyle = '#14161c';
  for (const b of outer) {
    if (b.x > v.maxX || b.x + b.w < v.minX || b.y > v.maxY || b.y + b.h < v.minY) continue;
    const r = artRect(camera, b.x, b.y, b.w, b.h);
    ctx.fillRect(Math.max(-2, r.x), Math.max(-2, r.y), Math.min(964, r.x + r.w) - Math.max(-2, r.x), Math.min(544, r.y + r.h) - Math.max(-2, r.y));
  }
  for (const b of boxes) {
    if (b.x > v.maxX || b.x + b.w < v.minX || b.y > v.maxY || b.y + b.h < v.minY) continue;
    const r = artRect(camera, b.x, b.y, b.w, b.h);
    if (!onScreen(r)) continue;
    ctx.fillStyle = roof;
    ctx.fillRect(r.x, r.y, r.w, r.h);
    if (view.roof === 'open') {
      // rim with a row of lamps
      ctx.fillStyle = o.night ? '#fff6d0' : '#8a8f9a';
      const step = Math.max(4, Math.round(camera.zoom * WD * 2));
      const horizontal = r.w > r.h;
      for (let k = 0; k < (horizontal ? r.w : r.h); k += step) ctx.fillRect(horizontal ? r.x + k : r.x + Math.round(r.w / 2) - 1, horizontal ? r.y + Math.round(r.h / 2) - 1 : r.y + k, 2, 2);
      continue;
    }
    // truss lines across the roof band
    ctx.fillStyle = lighten(roof, 0.08);
    const step = Math.max(6, Math.round(camera.zoom * WD * 3));
    for (let k = 0; k < r.w + r.h; k += step) {
      for (let t = 0; t < Math.min(r.w, r.h); t += 2) {
        const x = r.w > r.h ? r.x + k - t : r.x + t;
        const y = r.w > r.h ? r.y + t : r.y + k - t;
        if (x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h) ctx.fillRect(x, y, 1, 1);
      }
    }
    if (view.roof === 'retractable') {
      ctx.fillStyle = o.night ? '#0e1420' : '#6d8fb3';
      const slot = r.w > r.h ? { x: r.x, y: r.y + Math.round(r.h * 0.55), w: r.w, h: Math.max(2, Math.round(r.h * 0.3)) } : { x: r.x + Math.round(r.w * 0.55), y: r.y, w: Math.max(2, Math.round(r.w * 0.3)), h: r.h };
      ctx.fillRect(slot.x, slot.y, slot.w, slot.h);
    }
  }
};

/** Scoreboard above the north end stand, reading along the end line. */
const drawScoreboard = (ctx: Ctx, camera: Camera, view: StadiumView, o: StadiumDecoOptions): void => {
  const y0 = FIELD_LENGTH + END_WALL + STAND_DEPTH + 0.6;
  const r = artRect(camera, MIDDLE_X - 11, y0, 22, 4.5);
  if (!onScreen(r) || camera.zoom < 2.5) return;
  ctx.fillStyle = '#16181f';
  ctx.fillRect(r.x - 2, r.y - 2, r.w + 4, r.h + 4);
  ctx.fillStyle = '#05060a';
  ctx.fillRect(r.x, r.y, r.w, r.h);
  const info = worldGameInfo();
  // panels stacked along the board's long (screen-vertical) axis: away | home
  const vertical = r.h > r.w;
  const turn: Turn = alongSign(camera) > 0 ? 1 : 3;
  const panels = [
    { abbr: o.awayAbbr, color: view.awayColor, score: info?.awayScore },
    { abbr: o.homeAbbr, color: view.homeColor, score: info?.homeScore },
  ];
  const n = panels.length;
  panels.forEach((p, i) => {
    const pr = vertical
      ? { x: r.x + 2, y: r.y + 2 + Math.round(((r.h - 4) * i) / n), w: r.w - 4, h: Math.round((r.h - 4) / n) - 2 }
      : { x: r.x + 2 + Math.round(((r.w - 4) * i) / n), y: r.y + 2, w: Math.round((r.w - 4) / n) - 2, h: r.h - 4 };
    ctx.fillStyle = darken(p.color, 0.2);
    ctx.fillRect(pr.x, pr.y, pr.w, pr.h);
    const text = p.score !== undefined && p.score !== null ? `${p.abbr} ${p.score}` : p.abbr;
    const hgt = Math.max(7, Math.round((vertical ? pr.w : pr.h) * 0.5));
    const px = stencil({ text, height: hgt, color: textColorOn(darken(p.color, 0.2)), turn: vertical ? turn : 0 });
    const img = pxImage(px);
    if (img && px.w <= pr.w + 2 && px.h <= pr.h + 2) ctx.drawImage(img, pr.x + Math.round((pr.w - px.w) / 2), pr.y + Math.round((pr.h - px.h) / 2));
  });
  if (o.excitement > 0.8 && o.animate && Math.floor(o.time * 4) % 2 === 0) {
    ctx.fillStyle = 'rgba(255,240,170,0.25)';
    ctx.fillRect(r.x, r.y, r.w, r.h);
  }
};

/** Draws the stadium dressing (after drawStadiumHi). */
export const drawStadiumDeco = (ctx: Ctx, camera: Camera, view: StadiumView, o: StadiumDecoOptions, clubTop: ArtRect | null): void => {
  drawRoof(ctx, camera, view, o);
  if (clubTop) drawRibbon(ctx, camera, clubTop, view, o);
  drawScoreboard(ctx, camera, view, o);
  drawTowers(ctx, camera, o, view.roof === 'dome');
};
