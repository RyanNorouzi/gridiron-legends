import { describe, expect, it } from 'vitest';
import {
  MIRROR_SUFFIX, buildRegistry, bundledPlaybookData, loadPlaybookData, materializeDefensivePlay, materializePlay,
  offensiveStrength, resolvePlaybook, resolveRoute, validateDefensivePlay, validateOffensivePlay, validatePlaybook,
} from '@/playbook/loader';
import type { DefensivePlay, OffensivePlay, Playbook } from '@/playbook/types';

const reg = loadPlaybookData();
const messages = (issues: { message: string }[]): string => issues.map((i) => i.message).join('\n');

const validPass = (): OffensivePlay => structuredClone(reg.offensePlays['shotgun-slants']);
const validDef = (): DefensivePlay => structuredClone(reg.defensePlays['43-cover3-zone']);

describe('materializePlay', () => {
  it('returns the play unchanged (minus flags) when nothing is flipped or mirrored', () => {
    const play = reg.offensePlays['shotgun-goRoutes'];
    const m = materializePlay(play, reg.offensiveFormations.shotgun, reg.routes);
    expect(m.play.flip).toBeUndefined();
    expect(m.play.assignments.WR2).toEqual({ type: 'route', route: 'go' });
    expect(m.routes.WR2.waypoints).toEqual(reg.routes.go.waypoints);
    expect(m.formation).toBe(reg.offensiveFormations.shotgun);
    for (const a of Object.values(m.play.assignments)) expect(a.mirror).toBeUndefined();
  });

  it('resolves mirror into the mirrored twin route for left-side receivers', () => {
    const play = reg.offensePlays['shotgun-goRoutes'];
    const m = materializePlay(play, reg.offensiveFormations.shotgun, reg.routes);
    expect(m.play.assignments.WR1.route).toBe(`go${MIRROR_SUFFIX}`);
    expect(m.play.assignments.WR1.mirror).toBeUndefined();
    const seamL = m.routes.WR3;
    expect(seamL.id).toBe(`seam${MIRROR_SUFFIX}`);
    expect(seamL.waypoints.map((w) => w.dx)).toEqual(reg.routes.seam.waypoints.map((w) => -w.dx));
    expect(seamL.waypoints.map((w) => w.dy)).toEqual(reg.routes.seam.waypoints.map((w) => w.dy));
  });

  it('flip negates slot x, mirrors gaps/runGap and inverts route mirroring', () => {
    const right = reg.offensePlays['iform-toss-right'];
    const left = reg.offensePlays['iform-toss-left'];
    expect(left.flip).toBe(true);
    const mr = materializePlay(right, reg.offensiveFormations.iForm, reg.routes);
    const ml = materializePlay(left, reg.offensiveFormations.iForm, reg.routes);
    expect(ml.play.flip).toBeUndefined();
    expect(ml.play.runGap).toBe('D-left');
    expect(mr.play.runGap).toBe('D-right');
    expect(ml.play.assignments.FB.gap).toBe('D-left');
    expect(ml.play.assignments.RT.gap).toBe('C-left');
    expect(ml.play.assignments.LT.gap).toBe('B-right');
    for (const s of ml.formation.slots) {
      const orig = reg.offensiveFormations.iForm.slots.find((o) => o.role === s.role);
      expect(s.x).toBe(-(orig?.x ?? NaN));
      expect(s.y).toBe(orig?.y);
    }
    // WR1 is on the left (mirrored) in the authored play; after the flip it is on the right and runs the base route.
    expect(mr.play.assignments.WR1.route).toBe(`stalkBlock${MIRROR_SUFFIX}`);
    expect(ml.play.assignments.WR1.route).toBe('stalkBlock');
    expect(ml.play.assignments.WR2.route).toBe(`stalkBlock${MIRROR_SUFFIX}`);
    expect(reg.offensiveFormations.iForm.slots.map((s) => s.x)).toEqual(reg.offensiveFormations.iForm.slots.map((s) => s.x));
  });

  it('resolveRoute treats a double mirror as identity and falls back when no twin is registered', () => {
    expect(resolveRoute(reg.routes, `post${MIRROR_SUFFIX}`, true).id).toBe('post');
    expect(resolveRoute(reg.routes, 'post', false).id).toBe('post');
    const only = { post: reg.routes.post };
    const m = resolveRoute(only, 'post', true);
    expect(m.id).toBe(`post${MIRROR_SUFFIX}`);
    expect(m.waypoints[1]?.dx).toBe(-(reg.routes.post.waypoints[1]?.dx ?? NaN));
    expect(() => resolveRoute(only, 'nope', false)).toThrow(/Unknown route/);
  });
});

