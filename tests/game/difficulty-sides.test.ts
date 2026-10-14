/**
 * Per-side difficulty (game/difficulty-sides.ts): who the human is, the neutral profile of his AI teammates, the one
 * difficulty read every AI athlete goes through, and the CPU performance edge (All-Pro / Legend) on effective ratings
 * in the live engine and the fast sim. AI vs AI (watch mode, league sims) keeps a single shared profile and no edge.
 */
import { describe, expect, it } from 'vitest';
import {
  applyCpuEdge, cpuEdgeFor, cpuPickScale, difficultyFor, EDGE_KEYS, EDGE_SPEED_RATING_CAP, humanTeamSide, NO_EDGE, playSideDifficulties, sideDifficulties, teamDifficulty, teammateProfile,
  USER_DEFENSE_EDGE, userDefenseProfile, CPU_OFFENSE_EDGE, CPU_OFFENSE_EDGE_CAP, cpuOffenseProfile,
} from '@/game/difficulty-sides';
import { DIFFICULTY_IDS, getDifficulty } from '@/game/rulesets';
import type { ControllerKind, TeamSide } from '@/game/types';
import { ATTRIBUTE_KEYS, type AttributeSet } from '@/players/types';
import { accelRate, maxSpeed, overAccelScale, overTopSpeed } from '@/physics/speed';
import { knobsFor } from '@/simulation/play-model';
import { buildMatchups } from '@/simulation/matchups';
import { staffClockSense, timeoutDecision } from '@/ai/coaching';
import { build } from './engine/helpers';

const ctl = (home: ControllerKind, away: ControllerKind): Record<TeamSide, ControllerKind> => ({ home, away });
const flat = (v: number): AttributeSet => Object.fromEntries(ATTRIBUTE_KEYS.map((k) => [k, v])) as AttributeSet;

describe('who is the human', () => {
  it('one human controller is the human team; watch mode, two humans and AI vs AI have none', () => {
    expect(humanTeamSide({ controllers: ctl('human', 'ai') })).toBe('home');
    expect(humanTeamSide({ controllers: ctl('ai', 'human') })).toBe('away');
    expect(humanTeamSide({ controllers: ctl('watch', 'ai') })).toBeNull();
    expect(humanTeamSide({ controllers: ctl('human', 'human') })).toBeNull();
    expect(humanTeamSide({ controllers: ctl('ai', 'ai') })).toBeNull();
    // A simulated user game keeps its managed side with both sides AI.
    expect(humanTeamSide({ controllers: ctl('ai', 'ai'), humanTeam: 'away' })).toBe('away');
    expect(humanTeamSide({ controllers: ctl('watch', 'ai'), humanTeam: 'home' })).toBeNull();
  });
});

