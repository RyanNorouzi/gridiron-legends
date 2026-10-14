import { describe, expect, it } from 'vitest';
import { yardLineLabel } from '@/game/play-by-play';

describe('play-by-play yard lines', () => {
  const abbrs = { home: 'ATL', away: 'BAL' };
  it('names the team whose territory the ball is in (kick plays read from the field, not the kicking team)', () => {
    // BAL kicks off (ctx.offense = away); the ATL returner is tackled at his own 2 = the kicking team's 98.
    expect(yardLineLabel(98, { offense: 'away', teamAbbrs: abbrs })).toBe('the ATL 2');
    expect(yardLineLabel(25, { offense: 'away', teamAbbrs: abbrs })).toBe('the BAL 25');
    expect(yardLineLabel(30, { offense: 'home', teamAbbrs: abbrs })).toBe('the ATL 30');
    expect(yardLineLabel(66, { offense: 'home', teamAbbrs: abbrs })).toBe('the BAL 34');
    expect(yardLineLabel(50, { offense: 'home', teamAbbrs: abbrs })).toBe('the 50');
  });
  it('falls back to OWN / OPP without team abbreviations', () => {
    expect(yardLineLabel(20)).toBe('the OWN 20');
    expect(yardLineLabel(80, { offense: 'home' })).toBe('the OPP 20');
  });
  it('a spot on or past a goal line is the end zone, never "the BAL 0"', () => {
    expect(yardLineLabel(100, { offense: 'home', teamAbbrs: abbrs })).toBe('the BAL end zone');
    expect(yardLineLabel(-0.4, { offense: 'home', teamAbbrs: abbrs })).toBe('the ATL end zone');
    expect(yardLineLabel(100)).toBe('the OPP end zone');
  });
});