describe('materializeDefensivePlay + offensiveStrength', () => {
  it('detects run and pass strength from the offensive formation', () => {
    expect(offensiveStrength(reg.offensiveFormations.trips)).toEqual({ run: 'left', pass: 'right' });
    expect(offensiveStrength(reg.offensiveFormations.iForm)).toEqual({ run: 'right', pass: 'right' });
    expect(offensiveStrength(reg.offensiveFormations.shotgunTrips).pass).toBe('right');
    expect(offensiveStrength(reg.offensiveFormations.empty).pass).toBe('left');
  });

  it('flips zones, gaps and slots when aligning to a left strength', () => {
    const play = reg.defensePlays['43-cover3-zone'];
    expect(play.alignTo).toBe('strength');
    const right = materializeDefensivePlay(play, reg.defensiveFormations['43'], { run: 'right', pass: 'right' });
    expect(right.play.assignments.SS.zone).toBe('curlFlatRight');
    expect(right.play.flip).toBeUndefined();
    expect(right.play.alignTo).toBeUndefined();
    const left = materializeDefensivePlay(play, reg.defensiveFormations['43'], { run: 'left', pass: 'right' });
    expect(left.play.assignments.SS.zone).toBe('curlFlatLeft');
    expect(left.play.assignments.CB1.zone).toBe('deepThirdRight');
    expect(left.play.assignments.FS.zone).toBe('deepThirdMiddle');
    expect(left.play.assignments.DT1.gap).toBe('B-right');
    expect(left.formation.slots.find((s) => s.role === 'SS')?.x).toBe(-5);
    expect(left.play.assignments.CB1.manTarget).toBeUndefined();
  });

  it('honours an authored flip and XORs it with alignment', () => {
    const play = reg.defensePlays['kickReturn-left'];
    const m = materializeDefensivePlay(play, reg.defensiveFormations.kickReturn);
    expect(m.formation.slots.find((s) => s.role === 'M1')?.x).toBe(12);
    const flippedPlay: DefensivePlay = { ...reg.defensePlays['43-cover3-zone'], flip: true };
    const both = materializeDefensivePlay(flippedPlay, reg.defensiveFormations['43'], { run: 'left', pass: 'left' });
    expect(both.play.assignments.SS.zone).toBe('curlFlatRight');
    const passOnly = materializeDefensivePlay(reg.defensePlays['43-cover6-zone'], reg.defensiveFormations['43'], { run: 'right', pass: 'left' });
    expect(passOnly.play.assignments.CB2.zone).toBe('deepQuarter1');
  });
});

