/** Rendering barrel: pixel canvas, palette, procedural sprites/logos, field drawing and the pixel font. */
export { createPixelCanvas, integerScaleFor, type PixelCanvas, type PixelCanvasOptions, type SurfaceLike } from './canvas';
export {
  CONFUSABLE_DE, UI_COLORS, colorDistance, colorblindSafe, contrastRatio, darken, distinctSet, fieldGreens, hexToLab, hexToRgb,
  hslToRgb, isConfusable, lighten, mix, relativeLuminance, resolveTeamPalettes, rgbToHex, rgbToHsl, rotateHue, simulateColorblind,
  textColorOn, type FieldGreens, type Hsl, type ResolvedPalettes, type Rgb,
} from './palette';
export {
  ANIM_FRAMES, BALL_SPRITE_SIZE, FACINGS, SKIN_TONES, SPRITE_H, SPRITE_W, SpriteCache, animForState, athleteSpriteKey, drawSprite,
  ensureSpriteImage, facingFromScreenVector, frameFor, generateAthleteSprite, generateBallSprite, skinToneFromSeed,
  type AthleteSpriteParams, type BallSpriteParams, type DrawSpriteOptions, type Facing8, type PixelBuffer, type Sprite, type SpriteAnim,
  type SpriteCtx,
} from './sprites';
export { GOAL_POST_COLOR, drawField, drawWeatherOverlay, hash01, worldRect, type FieldCtx, type FieldDrawOptions } from './field';
export {
  GLYPH_GAP, GLYPH_H, GLYPH_W, drawText, drawTextLines, glyphRows, hasGlyph, measureText, microDigitRows, wrapText,
  type DrawTextOptions, type FillCtx, type TextAlign, type TextMetrics, type TextSizeScale,
} from './text';
export {
  LOGO_MOTIFS, LOGO_SHAPES, clearLogoCache, drawTeamLogo, generateLogo, logoDesign, teamLogo, type LogoDesign, type LogoMotif, type LogoShape,
} from './logo';
