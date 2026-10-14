import { describe, expect, it } from 'vitest';
import { customContent } from '@/franchise/game-setup';
import type { League } from '@/franchise/types';
import { loadPlaybookData, resolvePlaybook } from '@/playbook/loader';
import { ChoiceDialog } from '@/ui/franchise/kit/dialogs';
import {
  bundledPlaybooks, choosePlaybook, currentPlaybook, customPlaybookId, defenseCategory, findPlay, isScrimmageDefense, isScrimmageOffense, offenseCategory, playRows,
  playbookIssues, togglePlay, usesCustom,
} from '@/ui/franchise/team/playbook-model';
import { PlayDiagramScreen, PlaybookTab, drawPlayPanel, playColumns } from '@/ui/franchise/team/playbook-tab';
import { TableScreen } from '@/ui/franchise/team/tab-screen';
import { createFakeCtx } from '../../render/fake-ctx';
import { baseLeague, mount, press, rcFor, topAs, userId } from './helpers';

describe('playbook model', () => {
  it('lists every play with the team membership', () => {
    const league = baseLeague();
    const team = userId(league);
    const reg = loadPlaybookData();
    const pb = currentPlaybook(league, team);
    const off = playRows(league, team, 'offense');
    expect(off).toHaveLength(Object.keys(reg.offensePlays).length);
    expect(off.filter((r) => r.inBook).map((r) => r.id).sort()).toEqual([...pb.offensePlayIds].sort());
    const def = playRows(league, team, 'defense');
    expect(def.filter((r) => r.inBook)).toHaveLength(pb.defensePlayIds.length);
    expect(new Set(off.map((r) => r.category))).toEqual(new Set(['Run', 'Pass', 'Special']));
    expect(def.some((r) => r.category === 'Blitz')).toBe(true);
    expect(offenseCategory(reg.offensePlays['kickoff-deep'] as never)).toBe('Special');
    expect(defenseCategory(reg.defensePlays['kickReturn-middle'] as never)).toBe('Special');
    expect(findPlay(league, 'offense', 'nope')).toBeNull();
    expect(playbookIssues(league, team)).toEqual([]);
    expect(usesCustom(league, team)).toBe(false);
  });
  it('toggles plays into a custom playbook the loader resolves, and reports coverage gaps', () => {
    const league = baseLeague();
    const team = userId(league);
    const base = currentPlaybook(league, team);
    const extra = playRows(league, team, 'offense').find((r) => !r.inBook);
    if (!extra) throw new Error('a play outside the playbook');
    const added = togglePlay(league, team, 'offense', extra.id);
    expect(added.ok).toBe(true);
    const id = customPlaybookId(team);
    expect(added.league.teams[team]?.playbookId).toBe(id);
    expect(added.league.customPlaybooks.map((p) => p.id)).toEqual([id]);
    const resolved = resolvePlaybook(id, customContent(added.league));
    expect(resolved.offense.map((p) => p.id)).toContain(extra.id);
    expect(resolved.offense).toHaveLength(base.offensePlayIds.length + 1);
    expect(resolved.issues).toEqual([]);
    const removed = togglePlay(added.league, team, 'offense', extra.id);
    expect(removed.league.customPlaybooks).toHaveLength(1);
    expect(currentPlaybook(removed.league, team).offensePlayIds).toEqual(base.offensePlayIds);
    let noRuns: League = removed.league;
    for (const row of playRows(noRuns, team, 'offense').filter((r) => r.inBook && r.category === 'Run')) noRuns = togglePlay(noRuns, team, 'offense', row.id).league;
    const punts = playRows(noRuns, team, 'offense').filter((r) => r.inBook && findPlay(noRuns, 'offense', r.id)?.id.startsWith('punt'));
    expect(punts.length).toBeGreaterThan(0);
    for (const punt of punts) noRuns = togglePlay(noRuns, team, 'offense', punt.id).league;
    const issues = playbookIssues(noRuns, team);
    expect(issues).toContain('No run plays: the offense can only pass');
    expect(issues).toContain('No punt play: a generic one is used');
    let one: League = league;
    const defIds = currentPlaybook(league, team).defensePlayIds;
    for (const d of defIds.slice(1)) one = togglePlay(one, team, 'defense', d).league;
    const last = togglePlay(one, team, 'defense', defIds[0] as string);
    expect(last.ok).toBe(false);
    expect(last.reason).toContain('at least one');
    expect(playbookIssues(one, team)).toEqual(expect.arrayContaining(['No kick return: a generic one is used']));
    expect(togglePlay(league, team, 'offense', 'nope').ok).toBe(false);
  });
  it('keeps at least one scrimmage play per side (kick units alone cannot run a down)', () => {
    const league = baseLeague();
    const team = userId(league);
    const reg = loadPlaybookData();
    let work: League = league;
    const scrimmage = (side: 'offense' | 'defense'): string[] => currentPlaybook(work, team)[side === 'offense' ? 'offensePlayIds' : 'defensePlayIds']
      .filter((id) => (side === 'offense' ? isScrimmageOffense(reg.offensePlays[id] as never) : isScrimmageDefense(reg.defensePlays[id] as never)));
    for (const side of ['offense', 'defense'] as const) {
      const ids = scrimmage(side);
      expect(ids.length).toBeGreaterThan(1);
      for (const id of ids.slice(1)) {
        const r = togglePlay(work, team, side, id);
        expect(r.ok).toBe(true);
        work = r.league;
      }
      const last = togglePlay(work, team, side, ids[0] as string);
      expect(last.ok).toBe(false);
      expect(last.reason).toContain('last');
      expect(last.league).toBe(work);
      expect(scrimmage(side)).toEqual([ids[0]]);
      const pb = currentPlaybook(work, team);
      expect((side === 'offense' ? pb.offensePlayIds : pb.defensePlayIds).length).toBeGreaterThan(1);
    }
    const kick = currentPlaybook(work, team).offensePlayIds.find((id) => !isScrimmageOffense(reg.offensePlays[id] as never));
    expect(kick).toBeDefined();
    expect(togglePlay(work, team, 'offense', kick as string).ok).toBe(true);
  });
  it('switches between bundled playbooks and the custom one', () => {
    const league = baseLeague();
    const team = userId(league);
    const other = bundledPlaybooks().find((p) => p.id !== currentPlaybook(league, team).id);
    if (!other) throw new Error('second playbook');
    const switched = choosePlaybook(league, team, other.id);
    expect(switched.league.teams[team]?.playbookId).toBe(other.id);
    expect(choosePlaybook(switched.league, team, other.id).ok).toBe(false);
    expect(choosePlaybook(league, team, customPlaybookId(team)).ok).toBe(false);
    const custom = togglePlay(switched.league, team, 'defense', currentPlaybook(switched.league, team).defensePlayIds[0] as string).league;
    const back = choosePlaybook(custom, team, other.id);
    expect(back.ok).toBe(true);
    expect(choosePlaybook(back.league, team, customPlaybookId(team)).league.teams[team]?.playbookId).toBe(customPlaybookId(team));
  });
});

