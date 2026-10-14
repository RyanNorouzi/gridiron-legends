import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  CROWD_BED_IDS, MAX_SAMPLE_GAIN, SAMPLE_IDS, isSafeSamplePath, missingSampleIds, parseSampleManifest, sampleIdsFor,
} from '@/audio/sample-manifest';

const AUDIO_DIR = fileURLToPath(new URL('../../public/audio', import.meta.url));
const raw = JSON.parse(readFileSync(resolve(AUDIO_DIR, 'manifest.json'), 'utf8')) as { sounds: { id: string; variants: { file: string }[] }[] };

describe('shipped manifest (public/audio/manifest.json)', () => {
  const { manifest, errors } = parseSampleManifest(raw);

  it('parses without errors and covers every sample id the game triggers', () => {
    expect(errors).toEqual([]);
    expect(missingSampleIds(manifest)).toEqual([]);
    expect(manifest.entries.size).toBe(raw.sounds.length);
  });

  it('has unique ids', () => {
    const ids = raw.sounds.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('points at files that exist and are non-empty', () => {
    const missing: string[] = [];
    for (const entry of manifest.entries.values()) {
      for (const v of entry.variants) {
        const path = resolve(AUDIO_DIR, v.file);
        if (!existsSync(path) || statSync(path).size < 200) missing.push(v.file);
      }
    }
    expect(missing).toEqual([]);
  });

  it('has sane gains, durations and bed loop points', () => {
    for (const entry of manifest.entries.values()) {
      expect(entry.gain).toBeGreaterThan(0.1);
      expect(entry.gain).toBeLessThanOrEqual(MAX_SAMPLE_GAIN);
      for (const v of entry.variants) expect(v.duration).toBeGreaterThan(0.02);
    }
    for (const id of CROWD_BED_IDS) {
      const bed = manifest.entries.get(id);
      expect(bed?.loop).toBe(true);
      for (const v of bed?.variants ?? []) {
        expect(v.loopEnd! - v.loopStart!).toBeGreaterThan(10);
      }
    }
  });

  it('splits ids by bus', () => {
    expect(sampleIdsFor('sfx').every((id) => id.startsWith('sfx.'))).toBe(true);
    expect(sampleIdsFor('crowd')).toContain('crowd.bed_loud');
    expect(sampleIdsFor('sfx').length + sampleIdsFor('crowd').length).toBe(SAMPLE_IDS.length);
  });
});

describe('parseSampleManifest (system boundary)', () => {
  it('never throws on garbage and reports it', () => {
    for (const junk of [null, 42, 'x', {}, { sounds: 'no' }]) {
      const r = parseSampleManifest(junk);
      expect(r.manifest.entries.size).toBe(0);
      expect(r.errors.length).toBeGreaterThan(0);
    }
  });

  it('drops bad entries, keeps good ones and the first of duplicates', () => {
    const good = { id: 'sfx.catch', category: 'sfx', gain: 0.7, loop: null, variants: [{ file: 'sfx/catch_1.m4a', duration: 0.2 }] };
    const r = parseSampleManifest({
      version: 1,
      sounds: [
        good,
        { ...good, gain: 0.1 },
        { ...good, id: 'sfx.kick', gain: 9 },
        { ...good, id: 'sfx.snap', category: 'music' },
        { ...good, id: 'crowd.cheer' },
        { ...good, id: 'sfx.turf', variants: [{ file: '../../etc/passwd.m4a', duration: 1 }] },
        { ...good, id: 'crowd.bed_loud', category: 'crowd', loop: {}, variants: [{ file: 'crowd/b.m4a', duration: 10, loopStart: 5, loopEnd: 2 }] },
      ],
    });
    expect([...r.manifest.entries.keys()]).toEqual(['sfx.catch']);
    expect(r.manifest.entries.get('sfx.catch')?.gain).toBe(0.7);
    expect(r.errors).toHaveLength(6);
  });

  it('only accepts relative audio paths', () => {
    expect(isSafeSamplePath('sfx/tackle_big_3.m4a')).toBe(true);
    for (const bad of ['/etc/x.m4a', '../x.m4a', 'sfx/../../x.m4a', 'https://evil.test/x.m4a', 'data:audio/x.m4a', 'sfx\\x.m4a', 'sfx/x.exe', '', 7]) {
      expect(isSafeSamplePath(bad)).toBe(false);
    }
  });
});
