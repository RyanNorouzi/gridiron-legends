import { dist } from '@/core/vec2';
import type { AthleteIntent, IntentDecider } from '@/game/engine-api';
import type { Athlete, PlayState } from '@/game/play-types';
import type { ZoneName } from '@/playbook/types';
import { isDeepZone, zoneLandmark } from '@/playbook/zones';
import { commonIntent, defenderJitter, depthOf, mem, perceive, rf, type Perception } from './defense-shared';
import { trackIntent } from './coverage-man';
import { zoneCoverIntent, zoneOf } from './coverage-zone';
import { difficultyFor } from '@/game/difficulty-sides';

/**
 * Match (pattern-match) coverage, used when the defensive play's family is 'match'. Defenders start on their
 * zone landmarks and convert to man on the receiver who threatens their zone vertically: a deep defender
 * locks onto the vertical stem entering his band, an underneath defender carries a vertical #2 until he
 * hands him to the deep player. A receiver who breaks off short or leaves the band releases the defender back
 * to zone rules. Recognising the vertical stem takes reaction time shortened by coverageAnticipation.
 */

const VERTICAL_SPEED = 3.5;

/** True when the receiver is a vertical threat to this zone right now. */
const isVerticalThreat = (state: PlayState, zone: ZoneName, r: Athlete): boolean => {
  const dir = state.ctx.direction;
  const lm = zoneLandmark(zone, state.losY, dir);
  const deep = isDeepZone(zone);
  if (r.state === 'blocking' || r.state === 'engaged') return false;
  const ahead = r.pos.x + r.vel.x * 0.5;
  const inBand = Math.abs(r.pos.x - lm.center.x) <= lm.halfWidth + 2 || Math.abs(ahead - lm.center.x) <= lm.halfWidth + 2;
  if (!inBand) return false;
  const depth = depthOf(state, r.pos);
  const vertical = dir * r.vel.y;
  if (deep) return vertical >= VERTICAL_SPEED && (depth >= 6 || (depth >= 4 && vertical >= 4.5));
  return vertical >= VERTICAL_SPEED && depth >= 3 && depth <= lm.depthMax + 2;
};

/** Should a locked defender keep carrying this receiver? */
const keepCarrying = (athlete: Athlete, state: PlayState, zone: ZoneName, r: Athlete): boolean => {
  const s = athlete.ai.scratch;
  const dir = state.ctx.direction;
  const lm = zoneLandmark(zone, state.losY, dir);
  if (!r.active) return false;
  const depth = depthOf(state, r.pos);
  const vertical = dir * r.vel.y;
  if (!isDeepZone(zone) && depth > lm.depthMax + 2) return false;
  if (Math.abs(r.pos.x - lm.center.x) > lm.halfWidth + 7) return false;
  if (vertical < 1) {
    if (mem(s, 'matchSlowAt', -1) < 0) s.matchSlowAt = state.time;
    if (state.time - mem(s, 'matchSlowAt', state.time) > 0.4 && depth < lm.depthMin) return false;
  } else {
    s.matchSlowAt = -1;
  }
  return true;
};

/** Best vertical threat not already carried by a closer match defender. */
const matchCandidate = (athlete: Athlete, state: PlayState, p: Perception, zone: ZoneName): Athlete | null => {
  let best: Athlete | null = null;
  let bestScore = -Infinity;
  for (const r of p.view.receivers) {
    if (!isVerticalThreat(state, zone, r)) continue;
    const idx = state.athletes.indexOf(r);
    const taken = p.view.defense.some((d) => d !== athlete && d.active && mem(d.ai.scratch, 'matchIdx', -1) === idx && dist(d.pos, r.pos) < dist(athlete.pos, r.pos));
    if (taken) continue;
    const score = depthOf(state, r.pos) + state.ctx.direction * r.vel.y - dist(r.pos, athlete.pos) * 0.3;
    if (score > bestScore) { bestScore = score; best = r; }
  }
  return best;
};

/** Match-coverage intent for one zone: zone landmarks until a vertical threat converts the defender to man. */
export const matchCoverIntent = (athlete: Athlete, state: PlayState, dt: number, p: Perception, zone: ZoneName): AthleteIntent => {
  const s = athlete.ai.scratch;
  if (state.phase !== 'live') return zoneCoverIntent(athlete, state, p, zone);
  const c = p.carrier;
  const ballPlay = (p.view.ballInAir && p.passSeen) || (c !== null && c.position !== 'QB') || (p.recognizedRun && c !== null) || athlete.state === 'engaged';
  if (ballPlay) {
    s.matchIdx = -1;
    return zoneCoverIntent(athlete, state, p, zone);
  }
  const idx = mem(s, 'matchIdx', -1);
  let locked: Athlete | null = idx >= 0 ? state.athletes[idx] ?? null : null;
  if (locked && !keepCarrying(athlete, state, zone, locked)) {
    locked = null;
    s.matchIdx = -1;
    s.matchCueAt = -1;
  }
  if (!locked) {
    const cand = matchCandidate(athlete, state, p, zone);
    if (cand) {
      const candIdx = state.athletes.indexOf(cand);
      if (mem(s, 'matchCueIdx', -1) !== candIdx) {
        s.matchCueIdx = candIdx;
        s.matchCueAt = state.time;
      }
      const anticipation = difficultyFor(state, athlete).coverageAnticipation * (0.6 + 0.4 * rf(athlete.attrs.awareness));
      const delay = p.reaction * (1.2 - anticipation) + defenderJitter(athlete, 'matchDelay', 0.03);
      if (state.time - mem(s, 'matchCueAt', state.time) >= delay) {
        locked = cand;
        s.matchIdx = candIdx;
        s.matchSlowAt = -1;
        athlete.ai.targetAthleteId = cand.id;
      }
    } else {
      s.matchCueIdx = -1;
    }
  }
  if (locked) return trackIntent(athlete, locked, state, dt, p, { technique: 'off', hasHelp: isDeepZone(zone), label: `match ${locked.role}` });
  return zoneCoverIntent(athlete, state, p, zone);
};

/** 'defense:zone' decider: match rules for match-family calls, plain zone otherwise. */
export const decideZone: IntentDecider = (athlete, state, dt) => {
  const p = perceive(athlete, state);
  const common = commonIntent(athlete, state, p.view);
  if (common) return common;
  const zone = zoneOf(athlete);
  if (state.ctx.defensivePlay.family === 'match') return matchCoverIntent(athlete, state, dt, p, zone);
  return zoneCoverIntent(athlete, state, p, zone);
};
