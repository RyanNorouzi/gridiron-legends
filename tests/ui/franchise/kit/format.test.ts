import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '@/core/settings';
import type { Contract, InjuryStatus } from '@/players/types';
import { createTheme } from '@/ui/theme';
import {
  compactName, formatAge, formatCapPct, formatContract, formatDate, formatHeight, formatInjury, formatMoney, formatPercent, formatPositions,
  formatRating, formatRatingRange, formatRecord, formatSigned, formatStreak, formatWeight, humanize, moodTone, ordinal, phaseLabel,
  ratingTier, ratingTone, toneColor,
} from '@/ui/franchise/kit/format';

const contract = (o: Partial<Contract> = {}): Contract => ({
  salary: 14_000_000, years: 3, yearsRemaining: 3, guaranteed: 20_000_000, signingBonus: 0, role: 'starter', signedYear: 2027, restructured: false, tag: null, ...o,
});

describe('money and percentages', () => {
  it('formats compact dollars', () => {
    expect(formatMoney(12_300_000)).toBe('$12.3M');
    expect(formatMoney(950_000)).toBe('$950K');
    expect(formatMoney(1_000_000)).toBe('$1.0M');
    expect(formatMoney(999_700)).toBe('$1.0M');
    expect(formatMoney(2_450_000_000)).toBe('$2.5B');
    expect(formatMoney(500)).toBe('$500');
    expect(formatMoney(999_960_000)).toBe('$1.0B');
    expect(formatMoney(-2_000_000)).toBe('-$2.0M');
    expect(formatMoney(0)).toBe('$0');
    expect(formatMoney(Number.NaN)).toBe('$?');
  });
  it('formats cap share, percents and signed deltas', () => {
    expect(formatCapPct(24_600_000, 200_000_000)).toBe('12.3%');
    expect(formatCapPct(5, 0)).toBe('0.0%');
    expect(formatPercent(0.455)).toBe('45.5%');
    expect(formatSigned(3)).toBe('+3');
    expect(formatSigned(-2)).toBe('-2');
    expect(formatSigned(0)).toBe('0');
  });
});

describe('ratings', () => {
  it('maps tiers to tones and theme colours', () => {
    expect([95, 85, 75, 65, 55, 40].map(ratingTier)).toEqual(['elite', 'great', 'good', 'average', 'weak', 'poor']);
    expect(ratingTone(92)).toBe('accent');
    expect(ratingTone(45)).toBe('danger');
    const theme = createTheme(DEFAULT_SETTINGS);
    expect(toneColor(theme, ratingTone(85))).toBe(theme.colors.success);
    expect(toneColor(theme)).toBe(theme.colors.text);
    const cb = createTheme({ ...DEFAULT_SETTINGS, colorblind: 'deuteranopia' });
    expect(toneColor(cb, 'danger')).toBe(cb.colors.danger);
  });
  it('formats ratings and ranges', () => {
    expect(formatRating(88)).toEqual({ text: '88', tone: 'success' });
    expect(formatRating(null)).toEqual({ text: '?', tone: 'dim' });
    expect(formatRatingRange(76, 68)).toEqual({ text: '68-76', tone: 'info' });
    expect(formatRatingRange(70, 70).text).toBe('70');
  });
});

describe('bio, records and dates', () => {
  it('formats people', () => {
    expect(formatAge(27)).toBe('27');
    expect(formatAge(27, true)).toBe('Age 27');
    expect(formatHeight(74)).toBe(`6'2"`);
    expect(formatHeight(72)).toBe(`6'0"`);
    expect(formatWeight(215.4)).toBe('215 lb');
    expect(formatPositions(['QB', 'RB'])).toBe('QB/RB');
    expect(formatPositions([])).toBe('-');
    expect(humanize('hotHeaded')).toBe('Hot Headed');
    expect(humanize('seasonEnding')).toBe('Season Ending');
  });
  it('formats ordinals', () => {
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 101, 102, 111].map(ordinal)).toEqual(['1st', '2nd', '3rd', '4th', '11th', '12th', '13th', '21st', '22nd', '23rd', '101st', '102nd', '111th']);
  });
  it('formats records and streaks', () => {
    expect(formatRecord({ wins: 10, losses: 6, ties: 0 })).toBe('10-6');
    expect(formatRecord({ wins: 10, losses: 6, ties: 1 })).toBe('10-6-1');
    expect(formatRecord({ wins: 3, losses: 2 }, true)).toBe('3-2-0');
    expect(formatStreak(3)).toBe('W3');
    expect(formatStreak(-2)).toBe('L2');
    expect(formatStreak(0)).toBe('-');
  });
  it('formats league dates per phase', () => {
    expect(formatDate(2027, 5)).toBe('2027 Wk 5');
    expect(formatDate(2027, 2, 'preseason')).toBe('2027 Pre Wk 2');
    expect(formatDate(2027, 1, 'playoffs', ['Wild Card', 'Divisional'])).toBe('2027 Wild Card');
    expect(formatDate(2027, 3, 'playoffs')).toBe('2027 Playoffs Rd 3');
    expect(formatDate(2027, 0, 'freeAgency')).toBe('2027 Free Agency');
    expect(phaseLabel('resigning')).toBe('Re-signing');
  });
});

describe('contracts, injuries, mood', () => {
  it('summarises contracts', () => {
    expect(formatContract(contract())).toBe('3y $42.0M ($14.0M/yr)');
    expect(formatContract(contract({ salary: 10_000_000, signingBonus: 12_000_000 }))).toBe('3y $42.0M ($14.0M/yr)');
    expect(formatContract(contract({ yearsRemaining: 1 }), { remaining: true })).toBe('1y $14.0M ($14.0M/yr)');
    expect(formatContract(null)).toBe('No contract');
  });
  it('summarises injuries and mood', () => {
    const inj: InjuryStatus = { bodyArea: 'lowerBody', severity: 'short', weeksRemaining: 3, permanentPenalty: null, occurredYear: 2027, occurredWeek: 4 };
    expect(formatInjury(inj)).toEqual({ text: 'Lower Body - Short (3 wks)', tone: 'danger' });
    expect(formatInjury({ ...inj, severity: 'minor', weeksRemaining: 1 })).toEqual({ text: 'Lower Body - Minor (1 wk)', tone: 'warning' });
    expect(formatInjury(null)).toEqual({ text: 'Healthy', tone: 'success' });
    expect([90, 50, 30, 10].map(moodTone)).toEqual(['success', 'normal', 'warning', 'danger']);
  });
});

describe('compactName', () => {
  it('keeps short names and shortens long ones to initial plus surname', () => {
    expect(compactName('Troy Nolan')).toBe('Troy Nolan');
    expect(compactName('Marquis Whitfield')).toBe('M. Whitfield');
    expect(compactName('Andre St. Clair-Robinson', 10)).toBe('A. St. Clair-Robinson');
    expect(compactName('Madonnalongname')).toBe('Madonnalongname');
  });
});
