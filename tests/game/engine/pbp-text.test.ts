import { describe, expect, it } from 'vitest';
import { idleIntent, type AthleteIntent } from '@/game/engine-api';
import { buildPlayByPlay, dragLine, nameList } from '@/game/play-by-play';
import type { Athlete, PlayState } from '@/game/play-types';
import { deriveFacts } from '@/game/outcome';
import { catchLabel, distanceLabel, downDistanceLabel, foulLabel, humanizeId, incompleteLabel, kickLabel, yardsLabel } from '@/game/text-labels';
import { ahead, build, clearDefense, scripted, ticksSinceSnap, toward, trackBall } from './helpers';

const RAW_IDS = /highPoint|outOfBounds\)|roughingPasser|kickMade|extraPoint|fieldGoal|\(offense\)|\(defense\)|\b1 yards\b|\d+\.\d+/;

const throwAt = (target: string, after: number) => (a: Athlete, s: PlayState): AthleteIntent => {
  if (!a.hasBall || ticksSinceSnap(s) < after) return idleIntent('wait');
  return { ...idleIntent('throw'), action: 'throw', targetId: target, throwType: 'touch' };
};
/** A passer who really drops (straight back from where he took the snap until the throw) and then throws. */
const dropThenThrowAt = (target: string, after: number) => (a: Athlete, s: PlayState): AthleteIntent => {
  if (a.hasBall && ticksSinceSnap(s) < after) return { ...idleIntent('drop'), move: { x: 0, y: -s.ctx.direction }, sprint: true };
  return throwAt(target, after)(a, s);
};
const route = (a: Athlete, s: PlayState): AthleteIntent => (s.phase !== 'live' ? idleIntent('set') : !a.hasBall && s.ball.phase === 'inAir' ? trackBall(a, s) : ahead(s, 'offense'));

describe('text labels', () => {
  it('words ids and rounds the chains like the HUD', () => {
    expect(distanceLabel(12.5)).toBe('13');
    expect(distanceLabel(0.5)).toBe('1');
    expect(distanceLabel(4.773313513437941)).toBe('5');
    expect(distanceLabel(10)).toBe('10');
    expect(downDistanceLabel(1, 4.77, 95.23)).toBe('1st & Goal');
    expect(downDistanceLabel(2, 12.5, 40)).toBe('2nd & 13');
    expect(foulLabel('roughingPasser')).toBe('Roughing the passer');
    expect(catchLabel('highPoint', false)).toBe('leaping catch');
    expect(incompleteLabel('outOfBounds')).toBe('out of bounds');
    expect(kickLabel('extraPoint')).toBe('extra point');
    expect(humanizeId('shotgun-curls')).toBe('Shotgun Curls');
    expect(yardsLabel(1)).toBe('1 yard');
    expect(yardsLabel(7)).toBe('7 yards');
  });
});

