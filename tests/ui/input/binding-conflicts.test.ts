/**
 * The default control profile must never bind two actions that one screen reads in the same moment to the same
 * button (e.g. the play-call screen read LB as both "previous tab" and "call timeout", so tabbing left burned a
 * timeout).
 */
import { describe, expect, it } from 'vitest';
import { loadDefaultProfile } from '@/ui/input/schemes';
import type { Action } from '@/ui/input/types';

/** Actions each screen/context reads together; synonyms that do the same thing are grouped as one entry. */
const CONTEXTS: Record<string, (Action | Action[])[]> = {
  playCall: ['confirm', 'back', 'pause', 'callTimeout', ['menuTabLeft', 'menuLeft'], ['menuTabRight', 'menuRight'], 'menuUp', 'menuDown'],
  presnapOffense: [['snap', 'confirm'], 'audible', 'showPlayArt', 'callTimeout', 'pause'],
  postPlay: [['confirm', 'snap'], 'challenge', 'showPlayArt', 'skipPlay', 'pause'],
};

const buttonsOf = (scheme: Record<Action, string[]>, entry: Action | Action[]): Set<string> =>
  new Set((Array.isArray(entry) ? entry : [entry]).flatMap((a) => scheme[a] ?? []));

describe('default bindings', () => {
  const scheme = loadDefaultProfile().scheme as unknown as Record<Action, string[]>;
  for (const [context, entries] of Object.entries(CONTEXTS)) {
    it(`no two ${context} actions share a button`, () => {
      const clashes: string[] = [];
      for (let i = 0; i < entries.length; i++) {
        for (let j = i + 1; j < entries.length; j++) {
          const a = buttonsOf(scheme, entries[i] as Action | Action[]);
          const b = buttonsOf(scheme, entries[j] as Action | Action[]);
          for (const btn of a) if (b.has(btn)) clashes.push(`${JSON.stringify(entries[i])} and ${JSON.stringify(entries[j])} on ${btn}`);
        }
      }
      expect(clashes).toEqual([]);
    });
  }
});
