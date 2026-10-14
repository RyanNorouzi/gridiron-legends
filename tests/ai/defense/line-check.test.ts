import { describe, expect, it } from 'vitest';
import { registerAll } from '@/ai/register';
import { aiLineCheck, isHeavyLook, isSpreadLook, lineCheckKey, lineCheckRate, offenseLook, signalCaller, type OffenseLook } from '@/ai/line-check';
import { getDifficulty } from '@/game/rulesets';
import type { DifficultyId } from '@/game/types';
import { loadPlaybookData } from '@/playbook/loader';
import type { DefensivePlay } from '@/playbook/types';
import { buildPlayState } from '../../fixtures/play-state';
import { build } from '../../game/engine/helpers';

registerAll();
const reg = loadPlaybookData();
const def = (id: string): DefensivePlay => {
  const p = reg.defensePlays[id];
  if (!p) throw new Error(`unknown defense ${id}`);
  return p;
};
const look = (o: Partial<OffenseLook>): OffenseLook => ({ formation: 'shotgun', personnel: '11', wideReceivers: 3, tightEnds: 1, backs: 1, ...o });

describe('the AI defense\'s check at the line (what it can see)', () => {
  it('reads spread and heavy looks from the formation and the bodies on the field', () => {
    const empty = offenseLook(buildPlayState({ offensePlayId: 'empty-mesh', defensePlayId: '43-cover3-zone', seed: 1 }).state);
    expect(empty.formation).toBe('empty');
    expect(isSpreadLook(empty)).toBe(true);
    expect(isHeavyLook(empty)).toBe(false);
    const heavy = offenseLook(buildPlayState({ offensePlayId: 'heavy-iso-right', defensePlayId: '43-cover3-zone', seed: 1 }).state);
    expect(isHeavyLook(heavy)).toBe(true);
    expect(isSpreadLook(heavy)).toBe(false);
    const gun = offenseLook(buildPlayState({ offensePlayId: 'shotgun-mesh', defensePlayId: '43-cover3-zone', seed: 1 }).state);
    expect(isSpreadLook(gun) || isHeavyLook(gun)).toBe(false);
  });

  it('checks run stoppers and man calls to zone against spread, light shells to a run fit against heavy', () => {
    const spread = look({ formation: 'empty', personnel: '00', wideReceivers: 5, tightEnds: 0, backs: 0 });
    const heavy = look({ formation: 'heavy', personnel: '22', wideReceivers: 1, tightEnds: 2, backs: 2 });
    expect(lineCheckKey(def('43-runStop-cover1'), spread)).toBe('zoneShift');
    expect(lineCheckKey(def('43-cover1-man'), spread)).toBe('zoneShift');
    expect(lineCheckKey(def('43-cover3-zone'), spread)).toBeNull();
    expect(lineCheckKey(def('43-cover2-zone'), heavy)).toBe('manShift');
    expect(lineCheckKey(def('43-cover3-zone'), heavy)).toBeNull();
    expect(lineCheckKey(def('43-cover2-zone'), look({}))).toBeNull();
    // A call without the matching audible has nothing to check to.
    expect(lineCheckKey(def('43-cover4-zone'), heavy)).toBeNull();
  });

  it('is a higher-difficulty decision: never at rookie or pro, most mismatches at legend', () => {
    const rate = (id: DifficultyId): number => lineCheckRate(getDifficulty(id).playcallingIq);
    expect(rate('rookie')).toBe(0);
    expect(rate('pro')).toBe(0);
    expect(rate('allPro')).toBeGreaterThan(0.3);
    expect(rate('legend')).toBeGreaterThan(rate('allPro'));
  });

  it('never reads the offense\'s play: two calls from the same formation get the same check', () => {
    let checks = 0;
    for (let seed = 1; seed <= 12; seed++) {
      const a = buildPlayState({ offensePlayId: 'empty-mesh', defensePlayId: '43-runStop-cover1', seed, difficulty: 'legend' }).state;
      const verdict = aiLineCheck(a);
      const other = reg.offensePlays['empty-fades'];
      if (!other) throw new Error('missing empty-fades');
      a.ctx = { ...a.ctx, offensivePlay: other };
      expect(aiLineCheck(a)).toBe(verdict);
      if (verdict) checks++;
    }
    expect(checks).toBeGreaterThan(4);
  });

  it('in the live engine a legend defense checks out of a run stopper against empty; a rookie one never does', () => {
    const plays = { offensePlays: reg.offensePlays, defensePlays: reg.defensePlays };
    const checked = (id: DifficultyId): number => {
      let n = 0;
      for (let seed = 1; seed <= 10; seed++) {
        const b = build({ offensePlayId: 'empty-mesh', defensePlayId: '43-runStop-cover1', seed, difficulty: id }, { difficulty: getDifficulty(id) }, { plays });
        const caller = signalCaller(b.engine.state);
        for (let i = 0; i < 90 && b.engine.state.phase === 'presnap'; i++) b.engine.tick();
        const ev = b.engine.state.events.find((e) => e.type === 'audible' && e.side === 'defense');
        if (ev && ev.type === 'audible' && ev.success) {
          n++;
          expect(b.engine.state.ctx.defensivePlay.id).toBe('43-cover3-zone');
        }
        expect(caller?.position).toBe('MLB');
      }
      return n;
    };
    expect(checked('rookie')).toBe(0);
    expect(checked('legend')).toBeGreaterThan(3);
  });
});
