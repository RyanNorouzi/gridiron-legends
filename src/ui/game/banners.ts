/**
 * Event banners: the pure mapping from controller events / play summaries to banner specs (and to the audio
 * manager's controller events), a timed queue the Game screen owns, and the drawing routine (a slab band with the
 * headline in the DISPLAY face and a sub-line tab, slamming in unless motion is reduced; sizes come from the theme).
 */
import type { AudioGameEvent } from '@/audio/index';
import type { GameEvent } from '@/game/game-controller';
import type { ReviewKind } from '@/game/play-events';
import type { GameSetup, TeamSide } from '@/game/types';
import { UI_SLAB, darken, lighten, textColorOn } from '../render/palette';
import { drawText, measureText, type FillCtx } from '../render/text';
import { measureDisplay, drawDisplayText } from '../widgets/text-display';
import { drawDiagonalStripes, drawTab, fillAlpha, type ArtCtx } from '../widgets/ui-art';
import type { Theme } from '../theme';
import { foulName } from './session-flow';
import type { PostPlaySummary } from './session-types';

export type BannerTone = 'good' | 'bad' | 'neutral' | 'flag';

export interface BannerSpec {
  text: string;
  sub: string | null;
  tone: BannerTone;
}

export interface Banner extends BannerSpec {
  /** Seconds left on screen. */
  remaining: number;
  total: number;
}

/** The ruling under review, in banner words. */
export const REVIEW_WORDS: Readonly<Record<ReviewKind, string>> = Object.freeze({
  catch: 'CATCH', fumble: 'FUMBLE', touchdown: 'TOUCHDOWN', firstDown: 'FIRST DOWN', spot: 'SPOT',
});

/**
 * The timeout confirmation as one line ("TIMEOUT · ATL · 2 LEFT"), for screens that cover the banner (the play call
 * shows it as a toast above itself).
 */
export const timeoutNotice = (setup: GameSetup, side: TeamSide, remaining: number): string => `TIMEOUT · ${setup[side].team.abbr} · ${remaining} LEFT`;

/** Controller event -> banner (null when the event is not banner-worthy). */
export const bannerForGameEvent = (e: GameEvent, setup: GameSetup): BannerSpec | null => {
  const abbr = (side: 'home' | 'away'): string => setup[side].team.abbr;
  switch (e.type) {
    case 'score': {
      const who = abbr(e.side);
      if (e.kind === 'touchdown') return { text: 'TOUCHDOWN', sub: who, tone: 'good' };
      if (e.kind === 'fieldGoal') return { text: 'FIELD GOAL', sub: `${who} · +3`, tone: 'good' };
      if (e.kind === 'safety') return { text: 'SAFETY', sub: `${who} · +2`, tone: 'good' };
      if (e.kind === 'extraPoint') return { text: 'EXTRA POINT', sub: `${who} · GOOD`, tone: 'good' };
      if (e.kind === 'twoPoint') return { text: 'TWO-POINT CONVERSION', sub: `${who} · GOOD`, tone: 'good' };
      return { text: 'DEFENSIVE TWO POINTS', sub: who, tone: 'good' };
    }
    case 'turnover':
      if (e.kind === 'interception') return { text: 'INTERCEPTION', sub: `${abbr(e.to)} BALL`, tone: 'bad' };
      if (e.kind === 'fumble') return { text: 'FUMBLE', sub: `RECOVERED BY ${abbr(e.to)}`, tone: 'bad' };
      if (e.kind === 'onside') return { text: 'ONSIDE KICK RECOVERED', sub: `${abbr(e.to)} BALL`, tone: 'good' };
      return { text: 'TURNOVER ON DOWNS', sub: `${abbr(e.to)} BALL`, tone: 'bad' };
    case 'firstDown': return { text: 'FIRST DOWN', sub: abbr(e.side), tone: 'good' };
    case 'penaltyFlag':
      return e.accepted
        ? { text: 'FLAG', sub: `${foulName(e.penalty.foul)} · ${abbr(e.side)} · ${e.penalty.yards} YDS`, tone: 'flag' }
        : { text: 'PENALTY DECLINED', sub: foulName(e.penalty.foul), tone: 'flag' };
    case 'twoMinute': return { text: 'TWO-MINUTE WARNING', sub: null, tone: 'neutral' };
    case 'halftime': return { text: 'HALFTIME', sub: `${abbr('home')} ${e.score.home} · ${abbr('away')} ${e.score.away}`, tone: 'neutral' };
    case 'final': return { text: 'FINAL', sub: e.winner ? `${abbr(e.winner)} WIN` : 'TIE GAME', tone: 'neutral' };
    case 'challengeFlag':
      return { text: e.booth ? 'BOOTH REVIEW' : 'CHALLENGE FLAG', sub: e.booth ? `REVIEWING THE ${REVIEW_WORDS[e.call.kind]}` : `${abbr(e.side)} CHALLENGE THE ${REVIEW_WORDS[e.call.kind]}`, tone: 'flag' };
    case 'challengeResult':
      if (e.result === 'overturned') return { text: 'CALL OVERTURNED', sub: e.booth ? 'RULING REVERSED' : `${abbr(e.side)} WIN THE CHALLENGE`, tone: 'flag' };
      // An upheld coach's challenge costs a timeout (rules/challenges.ts applyChallengeAccounting).
      return { text: 'CALL STANDS', sub: e.booth ? 'RULING CONFIRMED' : `${abbr(e.side)} LOSE A TIMEOUT`, tone: 'neutral' };
    case 'timeout': return { text: 'TIMEOUT', sub: `${abbr(e.side)} · ${e.remaining} LEFT`, tone: 'neutral' };
    case 'quarterEnd': return { text: `END OF QUARTER ${e.quarter}`, sub: null, tone: 'neutral' };
    case 'overtime': return { text: 'OVERTIME', sub: e.period > 1 ? `PERIOD ${e.period}` : null, tone: 'neutral' };
    case 'injury': return { text: 'INJURY', sub: e.severity.toUpperCase(), tone: 'bad' };
    default: return null;
  }
};

