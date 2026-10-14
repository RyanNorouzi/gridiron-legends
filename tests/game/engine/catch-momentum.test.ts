/**
 * A receiver who catches the ball in stride keeps his momentum (the owner: "when people catch they completely
 * unnaturally stop"): securing the catch no longer halves his top speed, he just cannot cut hard for a moment, so
 * three tenths of a second after the catch he is still running at most of the speed he caught it at.
 */
import { describe, expect, it } from 'vitest';
import { registerAll } from '@/ai/register';
import { len } from '@/core/vec2';
import { build } from './helpers';

registerAll();

describe('catching on the run', () => {
  it('keeps most of the receiver\'s speed through the catch', () => {
    const ratios: number[] = [];
    for (const [off, def] of [['shotgun-slants', '43-cover3-zone'], ['shotgun-mesh', '43-cover1-man'], ['singleback-curlFlat', '43-cover2-zone']] as const) {
      for (let seed = 1; seed <= 12; seed++) {
        const { engine } = build({ offensePlayId: off, defensePlayId: def, seed });
        let caughtAt: number | null = null;
        let receiver: string | null = null;
        let speedAtCatch = 0;
        for (let i = 0; i < 1200 && !engine.isDead; i++) {
          engine.tick({});
          const s = engine.state;
          if (caughtAt === null) {
            const c = s.events.find((e) => e.type === 'catch');
            if (c && c.type === 'catch') {
              caughtAt = s.tick;
              receiver = c.receiver;
              speedAtCatch = len(s.athletes.find((a) => a.id === receiver)!.vel);
            }
          } else if (s.tick === caughtAt + 18) {
            const r = s.athletes.find((a) => a.id === receiver)!;
            // Only clean catches in stride: still on his feet, untouched, caught at a run.
            if (speedAtCatch >= 4 && r.state !== 'tackled' && r.state !== 'wrapped' && r.state !== 'down' && r.state !== 'falling') ratios.push(len(r.vel) / speedAtCatch);
            break;
          }
        }
      }
    }
    expect(ratios.length).toBeGreaterThanOrEqual(8);
    ratios.sort((a, b) => a - b);
    const median = ratios[Math.floor(ratios.length / 2)] as number;
    expect(median).toBeGreaterThanOrEqual(0.8);
    // Nobody stops dead after a clean catch.
    expect(ratios.filter((r) => r < 0.4).length / ratios.length).toBeLessThan(0.15);
  }, 120_000);
});
