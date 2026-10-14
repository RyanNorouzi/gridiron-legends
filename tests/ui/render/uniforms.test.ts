/**
 * Game-day uniforms: every pairing of league teams must put two clearly different jerseys on the field (normally and
 * under each colour-vision deficiency), with readable numbers.
 */
import { describe, expect, it } from 'vitest';
import type { ColorblindMode } from '@/core/settings';
import { loadTeamData } from '@/teams/data';
import { AWAY_JERSEY, colorDistance, contrastRatio, resolveTeamPalettes, simulateColorblind, teamUniforms, UNIFORM_CONTRAST } from '@/ui/render/palette';

const MODES: ColorblindMode[] = ['none', 'protanopia', 'deuteranopia', 'tritanopia'];

describe('teamUniforms', () => {
  const teams = loadTeamData();
  it('the away side wears white unless the home colour is itself light', () => {
    const [a, b] = [teams.find((t) => t.abbr === 'ATL')!, teams.find((t) => t.abbr === 'BAL')!];
    const u = teamUniforms(resolveTeamPalettes(a.colors, b.colors, 'none'));
    expect(u.away.primary).toBe(AWAY_JERSEY);
    expect(u.home.primary).toBe(a.colors.primary);
  });

  it('every home/away pairing gets separable jerseys and readable numbers in every colour mode', () => {
    const failures: string[] = [];
    for (const mode of MODES) {
      for (const home of teams) {
        for (const away of teams) {
          if (home.abbr === away.abbr) continue;
          const u = teamUniforms(resolveTeamPalettes(home.colors, away.colors, mode));
          const sim = (c: string): string => (mode === 'none' ? c : simulateColorblind(c, mode));
          const jerseys = contrastRatio(sim(u.home.primary), sim(u.away.primary));
          if (jerseys < UNIFORM_CONTRAST - 0.05 && colorDistance(sim(u.home.primary), sim(u.away.primary)) < 30) {
            failures.push(`${mode} ${home.abbr} vs ${away.abbr}: jerseys ${u.home.primary}/${u.away.primary} contrast ${jerseys.toFixed(2)}`);
          }
          for (const [side, c] of [['home', u.home], ['away', u.away]] as const) {
            if (contrastRatio(c.primary, c.accent) < 2) failures.push(`${mode} ${home.abbr} vs ${away.abbr}: ${side} numbers unreadable`);
          }
        }
      }
    }
    expect(failures.slice(0, 10)).toEqual([]);
  });
});