describe('user defense boost', () => {
  it("on scrimmage downs where the human defends, his defense plays like a Legend unit with a big edge and full tackle assist", () => {
    for (const id of DIFFICULTY_IDS) {
      const difficulty = getDifficulty(id);
      const src = { controllers: ctl('human', 'ai'), difficulty };
      const onDefense = playSideDifficulties(src, 'away', 'none')!;
      expect(onDefense.home).toEqual(userDefenseProfile(difficulty));
      expect(onDefense.home.aiReactionDelay).toBeLessThanOrEqual(0.02);
      expect(onDefense.home.userTackleAssist).toBe(1);
      expect(cpuEdgeFor({ sideDifficulty: onDefense }, 'home')).toEqual(USER_DEFENSE_EDGE);
      // The CPU offense gets its own boost on top of its difficulty's edge.
      expect(onDefense.away).toEqual(cpuOffenseProfile(difficulty));
      const cpuEdge = cpuEdgeFor({ sideDifficulty: onDefense }, 'away');
      expect(cpuEdge.speed).toBeCloseTo(Math.min(CPU_OFFENSE_EDGE_CAP, (difficulty.cpuSpeedEdge ?? 0) + CPU_OFFENSE_EDGE.speed), 9);
      expect(cpuEdge.skill).toBeCloseTo(Math.min(CPU_OFFENSE_EDGE_CAP, (difficulty.cpuSkillEdge ?? 0) + CPU_OFFENSE_EDGE.skill), 9);
      // When the human has the ball the CPU defense is just its difficulty's profile.
      expect(playSideDifficulties(src, 'home', 'none')!.away).toEqual(sideDifficulties(src)!.away);
      // On offense, and on kicks, the human's team is the plain teammate profile with no edge.
      expect(playSideDifficulties(src, 'home', 'none')!.home).toEqual(teammateProfile(difficulty));
      expect(playSideDifficulties(src, 'away', 'punt')!.home).toEqual(teammateProfile(difficulty));
      expect(cpuEdgeFor({ sideDifficulty: playSideDifficulties(src, 'home', 'none')! }, 'home')).toBe(NO_EDGE);
    }
  });

  it('AI vs AI never gets the boost', () => {
    const difficulty = getDifficulty('pro');
    expect(playSideDifficulties({ controllers: ctl('ai', 'ai'), difficulty }, 'away', 'none')).toBeUndefined();
    expect(playSideDifficulties({ controllers: ctl('watch', 'ai'), difficulty }, 'away', 'none')).toBeUndefined();
  });
});

describe('per-side profiles', () => {
  it("the human's AI teammates decide at the neutral pro level with the selected user assists and no edge", () => {
    const pro = getDifficulty('pro');
    for (const id of DIFFICULTY_IDS) {
      const selected = getDifficulty(id);
      const mate = teammateProfile(selected);
      for (const k of ['aiReactionDelay', 'coverageAnticipation', 'pursuitQuality', 'tackleDecisionQuality', 'qbDecisionQuality', 'receiverIntelligence', 'blockingIq', 'playcallingIq', 'interceptionAwareness'] as const) {
        expect(mate[k]).toBe(pro[k]);
      }
      expect(mate.userPassAssist).toBe(selected.userPassAssist);
      expect(mate.userTackleAssist).toBe(selected.userTackleAssist);
      expect(mate.userBallSecurityAssist).toBe(selected.userBallSecurityAssist);
      expect([mate.cpuSpeedEdge, mate.cpuStrengthEdge, mate.cpuSkillEdge]).toEqual([0, 0, 0]);
    }
  });

  it('human vs CPU: the CPU plays the selected profile, the human team the neutral one; AI vs AI shares one profile', () => {
    const legend = getDifficulty('legend');
    const sides = sideDifficulties({ controllers: ctl('human', 'ai'), difficulty: legend });
    expect(sides?.away).toEqual(legend);
    expect(sides?.home.qbDecisionQuality).toBe(getDifficulty('pro').qbDecisionQuality);
    expect(sideDifficulties({ controllers: ctl('ai', 'ai'), difficulty: legend })).toBeUndefined();
    expect(teamDifficulty({ controllers: ctl('watch', 'ai'), difficulty: legend }, 'home')).toBe(legend);
    expect(teamDifficulty({ controllers: ctl('ai', 'human'), difficulty: legend }, 'home')).toEqual(legend);
  });

  it('difficultyFor reads the athlete\'s own team and falls back to the shared profile', () => {
    const legend = getDifficulty('legend');
    const mate = teammateProfile(legend);
    const ctx = { difficulty: legend, sideDifficulty: { home: mate, away: legend } };
    expect(difficultyFor(ctx, 'home')).toBe(mate);
    expect(difficultyFor({ ctx }, { teamSide: 'away' })).toBe(legend);
    expect(difficultyFor({ difficulty: legend }, 'home')).toBe(legend);
  });
});

