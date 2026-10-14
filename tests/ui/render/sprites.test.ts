import { describe, expect, it } from 'vitest';
import {
  ANIM_FRAMES, BALL_SPRITE_SIZE, SKIN_TONES, SPRITE_H, SPRITE_W, SpriteCache, animForState, drawSprite, facingFromScreenVector, frameFor,
  generateAthleteSprite, generateBallSprite, skinToneFromSeed, type AthleteSpriteParams, type PixelBuffer,
} from '@/ui/render/sprites';
import { hexToRgb } from '@/ui/render/palette';
import { createFakeCtx } from './fake-ctx';

const palette = { primary: '#1a3fb0', secondary: '#f2f2f2', accent: '#ffcc33', helmet: '#0d2260' };
const base: AthleteSpriteParams = { palette, skinTone: '#c98d63', group: 'WR', facing: 's', anim: 'idle', frame: 0, number: 84 };

const opaqueCount = (b: PixelBuffer): number => {
  let n = 0;
  for (let i = 3; i < b.data.length; i += 4) if (b.data[i] === 255) n++;
  return n;
};
const countColor = (b: PixelBuffer, hex: string): number => {
  const c = hexToRgb(hex);
  let n = 0;
  for (let i = 0; i < b.data.length; i += 4) if (b.data[i + 3] === 255 && b.data[i] === c.r && b.data[i + 1] === c.g && b.data[i + 2] === c.b) n++;
  return n;
};
const bbox = (b: PixelBuffer): { w: number; h: number } => {
  let minX = b.width;
  let maxX = -1;
  let minY = b.height;
  let maxY = -1;
  for (let y = 0; y < b.height; y++) {
    for (let x = 0; x < b.width; x++) {
      if (b.data[(y * b.width + x) * 4 + 3] !== 255) continue;
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }
  }
  return { w: maxX - minX + 1, h: maxY - minY + 1 };
};
const mirrored = (b: PixelBuffer): Uint8ClampedArray => {
  const out = new Uint8ClampedArray(b.data.length);
  for (let y = 0; y < b.height; y++) {
    for (let x = 0; x < b.width; x++) {
      const src = (y * b.width + x) * 4;
      const dst = (y * b.width + (b.width - 1 - x)) * 4;
      for (let k = 0; k < 4; k++) out[dst + k] = b.data[src + k] as number;
    }
  }
  return out;
};

