/**
 * Crowd reaction cues (pure): turns the synth's crowd triggers (crowdCheer / crowdRoar / crowdGroan, already
 * resolved for which team the crowd supports) into recorded reactions, and adds the reactions the synth
 * never had: boos for flags on the home side, an "oooh" on big hits, horns and drums for home scores and
 * takeaways, and an anticipation swell while a deep ball is in the air.
 */
import type { PlayEvent } from '@/game/play-events';
import { otherSide, type Side, type TeamSide } from '@/game/types';
import type { AudioGameEvent, EventContext, SoundTrigger } from './manager';
import type { ContactTier, SampleCue } from './sample-cues';
import type { SampleId } from './sample-manifest';
import type { SoundId } from './sounds';

/** Event context plus what the field layer just sounded. */
export interface CrowdCueContext extends EventContext {
  /** Hardest contact the field layer sounded for this event (null = no contact). */
  tier: ContactTier | null;
}

/** Air yards from which a throw lifts the crowd into an anticipation swell. */
export const SWELL_AIR_YARDS = 20;

const cue = (id: SampleId, gain: number, delayMs = 0): SampleCue => ({ id, gain, delayMs, pan: 0 });

const teamOf = (side: Side | null, ctx: EventContext): TeamSide | null =>
  side === null || ctx.offense === null ? null : side === 'offense' ? ctx.offense : otherSide(ctx.offense);

/** Recorded equivalent of one synth crowd trigger. */
export const crowdCueForTrigger = (t: SoundTrigger): SampleCue | null => {
  switch (t.id) {
    case 'crowdRoar': return cue('crowd.roar', t.volume);
    case 'crowdCheer': return t.volume >= 0.55 ? cue('crowd.cheer', t.volume) : cue('crowd.applause', Math.min(1, t.volume * 1.3));
    case 'crowdGroan': return cue('crowd.groan', t.volume);
    default: return null;
  }
};

/** The team a penalty was called on (null when unknown). */
const flaggedTeam = (e: Extract<PlayEvent, { type: 'penalty' }>, ctx: EventContext): TeamSide | null => {
  const s = e.penalty && typeof e.penalty === 'object' ? e.penalty.side : null;
  return s === 'offense' || s === 'defense' ? teamOf(s, ctx) : null;
};

/** Which team scored / took the ball, for the extra stings. */
const beneficiary = (e: AudioGameEvent, ctx: EventContext): TeamSide | null => {
  switch (e.type) {
    case 'touchdown': return e.side === 'offense' || e.side === 'defense' ? teamOf(e.side, ctx) : null;
    case 'score': return e.points >= 6 ? e.teamSide : null;
    case 'interception': return teamOf('defense', ctx);
    case 'recovery': return e.side === 'defense' ? teamOf('defense', ctx) : null;
    case 'gameOver': return e.winner;
    default: return null;
  }
};

/** Recorded crowd cues for an event given the synth triggers it produced. */
export const crowdCuesForEvent = (event: AudioGameEvent, triggers: readonly SoundTrigger[], cx: CrowdCueContext): SampleCue[] => {
  const out: SampleCue[] = [];
  const flaggedHome = event.type === 'penalty' && flaggedTeam(event, cx) === cx.crowdSide;
  for (const t of triggers) {
    const c = crowdCueForTrigger(t);
    if (!c) continue;
    // A flag on the crowd's team draws boos instead of a groan.
    out.push(flaggedHome && c.id === 'crowd.groan' ? cue('crowd.boo', Math.max(0.6, c.gain)) : c);
  }
  if (cx.tier === 'big') out.push(cue('crowd.oooh', 0.85, 120));
  const team = beneficiary(event, cx);
  if (team !== null && team === cx.crowdSide) {
    if (event.type === 'touchdown' || event.type === 'score' || event.type === 'gameOver') out.push(cue('crowd.horn', 0.8, 350));
    else out.push(cue('crowd.drum', 0.8, 150));
  } else if (team !== null && (event.type === 'touchdown' || event.type === 'score')) {
    out.push(cue('crowd.boo', 0.35, 900));
  }
  if (event.type === 'throw' && typeof event.airYards === 'number' && event.airYards >= SWELL_AIR_YARDS && event.throwType !== 'throwAway') {
    out.push(cue('crowd.swell', 0.75));
  }
  if (event.type === 'kick' && event.kind === 'kickoff') out.push(cue('crowd.drum', 0.55));
  if (event.type === 'kickBlocked' && teamOf('defense', cx) === cx.crowdSide) out.push(cue('crowd.drum', 0.7, 200));
  return dedupe(out);
};

/** One cue per id (the loudest), so two triggers never stack the same recording. */
const dedupe = (cues: readonly SampleCue[]): SampleCue[] => {
  const best = new Map<SampleId, SampleCue>();
  for (const c of cues) {
    const prev = best.get(c.id);
    if (!prev || c.gain > prev.gain) best.set(c.id, c);
  }
  return [...best.values()];
};

/** Synth ids a ready recording replaces outright (a real whistle / crowd instead of the chip-tune one). */
export const REPLACED_BY: Readonly<Partial<Record<SoundId, readonly SampleId[]>>> = Object.freeze({
  whistle: ['sfx.whistle_short', 'sfx.whistle_long'],
  crowdCheer: ['crowd.cheer', 'crowd.applause'],
  crowdRoar: ['crowd.roar'],
  // A flag on the crowd's own team turns the groan into boos (crowdCuesForEvent), which replace it too.
  crowdGroan: ['crowd.groan', 'crowd.boo'],
});

/** Synth ids that keep sounding UNDER the recordings (the arcade layer the owner asked to keep), softened. */
export const LAYERED_UNDER: ReadonlySet<SoundId> = new Set<SoundId>(['tackle', 'bigHit', 'hitStick', 'sack', 'catch', 'snap', 'kickoff', 'punt', 'fumble']);

/** Synth gain multiplier for a layered sound when recordings played for the same event. */
export const SYNTH_UNDER_SAMPLES = 0.55;
