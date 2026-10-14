/**
 * Play art: draws an offensive or defensive play as a top-down diagram in the play-local frame (+x = offense's
 * right, +y = downfield), laid out like the horizontal game field: downfield runs to the RIGHT and the offense's
 * right is DOWN (the offense faces right, as it attacks on the field). Offense: slot dots (squares for linemen,
 * discs for eligibles, ring for the QB), route lines from routePath, the run track through the called gap,
 * play-action fake marker.
 * Defense: slot dots, zone blobs at their landmarks, man-coverage ties toward the LOS, blitz / rush arrows.
 * Drawn as chalk on a slate-green board (art bible §12.1): O's and squares for the offense, X's for the defense, chalk
 * strokes with a faint dust trail on the one chunky pixel grid. Colour still carries meaning
 * (routes / zones blue, runs and man ties orange, blitzes red) and every mark also differs in shape.
 * Only fillRect-based primitives, so it renders on the recording fake context in tests.
 */
import { vec2, type Vec2 } from '@/core/vec2';
import { MIDDLE_X } from '@/game/types';
import type { PlaybookRegistry } from '@/playbook/loader';
import { materializeDefensivePlay, materializePlay } from '@/playbook/loader';
import { routePath } from '@/playbook/transform';
import type { DefAssignment, DefensivePlay, FormationSlot, Gap, OffensivePlay } from '@/playbook/types';
import { zoneLandmark } from '@/playbook/zones';
import type { FillCtx } from '../render/text';
import type { Theme } from '../theme';
import { pixelDashedLine } from './pixel-draw';
import { UI_SLAB, lighten, mix } from '../render/palette';
import { artEllipse, artLine, artPattern, fillAlpha, fillPattern, type ArtCtx } from '../widgets/ui-art';

export interface PlayArtBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PlayArtOptions {
  theme: Theme;
  /** Colour of the unit's dots. */
  unitColor?: string;
  /** Colour of the routes / zones. */
  routeColor?: string;
  /** Highlight one role (the controlled athlete or primary read). */
  highlightRole?: string | null;
  /** Yards of field width shown top to bottom across the box height (default 54). */
  yardsWide?: number;
  /** Yards from the LOS downfield (to the right, default 22) and behind it (to the left, default 10). */
  yardsDeep?: number;
  yardsBack?: number;
}

/** Gap x offsets (yards) in the play-local frame. */
export const GAP_X: Readonly<Record<Gap, number>> = {
  'A-left': -0.7, 'A-right': 0.7, 'B-left': -2.2, 'B-right': 2.2, 'C-left': -3.8, 'C-right': 3.8, 'D-left': -6, 'D-right': 6,
};

/**
 * Maps play-local yards into a box, horizontally like the game field: downfield = right (the LOS `yardsBack` from
 * the left edge), the offense's right = down, the interior ART_INNER_YARDS either side of the ball drawn wider than
 * the splits outside it (see innerAcrossScale). Points are clamped to the box edges.
 */
export const artProjector = (box: PlayArtBox, opts: PlayArtOptions): ((local: Vec2) => Vec2) => {
  const raw = artProjectorRaw(box, opts);
  const clampX = (x: number): number => Math.max(box.x, Math.min(box.x + box.w, x));
  const clampY = (y: number): number => Math.max(box.y, Math.min(box.y + box.h, y));
  return (local) => {
    const p = raw(local);
    return vec2(clampX(p.x), clampY(p.y));
  };
};

/** Yards either side of the ball drawn at the larger interior scale (the line and the backfield). */
export const ART_INNER_YARDS = 4.5;
/** Interior scale (lpx per yard) that keeps 1.15-yd lineman spacing a 5-lpx mark plus a gap apart. */
const ART_LINE_SCALE = 5.7;

/**
 * Across-field scale (lpx per yard) of the interior band: like a coach's board, the few yards around the ball get
 * about the downfield scale (up to 1.25x it) so five linemen 1.15 yd apart read as five separate marks, while the
 * wide splits beyond are compressed to still fit `yardsWide`. Never below the plain linear scale.
 */
const innerAcrossScale = (box: PlayArtBox, wide: number, along: number): number => {
  const linear = box.h / wide;
  const half = box.h / 2;
  // 40% of the half-height for the band, more (up to 60%) on a short board so the line still separates.
  const target = Math.max((half * 0.4) / ART_INNER_YARDS, Math.min(ART_LINE_SCALE, (half * 0.6) / ART_INNER_YARDS));
  return Math.max(linear, Math.min(along * 1.25, target));
};

