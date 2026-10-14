/**
 * Sample bank: lazily fetches + decodes the manifest's recordings, caches the decoded buffers and picks
 * variants. Generic over the buffer type so Node tests run it with fake decoders (no WebAudio needed).
 * Failures never throw into the game: a sample that cannot be fetched or decoded is simply not "ready",
 * and every cue for it falls back to the procedural synth.
 */
import type { Rng } from '@/core/rng';
import { parseSampleManifest, type SampleEntry, type SampleManifest, type SampleVariant } from './sample-manifest';

/** Fetch + decode one file (path relative to the audio base URL). */
export type SampleDecoder<B> = (file: string) => Promise<B>;
/** Fetch the raw manifest JSON. */
export type ManifestFetcher = () => Promise<unknown>;

/** Load state of one sample id ('missing' = not in the manifest). */
export type SampleStatus = 'idle' | 'loading' | 'ready' | 'failed' | 'missing';

/** A decoded variant chosen for playback. */
export interface PickedSample<B> {
  entry: SampleEntry;
  variant: SampleVariant;
  /** Index into entry.variants. */
  index: number;
  buffer: B;
}

/** How much of an id to decode. */
export interface PreloadOptions {
  /** Decode at most this many variants per id (crowd beds are big: one is enough). Default all. */
  maxVariants?: number;
  /** Chooses which variants to decode when capped; defaults to the first ones. */
  rng?: Rng;
}

interface Slot<B> {
  status: SampleStatus;
  buffers: (B | null)[];
  last: number;
  pending: Promise<void> | null;
}

/** Lazy, cached, failure-tolerant store of decoded samples keyed by manifest id. */
export class SampleBank<B> {
  private manifest: SampleManifest | null = null;
  private manifestPromise: Promise<SampleManifest | null> | null = null;
  private readonly slots = new Map<string, Slot<B>>();
  /** Validation problems reported by the manifest parser (surfaced for dev tools / tests). */
  manifestErrors: string[] = [];

  constructor(private readonly decode: SampleDecoder<B>, private readonly fetchManifest: ManifestFetcher) {}

  /** Loads + validates the manifest once; null when it cannot be fetched (everything stays on the synth). */
  ensureManifest(): Promise<SampleManifest | null> {
    this.manifestPromise ??= this.fetchManifest()
      .then((raw) => {
        const parsed = parseSampleManifest(raw);
        this.manifestErrors = parsed.errors;
        this.manifest = parsed.manifest;
        return parsed.manifest;
      })
      .catch(() => null);
    return this.manifestPromise;
  }

  /** The parsed manifest entry, once the manifest has loaded. */
  entry(id: string): SampleEntry | null {
    return this.manifest?.entries.get(id) ?? null;
  }

  status(id: string): SampleStatus {
    return this.slots.get(id)?.status ?? 'idle';
  }

  isReady(id: string): boolean {
    return this.status(id) === 'ready';
  }

  /** Starts loading `ids` (no-op for ids already loading/loaded). Resolves when all of them settled. */
  async preload(ids: readonly string[], opts: PreloadOptions = {}): Promise<void> {
    const manifest = await this.ensureManifest();
    await Promise.all(ids.map((id) => this.loadOne(manifest, id, opts)));
  }

  private loadOne(manifest: SampleManifest | null, id: string, opts: PreloadOptions): Promise<void> {
    const existing = this.slots.get(id);
    if (existing) return existing.pending ?? Promise.resolve();
    const entry = manifest?.entries.get(id);
    if (!entry) {
      this.slots.set(id, { status: 'missing', buffers: [], last: -1, pending: null });
      return Promise.resolve();
    }
    const slot: Slot<B> = { status: 'loading', buffers: entry.variants.map(() => null), last: -1, pending: null };
    this.slots.set(id, slot);
    const chosen = chooseVariants(entry.variants.length, opts);
    slot.pending = Promise.all(
      chosen.map((i) =>
        this.decode(entry.variants[i]?.file ?? '')
          .then((b) => { slot.buffers[i] = b; })
          .catch(() => undefined),
      ),
    ).then(() => {
      slot.status = slot.buffers.some((b) => b !== null) ? 'ready' : 'failed';
      slot.pending = null;
    });
    return slot.pending;
  }

  /**
   * Picks a decoded variant with the injected rng, never the same variant twice in a row when another is
   * available (round-robin feel without a predictable cycle). Null when the id is not ready.
   */
  pick(id: string, rng: Rng): PickedSample<B> | null {
    const slot = this.slots.get(id);
    const entry = this.manifest?.entries.get(id);
    if (!slot || slot.status !== 'ready' || !entry) return null;
    const available: number[] = [];
    slot.buffers.forEach((b, i) => { if (b !== null) available.push(i); });
    const pool = available.length > 1 ? available.filter((i) => i !== slot.last) : available;
    const index = pool.length === 1 ? (pool[0] ?? 0) : (pool[rng.int(0, pool.length - 1)] ?? 0);
    const buffer = slot.buffers[index];
    const variant = entry.variants[index];
    if (buffer === null || buffer === undefined || !variant) return null;
    slot.last = index;
    return { entry, variant, index, buffer };
  }

  /** Drops every decoded buffer (memory) but keeps the parsed manifest. */
  clear(): void {
    this.slots.clear();
  }
}

/** Which variant indices to decode: all, or `maxVariants` of them (random when an rng is given). */
export const chooseVariants = (count: number, opts: PreloadOptions): number[] => {
  const all = Array.from({ length: count }, (_, i) => i);
  const cap = opts.maxVariants;
  if (cap === undefined || cap >= count) return all;
  const n = Math.max(1, Math.floor(cap));
  return (opts.rng ? opts.rng.shuffle(all) : all).slice(0, n).sort((a, b) => a - b);
};