/** Summary banners the controller does not emit itself (sacks, big plays, kicks). */
export const bannerForSummary = (s: PostPlaySummary): BannerSpec | null => {
  const o = s.outcome;
  if (o.touchdown || o.safety || o.turnover || o.result === 'penalty') return null;
  if (o.result === 'sack') return { text: 'SACK', sub: `${Math.round(o.yards)} YDS`, tone: 'bad' };
  if (o.result === 'fieldGoal' || o.result === 'extraPoint') return o.kickMade === false ? { text: 'NO GOOD', sub: o.result === 'fieldGoal' ? 'FIELD GOAL MISSED' : 'EXTRA POINT MISSED', tone: 'bad' } : null;
  if (o.result === 'twoPoint' && o.points === 0) return { text: 'TWO-POINT TRY FAILED', sub: null, tone: 'bad' };
  if (o.bigPlay && !o.firstDown) return { text: 'BIG PLAY', sub: `${Math.round(o.yards)} YDS`, tone: 'good' };
  return null;
};

/** Controller event -> audio manager event (play events are forwarded separately). */
export const audioEventFor = (e: GameEvent): AudioGameEvent | null => {
  switch (e.type) {
    case 'score': return { type: 'score', teamSide: e.side, points: e.points };
    case 'twoMinute': return { type: 'twoMinuteWarning' };
    case 'final': return { type: 'gameOver', winner: e.winner };
    case 'timeout': return { type: 'timeout', teamSide: e.side };
    case 'quarterEnd': return { type: 'quarterEnd' };
    case 'halftime': return { type: 'halftime' };
    case 'challengeResult': return { type: 'challenge', tick: 0, side: e.side, call: 'catch', overturned: e.result === 'overturned' };
    case 'playApplied': return { type: 'playResult', firstDown: e.entry.outcome.firstDown, turnover: e.entry.outcome.turnover, yards: e.entry.outcome.yards };
    default: return null;
  }
};

/** Seconds a banner shows by default. */
export const BANNER_SECONDS = 2.2;

/** FIFO banner queue: one banner shows at a time; the rest wait. */
export class BannerQueue {
  private readonly queue: Banner[] = [];

  get current(): Banner | null {
    return this.queue[0] ?? null;
  }

  get pending(): number {
    return this.queue.length;
  }

  push(spec: BannerSpec, seconds = BANNER_SECONDS): void {
    // Identical consecutive banners (e.g. the same flag from two events) collapse.
    const last = this.queue[this.queue.length - 1];
    if (last && last.text === spec.text && last.sub === spec.sub) return;
    this.queue.push({ ...spec, remaining: seconds, total: seconds });
  }

  update(dt: number): void {
    const b = this.queue[0];
    if (!b) return;
    b.remaining -= dt;
    if (b.remaining <= 0) this.queue.shift();
  }

  clear(): void {
    this.queue.length = 0;
  }
}

export const toneColor = (theme: Theme, tone: BannerTone): string => {
  switch (tone) {
    case 'good': return theme.colors.success;
    case 'bad': return theme.colors.danger;
    case 'flag': return theme.colors.warning;
    default: return theme.colors.accent;
  }
};

/** Frames (at 60 fps) the slam-in takes; the display size steps down k+2 -> k+1 -> k across them (capped at 3). */
export const BANNER_SLAM_FRAMES = 6;
/** Seconds the light sweep takes to cross the band after the slam. */
export const BANNER_SWEEP_SECONDS = 0.55;

/** Display text size for a banner line: 3 when it fits the screen, else 2. */
export const bannerCellSize = (ctx: ArtCtx, text: string, width: number, theme: Theme): number =>
  measureDisplay(ctx, text, 3).width + theme.pad * 6 <= width ? 3 : 2;

