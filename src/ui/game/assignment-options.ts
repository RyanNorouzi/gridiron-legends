/**
 * Defensive assignment overrides (advanced play calling): the choices a defender can be switched to on top of the
 * called play (man on a receiver, a zone landmark, blitz / rush / fill through his gap, spy, contain), their short
 * labels, and helpers that apply a set of overrides to a play. The GameController merges the overrides into the
 * called play's assignments (GameCommand callPlay.assignmentOverrides); this module only builds them. Pure.
 */
import type { DefAssignment, DefensivePlay, FormationSlot, Gap, ZoneName } from '@/playbook/types';

/** One choice for a defender; `assignment` null = keep what the play calls. */
export interface AssignmentOption {
  id: string;
  label: string;
  assignment: DefAssignment | null;
}

/** Offensive roles a man defender can be told to follow (the engine re-targets missing roles at the snap). */
export const MAN_TARGETS: readonly string[] = ['WR1', 'WR2', 'WR3', 'TE1', 'RB'];

const ZONES: readonly (readonly [ZoneName, string])[] = [
  ['deepThirdLeft', 'DEEP THIRD L'], ['deepThirdMiddle', 'DEEP MIDDLE'], ['deepThirdRight', 'DEEP THIRD R'],
  ['deepHalfLeft', 'DEEP HALF L'], ['deepHalfRight', 'DEEP HALF R'],
  ['flatLeft', 'FLAT L'], ['flatRight', 'FLAT R'], ['curlFlatLeft', 'CURL-FLAT L'], ['curlFlatRight', 'CURL-FLAT R'],
  ['hookCurlLeft', 'HOOK-CURL L'], ['hookCurlRight', 'HOOK-CURL R'], ['middleHook', 'MIDDLE HOOK'],
];

const ZONE_LABEL: Readonly<Record<string, string>> = Object.fromEntries(ZONES);

const gapShort = (gap: Gap): string => gap.replace('-left', '-L').replace('-right', '-R');

/**
 * Gap a defender naturally attacks from his alignment (play-local x: + = offense's right): inside shades take the
 * A gap, then B, C and D moving outward.
 */
export const gapForSlot = (slot: Pick<FormationSlot, 'x'>): Gap => {
  const ax = Math.abs(slot.x);
  const letter = ax < 1.5 ? 'A' : ax < 3.5 ? 'B' : ax < 6 ? 'C' : 'D';
  return `${letter}-${slot.x < 0 ? 'left' : 'right'}` as Gap;
};

/** Short label for an assignment ("MAN WR1", "DEEP THIRD L", "BLITZ B-L", "SPY"). */
export const assignmentLabel = (a: DefAssignment | undefined | null): string => {
  if (!a) return '—';
  switch (a.type) {
    case 'manCover': return `MAN ${a.manTarget ?? 'NEAREST'}`;
    case 'zone': return a.zone ? (ZONE_LABEL[a.zone] ?? a.zone.replace(/([A-Z])/g, ' $1').toUpperCase()) : 'ZONE';
    case 'blitz': return a.gap ? `BLITZ ${gapShort(a.gap)}` : 'BLITZ';
    case 'rushGap': return a.gap ? `RUSH ${gapShort(a.gap)}` : 'RUSH';
    case 'runFill': return a.gap ? `FILL ${gapShort(a.gap)}` : 'RUN FILL';
    case 'contain': return 'CONTAIN';
    case 'spy': return 'SPY QB';
    case 'returner': return 'RETURNER';
    case 'returnBlock': return 'RETURN BLOCK';
  }
};

/** Every choice for a defender lined up at `slot`, "AS CALLED" first. */
export const assignmentOptionsFor = (slot: Pick<FormationSlot, 'x'>): AssignmentOption[] => {
  const gap = gapForSlot(slot);
  const out: AssignmentOption[] = [{ id: 'called', label: 'AS CALLED', assignment: null }];
  for (const target of MAN_TARGETS) out.push({ id: `man:${target}`, label: `MAN ${target}`, assignment: { type: 'manCover', manTarget: target, technique: 'off', hasHelp: false } });
  for (const [zone, label] of ZONES) out.push({ id: `zone:${zone}`, label, assignment: { type: 'zone', zone } });
  out.push({ id: 'blitz', label: `BLITZ ${gapShort(gap)}`, assignment: { type: 'blitz', gap } });
  out.push({ id: 'rush', label: `RUSH ${gapShort(gap)}`, assignment: { type: 'rushGap', gap } });
  out.push({ id: 'fill', label: `FILL ${gapShort(gap)}`, assignment: { type: 'runFill', gap } });
  out.push({ id: 'contain', label: 'CONTAIN', assignment: { type: 'contain' } });
  out.push({ id: 'spy', label: 'SPY QB', assignment: { type: 'spy' } });
  return out;
};

/** The play with `overrides` merged over its assignments (what the controller will run, and what the art shows). */
export const applyOverrides = (play: DefensivePlay, overrides: Readonly<Record<string, DefAssignment>> | undefined): DefensivePlay =>
  overrides && Object.keys(overrides).length > 0 ? { ...play, assignments: { ...play.assignments, ...overrides } } : play;

/** Overrides with no-op entries removed (a choice equal to what the play already calls is not an override). */
export const normalizeOverrides = (play: DefensivePlay, overrides: Readonly<Record<string, DefAssignment>>): Record<string, DefAssignment> => {
  const out: Record<string, DefAssignment> = {};
  for (const [role, a] of Object.entries(overrides)) {
    if (JSON.stringify(play.assignments[role]) !== JSON.stringify(a)) out[role] = a;
  }
  return out;
};
