/**
 * Midfield emblem (art bible §10.2): an original painted disc 8 yd across at the 50 in the home team's colours: an
 * accent rim with a dark keyline, a thin chalk ring, the primary field with a team motif (chevron, star or bolt,
 * chosen by the hash of the abbreviation) as a large tonal watermark toward the secondary colour, and the abbreviation in stencil letters across
 * the middle. Paint on grass is flat (no lighting). Rasterised per 0.5 px/yd zoom band into an RGBA buffer
 * (Node-testable) and cached; while the zoom is easing, a missing band draws the nearest cached one scaled so a
 * zoom sweep never paints a new emblem every frame.
 */
import { FIELD_LENGTH, MIDDLE_X } from '@/game/types';
import type { Camera } from '../../camera';
import { contrastRatio, darken, mix } from '../palette';
import { WD, hashStr } from '../world-layer';
import { alphaAt, Lru, newPx, pxImage, setPx, type Px } from './art';
import { paintStencil } from './stencil';

/** Emblem diameter, yards. */
export const EMBLEM_YD = 8;

/** Colours and name the emblem is painted from. */
export interface EmblemTeam { primary: string; secondary: string; accent: string; abbr: string }

type Motif = 'chevron' | 'star' | 'bolt';
const MOTIFS: readonly Motif[] = ['chevron', 'star', 'bolt'];

const inMotif = (m: Motif, x: number, y: number): boolean => {
  if (m === 'chevron') {
    const d = Math.abs(y + 0.15 - (0.55 - Math.abs(x) * 0.9));
    return d < 0.14 && Math.abs(x) < 0.7;
  }
  if (m === 'star') {
    const a = Math.atan2(y, x);
    const r = Math.hypot(x, y);
    const k = 0.34 + 0.3 * Math.pow(Math.abs(Math.cos(((a + Math.PI / 2) * 5) / 2)), 3);
    return r < k;
  }
  // bolt: a zigzag band
  const t = y * 2.2;
  const cx = t < -0.3 ? 0.15 + t * 0.2 : t < 0.3 ? -0.15 - (t - 0.3) * 0.5 : 0.15 + (t - 0.3) * 0.2;
  return Math.abs(x - cx) < 0.16 && Math.abs(y) < 0.62;
};

/** Paints the emblem at diameter `d` art px (pure; exported for tests). */
export const paintEmblem = (team: EmblemTeam, d: number): Px => {
  const size = Math.max(8, Math.round(d));
  const px = newPx(size, size);
  const motif = MOTIFS[hashStr(team.abbr) % MOTIFS.length] as Motif;
  const keyline = darken(team.primary, 0.5);
  // the motif is a tonal watermark behind the name band (review: a full-strength secondary motif cut in half by the
  // band read as a dark blob); it fills most of the disc so its arms show clearly above and below the band
  const motifFull = contrastRatio(team.secondary, team.primary) < 1.4 ? mix(team.primary, '#ffffff', 0.35) : team.secondary;
  const motifColor = mix(team.primary, motifFull, 0.42);
  const rim = contrastRatio(team.accent, team.primary) < 1.3 ? mix(team.primary, '#ffffff', 0.5) : team.accent;
  const R = size / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const nx = (x + 0.5 - R) / R;
      const ny = (y + 0.5 - R) / R;
      const r = Math.hypot(nx, ny);
      if (r > 1) continue;
      let c: string;
      if (r > 1 - 2 / R) c = keyline;
      else if (r > 0.9) c = rim;
      else if (r > 0.9 - Math.max(1.2, R * 0.04) / R) c = '#f4f4ea';
      else if (inMotif(motif, nx / 1.18, ny / 1.18)) c = motifColor;
      else c = team.primary;
      setPx(px, x, y, c);
    }
  }
  // the abbreviation across the middle on a keyline band
  const text = paintStencil({ text: team.abbr.toUpperCase(), height: Math.round(size * 0.24), color: '#f4f4ea', outline: keyline });
  const bandH = text.h + Math.max(2, Math.round(size * 0.04));
  const by = Math.round(R - bandH / 2);
  for (let y = by; y < by + bandH; y++) {
    for (let x = 0; x < size; x++) {
      if (alphaAt(px, x, y) === 0) continue;
      const nx = (x + 0.5 - R) / R;
      const ny = (y + 0.5 - R) / R;
      if (Math.hypot(nx, ny) < 0.9) setPx(px, x, y, keyline);
    }
  }
  const scale = Math.min(1, (size * 0.8) / Math.max(1, text.w));
  const tw = Math.round(text.w * scale);
  const tx = Math.round(R - tw / 2);
  const ty = Math.round(R - text.h / 2);
  for (let y = 0; y < text.h; y++) {
    for (let x = 0; x < tw; x++) {
      const sx = Math.min(text.w - 1, Math.floor(x / scale));
      const i = (y * text.w + sx) * 4;
      if ((text.data[i + 3] ?? 0) === 0) continue;
      const hex = `#${[text.data[i] ?? 0, text.data[i + 1] ?? 0, text.data[i + 2] ?? 0].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
      setPx(px, tx + x, ty + y, hex);
    }
  }
  return px;
};

const cache = new Lru<Px>(4);
let lastPaintAt = -Infinity;
const now = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/** Draws the emblem at midfield (world 26.65, 60) with `alpha` (70 % over the grass). */
export const drawEmblem = (ctx: CanvasRenderingContext2D, camera: Camera, team: EmblemTeam, alpha: number): void => {
  const band = Math.max(0.5, Math.round(camera.zoom * 2) / 2);
  const d = Math.round(EMBLEM_YD * band * WD);
  const key = `${team.primary}${team.secondary}${team.accent}${team.abbr}|`;
  let px = cache.get(key + d);
  const want = Math.round(EMBLEM_YD * camera.zoom * WD);
  if (!px) {
    const t = now();
    if (t - lastPaintAt > 250) {
      px = paintEmblem(team, d);
      cache.set(key + d, px);
      lastPaintAt = t;
    }
  }
  const c = camera.worldToScreen({ x: MIDDLE_X, y: FIELD_LENGTH / 2 });
  const cx = Math.round(c.x * WD);
  const cy = Math.round(c.y * WD);
  const prev = ctx.globalAlpha;
  ctx.globalAlpha = alpha;
  if (px) {
    const img = pxImage(px);
    if (img) ctx.drawImage(img, cx - Math.round(px.w / 2), cy - Math.round(px.h / 2));
  } else {
    // zooming: the nearest cached size, scaled (only for the frames of the sweep)
    for (const alt of [1, 2, 3, 4, 5, 6, 8, 10].flatMap((k) => [d - k * EMBLEM_YD, d + k * EMBLEM_YD])) {
      const q = cache.get(key + alt);
      const img = q ? pxImage(q) : null;
      if (img) {
        ctx.drawImage(img, cx - Math.round(want / 2), cy - Math.round(want / 2), want, want);
        break;
      }
    }
  }
  ctx.globalAlpha = prev;
};
