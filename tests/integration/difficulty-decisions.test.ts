/**
 * Difficulty is decision quality only (spec). Two halves:
 *  - the dice: for the same seed and inputs a play resolves with the same random stream whatever the difficulty. The
 *    live engine with every AI decision held at legend (disguises, coverage reads, fooled quarterbacks included) plays
 *    identically when only the engine's difficulty moves; and the controller hands a play the same rng stream whoever
 *    called it and however well.
 *  - the decisions: legend makes measurably better ones. Fewer bad fourth-down calls (expected-points regret on the
 *    unbiased model, outside the late-game window where win probability rules), better coverage matches against what
 *    the user has been running, more pre-snap disguise, and a sharper check at the line.
 */
import { describe, expect, it } from 'vitest';
import { createCoachHooks } from '@/ai/coaching';
import { fourthDownDecision, fourthDownRegret, type FourthDownSituation } from '@/ai/coaching';
import { disguisePlan } from '@/ai/disguise';
import { decideIntent } from '@/ai/index';
import { callDefensivePlay, defensiveCheck, formationClass, isRunStop, personnelMismatch } from '@/ai/playcalling-defense';
import { formationPersonnel, scoutOffense } from '@/ai/scouting';
import { registerAll } from '@/ai/register';
import { createRng } from '@/core/rng';
import type { IntentDecider } from '@/game/engine-api';
import type { PlayOutcome } from '@/game/play-types';
import { getDifficulty } from '@/game/rulesets';
import type { DifficultyId, PlayLogEntry } from '@/game/types';
import { emptyOutcome } from '@/game/outcome-factory';
import { loadPlaybookData } from '@/playbook/loader';
import type { DefensivePlay } from '@/playbook/types';
import { build } from '../game/engine/helpers';
import { controllerAt } from '../game/fixtures';

registerAll();

const IDS: readonly DifficultyId[] = ['rookie', 'pro', 'allPro', 'legend'];
const reg = loadPlaybookData();
const DEF: DefensivePlay[] = Object.values(reg.defensePlays).filter((p) => !p.tags.some((t) => t === 'kickReturn' || t === 'puntReturn' || t === 'fgBlock'));

const legendDecisions: IntentDecider = (a, s, dt) => {
  const engineSees = s.ctx.difficulty;
  s.ctx.difficulty = getDifficulty('legend');
  try {
    return decideIntent(a, s, dt);
  } finally {
    s.ctx.difficulty = engineSees;
  }
};

const fingerprint = (o: PlayOutcome): string =>
  JSON.stringify([o.result, o.yards, o.turnover, o.touchdown, o.timeElapsed, o.events.map((e) => `${e.type}@${e.tick}`)]);

describe('difficulty never touches the dice', () => {
  it('legend AI decisions (disguise, reads) resolve identically whatever difficulty the engine sees', () => {
    const plays: [string, string][] = [['shotgun-mesh', '43-cover2-zone'], ['trips-smash', '43-cover3-zone'], ['shotgun-curls', '43-cover1-safetyBlitz'], ['iform-dive-right', 'nickel-cover6-zone']];
    let disguised = 0;
    for (const [off, def] of plays) {
      for (const seed of [11, 12, 13]) {
        const run = (id: DifficultyId): string => {
          const b = build({ offensePlayId: off, defensePlayId: def, seed, ballOn: 40 }, { difficulty: getDifficulty(id) }, { decider: legendDecisions });
          return fingerprint(b.engine.run());
        };
        expect(run('rookie'), `${off} vs ${def} seed ${seed}`).toBe(run('legend'));
        const probe = build({ offensePlayId: off, defensePlayId: def, seed, ballOn: 40, difficulty: 'legend' });
        if (disguisePlan(probe.engine.state).disguised) disguised++;
      }
    }
    // The sample really exercised the legend-only behaviour.
    expect(disguised).toBeGreaterThan(0);
  }, 60_000);

  it('the controller hands a play the same rng stream whoever calls it and however well', () => {
    const streams = IDS.map((id) => {
      const c = controllerAt({ possession: 'home', down: 2, distance: 6, ballOn: 45 });
      const hooks = createCoachHooks(null, getDifficulty(id));
      const off = hooks.pickOffensivePlay(c.state, c.setup.home.offensePlays, createRng(`call:${id}`));
      const def = hooks.pickDefensivePlay(c.state, c.setup.away.defensePlays.filter((p) => !p.tags.includes('kickReturn') && !p.tags.includes('puntReturn')), createRng(`def:${id}`));
      const ctx = c.beginPlay(off.id, def.id);
      return JSON.stringify(ctx.rng.getState());
    });
    for (const s of streams) expect(s).toBe(streams[0]);
  });
});

/** Fourth downs where expected points is the right yardstick: quarters 1-3, within a score. */
const FOURTH_GRID: FourthDownSituation[] = (() => {
  const out: FourthDownSituation[] = [];
  for (const ballOn of [25, 35, 45, 50, 55, 62, 68, 75, 82, 90]) {
    for (const distance of [1, 2, 3, 5, 8, 12]) {
      if (ballOn + distance > 99) continue;
      for (const scoreDiff of [-7, 0, 7]) for (const quarter of [1, 2, 3]) out.push({ distance, ballOn, scoreDiff, quarter, secondsRemaining: 600 });
    }
  }
  return out;
})();

