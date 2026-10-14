/**
 * Browser wiring for the recorded-sample layer: one AudioContext shared with the synth backend, fetch +
 * decodeAudioData loaders against the deployed /audio/ folder, and the SampleLayer built on top. Any
 * network / decode failure leaves the affected sounds on the synth.
 */
import { createRng } from '@/core/rng';
import { SampleBank, type ManifestFetcher, type SampleDecoder } from './sample-bank';
import { SampleLayer } from './sample-layer';
import { isSafeSamplePath } from './sample-manifest';
import { createWebSampleOutput } from './sample-output';

/** One AudioContext shared by the synth backend and the sample layer. */
export interface SharedContext {
  /** The context, created on first call (and re-created after the previous one was closed). */
  get: () => AudioContext | null;
  /** The context if one exists; never creates. */
  current: () => AudioContext | null;
}

const defaultFactory = (): AudioContext | null => {
  const g = globalThis as unknown as { AudioContext?: new () => AudioContext; webkitAudioContext?: new () => AudioContext };
  const Ctor = g.AudioContext ?? g.webkitAudioContext;
  try {
    return Ctor ? new Ctor() : null;
  } catch {
    return null;
  }
};

/** Lazily created AudioContext shared by the synth and the sample layer. */
export const createSharedContext = (factory: () => AudioContext | null = defaultFactory): SharedContext => {
  let ctx: AudioContext | null = null;
  return {
    get: () => {
      if (!ctx || ctx.state === 'closed') ctx = factory();
      return ctx;
    },
    current: () => (ctx && ctx.state !== 'closed' ? ctx : null),
  };
};

/** Site-relative folder holding manifest.json (Vite's BASE_URL + 'audio/'). */
export const defaultSampleBaseUrl = (): string => {
  const env = (import.meta as unknown as { env?: { BASE_URL?: unknown } }).env;
  const base = typeof env?.BASE_URL === 'string' ? env.BASE_URL : '/';
  return `${base.endsWith('/') ? base : `${base}/`}audio/`;
};

type FetchFn = (url: string) => Promise<{ ok: boolean; json(): Promise<unknown>; arrayBuffer(): Promise<ArrayBuffer> }>;

const globalFetch = (): FetchFn | null => {
  const f = (globalThis as unknown as { fetch?: FetchFn }).fetch;
  return typeof f === 'function' ? f.bind(globalThis) : null;
};

/** Manifest loader over fetch. */
export const fetchManifest = (baseUrl: string, fetchFn: FetchFn | null = globalFetch()): ManifestFetcher => async () => {
  if (!fetchFn) throw new Error('fetch unavailable');
  const res = await fetchFn(`${baseUrl}manifest.json`);
  if (!res.ok) throw new Error('manifest not found');
  return res.json();
};

/** fetch + decodeAudioData loader; rejects unsafe paths before touching the network. */
export const fetchDecoder = (baseUrl: string, getContext: () => AudioContext | null, fetchFn: FetchFn | null = globalFetch()): SampleDecoder<AudioBuffer> =>
  async (file) => {
    if (!isSafeSamplePath(file)) throw new Error(`unsafe sample path ${file}`);
    const ctx = getContext();
    if (!fetchFn || !ctx) throw new Error('audio unavailable');
    const res = await fetchFn(`${baseUrl}${file}`);
    if (!res.ok) throw new Error(`sample ${file} not found`);
    return ctx.decodeAudioData(await res.arrayBuffer());
  };

/** Options for createBrowserSampleLayer. */
export interface BrowserSampleOptions {
  baseUrl?: string;
}

/** The SampleLayer the browser build uses (shares `shared` with the synth backend). */
export const createBrowserSampleLayer = (shared: SharedContext, opts: BrowserSampleOptions = {}): SampleLayer<AudioBuffer> => {
  const baseUrl = opts.baseUrl ?? defaultSampleBaseUrl();
  const bank = new SampleBank(fetchDecoder(baseUrl, shared.get), fetchManifest(baseUrl));
  const clock = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());
  return new SampleLayer({ bank, output: createWebSampleOutput(shared.current), rng: createRng('gridiron-samples'), now: clock });
};
