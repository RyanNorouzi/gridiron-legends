/**
 * UI theme: colours, spacing and text scaling derived from Settings. Every screen lays itself out relative to
 * `theme.lineHeight` / `theme.pad` (which scale with large-text mode) rather than absolute pixel numbers, and
 * status colours are remapped for the active colorblind mode so success/danger/warning stay distinguishable.
 */
import type { ColorblindMode, Settings } from '@/core/settings';
import { colorblindSafe, distinctSet, UI_COLORS } from './render/palette';
import { GLYPH_H, type TextSizeScale } from './render/text';

export interface ThemeColors {
  bg: string;
  bgAlt: string;
  panel: string;
  panelLight: string;
  panelBorder: string;
  text: string;
  textDim: string;
  textInverse: string;
  accent: string;
  accent2: string;
  danger: string;
  success: string;
  warning: string;
  selection: string;
  shadow: string;
  overlay: string;
  los: string;
  firstDown: string;
}

export interface Theme {
  /** 1 = normal, 2 = large-text accessibility mode. */
  textScale: TextSizeScale;
  /** Height of one glyph row at the current scale. */
  glyphH: number;
  /** Vertical rhythm for lists and labels at the current scale. */
  lineHeight: number;
  /** Outer padding for panels and screens. */
  pad: number;
  /** Gap between sibling widgets. */
  gap: number;
  /** Border thickness of panels in pixels. */
  border: number;
  reducedMotion: boolean;
  colorblind: ColorblindMode;
  colors: ThemeColors;
}

/** Text scale for the configured text size. */
export const textScaleFor = (textSize: Settings['textSize']): TextSizeScale => (textSize === 'large' ? 2 : 1);

/** Colours for a colorblind mode: status colours snap onto a safe hue axis and are then forced apart. */
export const themeColorsFor = (mode: ColorblindMode): ThemeColors => {
  const base: ThemeColors = { ...UI_COLORS };
  if (mode === 'none') return base;
  const [success, danger, warning] = distinctSet(
    [colorblindSafe(base.success, mode), colorblindSafe(base.danger, mode), colorblindSafe(base.warning, mode)],
    mode,
  ) as [string, string, string];
  return { ...base, success, danger, warning, accent2: colorblindSafe(base.accent2, mode) };
};

/** Builds the theme for the given settings (only the accessibility fields are read). */
export const createTheme = (settings: Pick<Settings, 'textSize' | 'reducedMotion' | 'colorblind'>): Theme => {
  const textScale = textScaleFor(settings.textSize);
  return {
    textScale,
    glyphH: GLYPH_H * textScale,
    lineHeight: (GLYPH_H + 4) * textScale,
    pad: 8 * textScale,
    gap: 4 * textScale,
    border: 2,
    reducedMotion: settings.reducedMotion,
    colorblind: settings.colorblind,
    colors: themeColorsFor(settings.colorblind),
  };
};
