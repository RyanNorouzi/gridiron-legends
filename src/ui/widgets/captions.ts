/**
 * Caption track (accessibility): the last few captioned sound cues ("[WHISTLE]", "[CROWD ROARS]") shown in a
 * dark box over every screen for a couple of seconds. The app feeds it from AudioManager.onCaption when the
 * captions preference is on. Identical consecutive captions merge into one line with a count.
 */
import { drawText, measureText, type FillCtx } from '../render/text';
import { drawSlab, type ArtCtx } from './ui-art';
import type { Theme } from '../theme';

/** Seconds a caption stays on screen. */
export const CAPTION_SECONDS = 2.5;
/** Most captions shown at once (older ones drop off). */
export const MAX_CAPTIONS = 3;

interface Line {
  text: string;
  count: number;
  remaining: number;
}

export class CaptionTrack {
  private readonly lines: Line[] = [];

  /** Current caption texts, oldest first. */
  get texts(): string[] {
    return this.lines.map((l) => (l.count > 1 ? `${l.text} x${l.count}` : l.text));
  }

  push(text: string): void {
    const last = this.lines[this.lines.length - 1];
    if (last && last.text === text) {
      last.count++;
      last.remaining = CAPTION_SECONDS;
      return;
    }
    this.lines.push({ text, count: 1, remaining: CAPTION_SECONDS });
    while (this.lines.length > MAX_CAPTIONS) this.lines.shift();
  }

  update(dt: number): void {
    for (const l of this.lines) l.remaining -= dt;
    while (this.lines.length > 0 && (this.lines[0]?.remaining ?? 0) <= 0) this.lines.shift();
  }

  clear(): void {
    this.lines.length = 0;
  }

  /** Draws the captions left-aligned in the lower middle of the screen (no motion: they simply appear). */
  draw(ctx: FillCtx, theme: Theme, width: number, height: number): void {
    const texts = this.texts;
    if (texts.length === 0) return;
    const size = theme.textScale;
    const lh = theme.glyphH + theme.gap * 2;
    const w = Math.min(width - theme.pad * 2, Math.max(...texts.map((t) => measureText(t, size).width)) + theme.gap * 4);
    const h = lh * texts.length + theme.gap;
    const x = theme.pad;
    const y = Math.round(height * 0.6 - h / 2);
    drawSlab(ctx as ArtCtx, x, y, w, h, { fill: theme.colors.shadow, alpha: 0.9, texture: false, outline: null });
    ctx.fillStyle = theme.colors.accent2;
    ctx.fillRect(x, y, 2, h);
    texts.forEach((t, i) => {
      drawText(ctx, t, x + theme.gap * 2, y + theme.gap + i * lh + theme.gap / 2, { color: theme.colors.text, size });
    });
  }
}
