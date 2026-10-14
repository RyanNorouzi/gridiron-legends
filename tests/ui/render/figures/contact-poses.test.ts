import { describe, expect, it } from 'vitest';
import { LINE_ANIM_IDS, TACKLE_ANIM_IDS, type AnimId } from '@/ui/render/anim-ids';
import { clipTiming, makeKit, painterFor, type FrameRequest } from '@/ui/render/anim';
import { LINE_POSES } from '@/ui/render/figures/anims-line';
import { TACKLE_POSES } from '@/ui/render/figures/anims-tackle';
import { armTo, legTo } from '@/ui/render/figures/contact-poses';
import { posesOwner } from '@/ui/render/figures/anims';
import '@/ui/render/figures/install';
import '@/ui/render/figures/contact-install';

const POSES = { ...LINE_POSES, ...TACKLE_POSES } as Record<AnimId, readonly unknown[]>;
const CLIPS: AnimId[] = [...LINE_ANIM_IDS, ...TACKLE_ANIM_IDS];
const pal = { primary: '#b3202e', secondary: '#1d1d24', accent: '#f2b705', helmet: '#b3202e' };
const kit = makeKit('home', pal, pal);

/** Where the two-bone chain (unit bones) puts its end for joint angles (hip / sh from hanging down). */
const legEnd = (hip: number, knee: number): { f: number; d: number } => ({ f: Math.sin(hip) + Math.sin(hip - knee), d: Math.cos(hip) + Math.cos(hip - knee) });

describe('contact poses', () => {
  it('gives every line-play and tackle clip one pose per frame, registered as chain B poses', () => {
    for (const clip of CLIPS) {
      expect(POSES[clip]?.length, clip).toBe(clipTiming(clip).frames);
      expect(posesOwner(clip), clip).toBe('B');
    }
  });

  it('plants feet and places hands by IK', () => {
    for (const [f, d] of [[0.3, 1.5], [-1.05, 1.45], [0.8, 1.2]] as const) {
      const l = legTo(f, d);
      const e = legEnd(l.hip, l.knee);
      expect(e.f).toBeCloseTo(f, 5);
      expect(e.d).toBeCloseTo(d, 5);
    }
    const a = armTo(1.5, 0.3);
    const a2 = a.sh + a.elbow;
    expect(Math.sin(a.sh) + Math.sin(a2)).toBeCloseTo(1.5, 5);
    expect(-Math.cos(a.sh) - Math.cos(a2)).toBeCloseTo(0.3, 5);
  });

  it('paints every frame in every facing: upright contact frames stay figure-sized, fallen ones lie flat', () => {
    for (const clip of CLIPS) {
      const painter = painterFor(clip);
      expect(painter, clip).not.toBeNull();
      const n = clipTiming(clip).frames;
      for (let frame = 0; frame < n; frame++) {
        for (const facing of ['e', 'w', 's', 'ne'] as const) {
          const req: FrameRequest = { clip, frame, facing, build: 'bigO', bodyVar: 1, tier: 1, kit, skin: 2, number: 72, ball: false, accessory: 0, lighting: 'day' };
          const f = painter?.paint(req);
          expect(f && f.width > 4 && f.height > 4, `${clip}:${frame}:${facing}`).toBe(true);
          expect(f?.height ?? 99, `${clip}:${frame}:${facing}`).toBeLessThanOrEqual(46);
          if (clipTiming(clip).lying && frame === n - 1 && facing === 'e') expect(f?.width ?? 0, `${clip} lies flat`).toBeGreaterThan(f?.height ?? 0);
        }
      }
    }
  });
});
