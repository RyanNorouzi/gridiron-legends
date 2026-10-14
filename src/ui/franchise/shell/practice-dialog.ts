/**
 * The weekly practice plan choice (hub menu > PRACTICE PLAN): rest & recover, normal week or full pads, with what
 * each does; the choice is committed to the League ('edit') and applies from the next completed week.
 */
import { PRACTICE_LABELS, PRACTICE_PLANS, practicePlanOf, setPracticePlan } from '@/franchise/practice-plan';
import type { PracticePlan } from '@/franchise/types';
import type { FranchiseContext } from '../context';
import { ChoiceDialog } from '../kit/dialogs';

/** Hub-menu label with the current plan ("Practice plan: Normal week"). */
export const practiceMenuLabel = (fc: FranchiseContext): string => `Practice plan: ${PRACTICE_LABELS[practicePlanOf(fc.league(), fc.userTeamId)].label}`;

/** Pushes the plan picker; returns the dialog. */
export const openPracticeDialog = (fc: FranchiseContext): ChoiceDialog => {
  const current = practicePlanOf(fc.league(), fc.userTeamId);
  const dialog = new ChoiceDialog('Weekly practice', 'How hard your team practises between games. Rest days help tired players recover.', PRACTICE_PLANS.map((p) => ({
    id: p, label: `${p === current ? '* ' : ''}${PRACTICE_LABELS[p].label}`, subLabel: PRACTICE_LABELS[p].detail,
  })), (id) => {
    if (!id || id === current) return;
    fc.commit(setPracticePlan(fc.league(), fc.userTeamId, id as PracticePlan), 'edit');
    fc.toast(`Practice: ${PRACTICE_LABELS[id as PracticePlan].label}`);
  });
  fc.push(dialog);
  return dialog;
};
