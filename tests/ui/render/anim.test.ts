import { afterEach, describe, expect, it } from 'vitest';
import {
  bodyVarFor, buildForPosition, canonicalRequest, clipTiming, frameAt, frameKey, hasFallbackPainter, makeKit, painterFor, registerClip, registerPainter,
  resetAnimRegistry, strideFrame, unpaintedClips, type FramePainter, type FrameRequest,
} from '@/ui/render/anim';
import { ANIM_IDS, CORE_ANIM_IDS, DEFAULT_TIMINGS, isAnimId, LINE_ANIM_IDS, TACKLE_ANIM_IDS } from '@/ui/render/anim-ids';
import { createLegacyPainter, installLegacyPainter, legacyPose } from '@/ui/render/anim-legacy';

const kit = makeKit('home', { primary: '#c02020', secondary: '#f0f0f0', accent: '#ffffff', helmet: '#c02020' }, { primary: '#c02020', secondary: '#f0f0f0', accent: '#ffffff', helmet: '#c02020' });
const req = (over: Partial<FrameRequest> = {}): FrameRequest => ({
  clip: 'run', frame: 3, facing: 'e', build: 'bigO', bodyVar: 1, tier: 1, kit, skin: 2, number: 72, ball: false, accessory: 9, lighting: 'day', ...over,
});
const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) cleanups.pop()?.(); });

describe('clip ids and timings', () => {
  it('covers every animation of the art bible with a timing', () => {
    expect(ANIM_IDS.length).toBe(CORE_ANIM_IDS.length + LINE_ANIM_IDS.length + TACKLE_ANIM_IDS.length);
    expect(new Set(ANIM_IDS).size).toBe(ANIM_IDS.length);
    for (const id of ANIM_IDS) {
      const t = DEFAULT_TIMINGS[id];
      expect(t.frames).toBeGreaterThan(0);
      expect(t.fps).toBeGreaterThan(0);
      if (t.next) expect(isAnimId(t.next)).toBe(true);
    }
    for (const id of ['stance3', 'run', 'sprint', 'throw', 'catchHigh', 'handFight', 'driveBlock', 'swim', 'pancake', 'wrap', 'bigHit', 'pileOn', 'getUp'] as const) {
      expect(ANIM_IDS).toContain(id);
    }
    expect(isAnimId('moonwalk')).toBe(false);
  });

  it('samples loops (wrapping, phase offset), one-shots (clamped) and locomotion by distance', () => {
    expect(frameAt('idle', 0)).toBe(0);
    expect(frameAt('idle', 0.5)).toBe(1);
    expect(frameAt('idle', 1)).toBe(0);
    expect(frameAt('idle', 0, 1)).toBe(1);
    expect(frameAt('throw', 10)).toBe(4);
    expect(frameAt('throw', -1)).toBe(0);
    const stride = clipTiming('run').strideYd as number;
    expect(strideFrame('run', 0)).toBe(0);
    expect(strideFrame('run', stride / 8)).toBe(1);
    expect(strideFrame('run', stride)).toBe(0);
    expect(strideFrame('run', stride * 2.5)).toBe(4);
  });

  it('lets a chain retime a clip within the registry', () => {
    const before = clipTiming('juke');
    registerClip('juke', { fps: 16 });
    expect(clipTiming('juke')).toMatchObject({ frames: before.frames, fps: 16 });
    registerClip('juke', before);
  });
});

