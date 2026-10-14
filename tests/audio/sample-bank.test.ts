import { describe, expect, it, vi } from 'vitest';
import { createRng } from '@/core/rng';
import { SampleBank, chooseVariants } from '@/audio/sample-bank';

const manifest = {
  version: 1,
  sounds: [
    { id: 'sfx.tackle_big', category: 'sfx', gain: 1, loop: null, variants: [1, 2, 3, 4, 5].map((i) => ({ file: `sfx/tackle_big_${i}.m4a`, duration: 0.5 })) },
    { id: 'sfx.snap', category: 'sfx', gain: 0.6, loop: null, variants: [{ file: 'sfx/snap_1.m4a', duration: 0.2 }] },
    { id: 'sfx.kick', category: 'sfx', gain: 0.8, loop: null, variants: [{ file: 'sfx/kick_1.m4a', duration: 0.3 }, { file: 'sfx/kick_2.m4a', duration: 0.3 }] },
  ],
};

const makeBank = (fail: (file: string) => boolean = () => false) => {
  const decode = vi.fn((file: string) => (fail(file) ? Promise.reject(new Error('404')) : Promise.resolve(`buf:${file}`)));
  const fetchManifest = vi.fn(() => Promise.resolve(manifest as unknown));
  return { bank: new SampleBank<string>(decode, fetchManifest), decode, fetchManifest };
};

describe('SampleBank', () => {
  it('loads nothing until asked, and each id only once', async () => {
    const { bank, decode, fetchManifest } = makeBank();
    expect(decode).not.toHaveBeenCalled();
    expect(bank.pick('sfx.snap', createRng(1))).toBeNull();
    await Promise.all([bank.preload(['sfx.snap']), bank.preload(['sfx.snap'])]);
    expect(decode).toHaveBeenCalledTimes(1);
    expect(fetchManifest).toHaveBeenCalledTimes(1);
    expect(bank.isReady('sfx.snap')).toBe(true);
    expect(bank.pick('sfx.snap', createRng(1))?.buffer).toBe('buf:sfx/snap_1.m4a');
  });

  it('picks variants deterministically from the injected rng and never repeats back to back', async () => {
    const seq = async (seed: number): Promise<number[]> => {
      const { bank } = makeBank();
      await bank.preload(['sfx.tackle_big']);
      const rng = createRng(seed);
      return Array.from({ length: 40 }, () => bank.pick('sfx.tackle_big', rng)?.index ?? -1);
    };
    const a = await seq(7);
    expect(await seq(7)).toEqual(a);
    expect(await seq(8)).not.toEqual(a);
    for (let i = 1; i < a.length; i++) expect(a[i]).not.toBe(a[i - 1]);
    expect(new Set(a).size).toBe(5);
  });

  it('marks failed decodes and missing ids so callers fall back to the synth', async () => {
    const { bank } = makeBank((f) => f.includes('kick_1'));
    await bank.preload(['sfx.kick', 'sfx.nope', 'sfx.snap']);
    expect(bank.status('sfx.nope')).toBe('missing');
    // One of two kick variants failed: the other still plays, every time.
    const rng = createRng(3);
    expect([0, 1, 2].map(() => bank.pick('sfx.kick', rng)?.index)).toEqual([1, 1, 1]);
    const all = makeBank(() => true);
    await all.bank.preload(['sfx.snap']);
    expect(all.bank.status('sfx.snap')).toBe('failed');
    expect(all.bank.pick('sfx.snap', rng)).toBeNull();
  });

  it('stays silent (no throw) when the manifest cannot be fetched', async () => {
    const bank = new SampleBank<string>(() => Promise.resolve('x'), () => Promise.reject(new Error('offline')));
    await expect(bank.preload(['sfx.snap'])).resolves.toBeUndefined();
    expect(bank.status('sfx.snap')).toBe('missing');
  });

  it('can cap how many variants it decodes', async () => {
    expect(chooseVariants(4, {})).toEqual([0, 1, 2, 3]);
    expect(chooseVariants(4, { maxVariants: 1 })).toEqual([0]);
    const picked = chooseVariants(5, { maxVariants: 2, rng: createRng(9) });
    expect(picked).toHaveLength(2);
    expect(picked).toEqual(chooseVariants(5, { maxVariants: 2, rng: createRng(9) }));
    const { bank, decode } = makeBank();
    await bank.preload(['sfx.tackle_big'], { maxVariants: 1 });
    expect(decode).toHaveBeenCalledTimes(1);
  });
});
