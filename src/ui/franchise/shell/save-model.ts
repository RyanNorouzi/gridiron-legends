/**
 * Save-slot helpers for the franchise screens: the slot list view-model (team, year, phase + week, updated time,
 * size), slot-id allocation, export file names and the browser file bridges (download an export as a Blob, pick
 * a file to import). The bridges no-op headlessly: export returns the JSON string for tests / tools, and import
 * resolves null when there is no DOM. Pure except for the guarded DOM access.
 */
import { phaseLabel as seasonPhaseLabel } from '@/franchise/phase';
import type { SaveSlotMeta } from '@/save/slots';

/** Longest save name the name dialogs accept. */
export const SAVE_NAME_MAX = 24;

/** A name cut to `max` characters at a word boundary when one is near (never mid-word unless a word is too long). */
export const fitSaveName = (name: string, max = SAVE_NAME_MAX): string => {
  const n = name.trim();
  if (n.length <= max) return n;
  const cut = n.slice(0, max + 1).lastIndexOf(' ');
  return (cut >= Math.ceil(max / 2) ? n.slice(0, cut) : n.slice(0, max)).trim();
};

/** Default name of a Season / Playoffs save: "Revelers 2026 season" (fits the name dialogs whole). */
export const modeSaveName = (team: { name: string } | undefined, year: number, mode: 'season' | 'playoffs'): string =>
  fitSaveName(`${team?.name ?? (mode === 'season' ? 'Season' : 'Playoffs')} ${year} ${mode}`);

/** Label of a save's game mode for the slot list. */
export const modeLabel = (mode: SaveSlotMeta['mode']): string => (mode === 'season' ? 'Season' : mode === 'playoffs' ? 'Playoffs' : 'Franchise');

/** One row of the slot list. */
export interface SlotRow {
  id: string;
  name: string;
  team: string;
  /** "2027 Week 5" / "2027 Free Agency", prefixed "SEASON · " / "PLAYOFFS · " for those modes and suffixed " · IN GAME". */
  when: string;
  /** "Franchise" / "Season" / "Playoffs" ("-" when damaged). */
  mode: string;
  /** "2027 Week 5" (no mode, no in-game marker). */
  season: string;
  updated: string;
  size: string;
  updatedAt: number;
  sizeBytes: number;
  inGame: boolean;
  /** Why the slot cannot be read (SaveSlotMeta.damaged), or null. */
  damaged: string | null;
}

/** Human size: "812 B", "34.5 KB", "4.7 MB". */
export const formatBytes = (bytes: number): string => {
  if (!Number.isFinite(bytes) || bytes < 0) return '?';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad2 = (n: number): string => String(n).padStart(2, '0');

/** "Sep 24 18:46" in local time ("-" for invalid stamps). */
export const formatUpdated = (ms: number): string => {
  const d = new Date(ms);
  if (!Number.isFinite(d.getTime())) return '-';
  return `${MONTHS[d.getMonth()]} ${d.getDate()} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
};

/** List rows for slot metadata (newest first, as the store lists them). Damaged slots show placeholders. */
export const slotRows = (metas: readonly SaveSlotMeta[]): SlotRow[] =>
  metas.map((m) => (m.damaged !== undefined
    ? { id: m.id, name: m.name, team: m.teamName, when: 'Unreadable', mode: '-', season: 'Unreadable', updated: '-', size: '?', updatedAt: 0, sizeBytes: 0, inGame: false, damaged: m.damaged }
    : {
      id: m.id, name: m.name, team: m.teamName, mode: modeLabel(m.mode), season: `${m.year} ${seasonPhaseLabel(m.phase, m.week)}`,
      when: `${m.mode === 'season' ? 'SEASON · ' : m.mode === 'playoffs' ? 'PLAYOFFS · ' : ''}${m.year} ${seasonPhaseLabel(m.phase, m.week)}${m.hasGameInProgress ? ' · IN GAME' : ''}`, updated: formatUpdated(m.updatedAt),
      size: formatBytes(m.sizeBytes), updatedAt: m.updatedAt, sizeBytes: m.sizeBytes, inGame: m.hasGameInProgress, damaged: null,
    }));

/** Saves that can be loaded (damaged listings dropped), newest first. */
export const loadableSlots = (metas: readonly SaveSlotMeta[]): SaveSlotMeta[] => metas.filter((m) => m.damaged === undefined);

/** First free "franchise-N" slot id. */
export const nextSlotId = (metas: readonly Pick<SaveSlotMeta, 'id'>[], prefix = 'franchise'): string => {
  const taken = new Set(metas.map((m) => m.id));
  for (let i = 1; ; i++) if (!taken.has(`${prefix}-${i}`)) return `${prefix}-${i}`;
};

/** File name for an exported save: "gridiron-<name>.json" with unsafe characters replaced. */
export const exportFileName = (name: string): string => `gridiron-${name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'save'}.json`;

interface DomLike {
  document?: {
    createElement(tag: string): {
      href: string; download: string; click(): void; type?: string; accept?: string; onchange: (() => void) | null; oncancel?: (() => void) | null;
      files?: { length: number; [i: number]: { text(): Promise<string> } } | null;
    };
  };
  URL?: { createObjectURL(b: unknown): string; revokeObjectURL(u: string): void };
  Blob?: new (parts: string[], opts: { type: string }) => unknown;
  setTimeout?: (cb: () => void, ms: number) => unknown;
}

const dom = (): DomLike => globalThis as unknown as DomLike;

/** True when a browser document is available (file export / import work). */
export const hasFileSupport = (): boolean => {
  const g = dom();
  return !!(g.document && g.URL && g.Blob);
};

/**
 * Offers `text` as a downloadable file in the browser (Blob + temporary link). Returns the text either way so
 * headless callers (tests, tools) get the export.
 */
export const downloadText = (fileName: string, text: string): string => {
  const g = dom();
  if (g.document && g.URL && g.Blob) {
    const url = g.URL.createObjectURL(new g.Blob([text], { type: 'application/json' }));
    const a = g.document.createElement('a');
    a.href = url;
    a.download = fileName;
    a.click();
    // Revoking synchronously can abort the download in some browsers; release the URL once it has started.
    const release = (): void => g.URL?.revokeObjectURL(url);
    if (g.setTimeout) g.setTimeout(release, 1000);
    else release();
  }
  return text;
};

/** Opens the browser file picker and resolves the chosen file's text (null when cancelled or headless). */
export const pickTextFile = (): Promise<string | null> => {
  const g = dom();
  if (!g.document) return Promise.resolve(null);
  return new Promise((resolve) => {
    const input = g.document?.createElement('input');
    if (!input) return resolve(null);
    input.type = 'file';
    input.accept = '.json,application/json,text/plain';
    input.onchange = () => {
      const file = input.files && input.files.length > 0 ? input.files[0] : undefined;
      if (!file) return resolve(null);
      file.text().then(resolve, () => resolve(null));
    };
    // Closing the picker without a file fires 'cancel' (no 'change'); resolve so the caller can tell the player.
    input.oncancel = () => resolve(null);
    input.click();
  });
};

/** Error text for a failed save operation (SaveError / StorageError messages, else a generic line). */
export const saveErrorText = (err: unknown, action: string): string => {
  const msg = err instanceof Error ? err.message : String(err);
  return `${action} failed: ${msg.length > 80 ? `${msg.slice(0, 77)}...` : msg}`;
};
