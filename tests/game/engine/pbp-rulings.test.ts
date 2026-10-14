/** Play-by-play wording for rulings: spots near a goal line (H2-13), overturned scores (H2-14), plain broken tackles (H2-21). */
import { describe, expect, it } from 'vitest';
import { registerAll } from '@/ai/register';
import { vec2 } from '@/core/vec2';
import { makePenalty } from '@/game/outcome-factory';
import { deriveFacts, roughingOnCompletion } from '@/game/outcome';
import { buildPlayByPlay, eventsForRuling, yardLineLabel } from '@/game/play-by-play';
import type { PlayEvent } from '@/game/play-events';
import { build } from './helpers';

registerAll();

describe('play-by-play rulings', () => {
  it('a ball half a yard short of a goal line is on the 1, never "the end zone" or the 0', () => {
    expect(yardLineLabel(99.5)).toBe('the OPP 1');
    expect(yardLineLabel(0.047)).toBe('the OWN 1');
    expect(yardLineLabel(100)).toBe('the OPP end zone');
    expect(yardLineLabel(0)).toBe('the OWN end zone');
    expect(yardLineLabel(50.2)).toBe('the 50');
    expect(yardLineLabel(62)).toBe('the OPP 38');
  });

  it('an alternate ruling drops the moments the reversal takes back', () => {
    const events: PlayEvent[] = [
      { type: 'snap', tick: 1 },
      { type: 'catch', tick: 40, receiver: 'off:WR1', catchKind: 'possession', contested: false, ballOn: 60 } as PlayEvent,
      { type: 'touchdown', tick: 90, scorer: 'off:RB', side: 'offense' } as PlayEvent,
    ];
    const noTd = { touchdown: false, safety: false };
    expect(eventsForRuling(events, noTd).map((e) => e.type)).toEqual(['snap', 'catch', 'touchdown']);
    expect(eventsForRuling(events, noTd, { deadReason: 'tackle', deadSpot: vec2(20, 109.5), wipeCompletion: false }).map((e) => e.type)).toEqual(['snap', 'catch']);
    expect(eventsForRuling(events, noTd, { deadReason: 'incomplete', deadSpot: vec2(20, 70), wipeCompletion: true }).map((e) => e.type)).toEqual(['snap']);
  });

  it('an overturned touchdown reads as a stop short of the goal line', () => {
    const { engine } = build({ offensePlayId: 'iform-dive-right', defensePlayId: '43-cover3-zone', seed: 3, ballOn: 97 });
    engine.run();
    const s = engine.state;
    const env = engine.debugEnv();
    // Replay the dead state as a goal-line touchdown, then rule it down half a yard short.
    s.deadReason = 'touchdown';
    s.events.push({ type: 'touchdown', tick: s.tick, scorer: 'off:RB', side: 'offense' } as PlayEvent);
    const alt = { deadReason: 'tackle' as const, deadSpot: vec2(26, s.ctx.direction === 1 ? 109.5 : 10.5), wipeCompletion: false };
    const lines = buildPlayByPlay(s, env, deriveFacts(s, env, alt), alt).join(' / ');
    expect(lines).not.toMatch(/TOUCHDOWN|touchdown|end zone/);
    expect(lines).toMatch(/OPP 1|\b1\b/);
  });

  it('a broken tackle without a special move is not "with a none"', () => {
    const { engine } = build({ offensePlayId: 'iform-dive-right', defensePlayId: '43-cover3-zone', seed: 3, ballOn: 40 });
    engine.run();
    const s = engine.state;
    const env = engine.debugEnv();
    s.events.push({ type: 'brokenTackle', tick: s.tick, carrier: 'off:RB', defender: 'def:MLB', move: 'none' } as PlayEvent);
    s.events.push({ type: 'brokenTackle', tick: s.tick, carrier: 'off:RB', defender: 'def:SS', move: 'stiffArm' } as PlayEvent);
    const lines = buildPlayByPlay(s, env, deriveFacts(s, env));
    expect(lines.join(' / ')).not.toMatch(/with a none/);
    expect(lines.some((l) => /breaks .+'s tackle$/.test(l))).toBe(true);
    expect(lines.some((l) => /tackle with a stiff arm$/.test(l))).toBe(true);
  });
});

describe('roughing the passer (H2-18)', () => {
  it('on a completion the offense kept it is added to the end of the play; otherwise it wipes the play out', () => {
    const rough = makePenalty('roughingPasser');
    expect(roughingOnCompletion([rough], true)[0]!.enforcement).toBe('endOfPlay');
    expect(roughingOnCompletion([rough], false)[0]!.enforcement).toBe('previousSpot');
    expect(roughingOnCompletion([makePenalty('holdingOffense')], true)[0]!.enforcement).toBe('previousSpot');
  });
});
