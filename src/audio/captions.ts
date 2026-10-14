/**
 * Captions for important sound cues (accessibility): which sounds deserve a caption and its text. Routine
 * sounds (snap, throw, catch, menu clicks, the ambient crowd) are not captioned. The AudioManager raises the
 * captions from the same event mapping that picks the sounds, whether or not audio is muted.
 */
import type { SoundId } from './sounds';

/** Caption text per captioned sound. */
export const SOUND_CAPTIONS: Readonly<Partial<Record<SoundId, string>>> = Object.freeze({
  whistle: 'WHISTLE',
  crowdRoar: 'CROWD ROARS',
  crowdGroan: 'CROWD GROANS',
  bigHit: 'BIG HIT',
  penaltyFlag: 'FLAG THROWN',
  touchdown: 'TOUCHDOWN FANFARE',
  turnover: 'TURNOVER STING',
  fumble: 'BALL IS LOOSE',
  sack: 'SACK',
  fieldGoal: 'KICK IS GOOD',
  twoMinute: 'TWO-MINUTE WARNING HORN',
  gameOver: 'FINAL HORN',
  boothExcited: 'BOOTH: WHAT A PLAY',
  boothWhoa: 'BOOTH: WHOA',
  boothAww: 'BOOTH: SO CLOSE',
});

/** Minimum gap between two identical captions, in milliseconds. */
export const CAPTION_REPEAT_MS = 800;

/** "[WHISTLE]" style caption for a sound, or null when it is not captioned. */
export const captionFor = (id: SoundId): string | null => {
  const text = SOUND_CAPTIONS[id];
  return text ? `[${text}]` : null;
};
