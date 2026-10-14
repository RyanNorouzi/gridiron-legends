import { describe, expect, it } from 'vitest';
import { createRng } from '@/core/rng';
import { loadPlaybookData, resolvePlaybook } from '@/playbook/loader';
import {
  canKneelOut, DEFAULT_KNEEL_RUNOFF, KNEEL_SECONDS, kneelBurnSeconds, kneelOutSeconds,
  defaultPlaybookForScheme, defensivePlaysForSituation, offensivePlayWeight, pickWeighted, playsByFormation, playsForSituation,
  situationTags, twoPointPlays, type PlaySituation,
} from '@/playbook/playbooks';
import type { OffensiveScheme } from '@/teams/types';

const reg = loadPlaybookData();
const balanced = resolvePlaybook('balanced');
const base: PlaySituation = { down: 1, distance: 10, ballOn: 25, clock: 900, scoreDiff: 0 };
const ids = (ws: { play: { id: string } }[]): string[] => ws.map((w) => w.play.id);
const weightOf = (ws: { play: { id: string }; weight: number }[], id: string): number => ws.find((w) => w.play.id === id)?.weight ?? 0;

describe('defaultPlaybookForScheme', () => {
  it('maps every scheme to a bundled playbook', () => {
    const schemes: OffensiveScheme[] = ['balanced', 'airRaid', 'westCoast', 'groundAndPound', 'spread'];
    for (const s of schemes) expect(reg.playbooks[defaultPlaybookForScheme(s)], s).toBeDefined();
    expect(defaultPlaybookForScheme('airRaid')).toBe('airRaid');
  });
});

describe('situationTags', () => {
  it('derives tags from down, distance, field position, clock and score', () => {
    expect(situationTags(base)).toEqual(['base']);
    expect(situationTags({ down: 3, distance: 1, ballOn: 97, clock: 90, scoreDiff: 3 })).toEqual(['shortYardage', 'redZone', 'goalLine', 'twoMinute', 'clockKill', 'thirdDown']);
    expect(situationTags({ down: 2, distance: 12, ballOn: 50, clock: 100, scoreDiff: -4 })).toEqual(['longYardage', 'twoMinute']);
  });
});

