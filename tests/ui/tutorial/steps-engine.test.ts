/**
 * Interactive tutorial steps on the real engine and AI: each step's drill runs headless with scripted input and the
 * StepTracker + goalStatus detect the action the step asks for (and do not fire when the player does nothing).
 */
import { describe, expect, it } from 'vitest';
import { registerAll } from '@/ai/register';
import { dist, normalize, sub, vec2 } from '@/core/vec2';
import { ballCarrier, findAthlete } from '@/game/athlete';
import type { PlayState, UserPlayInput } from '@/game/play-types';
import { DEFAULT_DRILL_OPTIONS, DrillRep, buildDrillScenario, idlePlayInput } from '@/game/practice';
import { predictLanding } from '@/physics/ball';
import { steadyHandoff } from '@/ui/screens/practice-view';
import { goalStatus, StepTracker, type GoalStatus } from '@/ui/tutorial/goals';
import { TUTORIAL_STEPS, type InteractiveStep } from '@/ui/tutorial/steps';

registerAll();

const stepById = (id: string): InteractiveStep => {
  const s = TUTORIAL_STEPS.find((x) => x.id === id);
  if (!s || s.kind !== 'interactive') throw new Error(`no interactive step ${id}`);
  return s;
};

/** Runs one attempt of a step until its goal is decided (or 3000 ticks). */
const attempt = (id: string, seed: number, input: (s: PlayState, t: number) => UserPlayInput): { status: GoalStatus; rep: DrillRep } => {
  const step = stepById(id);
  const rep = new DrillRep(buildDrillScenario(step.drill, { ...DEFAULT_DRILL_OPTIONS, difficulty: step.difficulty }, seed, seed));
  const tracker = new StepTracker(rep.scenario.userSide, rep.focusId);
  let status: GoalStatus = 'pending';
  for (let t = 0; t < 3000 && status === 'pending'; t++) {
    rep.tick(input(rep.state, t));
    status = goalStatus(step.goal, tracker.observe(rep.state, rep.finished || rep.state.phase === 'dead'));
  }
  return { status, rep };
};

const snapOnly = (s: PlayState): UserPlayInput => ({ ...idlePlayInput(), snap: s.phase === 'presnap' });

describe('interactive tutorial steps on the engine', () => {
  it('switch player: done on the switch button, never without it', () => {
    for (const seed of [1, 2, 3]) expect(attempt('switch', seed, (_s, t) => ({ ...idlePlayInput(), switchPlayer: t === 5 })).status).toBe('done');
    expect(attempt('switch', 1, () => idlePlayInput()).status).toBe('failed');
  });

  it('catching: running under the JUGS throw catches it; a receiver who stands still misses some', () => {
    const chase = (s: PlayState): UserPlayInput => {
      const me = findAthlete(s, 'off:WR2');
      const i = snapOnly(s);
      if (!me || s.ball.phase !== 'inAir') return i;
      const d = sub(predictLanding(s.ball, s.ctx.weather, 1.2).pos, me.pos);
      return Math.hypot(d.x, d.y) < 0.3 ? i : { ...i, move: normalize(d), sprint: true };
    };
    const results = [1, 2, 3, 4].map((seed) => attempt('catching', seed, chase).status);
    expect(results.filter((r) => r === 'done').length).toBeGreaterThanOrEqual(3);
    // Nobody presses snap: the machine snaps on its own cadence and throws anyway; a receiver who never moves misses some.
    const idle = [1, 2, 3, 4].map((seed) => attempt('catching', seed, () => idlePlayInput()));
    expect(idle.every((r) => r.rep.state.events.some((e) => e.type === 'throw'))).toBe(true);
    expect(idle.filter((r) => r.status === 'failed').length).toBeGreaterThan(0);
  });

  it('tackling: closing and pressing tackle is detected; a safety who never moves fails the step', () => {
    const tackle = (s: PlayState): UserPlayInput => {
      const me = findAthlete(s, s.controlledIds.home ?? null);
      const c = ballCarrier(s);
      const i = idlePlayInput();
      if (!me || !c || c.side !== 'offense' || s.phase !== 'live') return i;
      return { ...i, move: normalize(sub(c.pos, me.pos)), sprint: true, tackle: dist(me.pos, c.pos) <= 1.6 };
    };
    const results = [1, 2, 4, 5].map((seed) => attempt('tackling', seed, tackle));
    expect(results.filter((r) => r.status === 'done').length).toBeGreaterThanOrEqual(3);
    for (const r of results.filter((x) => x.status === 'done')) expect(r.rep.state.events.some((e) => e.type === 'tackle')).toBe(true);
    expect(attempt('tackling', 1, () => idlePlayInput()).status).toBe('failed');
  });

  it('running: after the handoff the user carrier gains the yards; a quarterback who never snaps does not', () => {
    for (const seed of [0, 1, 2, 3]) {
      const r = attempt('running', seed, (s) => steadyHandoff({ ...snapOnly(s), move: vec2(0.15, 1), sprint: true }, s, 'home'));
      expect(r.status, `seed ${seed}`).toBe('done');
      expect(r.rep.state.events.some((e) => e.type === 'handoff' || e.type === 'pitch')).toBe(true);
      expect(r.rep.userIds.length).toBeGreaterThan(1);
    }
    expect(attempt('running', 0, () => idlePlayInput()).status).toBe('failed');
  });
});