describe('CPU performance edge', () => {
  it('is zero at rookie and pro, noticeable at all-pro and big at legend; assists shrink to nothing at legend', () => {
    const [rookie, pro, allPro, legend] = DIFFICULTY_IDS.map(getDifficulty);
    for (const p of [rookie!, pro!]) expect([p.cpuSpeedEdge, p.cpuStrengthEdge, p.cpuSkillEdge]).toEqual([0, 0, 0]);
    for (const k of ['cpuSpeedEdge', 'cpuStrengthEdge', 'cpuSkillEdge'] as const) {
      expect(allPro![k]).toBeGreaterThanOrEqual(0.05);
      expect(legend![k]).toBeGreaterThan(allPro![k]! * 2);
    }
    expect(allPro!.userPassAssist).toBeLessThanOrEqual(0.2);
    expect([legend!.userPassAssist, legend!.userTackleAssist, legend!.userBallSecurityAssist]).toEqual([0, 0, 0]);
  });

  it('only the CPU side of a human-vs-CPU play gets it', () => {
    const legend = getDifficulty('legend');
    expect(cpuEdgeFor({}, 'home')).toBe(NO_EDGE);
    const ctx = { sideDifficulty: { home: teammateProfile(legend), away: legend } };
    expect(cpuEdgeFor(ctx, 'home')).toBe(NO_EDGE);
    expect(cpuEdgeFor(ctx, 'away')).toEqual({ speed: legend.cpuSpeedEdge, strength: legend.cpuStrengthEdge, skill: legend.cpuSkillEdge });
    expect(cpuEdgeFor({ sideDifficulty: { away: getDifficulty('pro') } }, 'away')).toBe(NO_EDGE);
  });

  it('multiplies the boosted ratings, caps them at 99 (speed / acceleration may pass it) and leaves the rest alone', () => {
    const base = flat(60);
    expect(applyCpuEdge(base, NO_EDGE)).toBe(base);
    const out = applyCpuEdge(base, { speed: 0.1, strength: 0.2, skill: 0.3 });
    for (const k of EDGE_KEYS.speed) expect(out[k]).toBeCloseTo(66);
    for (const k of EDGE_KEYS.strength) expect(out[k]).toBeCloseTo(72);
    for (const k of EDGE_KEYS.skill) expect(out[k]).toBeCloseTo(78);
    for (const k of ['awareness', 'reaction', 'stamina', 'vision', 'kickPower'] as const) expect(out[k]).toBe(60);
    const elite = applyCpuEdge(flat(95), { speed: 0.25, strength: 0.25, skill: 0.25 });
    expect(elite.catching).toBe(99);
    expect(elite.agility).toBe(99);
    expect(elite.speed).toBeCloseTo(118.75);
    expect(applyCpuEdge(flat(99), { speed: 0.5, strength: 0, skill: 0 }).speed).toBe(EDGE_SPEED_RATING_CAP);
  });

  it('a speed rating past 99 is faster still in movement (the curves continue linearly), up to 99 nothing changes', () => {
    for (const r of [1, 50, 99]) {
      expect(overTopSpeed(r)).toBe(0);
      expect(overAccelScale(r)).toBe(1);
    }
    expect(maxSpeed(115) + overTopSpeed(115)).toBeGreaterThan(maxSpeed(99) + 0.5);
    expect(overTopSpeed(120)).toBeGreaterThan(overTopSpeed(110));
    expect(overAccelScale(120) * accelRate(120)).toBeGreaterThan(accelRate(99));
  });

  it('the live engine applies it to the CPU athletes only, from the first presnap tick', () => {
    const legend = getDifficulty('legend');
    const sideDifficulty = { home: teammateProfile(legend), away: legend };
    const { engine } = build({ offense: 'home', difficulty: 'legend', seed: 11 }, { sideDifficulty });
    for (const a of engine.state.athletes) {
      const player = engine.state.ctx[a.side === 'offense' ? 'offenseLineup' : 'defenseLineup'][a.role];
      expect(player).toBeDefined();
      if (a.teamSide === 'home') expect(a.attrs.catching).toBe(player!.attrs.catching);
      else expect(a.attrs.catching).toBe(Math.min(99, player!.attrs.catching * (1 + legend.cpuSkillEdge!)));
    }
    engine.tick();
    // Re-applied on every refresh of the effective ratings (clear weather, fresh legs: catching is only the edge).
    for (const a of engine.state.athletes) {
      expect(a.attrs.catching).toBe(a.teamSide === 'home' ? a.baseAttrs.catching : Math.min(99, a.baseAttrs.catching * (1 + legend.cpuSkillEdge!)));
    }
  });

  it("the fast sim's decision knobs follow each side's own profile", () => {
    const legend = getDifficulty('legend');
    const pro = getDifficulty('pro');
    const { ctx } = build({ offense: 'home', difficulty: 'legend' }, { controllers: ctl('ai', 'ai'), sideDifficulty: { home: teammateProfile(legend), away: legend } });
    const k = knobsFor(ctx);
    expect(k.qbIq).toBe(pro.qbDecisionQuality);
    expect(k.coverageIq).toBe(legend.coverageAnticipation);
    const aiVsAi = knobsFor({ ...ctx, sideDifficulty: undefined });
    expect(aiVsAi.qbIq).toBe(legend.qbDecisionQuality);
  });

  it('the fast sim rates the CPU lineup with the edge and the user lineup without it', () => {
    const legend = getDifficulty('legend');
    const sideDifficulty = { home: teammateProfile(legend), away: legend };
    const { ctx } = build({ offense: 'home', difficulty: 'legend' }, { controllers: ctl('ai', 'ai'), sideDifficulty });
    const m = buildMatchups(ctx, { qbIq: null, coverageIq: null });
    const aiVsAi = buildMatchups({ ...ctx, sideDifficulty: undefined }, { qbIq: null, coverageIq: null });
    const plain = (list: typeof m.offense, id: string) => list.find((p) => p.player.id === id)!.attrs;
    for (const p of m.offense) expect(p.attrs).toEqual(plain(aiVsAi.offense, p.player.id));
    for (const p of m.defense) {
      const base = plain(aiVsAi.defense, p.player.id);
      expect(p.attrs.coverage).toBeCloseTo(Math.min(99, base.coverage * (1 + legend.cpuSkillEdge!)), 6);
      expect(p.attrs.awareness).toBe(base.awareness);
    }
    // The statistical model rates players close to the league reference, so the edge moves nearly every defender.
    expect(m.defense.filter((p) => p.attrs.coverage > plain(aiVsAi.defense, p.player.id).coverage + 1).length).toBeGreaterThan(5);
  });

  it("scales only a CPU defender's finished-pick chance (1 for the user's side and AI vs AI)", () => {
    const legend = getDifficulty('legend');
    const ctx = { sideDifficulty: { home: teammateProfile(legend), away: legend } };
    expect(cpuPickScale(ctx, 'home')).toBe(1);
    expect(cpuPickScale(ctx, 'away')).toBeCloseTo(1 + legend.cpuSkillEdge!);
    expect(cpuPickScale({}, 'away')).toBe(1);
  });
});

describe('Legend clock management', () => {
  it("a legend staff manages the clock perfectly; pro and all-pro keep the head coach's own clock sense", () => {
    expect(staffClockSense(null, getDifficulty('legend'))).toBe(1);
    expect(staffClockSense(null, getDifficulty('allPro'))).toBe(0.5);
    expect(staffClockSense(null, getDifficulty('pro'))).toBe(0.5);
    // Down three at 1:40 with the ball and one timeout left: a neutral pro staff keeps its timeouts, a legend one stops the clock like a clock manager.
    const sit = { clockRunning: true, timeouts: 2, quarter: 4, overtime: false, onOffense: true, playClockRunning: true, playClock: 20, secondsRemaining: 100, scoreDiff: -3, ballOn: 40 };
    expect(timeoutDecision(null, getDifficulty('legend'), { ...sit, timeouts: 1 })).toBe(true);
    expect(timeoutDecision(null, getDifficulty('pro'), { ...sit, timeouts: 1 })).toBe(false);
  });
});
