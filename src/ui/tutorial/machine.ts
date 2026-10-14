/**
 * Tutorial step machine: which step and page is showing, which steps are finished, skipping (one step or the
 * whole tutorial) and restarting. Interactive steps advance only when `report('done')` arrives (goals.ts decides
 * that from the play); 'failed' counts an attempt and asks for a retry; 'pending' changes nothing. Pure state,
 * no rendering; listeners hear every change.
 */
import type { GoalStatus } from './goals';
import type { TutorialStep } from './steps';

/** Running, played through, or skipped. */
export type TutorialStatus = 'running' | 'complete' | 'skipped';

/** Notifications the machine sends its listeners. */
export type MachineChange =
  | { type: 'step'; index: number; step: TutorialStep }
  | { type: 'page'; page: number }
  | { type: 'stepDone'; step: TutorialStep; skipped: boolean }
  | { type: 'retry'; step: TutorialStep; attempts: number }
  | { type: 'finished'; status: Exclude<TutorialStatus, 'running'> };

/** Where to start and what is already done. */
export interface TutorialMachineOptions {
  startIndex?: number;
  /** Step ids already finished (from saved progress). */
  completed?: readonly string[];
}

/** Tutorial step / page state machine (see the file header). */
export class TutorialMachine {
  private indexValue: number;
  private pageValue = 0;
  private statusValue: TutorialStatus = 'running';
  private readonly done = new Set<string>();
  private readonly skippedIds = new Set<string>();
  private failures = 0;
  private readonly listeners: ((c: MachineChange) => void)[] = [];

  constructor(readonly steps: readonly TutorialStep[], opts: TutorialMachineOptions = {}) {
    if (steps.length === 0) throw new Error('TutorialMachine: no steps');
    for (const id of opts.completed ?? []) this.done.add(id);
    this.indexValue = Math.max(0, Math.min(steps.length - 1, opts.startIndex ?? 0));
  }

  get index(): number { return this.indexValue; }
  get page(): number { return this.pageValue; }
  get status(): TutorialStatus { return this.statusValue; }
  get attempts(): number { return this.failures; }
  get total(): number { return this.steps.length; }
  get completedIds(): readonly string[] { return this.steps.filter((s) => this.done.has(s.id)).map((s) => s.id); }
  get skippedStepIds(): readonly string[] { return [...this.skippedIds]; }

  /** The current step (null once the tutorial is over). */
  get step(): TutorialStep | null {
    return this.statusValue === 'running' ? (this.steps[this.indexValue] ?? null) : null;
  }

  isDone(id: string): boolean {
    return this.done.has(id);
  }

  onChange(cb: (c: MachineChange) => void): () => void {
    this.listeners.push(cb);
    return () => {
      const i = this.listeners.indexOf(cb);
      if (i >= 0) this.listeners.splice(i, 1);
    };
  }

  private emit(c: MachineChange): void {
    for (const cb of [...this.listeners]) cb(c);
  }

  private finishStep(skipped: boolean): void {
    const step = this.step;
    if (!step) return;
    if (skipped) this.skippedIds.add(step.id);
    else this.done.add(step.id);
    this.emit({ type: 'stepDone', step, skipped });
    this.goTo(this.indexValue + 1);
  }

  private goTo(index: number): void {
    this.pageValue = 0;
    this.failures = 0;
    if (index >= this.steps.length) {
      this.statusValue = 'complete';
      this.emit({ type: 'finished', status: 'complete' });
      return;
    }
    this.indexValue = index;
    this.emit({ type: 'step', index, step: this.steps[index] as TutorialStep });
  }

  /** Info steps: next page, or finish the step after its last page. Returns false on interactive steps. */
  nextPage(): boolean {
    const step = this.step;
    if (!step || step.kind !== 'info') return false;
    if (this.pageValue < step.pages.length - 1) {
      this.pageValue += 1;
      this.emit({ type: 'page', page: this.pageValue });
    } else this.finishStep(false);
    return true;
  }

  /** Info steps: previous page (or the previous step's last page). */
  prevPage(): boolean {
    const step = this.step;
    if (!step || step.kind !== 'info') return false;
    if (this.pageValue > 0) {
      this.pageValue -= 1;
      this.emit({ type: 'page', page: this.pageValue });
      return true;
    }
    if (this.indexValue === 0) return false;
    this.indexValue -= 1;
    const prev = this.steps[this.indexValue] as TutorialStep;
    this.pageValue = prev.kind === 'info' ? prev.pages.length - 1 : 0;
    this.failures = 0;
    this.emit({ type: 'step', index: this.indexValue, step: prev });
    return true;
  }

  /** Interactive steps: the goal's status for the current attempt. */
  report(status: GoalStatus): 'advanced' | 'retry' | 'ignored' {
    const step = this.step;
    if (!step || step.kind !== 'interactive' || status === 'pending') return 'ignored';
    if (status === 'done') {
      this.finishStep(false);
      return 'advanced';
    }
    this.failures += 1;
    this.emit({ type: 'retry', step, attempts: this.failures });
    return 'retry';
  }

  /** Skips the current step (it is not marked finished). */
  skipStep(): void {
    this.finishStep(true);
  }

  /** Restarts the current step (attempt counter and page reset). */
  restartStep(): void {
    const step = this.step;
    if (!step) return;
    this.goTo(this.indexValue);
  }

  /** Ends the whole tutorial as skipped. */
  skipAll(): void {
    if (this.statusValue !== 'running') return;
    this.statusValue = 'skipped';
    this.emit({ type: 'finished', status: 'skipped' });
  }
}