/** The same mapping without clamping (zones that reach past the board are clipped when drawn instead). */
export const artProjectorRaw = (box: PlayArtBox, opts: PlayArtOptions): ((local: Vec2) => Vec2) => {
  const wide = opts.yardsWide ?? 54;
  const deep = opts.yardsDeep ?? 22;
  const back = opts.yardsBack ?? 10;
  const along = box.w / (deep + back);
  const inner = innerAcrossScale(box, wide, along);
  const innerPx = inner * ART_INNER_YARDS;
  const outer = Math.max(0, (box.h / 2 - innerPx) / Math.max(1e-6, wide / 2 - ART_INNER_YARDS));
  const across = (x: number): number => {
    const ax = Math.abs(x);
    const px = ax <= ART_INNER_YARDS ? ax * inner : innerPx + (ax - ART_INNER_YARDS) * outer;
    return Math.sign(x) * px;
  };
  const losX = box.x + back * along;
  return (local) => vec2(losX + local.y * along, box.y + box.h / 2 + across(local.x));
};

/** Yards shown downfield of the LOS on defensive boards (deep zones reach ~30 yd). */
export const DEFENSE_YARDS_DEEP = 30;
/** Yards shown behind the LOS on defensive boards. */
export const DEFENSE_YARDS_BACK = 8;

/** An ellipse on the art grid clipped to the board: a translucent fill and a crisp 1-art-px rim. */
const clippedEllipse = (ctx: FillCtx, box: PlayArtBox, cx: number, cy: number, rx: number, ry: number, color: string): void => {
  const art = ctx as ArtCtx;
  const x0 = box.x + 2;
  const x1 = box.x + box.w - 2;
  const y0 = box.y + 2;
  const y1 = box.y + box.h - 2;
  const rows = Math.ceil(ry);
  const prev = art.globalAlpha;
  const span = (j: number): number => {
    const t = 1 - (j * j) / Math.max(0.25, ry ** 2);
    return t < 0 ? -1 : Math.round(rx * Math.sqrt(t));
  };
  for (let j = -rows; j <= rows; j++) {
    const half = span(j);
    if (half < 0) continue;
    const y = Math.round(cy) + j;
    if (y < y0 || y >= y1) continue;
    const left = Math.round(cx) - half;
    const right = Math.round(cx) + half + 1;
    const l = Math.max(x0, left);
    const r = Math.min(x1, right);
    if (r <= l) continue;
    art.globalAlpha = prev * 0.14;
    ctx.fillStyle = color;
    ctx.fillRect(l, y, r - l, 1);
    art.globalAlpha = prev;
    // Rim: the ends of this row, or the whole row on the top / bottom edge.
    const edge = Math.abs(j) === rows || span(Math.abs(j) + 1) < 0;
    const inner = Math.max(0, span(Math.abs(j) + 1));
    const run = edge ? half * 2 + 1 : Math.max(1, half - inner);
    const lx = left;
    const rx2 = right - run;
    if (edge) {
      if (r > l) ctx.fillRect(l, y, r - l, 1);
    } else {
      if (lx >= x0 && lx < x1) ctx.fillRect(lx, y, Math.min(run, x1 - lx), 1);
      if (rx2 >= x0 && rx2 < x1) ctx.fillRect(rx2, y, Math.min(run, x1 - rx2), 1);
    }
  }
  art.globalAlpha = prev;
};

/**
 * Chalk marks for players: hollow squares for linemen, O's for eligibles, an O with a centre dot for the passer /
 * kicker, and X's for defenders (a shape cue for each role, not only colour).
 */
const dot = (ctx: FillCtx, p: Vec2, color: string, kind: 'square' | 'disc' | 'ring' | 'x', s: number): void => {
  const x = Math.round(p.x);
  const y = Math.round(p.y);
  const art = ctx as ArtCtx;
  const r = s + 1;
  if (kind === 'x') {
    artLine(art, x - r, y - r, x + r, y + r, color, 2);
    artLine(art, x - r, y + r, x + r, y - r, color, 2);
    return;
  }
  if (kind === 'square') {
    ctx.fillStyle = color;
    ctx.fillRect(x - r, y - r, 2 * r + 1, 1);
    ctx.fillRect(x - r, y + r, 2 * r + 1, 1);
    ctx.fillRect(x - r, y - r, 1, 2 * r + 1);
    ctx.fillRect(x + r, y - r, 1, 2 * r + 1);
    return;
  }
  artEllipse(art, x, y, r + 0.5, r + 0.5, color, false, 2);
  if (kind === 'ring') artEllipse(art, x, y, 0.5, 0.5, color, true);
};

