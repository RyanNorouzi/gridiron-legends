import { describe, expect, it } from 'vitest';
import { loadPlaybookData, resolvePlaybook } from '@/playbook/loader';
import {
  coveredSpecialKinds, extraPointPlay, fakePlays, fieldGoalDistance, fieldGoalPlay, isFakePlay, isKickConcept, isSpecialPlay,
  kickoffPlay, puntPlay, returnPlay, specialFormationId, specialPlays,
} from '@/playbook/special-teams';

const reg = loadPlaybookData();
const all = Object.values(reg.offensePlays);
const defAll = Object.values(reg.defensePlays);

describe('isSpecialPlay', () => {
  it('maps kick concepts, fakes and two-point tags to PlayContext.special', () => {
    expect(isSpecialPlay(reg.offensePlays['kickoff-deep'])).toBe('kickoff');
    expect(isSpecialPlay(reg.offensePlays['kickoff-onside'])).toBe('onside');
    expect(isSpecialPlay(reg.offensePlays['punt-standard'])).toBe('punt');
    expect(isSpecialPlay(reg.offensePlays['fakePunt-run'])).toBe('punt');
    expect(isSpecialPlay(reg.offensePlays['fieldGoal-standard'])).toBe('fieldGoal');
    expect(isSpecialPlay(reg.offensePlays['fakeFieldGoal-pass'])).toBe('fieldGoal');
    expect(isSpecialPlay({ ...reg.offensePlays['fakeFieldGoal-pass'], tags: ['twoPoint'] })).toBe('extraPoint');
    expect(isSpecialPlay(reg.offensePlays['extraPoint-standard'])).toBe('extraPoint');
    expect(isSpecialPlay(reg.offensePlays['shotgunTrips-twoPoint-pick'])).toBe('twoPoint');
    expect(isSpecialPlay(reg.offensePlays['shotgun-slants'])).toBe('none');
    expect(isKickConcept('fakePunt')).toBe(true);
    expect(isKickConcept('mesh')).toBe(false);
    expect(isFakePlay(reg.offensePlays['fakePunt-pass'])).toBe(true);
    expect(isFakePlay(reg.offensePlays['punt-standard'])).toBe(false);
  });

  it('special plays use the special formations with kicker/holder/snapper assignments', () => {
    const ko = reg.offensePlays['kickoff-deep'];
    expect(ko.formation).toBe(specialFormationId('kickoff'));
    expect(ko.assignments.K.type).toBe('kicker');
    expect(Object.values(ko.assignments).filter((a) => a.type === 'kickCoverage')).toHaveLength(10);
    const punt = reg.offensePlays['punt-standard'];
    expect(punt.formation).toBe(specialFormationId('punt'));
    expect(punt.assignments.P.type).toBe('kicker');
    expect(punt.assignments.LS.type).toBe('longSnapper');
    expect(Object.values(punt.assignments).filter((a) => a.type === 'gunner')).toHaveLength(2);
    const fg = reg.offensePlays['fieldGoal-standard'];
    expect(fg.formation).toBe(specialFormationId('fieldGoal'));
    expect(fg.assignments.H.type).toBe('holder');
    expect(fg.assignments.K.type).toBe('kicker');
    expect(reg.offensePlays['kickoff-onside'].formation).toBe(specialFormationId('onside'));
    expect(reg.offensePlays['fakeFieldGoal-pass'].assignments.H.type).toBe('qb');
  });
});

describe('play pickers', () => {
  it('picks kickoff variants', () => {
    expect(kickoffPlay(all)?.id).toBe('kickoff-deep');
    expect(kickoffPlay(all, { onside: true })?.id).toBe('kickoff-onside');
    expect(kickoffPlay(all, { squib: true })?.id).toBe('kickoff-squib');
    expect(kickoffPlay(all.filter((p) => p.id !== 'kickoff-squib'), { squib: true })?.id).toBe('kickoff-deep');
    expect(kickoffPlay([])).toBeNull();
  });

  it('picks pooch punts inside the opponent 45 and FG/XP plays', () => {
    expect(puntPlay(all, 30)?.id).toBe('punt-standard');
    expect(puntPlay(all, 58)?.id).toBe('punt-pooch');
    expect(puntPlay(all.filter((p) => p.id !== 'punt-pooch'), 58)?.id).toBe('punt-standard');
    expect(fieldGoalPlay(all)?.id).toBe('fieldGoal-standard');
    expect(extraPointPlay(all)?.id).toBe('extraPoint-standard');
    expect(fieldGoalPlay([])).toBeNull();
    expect(fieldGoalDistance(75)).toBe(42);
    expect(fieldGoalDistance(98)).toBe(19);
  });

  it('lists fakes by kind and type and excludes fakes from specialPlays', () => {
    expect(fakePlays(all, 'punt').map((p) => p.id).sort()).toEqual(['fakePunt-pass', 'fakePunt-run']);
    expect(fakePlays(all, 'fieldGoal', 'run').map((p) => p.id)).toEqual(['fakeFieldGoal-run']);
    expect(specialPlays(all, 'punt').map((p) => p.id).sort()).toEqual(['punt-pooch', 'punt-standard']);
    expect(specialPlays(all, 'fakePunt')).toEqual([]);
  });

  it('every bundled playbook can cover every kick kind', () => {
    for (const id of Object.keys(reg.playbooks)) {
      const kinds = coveredSpecialKinds(resolvePlaybook(id).offense).sort();
      expect(kinds, id).toEqual(['extraPoint', 'fieldGoal', 'kickoff', 'onside', 'punt']);
    }
  });
});

describe('returnPlay', () => {
  it('picks the matching return unit for each kick kind', () => {
    expect(returnPlay(defAll, 'kickoff')?.id).toBe('kickReturn-middle');
    expect(returnPlay(defAll, 'onside')?.id).toBe('kickReturn-hands');
    expect(returnPlay(defAll, 'punt')?.id).toBe('puntReturn-middle');
    expect(returnPlay(defAll, 'punt', { block: true })?.id).toBe('puntReturn-block');
    expect(returnPlay(defAll, 'fieldGoal')?.id).toBe('fgBlock-middle');
    expect(returnPlay(defAll, 'extraPoint', { block: true })?.id).toBe('fgBlock-edge');
    expect(returnPlay(defAll, 'none')).toBeNull();
    expect(returnPlay(defAll, 'twoPoint')).toBeNull();
    expect(returnPlay(defAll.filter((p) => !p.tags.includes('onside')), 'onside')?.id).toBe('kickReturn-middle');
    expect(returnPlay([], 'kickoff')).toBeNull();
    for (const kind of ['kickoff', 'onside', 'punt', 'fieldGoal', 'extraPoint'] as const) {
      const play = returnPlay(resolvePlaybook('spread').defense, kind);
      expect(play, kind).not.toBeNull();
      if (kind !== 'fieldGoal' && kind !== 'extraPoint') expect(Object.values(play?.assignments ?? {}).some((a) => a.type === 'returner')).toBe(true);
    }
  });
});
