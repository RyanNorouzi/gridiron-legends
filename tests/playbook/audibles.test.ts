import { describe, expect, it } from 'vitest';
import { availableAudibles, availableDefensiveAudibles, resolveAudible, resolveDefensiveAudible, suggestAudible, suggestDefensiveAudible } from '@/playbook/audibles';
import { loadPlaybookData } from '@/playbook/loader';
import type { DefensivePlay, OffensivePlay } from '@/playbook/types';

const reg = loadPlaybookData();
const slants = reg.offensePlays['shotgun-slants'];
const dive = reg.offensePlays['iform-dive-right'];
const cover1 = reg.defensePlays['43-cover1-man'];
const cover3 = reg.defensePlays['43-cover3-zone'];
const allOut = reg.defensePlays['34-cover0-allOut'];
const runStop = reg.defensePlays['43-runStop-cover1'];
const dime = reg.defensePlays['dime-cover2-zone'];

describe('resolveAudible', () => {
  it('returns the referenced play for defined keys and null otherwise', () => {
    expect(resolveAudible(slants, 'manBeater', reg)?.id).toBe('shotgun-mesh');
    expect(resolveAudible(slants, 'passToRun', reg)?.id).toBe('shotgun-insideZone-left');
    expect(resolveAudible(slants, 'runToPass', reg)).toBeNull();
    expect(resolveAudible(dive, 'runToPass', reg)?.id).toBe('iform-paBoot-right');
    expect(availableAudibles(slants)).toEqual(['manBeater', 'zoneBeater', 'blitzBeater', 'passToRun']);
    expect(availableAudibles(reg.offensePlays['iform-kneel'])).toEqual([]);
  });

  it('refuses targets that are unknown, self or in another formation', () => {
    const bogus: OffensivePlay = { ...slants, audibles: { manBeater: 'ghost', zoneBeater: 'iform-dive-right', blitzBeater: slants.id } };
    expect(resolveAudible(bogus, 'manBeater', reg)).toBeNull();
    expect(resolveAudible(bogus, 'zoneBeater', reg)).toBeNull();
    expect(resolveAudible(bogus, 'blitzBeater', reg)).toBeNull();
  });

  it('resolves defensive audibles within the formation', () => {
    expect(resolveDefensiveAudible(cover1, 'zoneShift', reg)?.id).toBe('43-cover3-zone');
    expect(resolveDefensiveAudible(cover1, 'spy', reg)?.id).toBe('43-cover1-spy');
    expect(resolveDefensiveAudible(reg.defensePlays['43-cover4-zone'], 'blitz', reg)).toBeNull();
    const cross: DefensivePlay = { ...cover1, audibles: { blitz: 'nickel-cover0-cbBlitz' } };
    expect(resolveDefensiveAudible(cross, 'blitz', reg)).toBeNull();
    expect(availableDefensiveAudibles(cover1)).toEqual(['manShift', 'zoneShift', 'blitz', 'spy']);
  });
});

describe('suggestAudible', () => {
  it('answers man with manBeater and zone/match with zoneBeater', () => {
    expect(suggestAudible(slants, cover1)).toBe('manBeater');
    expect(suggestAudible(slants, cover3)).toBe('zoneBeater');
    expect(suggestAudible(slants, reg.defensePlays['43-cover3-match'])).toBe('zoneBeater');
  });

  it('prioritises blitz beaters against pressure and cover 0', () => {
    expect(suggestAudible(slants, allOut)).toBe('blitzBeater');
    expect(suggestAudible(slants, reg.defensePlays['43-cover1-doubleAGap'])).toBe('blitzBeater');
    const noBlitzBeater: OffensivePlay = { ...slants, audibles: { manBeater: 'shotgun-mesh' } };
    expect(suggestAudible(noBlitzBeater, allOut)).toBe('manBeater');
  });

  it('flips run/pass against stacked and light boxes', () => {
    expect(suggestAudible(dive, runStop)).toBe('runToPass');
    expect(suggestAudible(dive, cover3)).toBeNull();
    expect(suggestAudible(slants, dime)).toBe('passToRun');
    expect(suggestAudible(slants, reg.defensePlays['prevent-cover4-zone'])).toBe('passToRun');
    const noOptions: OffensivePlay = { ...dive, audibles: undefined };
    expect(suggestAudible(noOptions, runStop)).toBeNull();
  });

  it('suggests defensive adjustments from the offensive look', () => {
    expect(suggestDefensiveAudible(cover1, reg.offensePlays['shotgun-qbPowerRead'])).toBe('spy');
    expect(suggestDefensiveAudible(cover1, dive)).toBe('blitz');
    expect(suggestDefensiveAudible(cover1, reg.offensePlays['empty-mesh'], '00')).toBe('zoneShift');
    expect(suggestDefensiveAudible(cover1, reg.offensePlays['heavy-iso-right'], '22')).toBe('blitz');
    expect(suggestDefensiveAudible(cover1, reg.offensePlays['twoTE-skinnyPosts'], '12')).toBe('blitz');
    expect(suggestDefensiveAudible(cover1, slants, '11')).toBeNull();
    expect(suggestDefensiveAudible(reg.defensePlays['43-cover4-zone'], dive)).toBeNull();
  });
});
