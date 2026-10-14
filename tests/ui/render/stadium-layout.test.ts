import { describe, expect, it, vi } from 'vitest';
import { vec2 } from '@/core/vec2';
import { FIELD_LENGTH, MIDDLE_X } from '@/game/types';
import { defaultSettings } from '@/save/settings-store';
import { Camera } from '@/ui/camera';
import { drawStadium, stadiumViewFor } from '@/ui/render/stadium';
import { PlayCallScreen } from '@/ui/screens/playcall';
import { createTheme } from '@/ui/theme';
import { MenuList } from '@/ui/widgets/menu';
import { autoplay, makeSession, makeUi } from '../game/fixtures';
import { createFakeCtx } from './fake-ctx';

const view = { name: 'Harbor Point', roof: 'open' as const, attendancePct: 0.9, homeColor: '#aa2222', awayColor: '#2222aa' };

describe('pixel stadium', () => {
  it('draws stands and a crowd around the field, as full as the attendance', () => {
    const cam = new Camera(480, 270);
    cam.setMode('simulation', { userSide: null, offense: 'home', direction: 1, ballPos: vec2(MIDDLE_X, 60), controlledPos: null });
    cam.snap();
    const full = drawStadium(createFakeCtx(), cam, view, { time: 0, animations: true });
    const empty = drawStadium(createFakeCtx(), cam, { ...view, attendancePct: 0.1 }, { time: 0, animations: true });
    expect(full).toBeGreaterThan(200);
    expect(empty).toBeLessThan(full / 3);
    // Horizontal field: the name banners hang on the stand above the field, in view in the whole-field shot...
    const ctx = createFakeCtx();
    drawStadium(ctx, cam, view, { time: 0, animations: false });
    const banners = ctx.fillsWith('#1b1d24');
    expect(banners.length).toBeGreaterThan(0);
    for (const b of banners) expect(b.y + b.h).toBeLessThan(cam.worldToScreen(vec2(0, 60)).y);
    // ...and the crowd sits above / below the field (sideline stands) and left / right of it (end-line stands).
    const top = cam.worldToScreen(vec2(0, 60)).y;
    const bottom = cam.worldToScreen(vec2(53.33, 60)).y;
    const crowd = createFakeCtx();
    drawStadium(crowd, cam, view, { time: 0, animations: false });
    const home = crowd.fillsWith(view.homeColor);
    expect(home.some((f) => f.y < top)).toBe(true);
    expect(home.some((f) => f.y > bottom)).toBe(true);
    expect(home.some((f) => f.x < cam.worldToScreen(vec2(MIDDLE_X, 0)).x)).toBe(true);
    cam.setMode('standard', { userSide: null, offense: 'home', direction: 1, ballPos: vec2(MIDDLE_X, FIELD_LENGTH - 6), controlledPos: null });
    cam.snap();
    // Animations off (Settings.animations): the crowd does not move with the clock.
    const at = (time: number, animations: boolean) => {
      const c = createFakeCtx();
      drawStadium(c, cam, view, { time, animations });
      return JSON.stringify(c.fills);
    };
    expect(at(0, false)).toBe(at(5.3, false));
    expect(at(0, true)).not.toBe(at(5.3, true));
  });

  it('never draws a name banner cut off by the top or bottom edge of the screen', () => {
    const cam = new Camera(480, 270);
    for (const direction of [1, -1] as const) {
      // Kick framing shows only a sliver of the top stand: a banner there would be sliced through its lettering.
      cam.setMode('kick', { userSide: null, offense: 'home', direction, ballPos: vec2(MIDDLE_X, 60 - direction * 25), controlledPos: null, losY: 60 - direction * 25 });
      cam.snap();
      for (const x of [-8, -5, -4.3, -3, 0]) {
        cam.target.x = MIDDLE_X + x * (direction === 1 ? 1 : -1);
        const ctx = createFakeCtx();
        drawStadium(ctx, cam, view, { time: 0, animations: false });
        for (const b of ctx.fillsWith('#1b1d24')) {
          expect(b.y).toBeGreaterThanOrEqual(0);
          expect(b.y + b.h).toBeLessThanOrEqual(cam.height);
        }
      }
    }
  });

  it('comes from the game setup (name, roof, crowd colours)', () => {
    const f = makeSession({ setup: { seed: 3 } });
    const v = stadiumViewFor(f.setup, { home: { primary: '#123456' }, away: { primary: '#654321' } } as never);
    expect(v.name).toBe(f.setup.stadium.name);
    expect(v.homeColor).toBe('#123456');
  });
});

describe('large text layout', () => {
  it('the play-call list shows only the rows that fit inside its panel', () => {
    const ui = makeUi({ textSize: 'large' });
    const f = makeSession({ setup: { controllers: { home: 'human', away: 'ai' }, userSide: 'home', seed: 7 } });
    autoplay(f.session, { until: (s) => s.stage.kind === 'playcall', coinToss: 'receive' });
    const stage = f.session.stage;
    if (stage.kind !== 'playcall') throw new Error('expected playcall');
    const screen = new PlayCallScreen(stage.request, f.session.registry, { onCall: vi.fn() });
    ui.stack.push(screen);
    screen.render({ ...ui.rc, theme: createTheme({ ...defaultSettings(), textSize: 'large' }) });
    expect(screen.list.maxVisible).toBeGreaterThan(0);
    expect(screen.list.maxVisible).toBeLessThan(6);
  });

  it('a scrolling list keeps its scroll marks clear of the value arrows', () => {
    const theme = createTheme(defaultSettings());
    const items = Array.from({ length: 10 }, (_, i) => ({ id: `r${i}`, label: `ROW ${i}`, value: 'ON' }));
    const list = new MenuList(items, { maxVisible: 4 });
    list.select(2);
    const ctx = createFakeCtx();
    const w = 200;
    list.draw(ctx, theme, 0, 0, w);
    // Rows (and so the right-aligned values) end before the gutter where ▲ / ▼ are drawn.
    expect(list.hitTest(w - 2, 2)).toBe(-1);
    expect(list.hitTest(w - 20, 2)).toBeGreaterThanOrEqual(0);
  });
});
