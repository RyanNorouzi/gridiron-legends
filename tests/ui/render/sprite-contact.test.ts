import { describe, expect, it } from 'vitest';
import type { ColorblindMode } from '@/core/settings';
import { resolveTeamPalettes, teamUniforms } from '@/ui/render/palette';
import {
  ANIM_FRAMES, FACINGS, SpriteCache, animForState, frameFor, generateAthleteSprite, type AthleteSpriteParams, type PixelBuffer, type SpriteAnim,
} from '@/ui/render/sprites';

const palette = { primary: '#1a3fb0', secondary: '#f2f2f2', accent: '#ffcc33', helmet: '#0d2260' };
const base: AthleteSpriteParams = { palette, skinTone: '#c98d63', group: 'RB', facing: 'e', anim: 'idle', frame: 0, number: 28 };

const pixels = (b: PixelBuffer): number[] => Array.from(b.data);
const opaque = (b: PixelBuffer): number => {
  let n = 0;
  for (let i = 3; i < b.data.length; i += 4) if (b.data[i] === 255) n++;
  return n;
};
/** Mean opaque row (higher = lower on the sprite) and the right-most opaque column. */
const shape = (b: PixelBuffer): { meanY: number; maxX: number; topY: number } => {
  let sy = 0;
  let n = 0;
  let maxX = -1;
  let topY = b.height;
  for (let y = 0; y < b.height; y++) {
    for (let x = 0; x < b.width; x++) {
      if (b.data[(y * b.width + x) * 4 + 3] !== 255) continue;
      sy += y;
      n++;
      maxX = Math.max(maxX, x);
      topY = Math.min(topY, y);
    }
  }
  return { meanY: sy / Math.max(1, n), maxX, topY };
};

describe('tackle-struggle sprites', () => {
  it('maps the struggle states to their own poses and keeps tackled / down', () => {
    expect(animForState('wrapped')).toBe('wrapped');
    expect(animForState('wrapping')).toBe('wrapping');
    expect(animForState('falling')).toBe('falling');
    expect(animForState('tackled')).toBe('tackled');
    expect(animForState('down')).toBe('down');
    expect(ANIM_FRAMES.wrapped).toBe(4);
  });

  it('loops the churning legs and the driving tackler, plays the fall once', () => {
    expect(frameFor('wrapped', 0.5, 8)).toBe(0);
    expect(frameFor('wrapped', 0.26, 8)).toBe(2);
    expect(frameFor('wrapping', 0.13, 8)).toBe(1);
    expect(frameFor('wrapping', 0.26, 8)).toBe(0);
    expect(frameFor('falling', 5)).toBe(ANIM_FRAMES.falling - 1);
  });

  it('every struggle pose is distinct from idle, run, tackled and down in every facing', () => {
    const cache = new SpriteCache();
    const others: SpriteAnim[] = ['idle', 'run', 'tackled', 'down'];
    for (const facing of FACINGS) {
      for (const anim of ['wrapped', 'wrapping', 'falling'] as const) {
        for (let frame = 0; frame < ANIM_FRAMES[anim]; frame++) {
          const s = generateAthleteSprite(cache, { ...base, facing, anim, frame });
          expect(opaque(s), `${anim}/${facing}/${frame}`).toBeGreaterThan(50);
          for (const o of others) {
            for (let of = 0; of < ANIM_FRAMES[o]; of++) expect(pixels(s)).not.toEqual(pixels(generateAthleteSprite(cache, { ...base, facing, anim: o, frame: of })));
          }
        }
      }
    }
  });

  it('churning legs change from frame to frame', () => {
    const cache = new SpriteCache();
    const frames = [0, 1, 2, 3].map((frame) => pixels(generateAthleteSprite(cache, { ...base, anim: 'wrapped', frame })));
    expect(new Set(frames.map((f) => f.join(','))).size).toBe(4);
  });

  it('the tackler is low with his arms out in front, the carrier leans into the hit', () => {
    const cache = new SpriteCache();
    const idle = shape(generateAthleteSprite(cache, base));
    const wrapping = shape(generateAthleteSprite(cache, { ...base, anim: 'wrapping' }));
    const wrapped = shape(generateAthleteSprite(cache, { ...base, anim: 'wrapped' }));
    expect(wrapping.topY).toBeGreaterThan(idle.topY);
    expect(wrapping.maxX).toBeGreaterThan(idle.maxX);
    expect(wrapped.maxX).toBeGreaterThan(idle.maxX);
  });

  it('a falling body tips over and sinks, more on the second frame', () => {
    const cache = new SpriteCache();
    const idle = shape(generateAthleteSprite(cache, base));
    const f0 = shape(generateAthleteSprite(cache, { ...base, anim: 'falling', frame: 0 }));
    const f1 = shape(generateAthleteSprite(cache, { ...base, anim: 'falling', frame: 1 }));
    expect(f0.meanY).toBeGreaterThan(idle.meanY);
    expect(f1.meanY).toBeGreaterThan(f0.meanY);
    expect(f1.topY).toBeGreaterThan(f0.topY);
    // Seen from the side the body tips toward the way he faces (mirrored for west).
    const west = shape(generateAthleteSprite(cache, { ...base, anim: 'falling', frame: 1, facing: 'w' }));
    expect(west.maxX).toBeLessThan(f1.maxX);
  });

  it('paints both teams in every colour-blind mode with distinguishable jerseys', () => {
    const home = { primary: '#c02020', secondary: '#f0f0f0', accent: '#ffffff', helmet: '#c02020' };
    const away = { primary: '#20a040', secondary: '#e0e0e0', accent: '#ffff00', helmet: '#20a040' };
    for (const mode of ['none', 'protanopia', 'deuteranopia', 'tritanopia'] as ColorblindMode[]) {
      const u = teamUniforms(resolveTeamPalettes(home, away, mode));
      const cache = new SpriteCache();
      for (const anim of ['wrapped', 'wrapping', 'falling'] as const) {
        const h = generateAthleteSprite(cache, { ...base, palette: u.home, anim });
        const a = generateAthleteSprite(cache, { ...base, palette: u.away, anim });
        expect(opaque(h)).toBeGreaterThan(50);
        expect(pixels(h), `${mode}/${anim}`).not.toEqual(pixels(a));
      }
    }
  });
});
