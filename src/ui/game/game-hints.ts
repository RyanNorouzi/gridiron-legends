/**
 * Game-screen control hints and the touch-overlay context: the tappable buttons for the current session stage
 * (post-play CONTINUE / CHALLENGE / REPLAY, intermission CONTINUE, JUMP IN / SKIP while spectating) and which
 * label set the touch overlay shows. Pure over the session.
 */
import type { PlayState } from '@/game/play-types';
import type { TeamSide } from '@/game/types';
import type { Action } from '../input/types';
import type { HintButton } from '../widgets/hint-buttons';
import { playInputContext } from './play-input';
import { postPlayControls, recordingFor } from './postplay-controls';
import type { GameSession } from './session-types';
import type { TouchContext } from './touch-overlay';

/** Touch-overlay context for the session's stage. */
export const touchContextFor = (session: GameSession): TouchContext => {
  const stage = session.stage;
  if (stage.kind === 'live') {
    const side = session.userSide;
    if (stage.meta.spectating || side === null) return session.watching ? 'watch' : 'spectator';
    return playInputContext(stage.play.state, side);
  }
  if (stage.kind === 'postPlay') return 'postPlay';
  return session.watching ? 'watch' : 'menu';
};

/** A kickoff or punt in the air that the local user's side receives (he is on the automatic return until he moves). */
export const returnerCue = (play: PlayState, userSide: TeamSide | null): boolean => {
  const sp = play.ctx.special;
  const ball = play.ball;
  return userSide !== null && userSide !== play.ctx.offense && (sp === 'kickoff' || sp === 'onside' || sp === 'punt')
    && play.phase === 'live' && ball.phase === 'inAir' && (ball.kind === 'kickoff' || ball.kind === 'punt');
};

/** Buttons the Game screen shows (and lets the pointer tap) for the current stage. */
export const gameHints = (session: GameSession, glyph: (a: Action) => string): HintButton[] => {
  const stage = session.stage;
  const out: HintButton[] = [];
  if (stage.kind === 'postPlay') return postPlayControls(glyph, stage.challenge, recordingFor(stage.summary, session.lastReplay()) !== null);
  if (stage.kind === 'intermission') out.push({ id: 'continue', glyph: glyph('confirm'), label: 'CONTINUE' });
  else if (stage.kind === 'live' && stage.meta.spectating) {
    if (session.watching) out.push({ id: 'jumpIn', glyph: glyph('jumpIn'), label: 'JUMP IN' });
    out.push({ id: 'skip', glyph: glyph('skipPlay'), label: 'SKIP' });
  } else if (stage.kind === 'live' && returnerCue(stage.play.state, session.userSide)) {
    // No input yet = the AI returns it for him; the cue says whose man he is and how to wave it off.
    out.push({ id: 'returner', glyph: glyph('fairCatch'), label: 'YOU: RETURNER - FAIR CATCH' });
  }
  return out;
};