describe('validation of user-authored content', () => {
  it('flags an unknown formation, missing and extra assignments', () => {
    const play = validPass();
    play.formation = 'wishbone';
    let msgs = messages(validateOffensivePlay(play, reg));
    expect(msgs).toContain('unknown formation wishbone');
    const play2 = validPass();
    delete play2.assignments.WR3;
    play2.assignments.WR9 = { type: 'route', route: 'go' };
    msgs = messages(validateOffensivePlay(play2, reg));
    expect(msgs).toContain('slot WR3 has no assignment');
    expect(msgs).toContain('assignment for unknown role WR9');
  });

  it('flags unknown routes, bad gaps, missing run fields and ineligible route runners', () => {
    const play = validPass();
    play.assignments.WR2 = { type: 'route', route: 'zigzag' };
    play.assignments.LT = { type: 'route', route: 'go' };
    play.assignments.RG = { type: 'runBlock', gap: 'E-left' as never };
    const msgs = messages(validateOffensivePlay(play, reg));
    expect(msgs).toContain('WR2 references unknown route zigzag');
    expect(msgs).toContain('ineligible LT cannot run a route');
    expect(msgs).toContain('RG has invalid gap E-left');
    const run = structuredClone(reg.offensePlays['iform-dive-right']);
    delete run.ballCarrier;
    delete run.runGap;
    const runMsgs = messages(validateOffensivePlay(run, reg));
    expect(runMsgs).toContain('run plays need a ballCarrier');
    expect(runMsgs).toContain('run plays need a runGap');
  });

  it('flags bad primary/progression, missing dropback/fakeTo and bad audibles', () => {
    const play = validPass();
    play.primary = 'WR7';
    play.progression = ['WR1', 'TE9'];
    delete play.dropback;
    play.audibles = { manBeater: 'no-such-play', zoneBeater: 'iform-dive-right', blitzBeater: play.id };
    const msgs = messages(validateOffensivePlay(play, reg));
    expect(msgs).toContain('primary WR7 is not a slot');
    expect(msgs).toContain('progression role TE9 is not a slot');
    expect(msgs).toContain('pass plays need a dropback');
    expect(msgs).toContain('audible manBeater references unknown play no-such-play');
    expect(msgs).toContain('audible zoneBeater -> iform-dive-right uses a different formation');
    expect(msgs).toContain('audible blitzBeater references itself');
    const pa = structuredClone(reg.offensePlays['singleback-paPost']);
    delete pa.fakeTo;
    expect(messages(validateOffensivePlay(pa, reg))).toContain('playAction plays need fakeTo');
    expect(validateOffensivePlay(validPass(), reg)).toEqual([]);
  });

  it('flags defensive plays with bad man targets, zones, gaps and enums', () => {
    const play = validDef();
    play.assignments.CB1 = { type: 'manCover', manTarget: 'LT' };
    play.assignments.CB2 = { type: 'zone', zone: 'deepFifth' as never };
    play.assignments.DT1 = { type: 'rushGap' };
    play.assignments.MLB = { type: 'blitz', gap: 'Z-left' as never };
    play.coverage = 'cover5' as never;
    play.blitz = 'everyone' as never;
    const msgs = messages(validateDefensivePlay(play, reg));
    expect(msgs).toContain('CB1 man target LT is not an eligible offensive role');
    expect(msgs).toContain('CB2 has invalid zone deepFifth');
    expect(msgs).toContain('DT1 rushGap needs a gap');
    expect(msgs).toContain('MLB has invalid gap Z-left');
    expect(msgs).toContain('invalid coverage cover5');
    expect(msgs).toContain('invalid blitz everyone');
    expect(validateDefensivePlay(validDef(), reg)).toEqual([]);
    const noTarget = validDef();
    noTarget.assignments.CB1 = { type: 'manCover' };
    expect(messages(validateDefensivePlay(noTarget, reg))).toContain('CB1 manCover needs a manTarget');
  });

  it('flags playbooks with unknown or duplicate play ids', () => {
    const pb: Playbook = { id: 'custom', name: 'Custom', offensePlayIds: ['shotgun-slants', 'shotgun-slants', 'ghost'], defensePlayIds: [] };
    const msgs = messages(validatePlaybook(pb, reg));
    expect(msgs).toContain('offensePlayIds references unknown play ghost');
    expect(msgs).toContain('offensePlayIds contains duplicates');
    expect(msgs).toContain('defensePlayIds is empty');
  });

  it('rejects malformed formations at the boundary', () => {
    const raw = bundledPlaybookData();
    const formations = structuredClone(raw.offensiveFormations) as { id: string; personnel: string; slots: { role: string; eligible?: boolean }[] }[];
    const iForm = formations.find((f) => f.id === 'iForm');
    if (!iForm) throw new Error('fixture');
    iForm.personnel = '12';
    iForm.slots[0].eligible = true;
    iForm.slots.push({ role: 'RB' } as never);
    const { issues } = buildRegistry({ ...raw, offensiveFormations: formations });
    const msgs = messages(issues);
    expect(msgs).toContain('personnel 12 does not match slots');
    expect(msgs).toContain('the QB slot is not an eligible receiver');
    expect(msgs).toContain('has 12 slots, expected 11');
    expect(msgs).toContain('malformed slot');
    expect(buildRegistry({ ...raw, routes: 'nope' }).issues.map((i) => i.message)).toContain('routes: expected an array');
  });
});

