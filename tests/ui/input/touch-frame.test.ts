import { afterEach, describe, expect, it } from 'vitest';
import { createTouchSource } from '@/ui/input/touch';
import { TOUCH_GLYPHS } from '@/ui/input/glyphs';
import {
  beginTouchFrame, endTouchFrame, markTouchOverlay, resetTouchFrame, touchGlyphButton, touchHintAt, touchOverlayShown,
} from '@/ui/input/touch-frame';
import { hasGlyph } from '@/ui/render/text';
import { createTheme } from '@/ui/theme';
import { drawHintBar } from '@/ui/widgets/panel';
import { createFakeCtx } from '../render/fake-ctx';

const identity = (x: number, y: number) => ({ x, y });

describe('touch controls follow what is drawn (APP2-02)', () => {
  afterEach(() => resetTouchFrame());

  it('with the gamepad hidden, a tap on the hidden A zone is a plain pointer tap (IMPORT on Load Franchise)', () => {
    const src = createTouchSource(identity, { controlsVisible: touchOverlayShown, hintAt: touchHintAt });
    beginTouchFrame();
    endTouchFrame();
    src.touchStart(1, 446, 242);
    const down = src.poll();
    expect(down.buttons.size).toBe(0);
    expect(down.pointer).toMatchObject({ x: 446, y: 242, down: true, justDown: true });
    src.touchEnd(1, 446, 242);
    expect(src.poll().pointer?.justUp).toBe(true);
    // The team logo top-left is no longer a hidden BACK button.
    src.touchStart(2, 16, 12);
    expect(src.poll().buttons.has('select')).toBe(false);
    src.touchEnd(2, 16, 12);
  });

  it('left-half touches do not grab a stick while the gamepad is hidden (they drag as a pointer)', () => {
    const src = createTouchSource(identity, { controlsVisible: () => false });
    src.touchStart(1, 100, 150);
    src.touchMove(1, 100, 120);
    const s = src.poll();
    expect(s.axis).toEqual({ x: 0, y: 0 });
    expect(s.pointer).toMatchObject({ x: 100, y: 120, down: true });
  });

  it('the zones are live again once a frame draws the overlay', () => {
    const src = createTouchSource(identity, { controlsVisible: touchOverlayShown, hintAt: touchHintAt });
    beginTouchFrame();
    markTouchOverlay();
    endTouchFrame();
    expect(touchOverlayShown()).toBe(true);
    const a = src.layout().buttons.find((b) => b.button === 'a');
    src.touchStart(1, a?.x ?? 0, a?.y ?? 0);
    expect(src.poll().buttons.has('a')).toBe(true);
  });

  it('a tap on a drawn TAP B hint badge presses B', () => {
    const theme = createTheme({ textSize: 'normal', reducedMotion: false, colorblind: 'none' });
    const ctx = createFakeCtx();
    beginTouchFrame();
    drawHintBar(ctx, theme, [{ glyph: TOUCH_GLYPHS.b, label: 'BACK' }, { glyph: 'Stick ↑', label: 'MOVE' }], 480, 258);
    endTouchFrame();
    const src = createTouchSource(identity, { controlsVisible: touchOverlayShown, hintAt: touchHintAt });
    const hit = [...Array(480).keys()].find((x) => touchHintAt(x, 262) !== null);
    expect(hit).toBeDefined();
    src.touchStart(1, hit ?? 0, 262);
    expect(src.poll().buttons.has('b')).toBe(true);
    expect(touchGlyphButton('Stick ↑')).toBeNull();
    expect(touchGlyphButton('TAP A')).toBe('a');
  });

  it('every touch glyph is drawable in the pixel font (APP2-14)', () => {
    for (const g of Object.values(TOUCH_GLYPHS)) for (const ch of g) expect(hasGlyph(ch), `${g} / ${ch}`).toBe(true);
  });
});
