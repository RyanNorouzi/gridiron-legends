import { describe, expect, it, vi } from 'vitest';
import { loadPlaybookData } from '@/playbook/loader';
import { applyOverrides, assignmentLabel, assignmentOptionsFor, gapForSlot, normalizeOverrides } from '@/ui/game/assignment-options';
import { playsForComplexity } from '@/ui/game/session-flow';
import { AssignmentsScreen } from '@/ui/screens/assignments';
import { PlayCallScreen } from '@/ui/screens/playcall';
import { makeInput } from '../render/fake-ctx';
import { autoplay, makeSession, makeUi } from './fixtures';

const human = { controllers: { home: 'human', away: 'ai' } as const, userSide: 'home' as const };

describe('assignment options', () => {
  it('offers man, zone, pressure, spy and contain choices with the gap taken from the alignment', () => {
    expect(gapForSlot({ x: -0.5 })).toBe('A-left');
    expect(gapForSlot({ x: 2.5 })).toBe('B-right');
    expect(gapForSlot({ x: -8 })).toBe('D-left');
    const opts = assignmentOptionsFor({ x: 2.5 });
    expect(opts[0]?.assignment).toBeNull();
    const labels = opts.map((o) => o.label);
    expect(labels).toEqual(expect.arrayContaining(['MAN WR1', 'DEEP THIRD L', 'BLITZ B-R', 'SPY QB', 'CONTAIN']));
    expect(assignmentLabel({ type: 'zone', zone: 'deepThirdMiddle' })).toBe('DEEP MIDDLE');
  });

  it('merges overrides over the play and drops choices equal to the call', () => {
    const reg = loadPlaybookData();
    const play = Object.values(reg.defensePlays).find((p) => p.assignments.CB1?.type === 'manCover')!;
    const same = normalizeOverrides(play, { CB1: play.assignments.CB1!, FS: { type: 'spy' } });
    expect(Object.keys(same)).toEqual(['FS']);
    expect(applyOverrides(play, same).assignments.FS).toEqual({ type: 'spy' });
    expect(applyOverrides(play, {})).toBe(play);
  });
});

describe('assignment editor and the defensive play call', () => {
  const toDefenseCall = () => {
    const f = makeSession({ setup: { ...human, seed: 3 } });
    autoplay(f.session, { until: (s) => s.stage.kind === 'playcall' && s.stage.request.unit === 'defense', coinToss: 'kick' });
    const stage = f.session.stage;
    if (stage.kind !== 'playcall') throw new Error('expected playcall');
    return { f, request: stage.request };
  };

  it('overrides reach the play the engine runs', () => {
    const { f, request } = toDefenseCall();
    const ui = makeUi();
    const onCall = vi.fn((call) => f.session.callPlay(call));
    const screen = new PlayCallScreen(request, f.session.registry, { onCall });
    ui.stack.push(screen);
    const idx = screen.list.items.findIndex((i) => i.id === 'cover3');
    screen.list.select(idx);
    ui.stack.update(1 / 60, makeInput({ pressed: ['showPlayArt'] }));
    const editor = ui.stack.top;
    if (!(editor instanceof AssignmentsScreen)) throw new Error('expected the assignment editor');
    const role = editor.list.items[0]!.id;
    editor.cycle(role, 1);
    expect(editor.current[role]?.type).toBe('manCover');
    editor.render(ui.rc);
    editor.done();
    expect(ui.stack.top).toBe(screen);
    expect(screen.overridesFor('cover3')[role]).toEqual(editor.current[role]);
    expect(screen.list.items.find((i) => i.id === 'cover3')?.subLabel).toContain('CHANGED');
    screen.activate('cover3');
    expect(onCall.mock.calls[0]?.[0].assignmentOverrides?.[role]?.type).toBe('manCover');
    const live = f.session.stage;
    if (live.kind !== 'live') throw new Error('expected live');
    expect(live.meta.ctx.defensivePlay.assignments[role]?.type).toBe('manCover');
    expect(live.meta.ctx.defensivePlay.assignments[role]?.manTarget).toBe('WR1');
  });

  it('confirm on the CONTROL row steps to the next role', () => {
    const { f, request } = toDefenseCall();
    const screen = new PlayCallScreen(request, f.session.registry, { onCall: vi.fn() });
    const first = screen.controlRole;
    screen.activate('__control');
    expect(screen.controlRole).not.toBe(first);
    expect(request.controlRoles).toContain(screen.controlRole);
  });

  it('the simple playbook keeps only the core plays and hides the editor', () => {
    const plays = [{ id: 'a', tags: ['base'] }, { id: 'b', tags: ['trick'] }, { id: 'c', tags: ['goalLine'] }];
    expect(playsForComplexity(plays, 'simple').map((p) => p.id)).toEqual(['a']);
    expect(playsForComplexity(plays, 'simple', 'c').map((p) => p.id)).toEqual(['a', 'c']);
    expect(playsForComplexity(plays, 'advanced')).toHaveLength(3);
    const f = makeSession({ setup: { ...human, seed: 3 }, settings: { playbookComplexity: 'simple' } });
    autoplay(f.session, { until: (s) => s.stage.kind === 'playcall' && s.stage.request.unit === 'defense', coinToss: 'kick' });
    const stage = f.session.stage;
    if (stage.kind !== 'playcall') throw new Error('expected playcall');
    expect(stage.request.complexity).toBe('simple');
    const screen = new PlayCallScreen(stage.request, f.session.registry, { onCall: vi.fn() });
    expect(screen.canEditAssignments).toBe(false);
  });
});