describe('painter registry', () => {
  const painter = (id: string): FramePainter => ({ id, paint: () => ({ width: 1, height: 1, ax: 0, ay: 0 }) });

  it('picks the latest specific painter, else the latest fallback', () => {
    installLegacyPainter();
    const base = painterFor('run');
    expect(base).not.toBeNull();
    const fb = painter('fb');
    cleanups.push(registerPainter(fb));
    expect(painterFor('run')).toBe(fb);
    const runs = painter('runs');
    cleanups.push(registerPainter(runs, ['run', 'sprint']));
    expect(painterFor('run')).toBe(runs);
    expect(painterFor('idle')).toBe(fb);
    const later = painter('later');
    cleanups.push(registerPainter(later, ['run']));
    expect(painterFor('run')).toBe(later);
    expect(painterFor('sprint')).toBe(runs);
    expect(unpaintedClips()).not.toContain('run');
    expect(unpaintedClips()).toContain('idle');
  });

  it('keeps the placeholder fallback when a chain paints only some clips (no clip is left without a figure)', () => {
    resetAnimRegistry();
    const idleOnly = painter('idleOnly');
    cleanups.push(registerPainter(idleOnly, ['idle']));
    expect(hasFallbackPainter()).toBe(false);
    installLegacyPainter();
    expect(hasFallbackPainter()).toBe(true);
    expect(painterFor('idle')).toBe(idleOnly);
    expect(painterFor('run')?.id).toBe('legacy16');
    expect(painterFor('handFight')?.id).toBe('legacy16');
    // installing twice registers one fallback
    installLegacyPainter();
    resetAnimRegistry();
    installLegacyPainter();
    expect(painterFor('idle')?.id).toBe('legacy16');
  });

  it('keys frames by everything a painter paints, the number only when it bakes it', () => {
    const p = painter('p');
    expect(frameKey(p, req())).toBe(frameKey(p, req({ number: 11 })));
    expect(frameKey(p, req())).not.toBe(frameKey(p, req({ frame: 4 })));
    expect(frameKey(p, req())).not.toBe(frameKey(p, req({ tier: 2 })));
    expect(frameKey(p, req())).not.toBe(frameKey(p, req({ kit: makeKit('away', kit.palette, kit.uniform) })));
    const baked: FramePainter = { ...p, bakesNumber: true };
    expect(frameKey(baked, req())).not.toBe(frameKey(baked, req({ number: 11 })));
  });

  it('builds and body variants come from position and weight', () => {
    expect(buildForPosition('OG')).toBe('bigO');
    expect(buildForPosition('DT')).toBe('bigD');
    expect(buildForPosition('MLB')).toBe('power');
    expect(buildForPosition('RB')).toBe('back');
    expect(buildForPosition('QB')).toBe('qb');
    expect(buildForPosition('CB')).toBe('slim');
    expect(buildForPosition('P')).toBe('kick');
    expect(bodyVarFor('bigO', 295)).toBe(0);
    expect(bodyVarFor('bigO', 315)).toBe(1);
    expect(bodyVarFor('bigO', 340)).toBe(2);
    expect(bodyVarFor('slim', undefined)).toBe(1);
  });
});

describe('placeholder painter', () => {
  it('maps every clip to a legacy pose and folds equivalent frames into one key', () => {
    const legacy = createLegacyPainter();
    for (const id of ANIM_IDS) {
      const pose = legacyPose(id, 0, clipTiming(id).frames);
      expect(pose.frame).toBeGreaterThanOrEqual(0);
    }
    // run frames 0 and 4 are the same legacy sprite; jog and sprint share the run family
    expect(frameKey(legacy, req({ frame: 0 }))).toBe(frameKey(legacy, req({ frame: 4 })));
    expect(frameKey(legacy, req({ clip: 'jog', frame: 1 }))).toBe(frameKey(legacy, req({ clip: 'sprint', frame: 1 })));
    expect(frameKey(legacy, req({ lighting: 'night', accessory: 3 }))).toBe(frameKey(legacy, req()));
    const canon = canonicalRequest(legacy, req({ clip: 'sprint', frame: 5 }));
    expect(canonicalRequest(legacy, canon)).toEqual(canon);
  });

  it('paints figures sized by tier with the feet on the anchor (bottom row)', () => {
    const legacy = createLegacyPainter();
    const heights = ([1, 2, 3, 4] as const).map((tier) => legacy.paint(req({ tier })).height);
    // the tier heights of the retro figures (26 art px at tier 1 on the 1x grid)
    expect(heights).toEqual([26, 22, 18, 14]);
    const f = legacy.paint(req());
    expect(f.ay).toBe(f.height - 1);
    expect(f.rgba?.length).toBe(f.width * f.height * 4);
    expect(f.attach?.ball).toBeDefined();
  });
});
