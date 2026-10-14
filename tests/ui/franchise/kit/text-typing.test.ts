import { describe, expect, it, vi } from 'vitest';
import { createHeadlessServices } from '@/ui/franchise/context';
import { TextEntryDialog } from '@/ui/franchise/kit/dialogs';
import { createKeyboardSource, typedText } from '@/ui/input/keyboard';
import { createInputManager } from '@/ui/input/manager';
import { loadDefaultProfile } from '@/ui/input/schemes';
import { makeInput } from '../../render/fake-ctx';

describe('typing on a physical keyboard', () => {
  it('the keyboard source and manager deliver typed text, Backspace, Enter and Escape', () => {
    expect(typedText({ key: 'r' } as unknown as Event)).toBe('r');
    expect(typedText({ key: 'Backspace' } as unknown as Event)).toBe('\b');
    expect(typedText({ key: 'Escape' } as unknown as Event)).toBe('\x1b');
    expect(typedText({ key: 'ArrowLeft' } as unknown as Event)).toBeNull();
    const kb = createKeyboardSource();
    const manager = createInputManager([kb], loadDefaultProfile());
    kb.typeText('Rio');
    manager.update();
    expect(manager.consumeTick().text).toEqual(['R', 'i', 'o']);
    manager.update();
    expect(manager.consumeTick().text).toBeUndefined();
  });

  it('text entry takes letters (even L, J, I), deletes with Backspace and cancels only on Escape', () => {
    const services = createHeadlessServices();
    const onResult = vi.fn();
    const d = new TextEntryDialog('City', '', { maxLength: 12, initial: 'Riverpor' }, onResult);
    services.stack.push(d);
    // KeyL also maps to the back button: typed text wins, it is a letter here.
    services.stack.update(1 / 60, { ...makeInput({ pressed: ['back', 'showPlayArt'] }), text: ['t', 'l', 'j'] });
    expect(d.model.text).toBe('Riverportlj');
    services.stack.update(1 / 60, { ...makeInput({ pressed: ['back'] }), text: ['\b', '\b'] });
    expect(d.model.text).toBe('Riverport');
    expect(onResult).not.toHaveBeenCalled();
    services.stack.update(1 / 60, { ...makeInput({ pressed: ['back'] }), text: ['\x1b'] });
    expect(onResult).toHaveBeenCalledWith(null);
    const done = vi.fn();
    const d2 = new TextEntryDialog('Name', '', { maxLength: 12 }, done);
    services.stack.push(d2);
    services.stack.update(1 / 60, { ...makeInput(), text: ['H', 'a', 'r', 'b', 'o', 'r', '\n'] });
    expect(done).toHaveBeenCalledWith('Harbor');
  });
});
