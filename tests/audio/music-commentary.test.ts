import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '@/core/settings';
import { createAudio, createNullBackend, MUSIC_TRACKS, MusicSequencer, musicForScreens, noteRecipe, SOUNDS, soundsForEvent, eventSounds, validateRecipe, commentaryForEvent } from '@/audio/index';

describe('commentary bus', () => {
  it('has original booth and PA sounds on the commentary category', () => {
    const commentary = Object.entries(SOUNDS).filter(([, r]) => r.category === 'commentary');
    expect(commentary.map(([id]) => id).sort()).toEqual(['boothAww', 'boothExcited', 'boothWhoa', 'paChime']);
    for (const [id, r] of commentary) validateRecipe(id, r);
  });

  it('reacts to big moments and announces stoppages', () => {
    const ctx = { offense: 'home' as const, crowdSide: 'home' as const };
    expect(eventSounds({ type: 'touchdown', tick: 1, side: 'offense', scorer: 'off:RB' } as never, ctx).map((t) => t.id)).toContain('boothExcited');
    expect(soundsForEvent({ type: 'touchdown', tick: 1, side: 'offense', scorer: 'off:RB' } as never, ctx).map((t) => t.id)).not.toContain('boothExcited');
    expect(commentaryForEvent({ type: 'timeout', teamSide: 'home' })?.id).toBe('paChime');
    expect(commentaryForEvent({ type: 'snap', tick: 1 } as never)).toBeNull();
  });

  it('the COMMENTARY level scales the booth bus', () => {
    const backend = createNullBackend();
    const audio = createAudio({ ...DEFAULT_SETTINGS.audio, commentary: 0.5, master: 1 }, { backend });
    expect(backend.gains.commentary).toBe(0.5);
    audio.setLevels({ ...DEFAULT_SETTINGS.audio, master: 1, commentary: 0.25 });
    expect(backend.gains.commentary).toBe(0.25);
    audio.onGameEvent({ type: 'penalty', tick: 1, penalty: { side: 'defense' } } as never);
    expect(backend.calls.some((c) => c.kind === 'play' && c.recipe.category === 'commentary')).toBe(true);
  });
});

describe('background music', () => {
  it('loops the menu and game tracks note by note on the music bus', () => {
    for (const t of Object.values(MUSIC_TRACKS)) for (const n of t.notes) validateRecipe(`${t.id}:${n.step}`, noteRecipe(t, n));
    const played: string[] = [];
    const seq = new MusicSequencer((r) => played.push(r.category));
    seq.setTrack('menu');
    const loopSec = (60 / MUSIC_TRACKS.menu.bpm / 4) * MUSIC_TRACKS.menu.steps;
    let fired = 0;
    for (let t = 0; t < loopSec * 2; t += 1 / 60) fired += seq.update(1 / 60);
    expect(fired).toBeGreaterThanOrEqual(MUSIC_TRACKS.menu.notes.length * 2 - 4);
    expect(new Set(played)).toEqual(new Set(['music']));
    seq.setTrack(null);
    expect(seq.update(1)).toBe(0);
  });

  it('follows the screen stack and stays silent while muted', () => {
    expect(musicForScreens([])).toBeNull();
    expect(musicForScreens(['mainMenu'])).toBe('menu');
    expect(musicForScreens(['mainMenu', 'game', 'playcall'])).toBe('game');
    const backend = createNullBackend();
    const audio = createAudio(DEFAULT_SETTINGS, { backend });
    expect(audio.updateMusic(0.5, 'menu')).toBeGreaterThan(0);
    expect(audio.musicTrack).toBe('menu');
    expect(backend.calls.some((c) => c.kind === 'play' && c.recipe.category === 'music')).toBe(true);
    audio.mute();
    const before = backend.calls.length;
    audio.updateMusic(0.5, 'menu');
    expect(backend.calls.length).toBe(before);
  });
});
