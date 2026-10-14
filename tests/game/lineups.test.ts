import { describe, expect, it } from 'vitest';
import type { PlayerId } from '@/core/ids';
import type { Position } from '@/players/types';
import { FALLBACK_POSITIONS, gunnerScore, inferPositionFromRole, KICK_COVERAGE_POSITIONS, kickCoverageScore, lineupIds, personnelFor, PUNT_SHIELD_POSITIONS, selectLineup } from '@/game/lineups';
import { formationFromRoles } from '@/game/play-context';
import { makeTeam, OFFENSE_PLAYS } from './fixtures';

const base = () => makeTeam('home', 11);
const offForm = formationFromRoles(['QB', 'RB', 'FB', 'WR1', 'WR2', 'WR3', 'TE1', 'LT', 'LG', 'C', 'RG', 'RT']);

describe('selectLineup', () => {
  it('fills every role from the depth chart in order, never using a player twice', () => {
    const { team, players } = base();
    const lineup = selectLineup(team, players, offForm, {}, []);
    expect(Object.keys(lineup)).toHaveLength(offForm.slots.length);
    expect(lineup['QB']!.id).toBe(team.depthChart.QB[0]);
    expect(lineup['WR1']!.id).toBe(team.depthChart.WR[0]);
    expect(lineup['WR3']!.id).toBe(team.depthChart.WR[2]);
    expect(lineup['LT']!.id).toBe(team.depthChart.OT[0]);
    expect(lineup['RT']!.id).toBe(team.depthChart.OT[1]);
    expect(new Set(lineupIds(lineup)).size).toBe(offForm.slots.length);
  });

  it('mans a punt shield with cover men (TE / FB / LB / DE / SS) instead of the starting offensive line', () => {
    const { team, players } = base();
    // The bundled punt formation's slots (src/data/formations-offense.json 'punt').
    const slots: [string, Position][] = [['LS', 'C'], ['LG', 'OG'], ['RG', 'OG'], ['LT', 'OT'], ['RT', 'OT'], ['W1', 'TE'], ['W2', 'TE'], ['PP', 'RB'], ['P', 'P'], ['G1', 'CB'], ['G2', 'WR']];
    const punt = { slots: slots.map(([role, position]) => ({ role, position, x: 0, y: 0 })) };
    const lineup = selectLineup(team, players, punt, {}, []);
    for (const role of ['LG', 'RG', 'LT', 'RT']) expect(PUNT_SHIELD_POSITIONS, role).toContain(lineup[role]!.position);
    expect(lineup['LS']!.position).toBe('C');
    expect(new Set(lineupIds(lineup)).size).toBe(punt.slots.length);
    // A scrimmage formation still gets the offensive line.
    expect(selectLineup(team, players, offForm, {}, [])['LT']!.position).toBe('OT');
  });

  it('mans kickoff coverage and the punt gunners with the roster\'s best cover men (sure tacklers with speed)', () => {
    const { team, players } = base();
    // The bundled kickoff formation's slots (src/data/formations-offense.json 'kickoff').
    const koSlots: [string, Position][] = [['K', 'K'], ['KC1', 'CB'], ['KC2', 'SS'], ['KC3', 'OLB'], ['KC4', 'TE'], ['KC5', 'FB'], ['KC6', 'MLB'], ['KC7', 'RB'], ['KC8', 'OLB'], ['KC9', 'SS'], ['KC10', 'CB']];
    const ko = { slots: koSlots.map(([role, position]) => ({ role, position, x: 0, y: 0 })) };
    const lineup = selectLineup(team, players, ko, {}, []);
    expect(lineup['K']!.position).toBe('K');
    const cover = koSlots.filter(([r]) => r !== 'K').map(([r]) => lineup[r]!);
    for (const p of cover) expect(KICK_COVERAGE_POSITIONS).toContain(p.position);
    expect(new Set(lineupIds(lineup)).size).toBe(ko.slots.length);
    // Nobody left on the bench is a better cover man than the weakest one on the field.
    const chosen = new Set(cover.map((p) => p.id));
    const worst = Math.min(...cover.map(kickCoverageScore));
    const bench = team.rosterIds.map((id) => players[id]!).filter((p) => !chosen.has(p.id) && KICK_COVERAGE_POSITIONS.includes(p.position));
    for (const p of bench) expect(kickCoverageScore(p)).toBeLessThanOrEqual(worst);
    // Punt gunners are cover men too; the shield rule still holds.
    const puntSlots: [string, Position][] = [['LS', 'C'], ['LG', 'OG'], ['RG', 'OG'], ['LT', 'OT'], ['RT', 'OT'], ['W1', 'TE'], ['W2', 'TE'], ['PP', 'RB'], ['P', 'P'], ['G1', 'CB'], ['G2', 'WR']];
    const punt = selectLineup(team, players, { slots: puntSlots.map(([role, position]) => ({ role, position, x: 0, y: 0 })) }, {}, []);
    for (const g of ['G1', 'G2']) expect(KICK_COVERAGE_POSITIONS).toContain(punt[g]!.position);
    expect(gunnerScore(punt['G1']!)).toBeGreaterThan(0);
    for (const role of ['LG', 'RG', 'LT', 'RT', 'W1', 'W2', 'PP']) expect(PUNT_SHIELD_POSITIONS, role).toContain(punt[role]!.position);
    // A scrimmage formation still follows the depth chart.
    expect(selectLineup(team, players, offForm, {}, [])['RB']!.id).toBe(team.depthChart.RB[0]);
  });

  it('skips injured players (game injuries and the player record)', () => {
    const { team, players } = base();
    const qb1 = team.depthChart.QB[0]!;
    const wr1 = team.depthChart.WR[0]!;
    players[wr1]!.injury = { bodyArea: 'lowerBody', severity: 'short', weeksRemaining: 2, permanentPenalty: null, occurredYear: 2026, occurredWeek: 3 };
    const lineup = selectLineup(team, players, offForm, {}, [{ playerId: qb1, severity: 'minor', quarter: 1, playIndex: 3 }]);
    expect(lineup['QB']!.id).toBe(team.depthChart.QB[1]);
    expect(lineup['WR1']!.id).toBe(team.depthChart.WR[1]);
  });

  it('falls back across positions: extra WR slots pull from TE/RB, FB from RB, and throws when the roster is exhausted', () => {
    const { team, players } = base();
    const sixWide = formationFromRoles(['QB', 'WR1', 'WR2', 'WR3', 'WR4', 'WR5', 'WR6', 'WR7', 'LT', 'LG', 'C', 'RG', 'RT']);
    const lineup = selectLineup(team, players, sixWide, {}, []);
    expect(lineup['WR7']!.position).toBe('TE');
    const noFb = { ...team, depthChart: { ...team.depthChart, FB: [] as PlayerId[] } };
    for (const id of team.depthChart.FB) delete players[id];
    noFb.rosterIds = noFb.rosterIds.filter((id) => players[id] !== undefined);
    const withoutFb = selectLineup(noFb, players, offForm, {}, []);
    expect(withoutFb['FB']!.position).toBe('RB');
    expect(FALLBACK_POSITIONS.FB[0]).toBe('RB');
    const tiny = { ...team, rosterIds: [team.depthChart.QB[0]!] };
    expect(() => selectLineup(tiny, players, offForm, {}, [])).toThrow(/cannot fill role/);
  });

  it('rotates tired players at DL/RB when a fresher backup exists, and not at QB', () => {
    const { team, players } = base();
    const defForm = formationFromRoles(['DE1', 'DT1', 'DT2', 'DE2', 'OLB1', 'MLB', 'OLB2', 'CB1', 'CB2', 'FS', 'SS']);
    const tiredDe = team.depthChart.DE[0]!;
    const fatigue: Record<PlayerId, number> = { [tiredDe]: 0.9, [team.depthChart.DE[1]!]: 0.2 };
    const lineup = selectLineup(team, players, defForm, fatigue, []);
    expect(lineup['DE1']!.id).toBe(team.depthChart.DE[1]);
    expect(lineup['DE2']!.id).toBe(team.depthChart.DE[2]);
    expect(lineupIds(lineup)).not.toContain(tiredDe);
    const onlyOneBackup: Record<PlayerId, number> = { [tiredDe]: 0.9, [team.depthChart.DE[1]!]: 0.2, [team.depthChart.DE[2]!]: 0.8, [team.depthChart.DE[3]!]: 0.85 };
    const thin = selectLineup(team, players, defForm, onlyOneBackup, []);
    expect(thin['DE1']!.id).toBe(team.depthChart.DE[1]);
    expect(thin['DE2']!.id).toBe(tiredDe);
    const fresh = selectLineup(team, players, defForm, { [tiredDe]: 0.3 }, []);
    expect(fresh['DE1']!.id).toBe(tiredDe);
    const qbFatigue: Record<PlayerId, number> = { [team.depthChart.QB[0]!]: 0.95 };
    expect(selectLineup(team, players, offForm, qbFatigue, [])['QB']!.id).toBe(team.depthChart.QB[0]);
    const rbTired: Record<PlayerId, number> = { [team.depthChart.RB[0]!]: 0.8, [team.depthChart.RB[1]!]: 0.1 };
    expect(selectLineup(team, players, offForm, rbTired, [])['RB']!.id).toBe(team.depthChart.RB[1]);
    expect(selectLineup(team, players, offForm, rbTired, [], { rotate: false })['RB']!.id).toBe(team.depthChart.RB[0]);
  });

  it('honours per-game substitutions and returner depth slots', () => {
    const { team, players } = base();
    const backupQb = team.depthChart.QB[2]!;
    const lineup = selectLineup(team, players, offForm, {}, [], { overrides: { QB: backupQb } });
    expect(lineup['QB']!.id).toBe(backupQb);
    const returnForm = formationFromRoles(['KR', 'RB1', 'RB2']);
    const ret = selectLineup(team, players, returnForm, {}, []);
    expect(ret['KR']!.id).toBe(team.depthChart.KR[0]);
    const pr = selectLineup(team, players, formationFromRoles(['PR']), {}, []);
    expect(pr['PR']!.id).toBe(team.depthChart.PR[0]);
  });

  it('an override naming a depth starter moves him to that role instead of being ignored', () => {
    const { team, players } = base();
    const [wr1, wr2] = team.depthChart.WR;
    const lineup = selectLineup(team, players, formationFromRoles(['WR1', 'WR2']), {}, [], { overrides: { WR2: wr1! } });
    expect(lineup['WR2']!.id).toBe(wr1);
    expect(lineup['WR1']!.id).toBe(wr2);
  });

  it('infers positions from role names and personnel from plays', () => {
    expect(inferPositionFromRole('WR3')).toBe('WR');
    expect(inferPositionFromRole('LOLB')).toBe('OLB');
    expect(inferPositionFromRole('NCB')).toBe('CB');
    expect(inferPositionFromRole('H')).toBe('P');
    expect(inferPositionFromRole('???')).toBeNull();
    expect(personnelFor(OFFENSE_PLAYS[0]!)).toBe('11');
    expect(personnelFor(OFFENSE_PLAYS[0]!, { slots: offForm.slots })).toBe('21');
    expect(personnelFor(OFFENSE_PLAYS[0]!, { slots: [], personnel: '12' })).toBe('12');
  });
});
