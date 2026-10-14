/**
 * Highlight reel: which finished plays are worth keeping (touchdowns, interceptions, fumbles, long runs, long
 * catches, big hits, sacks, blocked / game-winning kicks and go-ahead scores late in the game) and a small
 * in-memory reel of their replay recordings for the current game. The replay store keeps only what the
 * retention setting allows (usually the current drive), so the Game screen hands each highlight's recording to
 * the reel as soon as the play ends; the reel caps its size, dropping the least important oldest entry first.
 * Pure logic, no drawing.
 */
import type { PenaltyInfo } from '@/game/play-events';
import type { PlayContext, PlayOutcome, ReplayRecording } from '@/game/play-types';
import { isNullifying, isReturnFoul } from '@/game/rules/penalties';
import type { PlayLogEntry, TeamSide } from '@/game/types';

/** Kinds of highlight, most important first. */
export type HighlightKind = 'gameWinner' | 'touchdown' | 'interception' | 'fumble' | 'longRun' | 'longCatch' | 'sack' | 'bigHit';

/** Importance: higher survives longer when the reel is full. */
const WEIGHT: Readonly<Record<HighlightKind, number>> = Object.freeze({
  gameWinner: 8, touchdown: 7, interception: 6, fumble: 5, longCatch: 4, longRun: 4, sack: 3, bigHit: 2,
});

/** Title shown in lists and on the replay screen. */
export const HIGHLIGHT_TITLES: Readonly<Record<HighlightKind, string>> = Object.freeze({
  gameWinner: 'GAME WINNER', touchdown: 'TOUCHDOWN', interception: 'INTERCEPTION', fumble: 'FUMBLE', longRun: 'LONG RUN',
  longCatch: 'LONG CATCH', sack: 'SACK', bigHit: 'BIG HIT',
});

/** Yards that make a run / a catch "long". */
export const LONG_RUN_YARDS = 20;
export const LONG_CATCH_YARDS = 25;

/** Seconds left in the fourth quarter (or any overtime) inside which a go-ahead score is a game winner. */
export const GAME_WINNER_WINDOW_SEC = 120;

/** True when `entry` put its scoring side ahead (from tied or behind) late in the fourth quarter or in overtime. */
export const isGoAheadLate = (entry: PlayLogEntry): boolean => {
  const o = entry.outcome;
  const side = o.scoringSide;
  if (!side || o.points <= 0) return false;
  const late = entry.quarter > 4 || (entry.quarter === 4 && entry.clock <= GAME_WINNER_WINDOW_SEC);
  if (!late) return false;
  const other: TeamSide = side === 'home' ? 'away' : 'home';
  const before = entry.scoreAfter[side] - o.points;
  return before <= entry.scoreAfter[other] && entry.scoreAfter[side] > entry.scoreAfter[other];
};

/** The kick a finished play was, from its result ('none' for scrimmage plays, fakes and place kicks). */
export const kickKindOf = (result: PlayOutcome['result'] | undefined): PlayContext['special'] =>
  result === 'kickoff' || result === 'onside' || result === 'punt' ? result : 'none';

/**
 * The accepted foul that wiped the play out (enforced from the previous spot or the spot of the foul), or null.
 * A kick-return foul never wipes the kick out (the receivers keep the ball and are walked back).
 */
export const nullifyingFoul = (outcome: Pick<PlayOutcome, 'penalties'> & Partial<Pick<PlayOutcome, 'result'>>): PenaltyInfo | null =>
  outcome.penalties.find((p) => p.accepted && isNullifying(p) && !isReturnFoul(p, kickKindOf(outcome.result))) ?? null;

/** True when the play's touchdown stands (a touchdown wiped out by an accepted foul does not count). */
export const scoredTouchdown = (outcome: Pick<PlayOutcome, 'touchdown' | 'penalties'>): boolean => outcome.touchdown && nullifyingFoul(outcome) === null;

/** The most important highlight kind of a play, or null when it is routine (or was wiped out by a foul). */
export const highlightKind = (outcome: PlayOutcome, entry: PlayLogEntry | null = null): HighlightKind | null => {
  if (outcome.result === 'penalty' || nullifyingFoul(outcome)) return null;
  if (entry && isGoAheadLate(entry)) return 'gameWinner';
  if (outcome.touchdown) return 'touchdown';
  if (outcome.turnoverType === 'interception') return 'interception';
  if (outcome.turnoverType === 'fumble') return 'fumble';
  if (outcome.result === 'pass' && outcome.yards >= LONG_CATCH_YARDS) return 'longCatch';
  if ((outcome.result === 'run' || outcome.result === 'scramble') && outcome.yards >= LONG_RUN_YARDS) return 'longRun';
  if (outcome.result === 'sack') return 'sack';
  if (outcome.events.some((e) => e.type === 'tackle' && e.kind === 'hitStick')) return 'bigHit';
  return null;
};

/** One kept highlight. */
export interface Highlight {
  id: string;
  kind: HighlightKind;
  title: string;
  /** "Q4 1:12 · 34 yds" style detail. */
  detail: string;
  recording: ReplayRecording;
}

const clockText = (sec: number): string => {
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

/** Detail line of a highlight. */
export const highlightDetail = (entry: PlayLogEntry): string => {
  const q = entry.quarter > 4 ? `OT${entry.quarter > 5 ? entry.quarter - 4 : ''}` : `Q${entry.quarter}`;
  const yds = Math.round(entry.outcome.yards);
  return `${q} ${clockText(entry.clock)} · ${yds >= 0 ? yds : `-${Math.abs(yds)}`} YDS`;
};

/** Default number of highlights a reel keeps. */
export const REEL_SIZE = 12;

/** The current game's highlights, in play order. */
export class HighlightReel {
  private readonly items: Highlight[] = [];

  constructor(readonly capacity = REEL_SIZE) {}

  get list(): readonly Highlight[] {
    return this.items;
  }

  get size(): number {
    return this.items.length;
  }

  /**
   * Keeps the play when it is a highlight and has a recording (one entry per recording id). When full, the
   * least important oldest entry is dropped, or the new one is refused when it matters least. Returns the kept
   * highlight or null.
   */
  offer(entry: PlayLogEntry, recording: ReplayRecording | null): Highlight | null {
    if (!recording || this.capacity <= 0) return null;
    const kind = highlightKind(entry.outcome, entry);
    if (!kind || this.items.some((h) => h.id === recording.id)) return null;
    const item: Highlight = { id: recording.id, kind, title: HIGHLIGHT_TITLES[kind], detail: highlightDetail(entry), recording };
    if (this.items.length >= this.capacity) {
      let drop = 0;
      this.items.forEach((h, i) => {
        if (WEIGHT[h.kind] < WEIGHT[this.items[drop]?.kind ?? h.kind]) drop = i;
      });
      const weakest = this.items[drop];
      if (!weakest || WEIGHT[weakest.kind] > WEIGHT[kind]) return null;
      this.items.splice(drop, 1);
    }
    this.items.push(item);
    return item;
  }

  clear(): void {
    this.items.length = 0;
  }
}