/**
 * Size step of the chalk marks: large text grows them only on a board tall enough for bigger marks, so a small board
 * (the play-call card in large-text mode) keeps its five linemen apart.
 */
export const markScale = (theme: Theme, box: PlayArtBox): number => Math.max(1, Math.min(theme.textScale, box.h >= 140 ? 2 : 1));

/** A chalk stroke: a faint wide dust trail under a crisp line on the art grid. */
const chalkLine = (ctx: FillCtx, x0: number, y0: number, x1: number, y1: number, color: string, thick = 2): void => {
  const art = ctx as ArtCtx;
  const prev = art.globalAlpha;
  art.globalAlpha = prev * 0.18;
  artLine(art, x0, y0, x1, y1, UI_SLAB.chalk, thick + 2);
  art.globalAlpha = prev;
  artLine(art, x0, y0, x1, y1, color, thick);
};

/** Chalk arrow: the stroke plus a two-line head at the tip. */
const chalkArrow = (ctx: FillCtx, x0: number, y0: number, x1: number, y1: number, color: string, head: number, thick = 2): void => {
  chalkLine(ctx, x0, y0, x1, y1, color, thick);
  const a = Math.atan2(y1 - y0, x1 - x0);
  for (const d of [-0.55, 0.55]) artLine(ctx as ArtCtx, x1, y1, x1 - Math.cos(a + d) * head, y1 - Math.sin(a + d) * head, color, thick);
};

const isLineman = (slot: FormationSlot): boolean => slot.position === 'OT' || slot.position === 'OG' || slot.position === 'C';

/**
 * Draws the diagram's chalkboard: slate green with a darker rim, faint deterministic chalk smudges, yard lines as
 * faint chalk and the line of scrimmage as a solid chalk-blue stroke (vertical, like the game field).
 */
export const drawArtField = (ctx: FillCtx, box: PlayArtBox, opts: PlayArtOptions): void => {
  const c = opts.theme.colors;
  const art = ctx as ArtCtx;
  const x = Math.round(box.x);
  const y = Math.round(box.y);
  const w = Math.round(box.w);
  const h = Math.round(box.h);
  ctx.fillStyle = UI_SLAB.chalkboard;
  ctx.fillRect(x, y, w, h);
  ctx.fillStyle = UI_SLAB.chalkboardDark;
  ctx.fillRect(x, y, w, 2);
  ctx.fillRect(x, y + h - 2, w, 2);
  ctx.fillRect(x, y, 2, h);
  ctx.fillRect(x + w - 2, y, 2, h);
  // Chalk dust: a sparse speckle over the board (a cached art pattern; nothing on the fake / legacy path).
  const dust = artPattern(art, 'chalkDust', 7, 5, (px, py) => ((px * 3 + py * 5) % 7 === 0 && py % 2 === 0 ? UI_SLAB.chalk : null));
  fillPattern(art, dust, 0.09, x + 2, y + 2, w - 4, h - 4);
  const project = artProjector(box, opts);
  const deep = opts.yardsDeep ?? 22;
  const back = opts.yardsBack ?? 10;
  // Hash marks: a short faint chalk tick every yard on both hash rows (3.1 yd either side of the ball).
  const hashes = [project(vec2(-3.08, 0)).y, project(vec2(3.08, 0)).y];
  for (let yd = -back + 1; yd < deep; yd++) {
    if (yd % 5 === 0) continue;
    const hx = Math.round(project(vec2(0, yd)).x);
    for (const hy of hashes) fillAlpha(art, UI_SLAB.chalk, 0.2, hx, Math.round(hy) - 1, 2, 2);
  }
  for (let yd = -Math.floor(back / 5) * 5; yd <= deep; yd += 5) {
    const p = project(vec2(0, yd));
    if (yd === 0) {
      fillAlpha(art, c.los, 0.35, Math.round(p.x) - 1, y + 2, 3, h - 4);
      ctx.fillStyle = lighten(c.los, 0.3);
      ctx.fillRect(Math.round(p.x), y + 2, 1, h - 4);
    } else fillAlpha(art, UI_SLAB.chalk, 0.16, Math.round(p.x), y + 2, 2, h - 4);
  }
};