describe('play-by-play wording', () => {
  it('a pass play narrates the dropback, uses the formation name and never prints raw ids or fractional yardage', () => {
    for (let seed = 1; seed <= 6; seed++) {
      const { engine } = build({ offensePlayId: 'shotgun-mesh', defensePlayId: '43-cover3-zone', seed, ruleset: 'arcade' }, { distance: 12.5, down: 2 }, {
        decider: scripted({ 'off:QB': dropThenThrowAt('off:WR2', 60), 'off:WR2': route }, clearDefense),
      });
      const o = engine.run();
      expect(o.playByPlay[0]).toMatch(/^2nd & 13 at /);
      expect(o.playByPlay[0]).not.toMatch(/\(shotgun\)/);
      expect(o.playByPlay.some((l) => /takes the snap and drops back/.test(l))).toBe(true);
      // A passer who never moves from where he took the snap does not "drop back".
      const still = build({ offensePlayId: 'shotgun-mesh', defensePlayId: '43-cover3-zone', seed, ruleset: 'arcade' }, {}, {
        decider: scripted({ 'off:QB': throwAt('off:WR2', 60), 'off:WR2': route }, clearDefense),
      }).engine.run();
      expect(still.playByPlay.some((l) => /takes the snap$/.test(l))).toBe(true);
      expect(still.playByPlay.some((l) => /drops back/.test(l))).toBe(false);
      for (const line of o.playByPlay) expect(line, line).not.toMatch(RAW_IDS);
    }
  });

  it('pressure on the passer is called out before the sack', () => {
    const { engine } = build({ offensePlayId: 'shotgun-mesh', defensePlayId: '43-cover3-zone', seed: 2, ruleset: 'arcade' }, {}, {
      decider: scripted({
        'off:QB': () => idleIntent('hold'),
        'def:CB1': (a, st) => (st.phase === 'live' ? toward(a, st.athletes.find((x) => x.id === 'off:QB')!.pos) : idleIntent('set')),
      }),
    });
    const o = engine.run(undefined, 60 * 20);
    expect(o.result).toBe('sack');
    const pressure = o.playByPlay.findIndex((l) => l.startsWith('Pressure coming from'));
    const sack = o.playByPlay.findIndex((l) => l.startsWith('SACKED'));
    expect(pressure).toBeGreaterThan(0);
    expect(pressure).toBeLessThan(sack);
  });

  it('a returned interception reports the return, not "no gain"', () => {
    const { engine } = build({ offensePlayId: 'shotgun-mesh', defensePlayId: '43-cover3-zone', seed: 3, ruleset: 'arcade' }, {}, {
      decider: scripted({ 'off:QB': throwAt('off:WR2', 60), 'off:WR2': route }, clearDefense),
    });
    engine.run();
    const s = engine.state;
    const env = engine.debugEnv();
    const facts = deriveFacts(s, env);
    const carrier = s.athletes.find((a) => a.side === 'defense')!;
    const tackler = s.athletes.find((a) => a.side === 'offense')!;
    const intFacts = { ...facts, turnover: true, turnoverType: 'interception' as const, incomplete: false, touchdown: false, safety: false, firstDown: false, yards: 0, returnYards: 12,
      tackle: { tackler: tackler.id, assists: [], kind: 'wrap' as const, carrier: carrier.id, pos: { x: 20, y: 50 }, tick: s.tick } };
    const last = buildPlayByPlay(s, env, intFacts).at(-1)!;
    expect(last).toMatch(/return of 12/);
    expect(last).not.toMatch(/no gain/);
  });

  it('rounds kick distances, words passes behind the line and says "First down" once', () => {
    const { engine } = build({ offensePlayId: 'shotgun-mesh', defensePlayId: '43-cover3-zone', seed: 3, ruleset: 'arcade' }, {}, {
      decider: scripted({ 'off:QB': throwAt('off:WR2', 60), 'off:WR2': route }, clearDefense),
    });
    engine.run();
    const s = engine.state;
    const env = engine.debugEnv();
    const qb = s.athletes.find((a) => a.role === 'QB')!.id;
    const wr = s.athletes.find((a) => a.role === 'WR2')!.id;
    s.events.push(
      { type: 'throw', tick: s.tick, thrower: qb, target: wr, throwType: 'bullet', airYards: -4.6, difficulty: 0.2 },
      { type: 'throw', tick: s.tick, thrower: qb, target: wr, throwType: 'bullet', airYards: 0.2, difficulty: 0.2 },
      { type: 'firstDown', tick: s.tick },
      { type: 'kickResult', tick: s.tick, kind: 'fieldGoal', made: true, distance: 48.97984864319636 },
    );
    const lines = buildPlayByPlay(s, env, { ...deriveFacts(s, env), firstDown: true, touchdown: false });
    expect(lines).toContain(`${s.athletes.find((a) => a.id === qb)!.name} throws a bullet to ${s.athletes.find((a) => a.id === wr)!.name}, 5 yards behind the line`);
    expect(lines.some((l) => l.endsWith(', at the line'))).toBe(true);
    expect(lines).toContain('The 49-yard field goal is GOOD');
    expect(lines.filter((l) => /^First down/.test(l))).toEqual(['First down.']);
    for (const line of lines) expect(line, line).not.toMatch(/-\d+ yards? downfield|\d+\.\d+/);
  });

  it('an untouched dive reads as a dive, a real slide as a slide', () => {
    const { engine } = build({ offensePlayId: 'shotgun-mesh', defensePlayId: '43-cover3-zone', seed: 3, ruleset: 'arcade' }, {}, {
      decider: scripted({ 'off:QB': throwAt('off:WR2', 60), 'off:WR2': route }, clearDefense),
    });
    engine.run();
    const s = engine.state;
    const env = engine.debugEnv();
    const facts = { ...deriveFacts(s, env), tackle: null, outOfBounds: false, touchdown: false, safety: false, incomplete: false, turnover: false, firstDown: false };
    s.deadReason = 'slide';
    s.events = s.events.filter((e) => e.type !== 'slide');
    expect(buildPlayByPlay(s, env, facts).at(-1)).toMatch(/\(the runner dives\)/);
    s.events.push({ type: 'slide', tick: s.tick, athlete: s.athletes[0]!.id });
    expect(buildPlayByPlay(s, env, facts).at(-1)).toMatch(/\(the runner slides\)/);
  });
});


describe('tackle struggle narration', () => {
  it('names gang tacklers and the yards a runner drags defenders', () => {
    expect(nameList(['Ames'])).toBe('Ames');
    expect(nameList(['Ames', 'Boyd'])).toBe('Ames and Boyd');
    expect(nameList(['Ames', 'Boyd', 'Cole'])).toBe('Ames, Boyd and Cole');
    expect(dragLine('Diaz', ['Ames'], 3.4)).toBe('Diaz drags Ames for 3 more yards');
    expect(dragLine('Diaz', ['Ames', 'Boyd'], 4)).toBe('Diaz drags two defenders for 4 more yards');
    expect(dragLine('Diaz', ['Ames'], 1)).toBe('Diaz drags Ames for 1 more yard');
    // Less than a yard while held is not worth a line.
    expect(dragLine('Diaz', ['Ames'], 0.4)).toBeNull();
    expect(dragLine('Diaz', [], 5)).toBeNull();
  });
});
