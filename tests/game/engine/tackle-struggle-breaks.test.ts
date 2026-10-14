import { describe, expect, it } from 'vitest';
import { registerAll } from '@/ai/register';
import type { IntentAction } from '@/game/engine-api';
import type { PlayState } from '@/game/play-types';
import { churn, posePile, runPile, type Body } from './struggle-harness';

registerAll();

/**
 * Breaking free of a tackle struggle in the live engine: the break rate follows the ratings (a star back's moves shed
 * a scrub's arm tackle; a weak back never escapes an elite tackler's wrap), and the play-by-play says he broke free.
 */

const STAR_BACK: Body = { massLb: 215, attrs: { agility: 95, balance: 95, strength: 88, carrying: 90, acceleration: 92 } };
const WEAK_BACK: Body = { massLb: 190, attrs: { agility: 45, balance: 40, strength: 40, carrying: 50 } };
const SCRUB: Body = { massLb: 180, attrs: { tackling: 35, strength: 40, balance: 45 } };
const ELITE: Body = { massLb: 245, attrs: { tackling: 97, strength: 92, balance: 90 } };

/** The runner churns and tries `move` whenever he can. */
const moving = (move: IntentAction) => ({ 'off:RB': (_a: unknown, s: PlayState) => ({ ...churn(s), action: move }) });

const breaks = (carrierBody: Body, tacklerBody: Body, kind: 'arm' | 'wrap', hold: number, move: IntentAction, n = 30): { rate: number; pbp: string[][] } => {
  let broke = 0;
  let runs = 0;
  const pbp: string[][] = [];
  for (let seed = 1; seed <= n; seed++) {
    const p = posePile({ seed, tacklerIds: ['def:CB1'], kind, hold, carrierBody, tacklerBody, script: moving(move) });
    if (!p) continue;
    const tr = runPile(p);
    runs += 1;
    const s = p.built.engine.state;
    if (s.events.some((e) => e.type === 'brokenTackle' && e.defender === 'def:CB1')) {
      broke += 1;
      pbp.push(tr.outcome.playByPlay);
    }
  }
  return { rate: broke / Math.max(1, runs), pbp };
};

describe('breaking free of a struggle', () => {
  it('a star back sheds a scrub far more often than a weak back escapes an elite tackler', () => {
    const star = breaks(STAR_BACK, SCRUB, 'arm', 0.5, 'spin');
    const weak = breaks(WEAK_BACK, ELITE, 'wrap', 1.2, 'spin');
    expect(star.rate).toBeGreaterThan(0.3);
    expect(weak.rate).toBeLessThan(0.1);
    // A strong back's stiff-arm / truck works too; the play-by-play calls it breaking free, not a missed tackle.
    const truck = breaks(STAR_BACK, SCRUB, 'arm', 0.5, 'truck');
    expect(truck.rate).toBeGreaterThan(0.3);
    expect(star.pbp.some((lines) => lines.some((l) => / breaks free from .+'s tackle/.test(l)))).toBe(true);
  });
});