describe('resolvePlaybook', () => {
  it('resolves a bundled playbook to concrete plays', () => {
    const r = resolvePlaybook('balanced');
    expect(r.playbook.id).toBe('balanced');
    expect(r.offense.length).toBe(reg.playbooks.balanced.offensePlayIds.length);
    expect(r.defense.length).toBe(reg.playbooks.balanced.defensePlayIds.length);
    expect(r.issues).toEqual([]);
    expect(() => resolvePlaybook('nope')).toThrow(/Unknown playbook nope/);
  });

  it('merges custom content, prefers bundled ids and excludes invalid custom plays with issues', () => {
    const goodCustom: OffensivePlay = { ...validPass(), id: 'my-slants', name: 'My Slants', audibles: undefined };
    const badCustom: OffensivePlay = { ...validPass(), id: 'my-broken', formation: 'nope' };
    const shadow: OffensivePlay = { ...validPass(), id: 'shotgun-slants', name: 'Shadowed' };
    const customDef: DefensivePlay = { ...validDef(), id: 'my-cover3', audibles: undefined };
    const custom = {
      playbooks: [{ id: 'mine', name: 'Mine', offensePlayIds: ['shotgun-slants', 'my-slants', 'my-broken', 'missing'], defensePlayIds: ['my-cover3', '43-cover1-man'] }],
      offense: [goodCustom, badCustom, shadow],
      defense: [customDef],
    };
    const r = resolvePlaybook('mine', custom);
    expect(r.offense.map((p) => p.id)).toEqual(['shotgun-slants', 'my-slants']);
    expect(r.offense[0].name).toBe(reg.offensePlays['shotgun-slants'].name);
    expect(r.defense.map((p) => p.id)).toEqual(['my-cover3', '43-cover1-man']);
    expect([...new Set(r.issues.map((i) => i.playId))]).toEqual(['my-broken', 'missing']);
    expect(r.issues.some((i) => i.message.includes('unknown formation nope'))).toBe(true);
    expect(resolvePlaybook('balanced', custom).playbook.name).toBe('Balanced');
  });
});

describe('flipped man coverage follows the mirror-image receiver', () => {
  it('re-points CB1/CB2 and paired TEs when the play flips and the offensive formation is known', () => {
    const play = reg.defensePlays['nickel-cover0-cbBlitz'];
    expect(play.alignTo).toBe('passStrength');
    const shotgun = reg.offensiveFormations.shotgun;
    const flipped = materializeDefensivePlay(play, reg.defensiveFormations.nickel, { run: 'right', pass: 'left' }, shotgun);
    expect(flipped.play.assignments.CB1.manTarget).toBe('WR2');
    expect(flipped.play.assignments.CB2.manTarget).toBe('WR1');
    expect(flipped.play.assignments.CB3.gap).toBe('D-left');
    // WR3 has no mirror twin in a 2x2 shotgun (WR1/WR2 are already paired) so the SS keeps it
    expect(flipped.play.assignments.SS.manTarget).toBe('WR3');
    expect(flipped.play.assignments.OLB1.manTarget).toBe('RB');
    // each corner now lines up on the same side as its receiver
    const cb1 = flipped.formation.slots.find((s) => s.role === 'CB1');
    const wr2 = shotgun.slots.find((s) => s.role === 'WR2');
    expect(Math.sign(cb1?.x ?? 0)).toBe(Math.sign(wr2?.x ?? 0));
    const twoTE = materializeDefensivePlay({ ...reg.defensePlays['43-cover1-man'], flip: true }, reg.defensiveFormations['43'], undefined, reg.offensiveFormations.twoTE);
    expect(twoTE.play.assignments.OLB2.manTarget).toBe('TE2');
    expect(twoTE.play.assignments.CB1.manTarget).toBe('WR2');
  });

  it('leaves man targets alone when not flipped or when no offensive formation is given', () => {
    const play = reg.defensePlays['nickel-cover0-cbBlitz'];
    const straight = materializeDefensivePlay(play, reg.defensiveFormations.nickel, { run: 'right', pass: 'right' }, reg.offensiveFormations.shotgun);
    expect(straight.play.assignments.CB1.manTarget).toBe('WR1');
    const blind = materializeDefensivePlay(play, reg.defensiveFormations.nickel, { run: 'left', pass: 'left' });
    expect(blind.play.assignments.CB1.manTarget).toBe('WR1');
    expect(blind.play.assignments.CB3.gap).toBe('D-left');
  });
});