/** Offensive play diagram. Returns false when the formation is unknown (draws a placeholder). */
export const drawOffensiveArt = (ctx: FillCtx, play: OffensivePlay, registry: PlaybookRegistry, box: PlayArtBox, opts: PlayArtOptions): boolean => {
  drawArtField(ctx, box, opts);
  const formation = registry.offensiveFormations[play.formation];
  const c = opts.theme.colors;
  const unit = opts.unitColor ?? UI_SLAB.chalk;
  const route = opts.routeColor ?? c.accent2;
  const chalkDim = mix(UI_SLAB.chalk, UI_SLAB.chalkboard, 0.45);
  const project = artProjector(box, opts);
  const s = markScale(opts.theme, box);
  if (!formation) {
    dot(ctx, project(vec2(0, -1)), c.textDim, 'ring', s);
    return false;
  }
  const mat = materializePlay(play, formation, registry.routes);
  const local = (slot: FormationSlot): Vec2 => vec2(slot.x, slot.y);
  const carrierRole = play.ballCarrier ?? null;
  for (const slot of mat.formation.slots) {
    const a = mat.play.assignments[slot.role];
    const origin = local(slot);
    const p0 = project(origin);
    const r = mat.routes[slot.role];
    if (a?.type === 'route' && r) {
      const path = routePath(r, origin, 0, 0, 1);
      let prev = p0;
      for (let i = 0; i < path.length; i++) {
        const q = project(path[i] as Vec2);
        if (i === path.length - 1) chalkArrow(ctx, prev.x, prev.y, q.x, q.y, route, 2 + s);
        else chalkLine(ctx, prev.x, prev.y, q.x, q.y, route);
        prev = q;
      }
    } else if (a?.type === 'runBlock' || a?.type === 'passBlock' || a?.type === 'leadBlock') {
      const gapX = a.gap ? GAP_X[a.gap] : 0;
      const target = a.type === 'passBlock' ? vec2(origin.x, origin.y + 0.8) : vec2(a.type === 'leadBlock' ? gapX : origin.x + (gapX - origin.x) * 0.5, 1.5);
      const q = project(target);
      chalkLine(ctx, p0.x, p0.y, q.x, q.y, chalkDim, 1);
      // Block "T": the bar stands across the blocker's path (vertical on the horizontal diagram).
      ctx.fillStyle = chalkDim;
      ctx.fillRect(Math.round(q.x), Math.round(q.y) - 2 * s, 1, 4 * s + 1);
    }
    if (a?.type === 'carry' || slot.role === carrierRole) {
      const gapX = play.runGap ? GAP_X[play.runGap] : 0;
      const outside = play.concept === 'outsideRun';
      const mid = project(vec2(outside ? gapX * 1.6 : gapX, 0.5));
      const end = project(vec2(outside ? gapX * 2 : gapX * 0.6, 7));
      chalkLine(ctx, p0.x, p0.y, mid.x, mid.y, c.warning, 3);
      chalkArrow(ctx, mid.x, mid.y, end.x, end.y, c.warning, 3 + s, 3);
    }
    if (a?.type === 'qb' && (play.fakeTo || play.type === 'playAction' || play.type === 'rpo')) {
      const fake = mat.formation.slots.find((x) => x.role === (play.fakeTo ?? play.ballCarrier));
      if (fake) {
        const q = project(local(fake));
        pixelDashedLine(ctx, p0.x, p0.y, q.x, q.y, c.warning, 2, 2, 1);
      }
    }
  }
  for (const slot of mat.formation.slots) {
    const p = project(local(slot));
    const a = mat.play.assignments[slot.role];
    const color = opts.highlightRole === slot.role ? c.accent : slot.role === play.primary && a?.type === 'route' ? c.success : unit;
    dot(ctx, p, color, a?.type === 'qb' || a?.type === 'kicker' || a?.type === 'holder' ? 'ring' : isLineman(slot) || a?.type === 'longSnapper' ? 'square' : 'disc', s);
  }
  return true;
};

const zoneBlob = (ctx: FillCtx, project: (l: Vec2) => Vec2, box: PlayArtBox, a: DefAssignment, color: string, s: number): void => {
  if (!a.zone) return;
  const lm = zoneLandmark(a.zone, 0, 1);
  const lx = lm.center.x - MIDDLE_X;
  const ly = lm.center.y;
  const halfDepth = (lm.depthMax - lm.depthMin) / 2;
  const centre = project(vec2(lx, ly));
  const w = project(vec2(lx + lm.halfWidth, ly));
  const h = project(vec2(lx, ly + halfDepth));
  // Width runs across the field (screen y), depth along it (screen x).
  const rx = Math.max(2, Math.abs(w.x - centre.x), Math.abs(h.x - centre.x));
  const ry = Math.max(2, Math.abs(w.y - centre.y), Math.abs(h.y - centre.y));
  clippedEllipse(ctx, box, centre.x, centre.y, rx, ry, color);
  // The landmark pip, kept on the board.
  const px = Math.max(box.x + 2, Math.min(box.x + box.w - 3, Math.round(centre.x)));
  const py = Math.max(box.y + 2, Math.min(box.y + box.h - 3, Math.round(centre.y)));
  ctx.fillStyle = color;
  ctx.fillRect(px - s, py - s, 2 * s + 1, 2 * s + 1);
};