/**
 * Draws the active banner across the middle of the screen (broadcast slab, art bible §12.1): an ink band with
 * tone-colour diagonal stripes, lit trims and cut end caps, the headline in the DISPLAY face and the sub line on a
 * tone-colour tab. It slams in over 6 frames (pixel-quantized size steps, no smoothing), a light sweep crosses it
 * once, and it fades over its last 0.35 s; reduced motion shows it static.
 */
export const drawBanner = (ctx: FillCtx & { globalAlpha: number }, theme: Theme, banner: Banner | null, width: number, height: number): void => {
  if (!banner) return;
  const art = ctx as ArtCtx;
  const s = theme.textScale;
  const elapsed = Math.max(0, banner.total - banner.remaining);
  const frame = theme.reducedMotion ? BANNER_SLAM_FRAMES : Math.floor(elapsed * 60);
  const fade = theme.reducedMotion ? 1 : Math.min(1, banner.remaining / 0.35);
  const tone = toneColor(theme, banner.tone);
  const k = bannerCellSize(art, banner.text, width, theme);
  const kNow = frame < 2 ? k + 2 : frame < 4 ? k + 1 : k;
  const m = measureDisplay(art, banner.text, k);
  const mNow = measureDisplay(art, banner.text, kNow);
  const fullW = Math.min(width - theme.pad * 2, Math.round(m.width + theme.pad * 6));
  const grow = Math.min(1, (frame + 1) / BANNER_SLAM_FRAMES);
  const bw = Math.max(theme.pad * 4, Math.round((fullW * grow) / 8) * 8);
  const bh = Math.round(m.height + theme.pad * 2);
  const bx = Math.round((width - bw) / 2);
  const by = Math.round(height * 0.34 - bh / 2);
  const prev = ctx.globalAlpha;
  ctx.globalAlpha = prev * fade;
  // Band: hard drop shadow, ink body, tone stripes, a darker lane behind the words.
  fillAlpha(art, UI_SLAB.edge, 0.6, bx + 2, by + 2, bw, bh);
  ctx.fillStyle = theme.colors.shadow;
  ctx.fillRect(bx, by, bw, bh);
  drawDiagonalStripes(art, bx, by + 3, bw, bh - 6, tone, 0.2, 12, 5);
  fillAlpha(art, theme.colors.shadow, 0.55, Math.round((width - m.width) / 2) - theme.pad, by + 4, Math.round(m.width) + theme.pad * 2, bh - 8);
  // Trims: 2 lpx of tone with a light art row above and a dark one below, top and bottom.
  for (const ty of [by, by + bh - 3]) {
    ctx.fillStyle = tone;
    ctx.fillRect(bx, ty, bw, 3);
    ctx.fillStyle = lighten(tone, 0.4);
    ctx.fillRect(bx, ty, bw, 1);
    ctx.fillStyle = darken(tone, 0.45);
    ctx.fillRect(bx, ty + 2, bw, 1);
  }
  // Cut end caps.
  drawTab(art, bx - 4, by, 6, bh, tone, { cut: 0, cutLeft: 4 });
  drawTab(art, bx + bw - 2, by, 6, bh, tone, { cut: 4 });
  // Light sweep once after the slam.
  const sweepT = (elapsed - BANNER_SLAM_FRAMES / 60) / BANNER_SWEEP_SECONDS;
  if (!theme.reducedMotion && sweepT > 0 && sweepT < 1) {
    const rows = Math.round(bh);
    const sx = bx - bh + sweepT * (bw + bh * 2);
    const p2 = ctx.globalAlpha;
    ctx.globalAlpha = p2 * 0.22;
    ctx.fillStyle = '#ffffff';
    for (let r = 0; r < rows; r++) {
      const x0 = Math.max(bx, Math.round(sx + (rows - r) * 0.5));
      const x1 = Math.min(bx + bw, x0 + 10);
      if (x1 > x0) ctx.fillRect(x0, by + r, x1 - x0, 1);
    }
    ctx.globalAlpha = p2;
  }
  drawDisplayText(art, banner.text, width / 2, Math.round(by + (bh - mNow.height) / 2), { k: kNow, align: 'center', color: theme.colors.text });
  if (banner.sub) {
    const sm = measureText(banner.sub, s);
    const tw = sm.width + theme.pad * 2;
    const th = sm.height + theme.gap + 2;
    const tx = Math.round((width - tw) / 2);
    const tyy = by + bh - 1;
    fillAlpha(art, UI_SLAB.edge, 0.6, tx + 2, tyy + 2, tw, th);
    drawTab(art, tx, tyy, tw, th, tone, { cut: theme.gap, cutLeft: theme.gap });
    drawText(ctx, banner.sub, width / 2, tyy + Math.round((th - sm.height) / 2), { size: s, align: 'center', color: textColorOn(tone) });
  }
  ctx.globalAlpha = prev;
};
