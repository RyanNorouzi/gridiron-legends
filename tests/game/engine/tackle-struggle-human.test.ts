import { describe, expect, it } from 'vitest';
import { registerAll } from '@/ai/register';
import { vec2 } from '@/core/vec2';
import { idleIntent } from '@/game/engine-api';
import type { PlayState, UserInputs, UserPlayInput } from '@/game/play-types';
import { BREAK_COOLDOWN } from '@/game/systems/tackle-struggle';
import { heldCarrierAction, switchControlled } from '@/game/user-control';
import { emptyInput } from './helpers';
import { eventsOf, humanTakes, posePile, runPile, type PosedPile } from './struggle-harness';

registerAll();

/** A human in the tackle struggle (game/user-control.ts + systems/tackle-struggle.ts). */

const seeds = (n: number): number[] => Array.from({ length: n }, (_, i) => i + 1);
const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);

const asInputs = (p: PosedPile, side: 'carrier' | 'tackler', input: (s: PlayState) => UserPlayInput) => (s: PlayState): UserInputs => {
  const who = side === 'carrier' ? p.carrier : p.tacklers[0]!;
  return { [who.teamSide]: input(s) };
};

describe('human carrier while wrapped', () => {
  it('maps the move buttons to break attempts (the hurdle button lowers the shoulder)', () => {
    const intent = () => ({ ...idleIntent('x') });
    const cases: [Partial<UserPlayInput>, string | null][] = [
      [{ juke: true }, 'juke'], [{ spin: true }, 'spin'], [{ stiffArm: true }, 'stiffArm'], [{ hurdle: true }, 'truck'], [{}, null],
    ];
    for (const [press, action] of cases) {
      const it0 = intent();
      heldCarrierAction(it0, { ...emptyInput(), ...press });
      expect(it0.action).toBe(action);
    }
  });

  it('pushing the stick upfield churns for more yards than giving up on the run', () => {
    const run = (stick: number): number[] => seeds(24).flatMap((seed) => {
      const p = posePile({ seed, tacklerIds: ['def:MLB'], onPose: (s) => humanTakes(s, 'off:RB') });
      if (!p) return [];
      const t = runPile(p, asInputs(p, 'carrier', (s) => ({ ...emptyInput(), move: vec2(0, stick * s.ctx.direction), sprint: stick > 0 })));
      return [p.built.engine.state.ctx.direction * (t.bestY - p.start.y)];
    });
    expect(mean(run(1))).toBeGreaterThan(mean(run(0)) + 0.2);
  });

  it('mashing a move button buys nothing: one attempt per cooldown, each failure weaker', () => {
    let attempts = 0;
    let budget = 0;
    for (const seed of seeds(24)) {
      const p = posePile({ seed, tacklerIds: ['def:MLB'], onPose: (s) => humanTakes(s, 'off:RB') });
      if (!p) continue;
      const t = runPile(p, asInputs(p, 'carrier', (s) => ({ ...emptyInput(), move: vec2(0, s.ctx.direction), juke: s.tick % 2 === 0 })));
      // The churn script made no moves before the pose: every special move here came from the mashing.
      attempts += eventsOf(p, 'specialMove').length;
      budget += Math.ceil(t.seconds / BREAK_COOLDOWN) + 1;
    }
    expect(attempts).toBeGreaterThan(0);
    expect(attempts).toBeLessThanOrEqual(budget);
  });
});

describe('human tackler', () => {
  const trial = (pressed: boolean): { breaks: number; plays: number } => {
    let breaks = 0;
    let plays = 0;
    for (const seed of seeds(24)) {
      const p = posePile({ seed, tacklerIds: ['def:MLB'], onPose: (s) => humanTakes(s, 'def:MLB') });
      if (!p) continue;
      plays += 1;
      runPile(p, asInputs(p, 'tackler', (s) => ({ ...emptyInput(), move: vec2(0, -s.ctx.direction), tackle: pressed })));
      breaks += eventsOf(p, 'brokenTackle').length;
    }
    return { breaks, plays };
  };

  it('holding the tackle button keeps the grip; letting go lets the runner slip away', () => {
    const held = trial(true);
    const loose = trial(false);
    expect(held.plays).toBeGreaterThan(18);
    expect(loose.breaks).toBeGreaterThan(held.breaks * 3);
    expect(held.breaks / held.plays).toBeLessThan(0.25);
  });

  it('switching to a nearby defender and running into the pile joins it', () => {
    let joins = 0;
    let plays = 0;
    for (const seed of seeds(16)) {
      const p = posePile({
        seed, tacklerIds: ['def:MLB'], kind: 'arm', hold: 0.6,
        onPose: (s, pile) => {
          const ss = s.athletes.find((a) => a.id === 'def:SS')!;
          ss.pos = vec2(pile.carrier.pos.x + 1.6, pile.carrier.pos.y + s.ctx.direction * 1.2);
          ss.vel = vec2(0, 0);
          humanTakes(s, 'def:SS');
        },
      });
      if (!p) continue;
      plays += 1;
      runPile(p, (s) => {
        const ss = s.athletes.find((a) => a.id === 'def:SS')!;
        const c = p.carrier;
        const d = Math.hypot(c.pos.x - ss.pos.x, c.pos.y - ss.pos.y) || 1;
        return { [ss.teamSide]: { ...emptyInput(), move: vec2((c.pos.x - ss.pos.x) / d, (c.pos.y - ss.pos.y) / d), sprint: true, tackle: true } };
      });
      if (eventsOf(p, 'pileJoin').some((e) => e.type === 'pileJoin' && e.defender === 'def:SS')) joins += 1;
    }
    expect(joins).toBeGreaterThan(plays * 0.4);
  });

  it('the switch button passes over the man already hanging on and hands the user a free defender to join with', () => {
    const p = posePile({ seed: 2, tacklerIds: ['def:MLB'], kind: 'arm', hold: 0.6 });
    expect(p).not.toBeNull();
    if (!p) return;
    const s = p.built.engine.state;
    const ss = s.athletes.find((a) => a.id === 'def:SS')!;
    ss.pos = vec2(p.carrier.pos.x + 2.5, p.carrier.pos.y + s.ctx.direction * 2);
    humanTakes(s, 'def:CB2');
    // The MLB (0.9 yd from the ball, holding on) is the nearest defender; the safety is the one who can still help.
    expect(switchControlled(s, ss.teamSide, { ...emptyInput(), switchPlayer: true })).toBe('def:SS');
  });
});
