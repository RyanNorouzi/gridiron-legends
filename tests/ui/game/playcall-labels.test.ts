import { describe, expect, it } from 'vitest';
import { playRowLabel } from '@/ui/screens/playcall';

describe('play-call row labels', () => {
  it('drop the formation words the tab already shows', () => {
    expect(playRowLabel('Singleback Y Cross', 'SINGLEBACK')).toBe('Y CROSS');
    expect(playRowLabel('I-Form Dive Right', 'I-FORM')).toBe('DIVE RIGHT');
    expect(playRowLabel('4-3 Cover 2 Man', '4-3')).toBe('COVER 2 MAN');
  });

  it('keep names that do not start with the tab (or are only the tab name)', () => {
    expect(playRowLabel('Shotgun Four Verts', 'SHOTGUN 2X2')).toBe('SHOTGUN FOUR VERTS');
    expect(playRowLabel('Singleback', 'SINGLEBACK')).toBe('SINGLEBACK');
    expect(playRowLabel('Victory Kneel', 'I-FORM')).toBe('VICTORY KNEEL');
    expect(playRowLabel('Singlebacker Blitz', 'SINGLEBACK')).toBe('SINGLEBACKER BLITZ');
  });
});
