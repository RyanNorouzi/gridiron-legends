import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '@/core/settings';
import { DataTable, type Column } from '@/ui/franchise/kit/data-table';
import { drawDataTable } from '@/ui/franchise/kit/data-table-view';
import { createInputManager } from '@/ui/input/manager';
import { createMouseSource } from '@/ui/input/mouse';
import { loadDefaultProfile } from '@/ui/input/schemes';
import type { InputState, PointerState } from '@/ui/input/types';
import { createTheme } from '@/ui/theme';
import { createFakeCtx, makeInput } from '../../render/fake-ctx';

interface Row { id: string; n: number }
const theme = createTheme(DEFAULT_SETTINGS);
const columns: Column<Row>[] = [{ key: 'n', label: 'N', flex: 1, format: (r) => String(r.n) }];
const table = (): DataTable<Row> => {
  const t = new DataTable(columns, Array.from({ length: 53 }, (_, i) => ({ id: `r${i}`, n: i })), { rowId: (r) => r.id });
  drawDataTable(createFakeCtx(), theme, t, { x: 10, y: 20, w: 300, h: 120 });
  return t;
};
const mouse = (p: Partial<PointerState> & { x: number; y: number }, pressed: InputState['justPressed'] extends ReadonlySet<infer A> ? A[] : never = []): InputState =>
  ({ ...makeInput({ pressed, device: 'mouse' }), pointer: { down: false, justDown: false, justUp: false, drag: null, ...p } });

describe('mouse scrolling of franchise tables (APP2-11)', () => {
  it('the wheel scrolls the table under the pointer', () => {
    const t = table();
    const hit = t.hitMap?.rows[1]?.rect;
    if (!hit) throw new Error('no layout');
    t.update(1 / 60, mouse({ x: hit.x + 5, y: hit.y + 2, wheel: 5 }));
    expect(t.scroll).toBe(5);
    t.update(1 / 60, mouse({ x: hit.x + 5, y: hit.y + 2, wheel: -2 }));
    expect(t.scroll).toBe(3);
    // Outside the table the wheel does nothing.
    t.update(1 / 60, mouse({ x: 400, y: 250, wheel: 4 }));
    expect(t.scroll).toBe(3);
  });

  it('a mouse press on a row (with its mapped confirm) does not open it; dragging scrolls, a click opens on release', () => {
    const t = table();
    const rows = t.hitMap?.rows ?? [];
    const r4 = rows[4]?.rect;
    if (!r4) throw new Error('no layout');
    const x = r4.x + 5;
    expect(t.update(1 / 60, mouse({ x, y: r4.y + 2, down: true, justDown: true }, ['confirm']))).toBeNull();
    t.update(1 / 60, mouse({ x, y: r4.y + 2 - 3 * (t.hitMap?.rowH ?? 8), down: true }));
    expect(t.scroll).toBe(3);
    expect(t.update(1 / 60, mouse({ x, y: r4.y + 2 - 3 * (t.hitMap?.rowH ?? 8), justUp: true }))).toBeNull();
    const click = t.hitMap?.rows[2]?.rect;
    if (!click) throw new Error('no layout');
    expect(t.update(1 / 60, mouse({ x, y: click.y + 2, down: true, justDown: true }, ['confirm']))).toBeNull();
    expect(t.update(1 / 60, mouse({ x, y: click.y + 2, justUp: true }))?.type).toBe('activate');
  });

  it('the mouse source turns wheel travel into scroll steps that reach the tick input', () => {
    const src = createMouseSource((x, y) => ({ x, y }));
    const manager = createInputManager([src], loadDefaultProfile());
    src.move(100, 100);
    src.wheel(100);
    manager.update();
    expect(manager.consumeTick().pointer?.wheel).toBe(2);
    manager.update();
    expect(manager.consumeTick().pointer?.wheel ?? 0).toBe(0);
  });
});
