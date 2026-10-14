import { describe, expect, it } from 'vitest';
import * as input from '@/ui/input/index';

describe('ui/input index', () => {
  it('imports headlessly and exposes the public surface', () => {
    expect(typeof window).toBe('undefined');
    expect(typeof input.createBrowserInput).toBe('function');
    expect(typeof input.createInputManager).toBe('function');
    expect(input.ACTIONS.length).toBeGreaterThan(0);
    expect(input.LOGICAL_WIDTH).toBe(480);
    const manager = input.createInputManager([input.createKeyboardSource(), input.createGamepadSource()], input.loadDefaultProfile());
    manager.update();
    expect(manager.consumeTick().down.size).toBe(0);
  });

  it('makeToLogical scales from the canvas box to logical pixels', () => {
    const canvas = { getBoundingClientRect: () => ({ left: 10, top: 20, width: 960, height: 540 }) } as unknown as HTMLCanvasElement;
    const toLogical = input.makeToLogical(canvas, { width: 480, height: 270 });
    expect(toLogical(10, 20)).toEqual({ x: 0, y: 0 });
    expect(toLogical(970, 560)).toEqual({ x: 480, y: 270 });
    const collapsed = { getBoundingClientRect: () => ({ left: 0, top: 0, width: 0, height: 0 }) } as unknown as HTMLCanvasElement;
    expect(input.makeToLogical(collapsed, { width: 480, height: 270 })(5, 6)).toEqual({ x: 5, y: 6 });
  });
});