describe('athlete sprites', () => {
  it('are deterministic and cached by parameters', () => {
    const cache = new SpriteCache();
    const a = generateAthleteSprite(cache, base);
    const b = generateAthleteSprite(cache, { ...base });
    expect(a).toBe(b);
    expect(cache.size).toBe(1);
    const other = generateAthleteSprite(new SpriteCache(), { ...base });
    expect(Array.from(other.data)).toEqual(Array.from(a.data));
  });

  it('fit the 16x16 buffer with binary alpha and a plausible pixel count', () => {
    const cache = new SpriteCache();
    for (const anim of Object.keys(ANIM_FRAMES) as (keyof typeof ANIM_FRAMES)[]) {
      for (const facing of ['n', 'e', 's', 'w', 'ne', 'sw'] as const) {
        for (let frame = 0; frame < ANIM_FRAMES[anim]; frame++) {
          const s = generateAthleteSprite(cache, { ...base, anim, facing, frame });
          expect(s.width).toBe(SPRITE_W);
          expect(s.height).toBe(SPRITE_H);
          for (let i = 3; i < s.data.length; i += 4) expect(s.data[i] === 0 || s.data[i] === 255).toBe(true);
          const n = opaqueCount(s);
          expect(n).toBeGreaterThan(50);
          expect(n).toBeLessThan(SPRITE_W * SPRITE_H);
        }
      }
    }
  });

  it('use every palette role: helmet, jersey, pants and skin are all present', () => {
    const s = generateAthleteSprite(new SpriteCache(), base);
    expect(countColor(s, palette.helmet)).toBeGreaterThan(3);
    expect(countColor(s, palette.primary)).toBeGreaterThan(6);
    expect(countColor(s, palette.secondary)).toBeGreaterThan(1);
    expect(countColor(s, base.skinTone)).toBeGreaterThan(0);
  });

  it('shows the jersey number front and back but not from the side', () => {
    const cache = new SpriteCache();
    const front7 = generateAthleteSprite(cache, { ...base, number: 7 });
    const front1 = generateAthleteSprite(cache, { ...base, number: 1 });
    expect(Array.from(front7.data)).not.toEqual(Array.from(front1.data));
    const back7 = generateAthleteSprite(cache, { ...base, facing: 'n', number: 7 });
    const back1 = generateAthleteSprite(cache, { ...base, facing: 'n', number: 1 });
    expect(Array.from(back7.data)).not.toEqual(Array.from(back1.data));
    const side7 = generateAthleteSprite(cache, { ...base, facing: 'e', number: 7 });
    const side1 = generateAthleteSprite(cache, { ...base, facing: 'e', number: 1 });
    expect(Array.from(side7.data)).toEqual(Array.from(side1.data));
    expect(countColor(front7, palette.accent)).toBeGreaterThan(countColor(side7, palette.accent));
  });

  it('mirrors east/west facings exactly', () => {
    const cache = new SpriteCache();
    const east = generateAthleteSprite(cache, { ...base, facing: 'e', anim: 'run', frame: 0 });
    const west = generateAthleteSprite(cache, { ...base, facing: 'w', anim: 'run', frame: 0 });
    expect(Array.from(west.data)).toEqual(Array.from(mirrored(east)));
  });

  it('animates the run cycle and wraps frames', () => {
    const cache = new SpriteCache();
    const f0 = generateAthleteSprite(cache, { ...base, anim: 'run', frame: 0 });
    const f1 = generateAthleteSprite(cache, { ...base, anim: 'run', frame: 1 });
    const f2 = generateAthleteSprite(cache, { ...base, anim: 'run', frame: 2 });
    const f4 = generateAthleteSprite(cache, { ...base, anim: 'run', frame: 4 });
    expect(Array.from(f0.data)).not.toEqual(Array.from(f1.data));
    expect(Array.from(f0.data)).not.toEqual(Array.from(f2.data));
    expect(f4).toBe(f0);
    expect(generateAthleteSprite(cache, { ...base, anim: 'run', frame: -1 })).toBe(generateAthleteSprite(cache, { ...base, anim: 'run', frame: 3 }));
    expect(cache.size).toBe(4);
    expect(frameFor('run', 0.5, 8)).toBe(0);
    expect(frameFor('run', 0.126, 8)).toBe(1);
    expect(frameFor('throw', 10)).toBe(ANIM_FRAMES.throw - 1);
  });

  it('draws downed and diving athletes wider than tall, upright ones taller than wide', () => {
    const cache = new SpriteCache();
    const down = bbox(generateAthleteSprite(cache, { ...base, anim: 'down' }));
    expect(down.w).toBeGreaterThan(down.h);
    const dive = bbox(generateAthleteSprite(cache, { ...base, anim: 'dive', facing: 'e' }));
    expect(dive.w).toBeGreaterThan(dive.h);
    const idle = bbox(generateAthleteSprite(cache, base));
    expect(idle.h).toBeGreaterThan(idle.w);
    const tackled1 = generateAthleteSprite(cache, { ...base, anim: 'tackled', frame: 1 });
    expect(Array.from(tackled1.data)).toEqual(Array.from(generateAthleteSprite(cache, { ...base, anim: 'down' }).data));
  });

  it('gives linemen broader shoulders than receivers', () => {
    const cache = new SpriteCache();
    const ol = bbox(generateAthleteSprite(cache, { ...base, group: 'OL' }));
    const wr = bbox(generateAthleteSprite(cache, { ...base, group: 'WR' }));
    expect(ol.w).toBeGreaterThan(wr.w);
  });

  it('maps poses and facings from engine state', () => {
    expect(animForState('moving')).toBe('run');
    expect(animForState('tackled')).toBe('tackled');
    expect(animForState('down')).toBe('down');
    expect(animForState('throwing')).toBe('throw');
    expect(animForState('kicking')).toBe('kick');
    expect(animForState('catching')).toBe('catch');
    expect(animForState('presnap')).toBe('idle');
    expect(facingFromScreenVector(1, 0)).toBe('e');
    expect(facingFromScreenVector(0, 1)).toBe('s');
    expect(facingFromScreenVector(0, -1)).toBe('n');
    expect(facingFromScreenVector(-1, 0)).toBe('w');
    expect(facingFromScreenVector(1, 1)).toBe('se');
    expect(facingFromScreenVector(-1, -1)).toBe('nw');
    expect(facingFromScreenVector(0, 0)).toBe('s');
  });

  it('picks deterministic skin tones from the palette', () => {
    expect(skinToneFromSeed(7)).toBe(skinToneFromSeed(7));
    expect(SKIN_TONES).toContain(skinToneFromSeed(12345));
    expect(SKIN_TONES).toContain(skinToneFromSeed(-3));
  });

  it('recycles buffers on clear and regenerates identical pixels', () => {
    const cache = new SpriteCache();
    const before = Array.from(generateAthleteSprite(cache, base).data);
    generateBallSprite(cache, { frame: 0 });
    expect(cache.size).toBe(2);
    cache.clear();
    expect(cache.size).toBe(0);
    expect(Array.from(generateAthleteSprite(cache, base).data)).toEqual(before);
  });
});

