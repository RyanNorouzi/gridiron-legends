import { describe, expect, it } from 'vitest';
import { createPlayEngine } from '@/game/play-engine';
import {
  CATEGORIES, DEFAULT_DRILL_OPTIONS, DRILLS, OPTION_CHOICES, buildDrillScenario, cycleOption, drillGoal, drillsIn, getDrill, hashX,
  lineupFor, optionValueText, practiceSquad, windDirFor, type DrillOptions,
} from '@/game/practice';
import { fieldGoalDistance } from '@/playbook/special-teams';
import { HASH_LEFT, HASH_RIGHT, MIDDLE_X, fieldY } from '@/game/types';
import { DIFFICULTY_IDS } from '@/game/rulesets';

const opts = (o: Partial<DrillOptions> = {}): DrillOptions => ({ ...DEFAULT_DRILL_OPTIONS, ...o });

describe('drill catalogue', () => {
  it('covers passing, running, catching, coverage, tackling, kicking and punting across the three categories', () => {
    expect(DRILLS.map((d) => d.id).sort()).toEqual(['catching', 'coverage', 'fieldGoal', 'passMan', 'passRoutes', 'passZone', 'punting', 'running', 'tackling', 'zoneCoverage']);
    for (const c of CATEGORIES) expect(drillsIn(c).length).toBeGreaterThan(0);
    expect(drillsIn('defense').every((d) => d.userUnit === 'defense')).toBe(true);
    expect(getDrill('passRoutes').defensePlay).toBeNull();
    expect(() => getDrill('nope' as never)).toThrow(/unknown drill/);
  });

  it('every drill builds a valid PlayContext at every difficulty, and the engine accepts it', () => {
    for (const def of DRILLS) {
      for (const difficulty of DIFFICULTY_IDS) {
        const sc = buildDrillScenario(def, opts({ difficulty }), 42, 0);
        const ctx = sc.ctx;
        expect(ctx.difficulty.id).toBe(difficulty);
        expect(ctx.ruleset.penalties).toBe(false);
        expect(ctx.ruleset.injuries).toBe(false);
        expect(ctx.userSide).toBe('home');
        expect(ctx.userControl).toBe(def.userUnit);
        expect(ctx.offense).toBe(def.userUnit === 'offense' ? 'home' : 'away');
        expect(ctx.controllers.home).toBe(def.control === 'engine' ? 'human' : 'ai');
        expect(ctx.controllers.away).toBe('ai');
        expect(def.offensePlays).toContain(ctx.offensivePlay.id);
        // Every formation slot has a player and an assignment.
        for (const slot of sc.formation.slots) {
          expect(ctx.offenseLineup[slot.role]).toBeDefined();
          expect(ctx.offensivePlay.assignments[slot.role]).toBeDefined();
        }
        if (def.defensePlay) {
          const form = sc.registries.defensiveFormations?.[ctx.defensivePlay.formation];
          expect(form).toBeDefined();
          for (const slot of form!.slots) expect(ctx.defenseLineup[slot.role]).toBeDefined();
        } else expect(Object.keys(ctx.defenseLineup)).toHaveLength(0);
        if (def.evaluator === 'completion') expect(sc.receiverSlots.length).toBeGreaterThan(1);
        const engine = createPlayEngine(ctx, { registries: sc.registries });
        expect(engine.state.phase).toBe('presnap');
        expect(engine.state.losY).toBeCloseTo(fieldY(ctx.ballOn, ctx.direction));
        if (def.control === 'engine') expect(engine.state.controlledIds.home).toBeDefined();
      }
    }
  });

  it('the kicking drills honour distance, line, hash and wind', () => {
    const fg = buildDrillScenario(getDrill('fieldGoal'), opts({ kickDistance: 45, hash: 'left', wind: 'headwind', windMph: 15 }), 3);
    expect(fg.ctx.special).toBe('fieldGoal');
    expect(fieldGoalDistance(fg.ctx.ballOn)).toBe(45);
    expect(fg.ctx.ballX).toBe(HASH_LEFT);
    expect(fg.ctx.weather.windMph).toBe(15);
    expect(fg.ctx.weather.type).toBe('wind');
    // Headwind blows back toward the kicker (the offense attacks +y).
    expect(Math.sin(fg.ctx.weather.windDir)).toBeCloseTo(-1);
    const calm = buildDrillScenario(getDrill('fieldGoal'), opts({ wind: 'calm' }), 3);
    expect(calm.ctx.weather.windMph).toBe(0);
    const punt = buildDrillScenario(getDrill('punting'), opts({ puntFrom: 25, hash: 'right' }), 3);
    expect(punt.ctx.special).toBe('punt');
    expect(punt.ctx.ballOn).toBe(25);
    expect(punt.ctx.ballX).toBe(HASH_RIGHT);
    // Scrimmage drills ignore kicking options and snap from the middle with clear skies.
    const pass = buildDrillScenario(getDrill('passZone'), opts({ hash: 'left', wind: 'tailwind' }), 3);
    expect(pass.ctx.ballX).toBe(MIDDLE_X);
    expect(pass.ctx.weather.windMph).toBe(0);
    expect(hashX('left', -1)).toBe(HASH_RIGHT);
    expect(Math.cos(windDirFor('crossRight', 1))).toBeCloseTo(1);
  });

  it('reps rotate through the scripted plays and are deterministic per seed', () => {
    const def = getDrill('coverage');
    const ids = def.offensePlays.map((_, i) => buildDrillScenario(def, opts(), 9, i).ctx.offensivePlay.id);
    expect(ids).toEqual([...def.offensePlays]);
    const a = buildDrillScenario(def, opts(), 9, 1);
    const b = buildDrillScenario(def, opts(), 9, 1);
    expect(a.ctx.rng.next()).toBe(b.ctx.rng.next());
    expect(buildDrillScenario(def, opts(), 10, 1).ctx.rng.next()).not.toBe(buildDrillScenario(def, opts(), 9, 1).ctx.rng.next());
  });

  it('the practice roster is fixed: same players whatever order they are generated in', () => {
    const squad = practiceSquad('gold', 'starter');
    const slots = [{ role: 'WR1', position: 'WR' as const }, { role: 'WR2', position: 'WR' as const }, { role: 'QB', position: 'QB' as const }];
    const first = lineupFor(squad, slots);
    const again = lineupFor(practiceSquad('gold', 'starter'), [...slots].reverse());
    expect(again.QB?.id).toBe(first.QB?.id);
    expect(first.WR1?.id).not.toBe(first.WR2?.id);
    // Reversed order hands the depth out in slot order, but the athletes are the same two receivers.
    expect(new Set([again.WR1?.id, again.WR2?.id])).toEqual(new Set([first.WR1?.id, first.WR2?.id]));
    expect(practiceSquad('scout', 'elite').player('CB', 0).overall).toBeGreaterThan(practiceSquad('scout', 'fringe').player('CB', 0).overall);
  });

  it('options cycle with wrap-around and render readable values and goals', () => {
    let o = opts();
    o = cycleOption(o, 'difficulty', 1);
    expect(o.difficulty).toBe('allPro');
    o = cycleOption(opts({ difficulty: 'rookie' }), 'difficulty', -1);
    expect(o.difficulty).toBe('legend');
    const last = OPTION_CHOICES.kickDistance[OPTION_CHOICES.kickDistance.length - 1]!;
    expect(cycleOption(opts({ kickDistance: last }), 'kickDistance', 1).kickDistance).toBe(OPTION_CHOICES.kickDistance[0]);
    expect(optionValueText(opts({ puntFrom: 35 }), 'puntFrom')).toBe('OWN 35');
    expect(optionValueText(opts({ puntFrom: 55 }), 'puntFrom')).toBe('OPP 45');
    expect(optionValueText(opts({ wind: 'headwind' }), 'wind')).toBe('IN YOUR FACE');
    // Seen from the side, a crosswind blows up or down the screen (the kick goes right).
    expect(optionValueText(opts({ wind: 'crossLeft' }), 'wind')).toBe('BOTTOM TO TOP');
    expect(optionValueText(opts({ wind: 'crossRight' }), 'wind')).toBe('TOP TO BOTTOM');
    expect(drillGoal(getDrill('fieldGoal'), opts({ kickDistance: 50 }))).toBe('Make the 50-yard field goal');
    expect(drillGoal(getDrill('tackling'), opts({ difficulty: 'legend' }))).toContain(String(getDrill('tackling').levels.legend.yards));
    expect(drillGoal(getDrill('punting'), opts({ puntTarget: 'left' }))).toContain('left sideline');
  });
});
