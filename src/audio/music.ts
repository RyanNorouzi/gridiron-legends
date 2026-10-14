/**
 * Background music: two ORIGINAL chiptune loops composed for this game (no samples, no borrowed melodies), played
 * on the music bus through the same synthesised voices as every other sound. 'menu' is an upbeat major-key loop for
 * menus and the franchise hub; 'game' a quieter minor groove under play. A step sequencer advances with real time
 * (update(dt)) and fires each note as a one-shot recipe, so the Settings MUSIC slider (and mute) controls it.
 */
import type { SynthRecipe } from './sounds';

export type MusicTrackId = 'menu' | 'game';
export type MusicVoice = 'lead' | 'bass' | 'kick' | 'hat';

/** One note: `step` in 16ths from the loop start, `semis` from the track root, `len` in 16ths. */
export interface MusicNote {
  step: number;
  semis: number;
  len: number;
  voice: MusicVoice;
}

export interface MusicTrack {
  id: MusicTrackId;
  bpm: number;
  /** Loop length in 16ths. */
  steps: number;
  /** Root frequency in Hz. */
  rootHz: number;
  /** Loop gain 0..1 (before the music bus). */
  gain: number;
  notes: readonly MusicNote[];
}

const eighths = (bar: number, semis: readonly number[], voice: MusicVoice = 'lead'): MusicNote[] =>
  semis.map((s, i) => ({ step: bar * 16 + i * 2, semis: s, len: 2, voice }));
const quarters = (bar: number, semis: readonly number[], voice: MusicVoice = 'bass'): MusicNote[] =>
  semis.map((s, i) => ({ step: bar * 16 + i * 4, semis: s, len: 3, voice }));
const drums = (bars: number, kickEvery: number, hatOffbeats: boolean): MusicNote[] => {
  const out: MusicNote[] = [];
  for (let s = 0; s < bars * 16; s++) {
    if (s % kickEvery === 0) out.push({ step: s, semis: 0, len: 1, voice: 'kick' });
    if (hatOffbeats && s % 4 === 2) out.push({ step: s, semis: 0, len: 1, voice: 'hat' });
  }
  return out;
};

/** The loops. Melodies are simple scale figures written for this game. */
export const MUSIC_TRACKS: Readonly<Record<MusicTrackId, MusicTrack>> = Object.freeze({
  menu: {
    id: 'menu', bpm: 116, steps: 64, rootHz: 261.63, gain: 0.5,
    notes: [
      ...eighths(0, [0, 4, 7, 9, 7, 4, 2, 4]), ...eighths(1, [5, 9, 12, 9, 7, 5, 4, 2]),
      ...eighths(2, [0, 4, 7, 12, 11, 9, 7, 4]), ...eighths(3, [2, 5, 7, 11, 9, 7, 2, 0]),
      ...quarters(0, [-12, -12, -5, -5]), ...quarters(1, [-7, -7, -3, -3]), ...quarters(2, [-12, -8, -5, -8]), ...quarters(3, [-10, -10, -5, -5]),
      ...drums(4, 8, true),
    ],
  },
  game: {
    id: 'game', bpm: 96, steps: 64, rootHz: 220, gain: 0.3,
    notes: [
      ...quarters(0, [-12, -12, -9, -7]), ...quarters(1, [-12, -12, -5, -7]), ...quarters(2, [-16, -16, -12, -9]), ...quarters(3, [-14, -14, -10, -7]),
      { step: 12, semis: 7, len: 4, voice: 'lead' }, { step: 28, semis: 10, len: 4, voice: 'lead' },
      { step: 44, semis: 3, len: 4, voice: 'lead' }, { step: 60, semis: 5, len: 4, voice: 'lead' },
      ...drums(4, 16, true),
    ],
  },
});

/** Hz of a note `semis` semitones from `rootHz`. */
export const noteHz = (rootHz: number, semis: number): number => rootHz * 2 ** (semis / 12);

/** The one-shot recipe that plays `note` of `track` (music bus). */
export const noteRecipe = (track: MusicTrack, note: MusicNote): SynthRecipe => {
  const stepSec = 60 / track.bpm / 4;
  const dur = Math.max(0.05, note.len * stepSec);
  const base = { category: 'music' as const, sweep: 'exponential' as const, noiseMix: 0 };
  switch (note.voice) {
    case 'lead': {
      const hz = noteHz(track.rootHz, note.semis);
      return { ...base, waveform: 'square', envelope: { attack: 0.005, decay: Math.min(0.08, dur / 3), sustain: 0.45, release: Math.min(0.08, dur / 3) }, startHz: hz, endHz: hz, duration: dur, gain: 0.22 };
    }
    case 'bass': {
      const hz = noteHz(track.rootHz, note.semis);
      return { ...base, waveform: 'triangle', envelope: { attack: 0.005, decay: Math.min(0.1, dur / 3), sustain: 0.6, release: Math.min(0.1, dur / 3) }, startHz: hz, endHz: hz, duration: dur, gain: 0.35 };
    }
    case 'kick':
      return { ...base, waveform: 'sine', envelope: { attack: 0.002, decay: 0.06, sustain: 0.2, release: 0.05 }, startHz: 110, endHz: 45, noiseMix: 0.1, duration: 0.14, gain: 0.45 };
    case 'hat':
      return { ...base, waveform: 'noise', noiseMix: 1, envelope: { attack: 0.001, decay: 0.02, sustain: 0.1, release: 0.02 }, startHz: 440, endHz: 440, duration: 0.05, gain: 0.12, filter: { kind: 'highpass', hz: 7000, q: 0.7 } };
  }
};

/**
 * Step sequencer over a track: `update(dt)` fires every note whose step was reached (a long frame catches up, but
 * never more than one loop at once), looping forever. `play` receives each note's recipe and gain.
 */
export class MusicSequencer {
  private track: MusicTrack | null = null;
  private clock = 0;
  private nextStep = 0;

  constructor(private readonly play: (recipe: SynthRecipe, gain: number) => void) {}

  get current(): MusicTrackId | null {
    return this.track?.id ?? null;
  }

  /** Switches loops (restarting from the top) or stops with null; the same id keeps playing. */
  setTrack(id: MusicTrackId | null): void {
    if ((this.track?.id ?? null) === id) return;
    this.track = id ? MUSIC_TRACKS[id] : null;
    this.clock = 0;
    this.nextStep = 0;
  }

  /** Advances by `dt` seconds and plays the notes that fall due. Returns how many notes fired. */
  update(dt: number): number {
    const t = this.track;
    if (!t || !(dt > 0)) return 0;
    const stepSec = 60 / t.bpm / 4;
    this.clock += Math.min(dt, stepSec * t.steps);
    let fired = 0;
    while (this.clock >= this.nextStep * stepSec) {
      const step = this.nextStep % t.steps;
      for (const n of t.notes) {
        if (n.step !== step) continue;
        this.play(noteRecipe(t, n), t.gain);
        fired++;
      }
      this.nextStep++;
      if (this.nextStep >= t.steps) {
        this.nextStep = 0;
        this.clock -= stepSec * t.steps;
      }
    }
    return fired;
  }
}

/**
 * Which loop plays for a screen stack (bottom to top ids): the game loop while a game, practice drill, replay or the
 * tutorial is anywhere on the stack (overlays like the play call or pause keep it), the menu loop otherwise.
 */
export const musicForScreens = (screenIds: readonly string[]): MusicTrackId | null => {
  if (screenIds.length === 0) return null;
  const inGame = screenIds.some((id) => id === 'game' || id.startsWith('practice') || id === 'replay' || id === 'tutorial');
  return inGame ? 'game' : 'menu';
};
