import type { AudioLevels, Settings } from '@/core/settings';
import { AudioManager, type AudioManagerOptions } from './manager';
import { createBrowserSampleLayer, createSharedContext } from './sample-web';
import { createNullBackend, createWebAudioBackend, type AudioBackend, type WebAudioOptions } from './synth';

export * from './sounds';
export * from './synth';
export * from './manager';
export * from './captions';
export * from './music';
export * from './sample-manifest';
export * from './sample-bank';
export * from './sample-output';
export * from './sample-cues';
export * from './crowd-cues';
export * from './crowd-model';
export * from './crowd-engine';
export * from './sample-layer';
export * from './sample-web';

/** True in a browser with WebAudio support. The audio module is the only sim-adjacent layer allowed to look at `window`. */
export const hasWebAudio = (): boolean => {
  const g = globalThis as unknown as { window?: unknown; AudioContext?: unknown; webkitAudioContext?: unknown };
  return g.window !== undefined && (typeof g.AudioContext === 'function' || typeof g.webkitAudioContext === 'function');
};

/** WebAudio in the browser, the recording null backend everywhere else (Node, tests, headless sims). */
export const createAudioBackend = (opts?: WebAudioOptions): AudioBackend => (hasWebAudio() ? createWebAudioBackend(opts) : createNullBackend());

export interface CreateAudioOptions extends AudioManagerOptions {
  /** Explicit backend (tests, tools); otherwise picked by environment. */
  backend?: AudioBackend;
  webAudio?: WebAudioOptions;
  /** Base URL of the recorded samples (default: the site's /audio/ folder). */
  sampleBaseUrl?: string;
}

const isSettings = (s: Settings | AudioLevels): s is Settings => 'audio' in s;

/**
 * Build the AudioManager from the persisted Settings (or just its AudioLevels).
 * In a WebAudio browser (and without an explicit backend) the synth and the recorded-sample layer share one
 * AudioContext, so the first user gesture unlocks both; everywhere else the manager is synth/null only.
 */
export const createAudio = (settings: Settings | AudioLevels, opts: CreateAudioOptions = {}): AudioManager => {
  const levels = isSettings(settings) ? settings.audio : settings;
  const { backend, webAudio, sampleBaseUrl, ...rest } = opts;
  const crowdNoise = rest.crowdNoise ?? (isSettings(settings) ? settings.crowdNoise : undefined);
  const managerOpts: AudioManagerOptions = { ...rest, ...(crowdNoise ? { crowdNoise } : {}) };
  if (backend || !hasWebAudio() || managerOpts.samples !== undefined) {
    return new AudioManager(backend ?? createAudioBackend(webAudio), levels, managerOpts);
  }
  const shared = createSharedContext(webAudio?.createContext);
  const synth = createWebAudioBackend({ ...webAudio, createContext: shared.get });
  const samples = createBrowserSampleLayer(shared, sampleBaseUrl !== undefined ? { baseUrl: sampleBaseUrl } : {});
  return new AudioManager(synth, levels, { ...managerOpts, samples });
};
