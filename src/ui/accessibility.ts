/**
 * Accessibility preferences the Settings record does not carry: captions for important sound cues and
 * hold-vs-toggle sprint. Stored as their own small record next to the settings (key ACCESS_KEY in the save
 * system's storage), loaded at boot and shared through ScreenServices.access; the Settings screen edits them.
 */
import type { StorageAdapter } from '@/save/storage';

export interface AccessPrefs {
  /** Show captions for important audio cues (whistles, crowd, hits, flags, horns). */
  captions: boolean;
  /** Sprint latches on a press instead of being held. */
  sprintToggle: boolean;
}

/** Storage key of the record. */
export const ACCESS_KEY = 'gl:access';

/** Defaults: everything off. */
export const defaultAccess = (): AccessPrefs => ({ captions: false, sprintToggle: false });

/** Lenient parse: unknown / wrong-typed fields fall back to the defaults. */
export const parseAccess = (raw: unknown): AccessPrefs => {
  const d = defaultAccess();
  if (!raw || typeof raw !== 'object') return d;
  const r = raw as Record<string, unknown>;
  return {
    captions: typeof r.captions === 'boolean' ? r.captions : d.captions,
    sprintToggle: typeof r.sprintToggle === 'boolean' ? r.sprintToggle : d.sprintToggle,
  };
};

export interface AccessStore {
  load(): Promise<AccessPrefs>;
  save(prefs: AccessPrefs): Promise<void>;
}

/** Store over the save system's storage adapter (corrupt records load as defaults). */
export const createAccessStore = (storage: StorageAdapter): AccessStore => ({
  load: async () => {
    const text = await storage.getItem(ACCESS_KEY);
    if (text === null) return defaultAccess();
    try {
      return parseAccess(JSON.parse(text) as unknown);
    } catch {
      return defaultAccess();
    }
  },
  save: (prefs) => storage.setItem(ACCESS_KEY, JSON.stringify(parseAccess(prefs))),
});