describe('playsForSituation', () => {
  it('never returns kick plays and only returns two-point plays at the goal line', () => {
    const out = playsForSituation(balanced.offense, base);
    for (const w of out) {
      expect(['kickoff', 'onside', 'punt', 'fieldGoal', 'extraPoint', 'fakePunt', 'fakeFieldGoal']).not.toContain(w.play.concept);
      expect(w.play.tags).not.toContain('twoPoint');
      expect(w.weight).toBeGreaterThan(0);
    }
    expect(out.length).toBeGreaterThan(20);
    const goal = playsForSituation(balanced.offense, { ...base, ballOn: 98, distance: 2 });
    expect(ids(goal)).toContain('iform-twoPoint-power');
  });

  it('weights short yardage toward runs and goal-line plays', () => {
    const short = playsForSituation(balanced.offense, { down: 3, distance: 1, ballOn: 40, clock: 600, scoreDiff: 0 });
    expect(weightOf(short, 'iform-power-right')).toBeGreaterThan(weightOf(short, 'shotgun-fourVerts'));
    expect(weightOf(short, 'iform-power-right')).toBeGreaterThan(weightOf(short, 'shotgun-slants'));
    const long = playsForSituation(balanced.offense, { down: 3, distance: 12, ballOn: 40, clock: 600, scoreDiff: 0 });
    expect(weightOf(long, 'shotgun-fourVerts')).toBeGreaterThan(weightOf(long, 'iform-power-right'));
    expect(weightOf(long, 'goalLine-qbSneak')).toBeLessThan(weightOf(long, 'shotgun-curls'));
    const goal = playsForSituation(balanced.offense, { down: 2, distance: 1, ballOn: 99, clock: 600, scoreDiff: 0 });
    expect(weightOf(goal, 'goalLine-qbSneak')).toBeGreaterThan(weightOf(goal, 'shotgun-postWheel'));
  });

  it('a goal-line QB sneak is a near-never call on 1st & 10 in the offense\'s own end', () => {
    const own14 = playsForSituation(balanced.offense, { down: 1, distance: 10, ballOn: 14, clock: 600, scoreDiff: 0 });
    const total = own14.reduce((t, w) => t + w.weight, 0);
    expect(weightOf(own14, 'goalLine-qbSneak') / total).toBeLessThan(0.005);
    const short = playsForSituation(balanced.offense, { down: 3, distance: 1, ballOn: 40, clock: 600, scoreDiff: 0 });
    expect(weightOf(short, 'goalLine-qbSneak')).toBeGreaterThan(weightOf(short, 'shotgun-fourVerts'));
  });

  it('only offers kneels when the lead can be run out and spikes when trailing with the clock running', () => {
    const kneel = reg.offensePlays['iform-kneel'];
    const spike = reg.offensePlays['singleback-spike'];
    expect(offensivePlayWeight(kneel, base)).toBe(0);
    // Four kneels into a running clock with 24 s runoffs and no opponent timeouts burn 4 + 4 * 24 = 100 s.
    const runOut = { down: 1, distance: 10, ballOn: 40, clock: 100, scoreDiff: 3, clockRunning: true, opponentTimeouts: 0, runoffSec: 24 };
    expect(offensivePlayWeight(kneel, runOut)).toBeGreaterThan(0);
    expect(offensivePlayWeight(kneel, { ...runOut, scoreDiff: -3 })).toBe(0);
    expect(offensivePlayWeight(kneel, { ...runOut, down: 3 })).toBe(0);
    // Each opponent timeout wipes a runoff, a stopped clock one more, and an unknown timeout count is assumed full.
    expect(offensivePlayWeight(kneel, { ...runOut, opponentTimeouts: 1 })).toBe(0);
    expect(offensivePlayWeight(kneel, { ...runOut, clock: 76, opponentTimeouts: 1 })).toBeGreaterThan(0);
    expect(offensivePlayWeight(kneel, { ...runOut, clock: 76, opponentTimeouts: 1, clockRunning: false })).toBe(0);
    expect(offensivePlayWeight(kneel, { down: 1, distance: 10, ballOn: 40, clock: 100, scoreDiff: 3 })).toBe(0);
    expect(offensivePlayWeight(spike, { down: 1, distance: 10, ballOn: 60, clock: 30, scoreDiff: -3, clockRunning: true })).toBeGreaterThan(0);
    expect(offensivePlayWeight(spike, { down: 1, distance: 10, ballOn: 60, clock: 30, scoreDiff: -3, clockRunning: false })).toBe(0);
    expect(offensivePlayWeight(spike, { down: 4, distance: 10, ballOn: 60, clock: 30, scoreDiff: -3, clockRunning: true })).toBe(0);
    const late = playsForSituation(balanced.offense, runOut);
    expect(weightOf(late, 'iform-kneel')).toBeGreaterThan(weightOf(late, 'shotgun-goRoutes'));
  });

  it('favours passes in two-minute drills when trailing and runs when killing the clock', () => {
    const trailing = playsForSituation(balanced.offense, { down: 1, distance: 10, ballOn: 40, clock: 90, scoreDiff: -6 });
    expect(weightOf(trailing, 'shotgun-quickOuts')).toBeGreaterThan(weightOf(trailing, 'iform-dive-right'));
    const leading = playsForSituation(balanced.offense, { down: 1, distance: 10, ballOn: 40, clock: 200, scoreDiff: 6 });
    expect(weightOf(leading, 'heavy-iso-right')).toBeGreaterThan(weightOf(leading, 'shotgun-goRoutes'));
    expect(weightOf(leading, 'trips-jetSweep-left')).toBe(0);
    const air = resolvePlaybook('airRaid');
    const trick = playsForSituation(air.offense, base);
    expect(weightOf(trick, 'trips-jetSweep-left')).toBeLessThan(weightOf(trick, 'shotgun-slants'));
  });

  it('picks deterministically through the injected rng', () => {
    const out = playsForSituation(balanced.offense, base);
    const a = pickWeighted(out, createRng(7));
    const b = pickWeighted(out, createRng(7));
    expect(a?.id).toBe(b?.id);
    expect(pickWeighted([], createRng(1))).toBeNull();
    const rng = createRng(123);
    const picks = new Set<string>();
    for (let i = 0; i < 40; i++) picks.add(pickWeighted(out, rng)?.id ?? '');
    expect(picks.size).toBeGreaterThan(5);
    const shortRng = createRng(99);
    const shortOut = playsForSituation(balanced.offense, { down: 4, distance: 1, ballOn: 60, clock: 500, scoreDiff: 0 });
    let runs = 0;
    for (let i = 0; i < 100; i++) if (pickWeighted(shortOut, shortRng)?.type === 'run') runs++;
    expect(runs).toBeGreaterThan(50);
  });
});