/** Share of grid calls whose expected-points regret exceeds `bad`. */
const badFourthDowns = (id: DifficultyId, bad = 0.35): number =>
  FOURTH_GRID.filter((s) => fourthDownRegret(s, fourthDownDecision(null, getDifficulty(id), s)) > bad).length / FOURTH_GRID.length;

const entry = (i: number, off: string, result: PlayLogEntry['outcome']['result']): PlayLogEntry => ({
  index: i, quarter: 1, clock: 700, possession: 'home', down: 1, distance: 10, ballOn: 30, ballX: 26.67, offensivePlayId: off, defensivePlayId: '43-cover3-zone',
  outcome: emptyOutcome({ result }, 'home'), scoreAfter: { home: 0, away: 0 }, review: null,
});

describe('legend decides better', () => {
  it('makes fewer bad fourth-down calls, never more as the difficulty climbs', () => {
    const rates = IDS.map((id) => badFourthDowns(id));
    console.log(`bad 4th-down calls: ${IDS.map((id, i) => `${id} ${((rates[i] as number) * 100).toFixed(1)}%`).join(', ')}`);
    for (let i = 1; i < rates.length; i++) expect(rates[i] as number).toBeLessThanOrEqual((rates[i - 1] as number) + 1e-9);
    expect((rates[0] as number) - (rates[3] as number)).toBeGreaterThan(0.08);
    const regret = (id: DifficultyId): number => FOURTH_GRID.reduce((sum, s) => sum + fourthDownRegret(s, fourthDownDecision(null, getDifficulty(id), s)), 0) / FOURTH_GRID.length;
    expect(regret('legend')).toBeLessThan(regret('rookie') * 0.7);
  });

  it('matches coverage to what the user runs: the box against his run formation, sub packages against his pass one', () => {
    // A user who runs out of the I-form and throws out of the gun.
    const log: PlayLogEntry[] = [];
    for (let i = 0; i < 12; i++) log.push(i % 2 ? entry(i, 'iform-iso-left', 'run') : entry(i, 'shotgun-deepCross', 'pass'));
    const report = scoutOffense(log, 'home');
    const iform = reg.offensePlays['iform-iso-left']?.formation as string;
    const gun = reg.offensePlays['shotgun-deepCross']?.formation as string;
    const matched = (id: DifficultyId): number => {
      let hits = 0;
      const n = 300;
      for (let i = 0; i < n; i++) {
        const sit = { down: 2, distance: 5, ballOn: 45, clock: 700, scoreDiff: 0 };
        const vsRun = callDefensivePlay({ plays: DEF, situation: sit, coach: null, difficulty: getDifficulty(id), rng: createRng(`r${i}`), offenseTendencies: report, offenseFormation: iform });
        const vsPass = callDefensivePlay({ plays: DEF, situation: sit, coach: null, difficulty: getDifficulty(id), rng: createRng(`p${i}`), offenseTendencies: report, offenseFormation: gun });
        if (isRunStop(vsRun) || formationClass(vsRun.formation) === 'base') hits++;
        if (!isRunStop(vsPass) && (formationClass(vsPass.formation) === 'nickel' || formationClass(vsPass.formation) === 'dime')) hits++;
      }
      return hits / (2 * n);
    };
    const rookie = matched('rookie');
    const legend = matched('legend');
    console.log(`coverage matched to the user's tendencies: rookie ${(rookie * 100).toFixed(1)}% legend ${(legend * 100).toFixed(1)}%`);
    expect(legend).toBeGreaterThan(rookie + 0.05);
  });

  it('checks out of personnel mismatches and disguises its shell more often', () => {
    const heavy = Object.values(reg.offensePlays).find((p) => formationPersonnel(p.formation) === '22' || formationPersonnel(p.formation) === '23');
    expect(heavy).toBeDefined();
    const dime = DEF.filter((p) => formationClass(p.formation) === 'dime');
    const fixedRate = (id: DifficultyId): number => {
      let fixed = 0;
      dime.forEach((call, k) => {
        for (let i = 0; i < 60; i++) {
          const out = defensiveCheck(call, { plays: DEF, situation: { down: 3, distance: 2, ballOn: 50, clock: 700, scoreDiff: 0 }, coach: null, difficulty: getDifficulty(id), rng: createRng(`${k}:${i}`), offenseFormation: heavy?.formation });
          if (!personnelMismatch(out.play, formationPersonnel(heavy?.formation))) fixed++;
        }
      });
      return fixed / (dime.length * 60);
    };
    expect(fixedRate('legend')).toBeGreaterThan(fixedRate('rookie') + 0.3);
    const disguiseShare = (id: DifficultyId): number => {
      let n = 0;
      for (let seed = 1; seed <= 60; seed++) if (disguisePlan(build({ offensePlayId: 'shotgun-mesh', defensePlayId: 'nickel-cover2-zone', seed, difficulty: id }).engine.state).disguised) n++;
      return n / 60;
    };
    expect(disguiseShare('legend')).toBeGreaterThan(disguiseShare('rookie') + 0.25);
  });
});
