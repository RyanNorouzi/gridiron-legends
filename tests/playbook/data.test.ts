import { describe, expect, it } from 'vitest';
import { loadPlaybookData, validatePlaybookData } from '@/playbook/loader';
import { OFFENSIVE_POSITIONS, type Position } from '@/players/types';
import type { BlitzType, CoverageFamily, CoverageShell, PlayConcept, RouteType } from '@/playbook/types';

const reg = loadPlaybookData();
const offPlays = Object.values(reg.offensePlays);
const defPlays = Object.values(reg.defensePlays);
const offFormations = Object.values(reg.offensiveFormations);
const defFormations = Object.values(reg.defensiveFormations);

describe('bundled playbook data', () => {
  it('validates with zero issues', () => {
    expect(validatePlaybookData()).toEqual([]);
  });

  it('meets the content minimums', () => {
    expect(offFormations.length).toBeGreaterThanOrEqual(10);
    expect(defFormations.length).toBeGreaterThanOrEqual(8);
    expect(Object.values(reg.routes).filter((r) => !r.id.endsWith('~m')).length).toBeGreaterThanOrEqual(22);
    expect(offPlays.length).toBeGreaterThanOrEqual(48);
    expect(defPlays.length).toBeGreaterThanOrEqual(32);
    expect(Object.keys(reg.playbooks).length).toBeGreaterThanOrEqual(5);
  });

  it('has the required offensive formations with 11 unique slots and correct eligibility', () => {
    for (const id of ['iForm', 'singleback', 'shotgun', 'shotgunTrips', 'pistol', 'trips', 'empty', 'twoTE', 'goalLine', 'kickoff', 'punt', 'fieldGoal']) {
      expect(reg.offensiveFormations[id], id).toBeDefined();
    }
    for (const f of offFormations) {
      expect(f.slots).toHaveLength(11);
      expect(new Set(f.slots.map((s) => s.role)).size).toBe(11);
      for (const s of f.slots) expect(s.y, `${f.id}:${s.role}`).toBeLessThanOrEqual(0);
      const ol = f.slots.filter((s) => (['OT', 'OG', 'C'] as Position[]).includes(s.position));
      for (const s of ol) expect(s.eligible, `${f.id}:${s.role}`).toBeFalsy();
      if (f.slots.some((s) => s.position === 'QB')) {
        for (const s of f.slots) expect(OFFENSIVE_POSITIONS.includes(s.position), `${f.id}:${s.role}`).toBe(true);
        expect(ol).toHaveLength(5);
        expect(f.slots.filter((s) => s.eligible)).toHaveLength(5);
        expect(f.slots.find((s) => s.position === 'QB')?.eligible).toBeFalsy();
      }
    }
    expect(reg.offensiveFormations.shotgun.slots.find((s) => s.role === 'QB')?.y).toBe(-5);
    expect(reg.offensiveFormations.pistol.slots.find((s) => s.role === 'QB')?.y).toBe(-3.5);
    expect(reg.offensiveFormations.iForm.slots.find((s) => s.role === 'RB')?.y).toBe(-7);
    expect(reg.offensiveFormations.twoTE.personnel).toBe('12');
  });

  it('has the required defensive formations with 11 unique slots and returners', () => {
    for (const id of ['43', '34', '425', 'nickel', 'dime', 'goalLine', 'prevent', 'kickReturn', 'puntReturn', 'fgBlock']) {
      expect(reg.defensiveFormations[id], id).toBeDefined();
    }
    for (const f of defFormations) {
      expect(f.slots).toHaveLength(11);
      expect(new Set(f.slots.map((s) => s.role)).size).toBe(11);
      for (const s of f.slots) expect(s.y, `${f.id}:${s.role}`).toBeGreaterThan(0);
    }
    expect(reg.defensiveFormations.kickReturn.slots.some((s) => s.role === 'KR')).toBe(true);
    expect(reg.defensiveFormations.puntReturn.slots.some((s) => s.role === 'PR')).toBe(true);
    expect(reg.defensiveFormations['43'].boxCount).toBe(7);
    expect(reg.defensiveFormations.nickel.slots.some((s) => s.role === 'CB3')).toBe(true);
  });

  it('covers every route type', () => {
    const types: RouteType[] = ['go', 'post', 'corner', 'out', 'in', 'dig', 'slant', 'curl', 'comeback', 'drag', 'flat', 'wheel', 'screen', 'hitch', 'seam', 'fade', 'cross', 'angle', 'stick', 'swing', 'checkRelease', 'block'];
    const present = new Set(Object.values(reg.routes).map((r) => r.type));
    for (const t of types) expect(present.has(t), t).toBe(true);
    for (const r of Object.values(reg.routes)) {
      if (r.id.endsWith('~m')) continue;
      expect(r.waypoints.length).toBeGreaterThan(0);
      expect(r.waypoints.filter((w) => w.isBreak).length).toBeLessThanOrEqual(1);
      expect(reg.routes[`${r.id}~m`]).toBeDefined();
    }
    const slant = reg.routes.slant;
    expect(slant.waypoints[0]?.isBreak).toBe(true);
    expect(slant.depth).toBe(3);
  });

  it('covers every play concept, with the common ones at least twice', () => {
    const counts = new Map<PlayConcept, number>();
    for (const p of offPlays) counts.set(p.concept, (counts.get(p.concept) ?? 0) + 1);
    const all: PlayConcept[] = ['insideRun', 'outsideRun', 'draw', 'screen', 'slant', 'curl', 'out', 'post', 'corner', 'go', 'cross', 'drag', 'mesh', 'fourVerts', 'playAction', 'rpo', 'qbRun', 'kneel', 'spike', 'kickoff', 'onside', 'punt', 'fieldGoal', 'extraPoint', 'fakePunt', 'fakeFieldGoal'];
    for (const c of all) expect(counts.get(c) ?? 0, c).toBeGreaterThanOrEqual(1);
    const twice: PlayConcept[] = ['insideRun', 'outsideRun', 'draw', 'screen', 'slant', 'curl', 'out', 'post', 'corner', 'go', 'cross', 'drag', 'mesh', 'fourVerts', 'rpo', 'qbRun', 'fakePunt', 'fakeFieldGoal'];
    for (const c of twice) expect(counts.get(c) ?? 0, c).toBeGreaterThanOrEqual(2);
    expect(counts.get('playAction') ?? 0).toBeGreaterThanOrEqual(3);
    expect(offPlays.filter((p) => p.tags.includes('twoPoint')).length).toBeGreaterThanOrEqual(2);
  });

  it('gives runs a carrier and gap, passes a dropback, play action a fake target', () => {
    for (const p of offPlays) {
      if (p.type === 'run' || p.type === 'qbRun' || p.type === 'rpo') {
        expect(p.ballCarrier, p.id).toBeDefined();
        expect(p.runGap, p.id).toBeDefined();
      }
      if (p.type === 'pass' || p.type === 'playAction' || p.type === 'screen') expect(p.dropback, p.id).toBeDefined();
      if (p.type === 'playAction' || p.type === 'rpo') {
        expect(p.fakeTo, p.id).toBeDefined();
        expect(p.assignments.QB?.fakeTo ?? p.assignments.H?.fakeTo ?? p.fakeTo).toBe(p.fakeTo);
      }
      const formation = reg.offensiveFormations[p.formation];
      for (const s of formation.slots) expect(p.assignments[s.role], `${p.id}:${s.role}`).toBeDefined();
    }
  });

  it('has audibles on at least 20 plays that all resolve within the same formation', () => {
    const withAudibles = offPlays.filter((p) => p.audibles && Object.keys(p.audibles).length > 0);
    expect(withAudibles.length).toBeGreaterThanOrEqual(20);
    for (const p of withAudibles) {
      for (const id of Object.values(p.audibles ?? {})) {
        const t = reg.offensePlays[id];
        expect(t, `${p.id} -> ${id}`).toBeDefined();
        expect(t.formation).toBe(p.formation);
      }
    }
    expect(offPlays.filter((p) => p.audibles?.manBeater).length).toBeGreaterThan(5);
    expect(offPlays.filter((p) => p.audibles?.blitzBeater).length).toBeGreaterThan(5);
    expect(offPlays.filter((p) => p.audibles?.runToPass).length).toBeGreaterThan(5);
    expect(offPlays.filter((p) => p.audibles?.passToRun).length).toBeGreaterThan(5);
  });

  it('covers every coverage shell, family and blitz type on defense', () => {
    const shells: CoverageShell[] = ['cover0', 'cover1', 'cover2', 'cover3', 'cover4', 'cover6', 'cover9'];
    const families: CoverageFamily[] = ['man', 'zone', 'match'];
    const blitzes: BlitzType[] = ['none', 'lb', 'cb', 'safety', 'nickel', 'doubleAGap', 'edge', 'zone', 'allOut'];
    for (const s of shells) expect(defPlays.some((p) => p.coverage === s), s).toBe(true);
    for (const f of families) expect(defPlays.some((p) => p.family === f), f).toBe(true);
    for (const b of blitzes) expect(defPlays.some((p) => p.blitz === b), b).toBe(true);
    for (const base of ['43', '34', '425', 'nickel', 'dime']) expect(defPlays.filter((p) => p.formation === base).length, base).toBeGreaterThanOrEqual(5);
    expect(defPlays.some((p) => p.tags.includes('runStop') && p.formation === 'goalLine')).toBe(true);
    expect(defPlays.some((p) => p.tags.includes('prevent'))).toBe(true);
    expect(defPlays.some((p) => p.tags.includes('kickReturn'))).toBe(true);
    expect(defPlays.some((p) => p.tags.includes('puntReturn'))).toBe(true);
    expect(defPlays.some((p) => p.tags.includes('fgBlock'))).toBe(true);
    expect(defPlays.some((p) => p.alignTo === 'strength')).toBe(true);
    expect(defPlays.some((p) => p.flip)).toBe(true);
    expect(defPlays.filter((p) => p.audibles).length).toBeGreaterThanOrEqual(3);
  });

  it('uses sensible defensive assignment types per position group', () => {
    for (const p of defPlays) {
      const f = reg.defensiveFormations[p.formation];
      if (p.tags.some((t) => ['kickReturn', 'puntReturn', 'fgBlock'].includes(t))) continue;
      for (const s of f.slots) {
        const a = p.assignments[s.role];
        if (s.position === 'DE' || s.position === 'DT') expect(['rushGap', 'contain', 'zone', 'manCover'], `${p.id}:${s.role}`).toContain(a.type);
        if (s.position === 'CB' || s.position === 'FS' || s.position === 'SS') expect(['manCover', 'zone', 'blitz', 'spy', 'runFill'], `${p.id}:${s.role}`).toContain(a.type);
      }
      expect(Object.values(p.assignments).some((a) => a.type === 'returner')).toBe(false);
    }
    const c3 = reg.defensePlays['43-cover3-zone'];
    expect(c3.assignments.FS.zone).toBe('deepThirdMiddle');
    expect(c3.assignments.CB1.zone).toBe('deepThirdLeft');
    const quarters = reg.defensePlays['43-cover4-zone'];
    expect([quarters.assignments.CB1.zone, quarters.assignments.FS.zone, quarters.assignments.SS.zone, quarters.assignments.CB2.zone]).toEqual(['deepQuarter1', 'deepQuarter2', 'deepQuarter3', 'deepQuarter4']);
  });

  it('playbooks reference real plays with the required minimum sizes', () => {
    for (const id of ['balanced', 'airRaid', 'westCoast', 'groundAndPound', 'spread']) {
      const pb = reg.playbooks[id];
      expect(pb, id).toBeDefined();
      expect(pb.offensePlayIds.length, id).toBeGreaterThanOrEqual(25);
      expect(pb.defensePlayIds.length, id).toBeGreaterThanOrEqual(18);
      for (const pid of pb.offensePlayIds) expect(reg.offensePlays[pid], `${id}:${pid}`).toBeDefined();
      for (const pid of pb.defensePlayIds) expect(reg.defensePlays[pid], `${id}:${pid}`).toBeDefined();
      for (const concept of ['kickoff', 'punt', 'fieldGoal', 'extraPoint', 'kneel', 'spike']) {
        expect(pb.offensePlayIds.some((pid) => reg.offensePlays[pid].concept === concept), `${id} lacks ${concept}`).toBe(true);
      }
      for (const tag of ['kickReturn', 'puntReturn', 'fgBlock']) {
        expect(pb.defensePlayIds.some((pid) => reg.defensePlays[pid].tags.includes(tag)), `${id} lacks ${tag}`).toBe(true);
      }
    }
    const air = reg.playbooks.airRaid.offensePlayIds.map((id) => reg.offensePlays[id]);
    const ground = reg.playbooks.groundAndPound.offensePlayIds.map((id) => reg.offensePlays[id]);
    const runShare = (ps: typeof air): number => ps.filter((p) => p.type === 'run').length / ps.length;
    expect(runShare(ground)).toBeGreaterThan(runShare(air));
  });
});