describe('defensivePlaysForSituation', () => {
  it('excludes return units and weights run stops / prevent by situation', () => {
    const out = defensivePlaysForSituation(balanced.defense, base);
    for (const w of out) expect(w.play.tags.some((t) => ['kickReturn', 'puntReturn', 'fgBlock'].includes(t))).toBe(false);
    const short = defensivePlaysForSituation(balanced.defense, { down: 3, distance: 1, ballOn: 50, clock: 600, scoreDiff: 0 });
    expect(weightOf(short, '43-runStop-cover1')).toBeGreaterThan(weightOf(short, 'dime-cover2-zone'));
    const long = defensivePlaysForSituation(balanced.defense, { down: 3, distance: 15, ballOn: 50, clock: 600, scoreDiff: 0 });
    expect(weightOf(long, 'dime-cover2-zone')).toBeGreaterThan(weightOf(long, '43-runStop-cover1'));
    const lateLead = defensivePlaysForSituation(balanced.defense, { down: 1, distance: 10, ballOn: 30, clock: 60, scoreDiff: -7 });
    expect(weightOf(lateLead, 'prevent-cover4-zone')).toBeGreaterThan(weightOf(lateLead, '43-cover1-man'));
    const normal = defensivePlaysForSituation(balanced.defense, base);
    expect(weightOf(normal, 'prevent-cover4-zone')).toBeLessThan(weightOf(normal, '43-cover1-man'));
    expect(weightOf(normal, 'goalLine-cover0-runStop')).toBeLessThan(weightOf(normal, '43-cover3-zone'));
  });
});

describe('helpers', () => {
  it('groups by formation and lists two-point plays', () => {
    const groups = playsByFormation(balanced.offense);
    expect(groups.iForm?.length).toBeGreaterThan(3);
    expect(Object.values(groups).flat()).toHaveLength(balanced.offense.length);
    const tp = twoPointPlays(balanced.offense);
    expect(tp.length).toBeGreaterThanOrEqual(2);
    for (const p of tp) expect(p.tags).toContain('twoPoint');
  });
});

describe('kneel clock model', () => {
  it('matches the AI: kneels, runoffs the clock runs into, timeouts wiping runoffs and the two-minute warning', () => {
    expect(kneelBurnSeconds(1, 0, 24)).toBe(4 * KNEEL_SECONDS + 4 * 24);
    expect(kneelBurnSeconds(1, 3, 24)).toBe(4 * KNEEL_SECONDS + 24);
    expect(kneelBurnSeconds(2, 0, 14, false)).toBe(3 * KNEEL_SECONDS + 2 * 14);
    // Above two minutes a running clock stops at the warning: one runoff less.
    expect(kneelOutSeconds({ down: 1, clock: 130, clockRunning: true, opponentTimeouts: 0, runoffSec: 24 })).toBe(4 + 3 * 24);
    expect(kneelOutSeconds({ down: 1, clock: 90, clockRunning: true, opponentTimeouts: 0 })).toBe(4 + 4 * DEFAULT_KNEEL_RUNOFF);
    expect(canKneelOut({ down: 1, distance: 10, ballOn: 30, clock: 30, scoreDiff: 4, opponentTimeouts: 3, runoffSec: 14 })).toBe(false);
    expect(canKneelOut({ down: 1, distance: 10, ballOn: 30, clock: 30, scoreDiff: 4, opponentTimeouts: 0, runoffSec: 14 })).toBe(true);
  });
});