/** Defensive play diagram (coverage shells, man ties, rush lanes). */
export const drawDefensiveArt = (ctx: FillCtx, play: DefensivePlay, registry: PlaybookRegistry, box: PlayArtBox, options: PlayArtOptions): boolean => {
  // Deeper board than the offense's so the deep thirds / halves fit.
  const opts: PlayArtOptions = { yardsDeep: DEFENSE_YARDS_DEEP, yardsBack: DEFENSE_YARDS_BACK, ...options };
  drawArtField(ctx, box, opts);
  const formation = registry.defensiveFormations[play.formation];
  const c = opts.theme.colors;
  const unit = opts.unitColor ?? UI_SLAB.chalk;
  const zoneColor = opts.routeColor ?? c.accent2;
  const chalkDim = mix(UI_SLAB.chalk, UI_SLAB.chalkboard, 0.45);
  const project = artProjector(box, opts);
  const s = markScale(opts.theme, box);
  if (!formation) {
    dot(ctx, project(vec2(0, 5)), c.textDim, 'ring', s);
    return false;
  }
  const mat = materializeDefensivePlay(play, formation);
  for (const slot of mat.formation.slots) {
    const a = mat.play.assignments[slot.role];
    if (!a) continue;
    const p0 = project(vec2(slot.x, slot.y));
    switch (a.type) {
      case 'zone': zoneBlob(ctx, artProjectorRaw(box, opts), box, a, zoneColor, s); break;
      case 'manCover': {
        const q = project(vec2(slot.x, -1.5));
        pixelDashedLine(ctx, p0.x, p0.y, q.x, q.y, c.warning, 2, 2, 1);
        break;
      }
      case 'blitz':
      case 'rushGap': {
        const gapX = a.gap ? GAP_X[a.gap] : slot.x;
        const q = project(vec2(gapX, -2));
        chalkArrow(ctx, p0.x, p0.y, q.x, q.y, a.type === 'blitz' ? c.danger : chalkDim, 2 + s, a.type === 'blitz' ? 3 : 2);
        break;
      }
      case 'contain': {
        const q = project(vec2(slot.x + Math.sign(slot.x || 1) * 3, -1));
        chalkArrow(ctx, p0.x, p0.y, q.x, q.y, chalkDim, 2 + s);
        break;
      }
      case 'spy': {
        const q = project(vec2(0, -2));
        pixelDashedLine(ctx, p0.x, p0.y, q.x, q.y, c.success, 1, 2, 1);
        break;
      }
      case 'runFill': {
        const gapX = a.gap ? GAP_X[a.gap] : slot.x;
        const q = project(vec2(gapX, 0.5));
        chalkLine(ctx, p0.x, p0.y, q.x, q.y, chalkDim, 1);
        break;
      }
      default: break;
    }
  }
  for (const slot of mat.formation.slots) {
    const p = project(vec2(slot.x, slot.y));
    const a = mat.play.assignments[slot.role];
    const color = opts.highlightRole === slot.role ? c.accent : a?.type === 'blitz' ? c.danger : unit;
    dot(ctx, p, color, a?.type === 'returner' ? 'ring' : 'x', s);
  }
  return true;
};

/** Draws either kind of play. */
export const drawPlayArt = (ctx: FillCtx, play: OffensivePlay | DefensivePlay, registry: PlaybookRegistry, box: PlayArtBox, opts: PlayArtOptions): boolean =>
  'coverage' in play ? drawDefensiveArt(ctx, play, registry, box, opts) : drawOffensiveArt(ctx, play, registry, box, opts);

/** Coverage / blitz description line for the play-call screen. */
export const describeDefense = (play: DefensivePlay): string => {
  const cov = play.coverage.replace('cover', 'COVER ');
  const blitz = play.blitz === 'none' ? '' : ` · ${play.blitz.replace(/([A-Z])/g, ' $1').toUpperCase()} BLITZ`;
  return `${cov} · ${play.family.toUpperCase()}${blitz}`;
};

/** Type / concept description line for offensive plays. */
export const describeOffense = (play: OffensivePlay): string => {
  const kind = play.type.replace(/([A-Z])/g, ' $1').toUpperCase();
  const concept = play.concept.replace(/([A-Z])/g, ' $1').toUpperCase();
  return kind === concept ? kind : `${kind} · ${concept}`;
};
