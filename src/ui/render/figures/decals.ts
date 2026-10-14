/**
 * Helmet side decals (art bible §5): eight original micro-glyphs (5 x 4 art px) — bolt, star, horn, wing, chevron,
 * ring, diamond, claw — painted on the helmet's side in the stripe colour with a highlight on the top row, and a
 * 1-2 px dot at the small tiers. A team's glyph is a deterministic hash of its resolved colours (the kit carries no
 * logo seed yet; chain D's logo family can drive it later through `decalFor`). No real team marks.
 */
import type { FigureKit } from '../anim';
import { hashStr } from '../world-layer';

/** Glyph rows, 5 bits each (bit 4 = the column toward the facemask). */
export const DECALS: readonly (readonly number[])[] = Object.freeze([
  [0b00110, 0b01100, 0b00110, 0b01100], // bolt
  [0b00100, 0b11111, 0b01110, 0b01010], // star
  [0b10001, 0b10001, 0b01110, 0b00100], // horn
  [0b11100, 0b01111, 0b00111, 0b00010], // wing
  [0b10001, 0b11011, 0b01110, 0b00100], // chevron
  [0b01110, 0b10001, 0b10001, 0b01110], // ring
  [0b00100, 0b01110, 0b01110, 0b00100], // diamond
  [0b10101, 0b10101, 0b01110, 0b00100], // claw
]);

/** Decal names, in DECALS order. */
export const DECAL_NAMES: readonly string[] = ['bolt', 'star', 'horn', 'wing', 'chevron', 'ring', 'diamond', 'claw'];

/** The decal index of a kit's team (same for its home and away kits). */
export const decalFor = (kit: FigureKit): number => {
  const p = kit.palette;
  return hashStr(`${p.primary}|${p.helmet}|${p.secondary}`) % DECALS.length;
};
