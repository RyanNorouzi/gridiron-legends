/**
 * Tutorial progress and the first-launch offer. Progress (steps finished, completed / skipped / "don't ask
 * again") is persisted under its own key through the save system's StorageAdapter and mirrored into
 * Settings.tutorialCompleted (persisted with the settings as well). The main menu asks `shouldOffer()` once the
 * record has loaded: the tutorial is offered on the first launch until it is completed, skipped or declined for good.
 */
import type { Settings } from '@/core/settings';
import type { StorageAdapter } from '@/save/storage';

/** Storage key of the tutorial progress record. */
export const TUTORIAL_KEY = 'gl:tutorial';

/** Persisted tutorial progress. */
export interface TutorialProgress {
  version: 1;
  /** Finished every step (or skipped the rest from the pause menu). */
  completed: boolean;
  /** Ended by "skip tutorial" rather than playing it through. */
  skipped: boolean;
  /** "Don't ask again" on the first-launch offer. */
  dismissed: boolean;
  completedSteps: string[];
  lastStepId: string | null;
}

/** Progress of a player who never opened the tutorial. */
export const emptyProgress = (): TutorialProgress => ({ version: 1, completed: false, skipped: false, dismissed: false, completedSteps: [], lastStepId: null });

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Forgiving parse: wrong or missing fields fall back to the empty record's values. */
export const parseProgress = (raw: unknown): TutorialProgress => {
  const out = emptyProgress();
  if (!isRecord(raw)) return out;
  if (typeof raw.completed === 'boolean') out.completed = raw.completed;
  if (typeof raw.skipped === 'boolean') out.skipped = raw.skipped;
  if (typeof raw.dismissed === 'boolean') out.dismissed = raw.dismissed;
  if (Array.isArray(raw.completedSteps)) out.completedSteps = raw.completedSteps.filter((s): s is string => typeof s === 'string');
  if (typeof raw.lastStepId === 'string') out.lastStepId = raw.lastStepId;
  return out;
};

/** Async persistence of the progress record. */
export interface TutorialStore {
  load(): Promise<TutorialProgress>;
  save(progress: TutorialProgress): Promise<void>;
}

/** Store over a StorageAdapter; corrupt JSON loads as empty progress. */
export const createTutorialStore = (storage: StorageAdapter): TutorialStore => ({
  load: async () => {
    const text = await storage.getItem(TUTORIAL_KEY);
    if (text === null) return emptyProgress();
    try {
      return parseProgress(JSON.parse(text) as unknown);
    } catch {
      return emptyProgress();
    }
  },
  save: (p) => storage.setItem(TUTORIAL_KEY, JSON.stringify(p)),
});

/** First-launch rule: offer until completed / skipped / dismissed (and only once progress is known). */
export const shouldOfferTutorial = (settings: Pick<Settings, 'tutorialCompleted'>, progress: TutorialProgress | null): boolean =>
  progress !== null && settings.tutorialCompleted !== true && !progress.completed && !progress.skipped && !progress.dismissed;

/** Index of the first step not yet finished (0 when everything was done: replay from the top). */
export const resumeIndex = (stepIds: readonly string[], progress: TutorialProgress | null): number => {
  if (!progress || progress.completed) return 0;
  const i = stepIds.findIndex((id) => !progress.completedSteps.includes(id));
  return i < 0 ? 0 : i;
};

/** What the tutorial screen reports progress to. */
export interface TutorialProgressSink {
  readonly progress: TutorialProgress | null;
  markStep(stepId: string): void;
  /** Tutorial over: played through (skipped=false) or skipped from the pause menu. */
  complete(skipped: boolean): void;
}

/**
 * Loads progress once, answers the main menu's first-launch question, and records step / completion progress
 * (storage + Settings.tutorialCompleted + persistSettings). Storage failures are reported and never thrown.
 */
export class TutorialProgressController implements TutorialProgressSink {
  private value: TutorialProgress | null = null;
  private declinedThisSession = false;
  readonly ready: Promise<TutorialProgress>;

  constructor(private readonly store: TutorialStore, private readonly settings: Settings, private readonly persistSettings?: (s: Settings) => unknown) {
    this.ready = store.load()
      .catch((err: unknown) => {
        console.warn('tutorial progress unavailable', err);
        return emptyProgress();
      })
      .then((p) => {
        // A settings record that already says "completed" wins over a missing progress record.
        if (settings.tutorialCompleted === true) p.completed = true;
        this.value = p;
        return p;
      });
  }

  get progress(): TutorialProgress | null {
    return this.value;
  }

  /** True when the main menu should offer the tutorial now. */
  shouldOffer(): boolean {
    return !this.declinedThisSession && shouldOfferTutorial(this.settings, this.value);
  }

  /** The player said no: `forever` stores "don't ask again", otherwise only this session is quiet. */
  decline(forever: boolean): void {
    this.declinedThisSession = true;
    if (!forever) return;
    const p = this.value ?? emptyProgress();
    p.dismissed = true;
    this.value = p;
    this.persist();
  }

  markStep(stepId: string): void {
    const p = this.value ?? emptyProgress();
    if (!p.completedSteps.includes(stepId)) p.completedSteps.push(stepId);
    p.lastStepId = stepId;
    this.value = p;
    this.persist();
  }

  complete(skipped: boolean): void {
    const p = this.value ?? emptyProgress();
    p.completed = true;
    p.skipped = skipped;
    this.value = p;
    this.settings.tutorialCompleted = true;
    this.declinedThisSession = true;
    this.persist();
    try {
      void Promise.resolve(this.persistSettings?.(this.settings)).catch((err: unknown) => console.warn('settings not saved', err));
    } catch (err) {
      console.warn('settings not saved', err);
    }
  }

  private persist(): void {
    const p = this.value;
    if (!p) return;
    this.store.save({ ...p, completedSteps: [...p.completedSteps] }).catch((err: unknown) => console.warn('tutorial progress not saved', err));
  }
}
