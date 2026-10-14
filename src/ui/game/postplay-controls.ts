/**
 * Post-play controls of the Game screen: the tappable CONTINUE / CHALLENGE / REPLAY buttons of the post-play card
 * (keyboard, gamepad, mouse and touch reach the same three), the replay title of a play and the check that the
 * newest recording belongs to the play on the card (fast-simulated plays have none, and the store's last
 * recording would then be an older play).
 */
import type { ReplayRecording } from '@/game/play-types';
import type { Action } from '../input/types';
import type { HintButton } from '../widgets/hint-buttons';
import { REVIEW_WORDS } from './banners';
import { HIGHLIGHT_TITLES, highlightKind } from './highlights';
import type { ChallengePrompt, PostPlaySummary } from './session-types';

/** What each post-play button does. */
export type PostPlayControl = 'continue' | 'challenge' | 'replay';

/** Keyboard / gamepad action of each post-play button. */
export const POST_PLAY_ACTIONS: Readonly<Record<PostPlayControl, Action>> = Object.freeze({
  continue: 'confirm', challenge: 'challenge', replay: 'showPlayArt',
});

/** The recording of the play on the card, or null when the newest one is from another play. */
export const recordingFor = (summary: PostPlaySummary, rec: ReplayRecording | null): ReplayRecording | null =>
  rec && !summary.simulated && rec.playIndex === summary.entry.index ? rec : null;

/** Replay title for a play: its highlight kind ("TOUCHDOWN") or plain REPLAY. */
export const replayTitleFor = (summary: PostPlaySummary): string => {
  const kind = highlightKind(summary.entry.outcome, summary.entry);
  return kind ? `REPLAY · ${HIGHLIGHT_TITLES[kind]}` : 'REPLAY';
};

/** The post-play buttons (CHALLENGE only while the window is open, REPLAY only with a recording of this play). */
export const postPlayControls = (glyph: (a: Action) => string, challenge: ChallengePrompt | null, canReplay: boolean): HintButton[] => {
  const out: HintButton[] = [{ id: 'continue', glyph: glyph(POST_PLAY_ACTIONS.continue), label: 'CONTINUE' }];
  if (challenge) {
    const secs = Math.max(0, Math.ceil(challenge.remainingSec));
    out.push({ id: 'challenge', glyph: glyph(POST_PLAY_ACTIONS.challenge), label: `CHALLENGE ${REVIEW_WORDS[challenge.call.kind]} ${secs}s` });
  }
  if (canReplay) out.push({ id: 'replay', glyph: glyph(POST_PLAY_ACTIONS.replay), label: challenge ? 'REVIEW' : 'REPLAY' });
  return out;
};
