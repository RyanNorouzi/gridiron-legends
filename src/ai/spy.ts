import { dist } from '@/core/vec2';
import type { AthleteIntent, IntentDecider } from '@/game/engine-api';
import type { Athlete, PlayState } from '@/game/play-types';
import {
  clampPoint, commonIntent, defenderNoise, depthOf, faceToward, localX, perceive, presnapIntent, seekIntent, engagedIntent,
  type Perception,
} from './defense-shared';
import { playBallIntent } from './coverage-man';
import { tackleIntent } from './tackling';

/**
 * QB spy. Mirrors the quarterback laterally from a shallow depth (4-6 yd, per athlete), squares up to him and
 * attacks the moment he crosses the line of scrimmage or breaks the pocket toward it. Otherwise he helps
 * underneath: shading toward a receiver settling near him and breaking on short throws. A recognised run
 * turns him into a pursuit player.
 */

/** Spy depth for this athlete (4..6 yd beyond the LOS). */
export const spyDepth = (athlete: Athlete): number => 4 + 2 * defenderNoise(athlete, 'spyDepth');

/** Spy intent (also used by run fill when the call asks the linebacker to spy on pass). */
export const spyIntent = (athlete: Athlete, state: PlayState, p: Perception): AthleteIntent => {
  const dir = state.ctx.direction;
  const view = p.view;
  const qb = view.qb;
  if (state.phase !== 'live') return presnapIntent(athlete, state, 'spy');
  if (!qb) return presnapIntent(athlete, state, 'spy (no qb)');
  if (athlete.state === 'engaged') return engagedIntent(athlete, state, p, qb.pos, 'shed');
  const c = p.carrier;
  if (c && c.position !== 'QB') return tackleIntent(athlete, c, state, { leverage: 'inside' });
  if (view.ballInAir && p.passSeen) {
    const landing = p.landing ?? state.ball.pos;
    const target = state.ball.targetId ? view.receivers.find((r) => r.id === state.ball.targetId) ?? null : null;
    if (dist(landing, athlete.pos) < 6) return playBallIntent(athlete, state, p, target);
    return seekIntent(athlete, clampPoint(landing, 0.3), { sprint: true, effort: 0.9, debug: 'rally' });
  }
  const qbDepth = view.qbDepth;
  const towardLos = dir * qb.vel.y;
  const crossing = qbDepth > -0.3;
  const breaking = c === qb && (qb.state === 'scrambling' || (towardLos > 4 && qbDepth > -4) || (Math.abs(qb.vel.x) > 4.5 && Math.abs(localX(state, qb.pos.x)) > 5));
  if (crossing || breaking) return tackleIntent(athlete, qb, state, { leverage: crossing ? 'inside' : 'none' });
  const depth = spyDepth(athlete);
  let x = qb.pos.x + qb.vel.x * 0.3;
  let label = 'spy';
  let helped: Athlete | null = null;
  for (const r of view.receivers) {
    const rd = depthOf(state, r.pos);
    if (rd < 2 || rd > 10 || dist(r.pos, athlete.pos) > 6 || Math.hypot(r.vel.x, r.vel.y) > 2.5) continue;
    const covered = view.defense.some((d) => d !== athlete && d.active && dist(d.pos, r.pos) <= 3);
    if (!covered && (!helped || dist(r.pos, athlete.pos) < dist(helped.pos, athlete.pos))) helped = r;
  }
  if (helped) {
    x = (x + helped.pos.x) / 2;
    label = `spy / help ${helped.role}`;
  }
  const aim = clampPoint({ x, y: state.losY + dir * depth }, 0.5);
  return seekIntent(athlete, aim, { locomotion: 'strafe', face: faceToward(athlete.pos, qb.pos), slowRadius: 2, stopRadius: 0.3, debug: label });
};

/** 'defense:spy' decider. */
export const decideSpy: IntentDecider = (athlete, state) => {
  const p = perceive(athlete, state);
  const common = commonIntent(athlete, state, p.view);
  if (common) return common;
  return spyIntent(athlete, state, p);
};