describe('materialize is pure', () => {
  it('does not mutate the registry play, formation or routes', () => {
    const play = reg.offensePlays['iform-toss-left'];
    const formation = reg.offensiveFormations.iForm;
    const before = structuredClone({ play, formation, go: reg.routes.stalkBlock });
    materializePlay(play, formation, reg.routes);
    expect({ play, formation, go: reg.routes.stalkBlock }).toEqual(before);
    const def = reg.defensePlays['43-cover3-zone'];
    const defFormation = reg.defensiveFormations['43'];
    const beforeDef = structuredClone({ def, defFormation });
    materializeDefensivePlay(def, defFormation, { run: 'left', pass: 'left' }, formation);
    expect({ def, defFormation }).toEqual(beforeDef);
    expect(play.flip).toBe(true);
    expect(def.alignTo).toBe('strength');
  });
});

describe('additional validation rules', () => {
  it('flags non-numeric dropback, missing names, bad techniques and self-referencing defensive audibles', () => {
    const play = validPass();
    play.dropback = Number.NaN;
    play.name = '';
    const msgs = messages(validateOffensivePlay(play, reg));
    expect(msgs).toContain('invalid dropback NaN');
    expect(msgs).toContain('missing name');
    const neg = validPass();
    neg.dropback = -3;
    expect(messages(validateOffensivePlay(neg, reg))).toContain('invalid dropback -3');
    const def = validDef();
    def.name = '';
    def.assignments.CB1 = { type: 'manCover', manTarget: 'WR1', technique: 'bump' as never };
    def.audibles = { blitz: def.id };
    const defMsgs = messages(validateDefensivePlay(def, reg));
    expect(defMsgs).toContain('missing name');
    expect(defMsgs).toContain('CB1 has invalid technique bump');
    expect(defMsgs).toContain('audible blitz references itself');
  });

  it('reports an unknown formation once instead of one issue per assignment', () => {
    const play = validPass();
    play.formation = 'wishbone';
    const issues = validateOffensivePlay(play, reg);
    expect(issues.filter((i) => i.message.includes('unknown role'))).toHaveLength(0);
    expect(issues.filter((i) => i.message.includes('unknown formation'))).toHaveLength(1);
  });

  it('rejects routes with more than one break', () => {
    const raw = bundledPlaybookData();
    const routes = structuredClone(raw.routes) as { id: string; waypoints: { isBreak?: boolean }[] }[];
    const post = routes.find((r) => r.id === 'post');
    if (!post) throw new Error('fixture');
    for (const w of post.waypoints) w.isBreak = true;
    expect(messages(buildRegistry({ ...raw, routes }).issues)).toContain('route:post: more than one isBreak waypoint');
  });
});

describe('resolvePlaybook custom audibles', () => {
  it('lets a custom play audible to another custom play while bundled ids still win', () => {
    const a: OffensivePlay = { ...validPass(), id: 'my-a', audibles: { manBeater: 'my-b' } };
    const b: OffensivePlay = { ...validPass(), id: 'my-b', audibles: { zoneBeater: 'my-a', blitzBeater: 'shotgun-slants' } };
    const custom = { playbooks: [{ id: 'mine', name: 'Mine', offensePlayIds: ['my-a', 'my-b'], defensePlayIds: ['43-cover1-man'] }], offense: [a, b], defense: [] };
    const r = resolvePlaybook('mine', custom);
    expect(r.issues).toEqual([]);
    expect(r.offense.map((p) => p.id)).toEqual(['my-a', 'my-b']);
  });
});