describe('PlaybookTab', () => {
  it('draws play art beside the catalogue and toggles plays through the dialog', () => {
    const league = baseLeague();
    const { fc, screen } = mount(league, (f) => new PlaybookTab(f));
    const rc = rcFor(fc);
    screen.render(rc);
    expect(screen.lastLayout?.side).not.toBeNull();
    expect(screen.catalogue.table.sortKey).toBe('in');
    expect(screen.catalogue.table.rows[0]?.inBook).toBe(true);
    const ctx = createFakeCtx();
    const row = screen.catalogue.table.selected;
    expect(drawPlayPanel(ctx, fc.services.theme, fc, row, { x: 0, y: 0, w: 180, h: 150 })).toBe(true);
    expect(ctx.fills.length).toBeGreaterThan(50);
    expect(drawPlayPanel(ctx, fc.services.theme, fc, null, { x: 0, y: 0, w: 180, h: 150 })).toBe(false);
    press(fc, 'confirm');
    const dialog = topAs(fc, ChoiceDialog);
    expect(dialog.list.items[0]?.label).toBe('Remove from playbook');
    dialog.choose('toggle');
    expect(fc.commits.at(-1)?.reason).toBe('edit');
    expect(usesCustom(fc.league(), fc.userTeamId)).toBe(true);
    expect(screen.summary().text).toContain('Custom');
    screen.catalogue.table.selectById(row?.id ?? '');
    press(fc, 'confirm');
    topAs(fc, ChoiceDialog).choose('view');
    const diagram = topAs(fc, PlayDiagramScreen);
    diagram.render(rc);
    press(fc, 'back');
    expect(fc.stack.top).toBe(screen);
    press(fc, 'audible');
    expect(screen.chips.current).toBe('defense');
    screen.render(rc);
    expect(screen.catalogue).toBe(screen.defense);
  });
  it('runs the tab menu: bundled playbooks, the custom one and validation', () => {
    const league = baseLeague();
    const { fc, screen } = mount(league, (f) => new PlaybookTab(f, { view: 'defense' }));
    expect(screen.menu().find((m) => m.id === 'custom')?.disabled).toBe(true);
    screen.onMenu('base');
    const pick = topAs(fc, ChoiceDialog);
    const other = pick.list.items.find((i) => !i.subLabel?.includes('in use'));
    if (!other) throw new Error('other playbook');
    pick.choose(other.id);
    expect(fc.league().teams[fc.userTeamId]?.playbookId).toBe(other.id);
    screen.playAction(screen.catalogue.table.rows[0] as never);
    topAs(fc, ChoiceDialog).choose('toggle');
    expect(usesCustom(fc.league(), fc.userTeamId)).toBe(true);
    screen.onMenu('base');
    topAs(fc, ChoiceDialog).choose(other.id);
    expect(fc.toasts.at(-1)).toContain('Now running');
    screen.onMenu('base');
    topAs(fc, ChoiceDialog).choose(other.id);
    expect(fc.toasts.at(-1)).toContain('already in use');
    expect(screen.menu().find((m) => m.id === 'custom')?.disabled).toBe(false);
    screen.onMenu('custom');
    expect(usesCustom(fc.league(), fc.userTeamId)).toBe(true);
    screen.onMenu('issues');
    const table = topAs(fc, TableScreen);
    table.render(rcFor(fc));
    press(fc, 'back');
    expect(playColumns(true)).toHaveLength(4);
    expect(playColumns(false)).toHaveLength(3);
    const big = mount(league, (f) => new PlaybookTab(f), { settings: { textSize: 'large' } });
    big.screen.render(rcFor(big.fc));
    expect(big.screen.offense.isWide).toBe(false);
  });
});