describe('ball sprite', () => {
  it('has four distinct rotation frames that wrap', () => {
    const cache = new SpriteCache();
    const frames = [0, 1, 2, 3].map((f) => generateBallSprite(cache, { frame: f }));
    for (let i = 0; i < 4; i++) for (let j = i + 1; j < 4; j++) expect(Array.from(frames[i]!.data)).not.toEqual(Array.from(frames[j]!.data));
    expect(generateBallSprite(cache, { frame: 4 })).toBe(frames[0]);
    expect(frames[0]!.width).toBe(BALL_SPRITE_SIZE);
    const flat = bbox(frames[0]!);
    const upright = bbox(frames[2]!);
    expect(flat.w).toBeGreaterThan(flat.h);
    expect(upright.h).toBeGreaterThan(upright.w);
    expect(countColor(frames[0]!, '#8c4e26')).toBeGreaterThan(0);
    expect(countColor(frames[0]!, '#f4f4ee')).toBeGreaterThan(0);
  });
});

describe('drawSprite without a DOM', () => {
  it('falls back to fill runs covering exactly the opaque pixels, anchored at the feet', () => {
    const cache = new SpriteCache();
    const s = generateAthleteSprite(cache, base);
    const ctx = createFakeCtx();
    drawSprite(ctx, s, 100, 200);
    const area = ctx.fills.reduce((a, f) => a + f.w * f.h, 0);
    expect(area).toBe(opaqueCount(s));
    for (const f of ctx.fills) {
      expect(f.x).toBeGreaterThanOrEqual(100 - s.anchorX);
      expect(f.x + f.w).toBeLessThanOrEqual(100 - s.anchorX + SPRITE_W);
      expect(f.y).toBeGreaterThanOrEqual(200 - s.anchorY);
      expect(f.y + f.h).toBeLessThanOrEqual(200 - s.anchorY + SPRITE_H);
    }
    expect(Math.max(...ctx.fills.map((f) => f.y + f.h))).toBe(201);
  });
  it('scales and flips', () => {
    const cache = new SpriteCache();
    const s = generateBallSprite(cache, { frame: 1 });
    const ctx = createFakeCtx();
    drawSprite(ctx, s, 50, 50, { scale: 2 });
    expect(ctx.fills.every((f) => f.h === 2)).toBe(true);
    const plain = createFakeCtx();
    const flipped = createFakeCtx();
    drawSprite(plain, s, 50, 50);
    drawSprite(flipped, s, 50, 50, { flipX: true });
    const xs = new Set(plain.fills.map((f) => f.x - (50 - s.anchorX)));
    const fx = new Set(flipped.fills.map((f) => s.width - (f.x - (50 - s.anchorX) + f.w)));
    expect(fx).toEqual(xs);
  });
});
