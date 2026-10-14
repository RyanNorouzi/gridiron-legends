import { describe, expect, it } from 'vitest';
import { registerAll } from '@/ai/register';
import { disguisePlan, disguiseRate, fooledByDisguise, MAX_DISGUISE_SHIFT, shellOf, shownCall } from '@/ai/disguise';
import { perceivedDefense } from '@/ai/qb';
import { dist, type Vec2 } from '@/core/vec2';
import type { Athlete, PlayState } from '@/game/play-types';
import type { DifficultyId } from '@/game/types';
import { build } from '../../game/engine/helpers';

registerAll();

const setup = (defensePlayId: string, seed: number, difficulty: DifficultyId = 'legend', userSide: 'home' | 'away' | null = null) =>
  build({ offensePlayId: 'shotgun-mesh', defensePlayId, seed, ballOn: 35, difficulty, userSide, controlRole: userSide ? 'FS' : null });

const depth = (s: PlayState, p: Vec2): number => s.ctx.direction * (p.y - s.losY);
const safeties = (s: PlayState): Athlete[] => s.athletes.filter((a) => a.side === 'defense' && (a.position === 'FS' || a.position === 'SS'));

/** Seeds whose snap the defense disguises at `difficulty` (plan made from the presnap state). */
const disguisedSeeds = (defensePlayId: string, difficulty: DifficultyId, n = 80): number[] => {
  const out: number[] = [];
  for (let seed = 1; seed <= n; seed++) if (disguisePlan(setup(defensePlayId, seed, difficulty).engine.state).disguised) out.push(seed);
  return out;
};

describe('pre-snap disguise', () => {
  it('legend disguises far more often than rookie, and the rate climbs with play-calling IQ', () => {
    expect(disguiseRate(0.35)).toBeLessThan(0.12);
    expect(disguiseRate(0.9)).toBeGreaterThan(0.5);
    const legend = disguisedSeeds('43-cover2-zone', 'legend').length / 80;
    const rookie = disguisedSeeds('43-cover2-zone', 'rookie').length / 80;
    expect(legend).toBeGreaterThan(0.4);
    expect(rookie).toBeLessThan(0.2);
    expect(legend - rookie).toBeGreaterThan(0.25);
  });

  it('never disguises a man-carrying safety, the goal line, or a human-called defense', () => {
    expect(disguisedSeeds('43-cover1-man', 'legend', 40)).toEqual([]);
    expect(disguisedSeeds('goalLine-cover1-runStop', 'legend', 40)).toEqual([]);
    for (let seed = 1; seed <= 40; seed++) expect(disguisePlan(setup('43-cover2-zone', seed, 'legend', 'away').engine.state).disguised).toBe(false);
  });

  it('a two-high call walks a safety down to show single-high, then rotates back deep after the snap', () => {
    const seed = disguisedSeeds('43-cover2-zone', 'legend')[0] as number;
    const { engine } = setup('43-cover2-zone', seed);
    const s = engine.state;
    const plan = disguisePlan(s);
    expect(plan).toMatchObject({ disguised: true, shown: 'singleHigh', real: 'twoHigh' });
    const start = new Map(safeties(s).map((a) => [a.id, { ...a.pos }]));
    for (const [id, spot] of Object.entries(plan.spots)) expect(dist(start.get(id) as Vec2, spot)).toBeLessThanOrEqual(MAX_DISGUISE_SHIFT + 1e-6);
    let guard = 0;
    while (s.phase === 'presnap' && guard++ < 600) engine.tick({});
    expect(s.phase).toBe('live');
    const [downId] = Object.entries(plan.spots).sort((a, b) => depth(s, a[1]) - depth(s, b[1]))[0] as [string, Vec2];
    const down = s.athletes.find((a) => a.id === downId) as Athlete;
    const atSnap = depth(s, down.pos);
    expect(atSnap).toBeLessThan(depth(s, start.get(downId) as Vec2) - 1.5);
    for (let i = 0; i < 72 && !engine.isDead; i++) engine.tick({});
    // His real job is a deep half: he has turned and bailed toward it.
    expect(depth(s, down.pos)).toBeGreaterThan(atSnap + 2);
  });

  it('shows the opposite shell; a quarterback who misreads it sees the shown call (no blitz, zone)', () => {
    const seed = disguisedSeeds('43-cover1-safetyBlitz', 'legend')[0] as number;
    const s = setup('43-cover1-safetyBlitz', seed).engine.state;
    const plan = disguisePlan(s);
    expect(shellOf(s.ctx.defensivePlay.coverage)).toBe('singleHigh');
    expect(plan.shown).toBe('twoHigh');
    const shown = shownCall(s.ctx.defensivePlay, plan);
    expect(shown).toMatchObject({ coverage: 'cover2', family: 'zone', blitz: 'none' });
    expect(fooledByDisguise(s, 'off:QB', 1)).toBe(false);
    expect(fooledByDisguise(s, 'off:QB', 0)).toBe(true);
    // The QB's read (awareness blended with qbDecisionQuality) decides which call he audibles against.
    const qb = s.athletes.find((a) => a.side === 'offense' && a.assignment.type === 'qb') as Athlete;
    const seen = perceivedDefense(qb, s);
    expect([s.ctx.defensivePlay.blitz, 'none']).toContain(seen.blitz);
    // An honest shell is read as called.
    const honestSeed = [...Array(80).keys()].map((i) => i + 1).find((k) => !disguisePlan(setup('43-cover1-safetyBlitz', k).engine.state).disguised) as number;
    const hs = setup('43-cover1-safetyBlitz', honestSeed).engine.state;
    disguisePlan(hs);
    expect(perceivedDefense(hs.athletes.find((a) => a.side === 'offense' && a.assignment.type === 'qb') as Athlete, hs)).toBe(hs.ctx.defensivePlay);
  });
});
