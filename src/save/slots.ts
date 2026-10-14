import type { League, SeasonPhase } from '@/franchise/types';
import type { GameState } from '@/game/types';
import { CURRENT_SAVE_VERSION } from './migrations';
import {
  estimateSize, gameStateFromRaw, leagueFromRaw, leagueToDiskForm, parseSaveText, serializeGameState, serializeLeague, stableStringify,
} from './serialize';
import { SaveError, type StorageAdapter } from './storage';

/**
 * Named save slots on top of a StorageAdapter. Each slot uses three keys:
 *   gl:slot:<id>          small metadata record (listing never loads a full league)
 *   gl:slot:<id>:league   serialized League
 *   gl:slot:<id>:game     serialized mid-game GameState (absent when no game is in progress)
 * Payloads are written before the metadata so a listing never shows a slot whose data is missing; a backend with
 * `setItems` (IndexedDB) writes all three in one atomic transaction instead. The slot metadata this store read or
 * wrote is cached, so a save starts its writes without a storage read first: an autosave flushed from `pagehide`
 * must queue its IndexedDB transaction before the page unloads. Autosaves use the fast (unsorted) JSON writer.
 * Timestamps come from the injected `now()`; nothing here reads the wall clock.
 */
export const SLOT_KEY_PREFIX = 'gl:slot:';
export const EXPORT_FORMAT = 'gridiron-legends-save';
export const EXPORT_FORMAT_VERSION = 1;
const SLOT_ID = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_NAME = 64;

/** Which game mode a slot belongs to (absent on older saves = 'franchise'). */
export type SlotMode = 'franchise' | 'season' | 'playoffs';

export interface SaveSlotMeta {
  id: string;
  /** Game mode of the save (absent = 'franchise'); decides which screen CONTINUE / LOAD reopens. */
  mode?: SlotMode;
  name: string;
  teamName: string;
  year: number;
  phase: SeasonPhase;
  week: number;
  createdAt: number;
  updatedAt: number;
  /** League save-format version. */
  version: number;
  /** Stored footprint of league + game payloads (UTF-16 bytes, see estimateSize). */
  sizeBytes: number;
  hasGameInProgress: boolean;
  /**
   * Set (to the problem) on list() entries whose metadata record is corrupt: the other fields are placeholders
   * (name = slot id, year 0, updatedAt 0, so they sort last). Such a slot can be deleted (or a load attempted, which
   * fails with the same problem); it is never overwritten by import / new-slot allocation.
   */
  damaged?: string;
}

/** Placeholder listing for a slot whose metadata cannot be read (see SaveSlotMeta.damaged). */
export const damagedSlotMeta = (slot: string, problem: string): SaveSlotMeta => ({
  id: slot, name: slot, teamName: 'Damaged save', year: 0, phase: 'preseason', week: 0, createdAt: 0, updatedAt: 0, version: 0, sizeBytes: 0,
  hasGameInProgress: false, damaged: problem,
});

export interface LoadedSlot {
  meta: SaveSlotMeta;
  league: League;
  /** Null when no game is stored or when the stored game could not be restored (see `gameError`). */
  game: GameState | null;
  /** Set when a game payload existed but failed to parse/migrate/validate; the league still loads. */
  gameError?: SaveError;
}

export interface SlotSaveOptions {
  /** Display name; defaults to the existing name or "<team> <year>". */
  name?: string;
  /** Overrides the store-level compression default for this write. */
  compress?: boolean;
  /** Game mode stamped on the slot; defaults to the existing slot's mode (else 'franchise'). */
  mode?: SlotMode;
}

export interface SlotImportOptions {
  /** Target slot; defaults to the first free `slot-N`. */
  slot?: string;
  name?: string;
}

export interface SlotStore {
  /** Every slot, newest first; slots with corrupt metadata are listed last as damaged entries (SaveSlotMeta.damaged). */
  list(): Promise<SaveSlotMeta[]>;
  exists(slot: string): Promise<boolean>;
  save(slot: string, league: League, game?: GameState | null, opts?: SlotSaveOptions): Promise<SaveSlotMeta>;
  load(slot: string): Promise<LoadedSlot>;
  delete(slot: string): Promise<void>;
  rename(slot: string, name: string): Promise<SaveSlotMeta>;
  /** Human-readable JSON envelope (uncompressed, sorted keys) for backup / sharing. The league is embedded in the
   *  compact file format (v2: zero stat fields omitted), the same form the slots store. */
  export(slot: string): Promise<string>;
  /** Accepts an export envelope or a bare league JSON (compact v2 or full v1 leagues alike, migrated on the way in);
   *  returns the new slot's metadata. */
  import(text: string, opts?: SlotImportOptions): Promise<SaveSlotMeta>;
}

export interface SlotStoreDeps {
  /** Milliseconds since epoch; injected so tests are deterministic. */
  now: () => number;
  /** Compress payloads by default (recommended for localStorage). */
  compress?: boolean;
}

export const metaKey = (slot: string): string => `${SLOT_KEY_PREFIX}${slot}`;
export const leagueKey = (slot: string): string => `${SLOT_KEY_PREFIX}${slot}:league`;
export const gameKey = (slot: string): string => `${SLOT_KEY_PREFIX}${slot}:game`;

/** Slot ids are short, path-safe tokens so keys stay unambiguous. */
export const assertSlotId = (slot: string): string => {
  if (typeof slot !== 'string' || !SLOT_ID.test(slot)) throw new SaveError('slot', '$.slot', `invalid slot id "${String(slot)}" (use 1-64 letters, digits, _ or -)`);
  return slot;
};

const cleanName = (name: string): string => {
  const n = name.trim().slice(0, MAX_NAME);
  if (!n) throw new SaveError('slot', '$.name', 'slot name must not be blank');
  return n;
};

/** "City Name" of the user's team, or "No team" when the league has no user team. */
export const userTeamName = (league: League): string => {
  const t = league.userTeamId === null ? undefined : league.teams[league.userTeamId];
  return t ? `${t.city} ${t.name}` : 'No team';
};

const isSlotMode = (v: unknown): v is SlotMode => v === 'franchise' || v === 'season' || v === 'playoffs';

const isMetaRecord = (v: unknown): v is SaveSlotMeta => {
  if (typeof v !== 'object' || v === null) return false;
  const m = v as Record<string, unknown>;
  return typeof m.id === 'string' && typeof m.name === 'string' && typeof m.teamName === 'string' && typeof m.year === 'number'
    && typeof m.phase === 'string' && typeof m.week === 'number' && typeof m.createdAt === 'number' && typeof m.updatedAt === 'number'
    && typeof m.version === 'number' && typeof m.sizeBytes === 'number' && typeof m.hasGameInProgress === 'boolean';
};

/** Builds the metadata record for a league/game pair (pure). */
export const buildSlotMeta = (
  slot: string, league: League, game: GameState | null,
  stamps: { name: string; createdAt: number; updatedAt: number; sizeBytes: number; mode?: SlotMode },
): SaveSlotMeta => ({
  id: slot,
  ...(stamps.mode && stamps.mode !== 'franchise' ? { mode: stamps.mode } : {}),
  name: stamps.name,
  teamName: userTeamName(league),
  year: league.year,
  phase: league.season.phase,
  week: league.season.week,
  createdAt: stamps.createdAt,
  updatedAt: stamps.updatedAt,
  version: league.version,
  sizeBytes: stamps.sizeBytes,
  hasGameInProgress: game !== null && game.phase !== 'final',
});

export const createSlotStore = (storage: StorageAdapter, deps: SlotStoreDeps): SlotStore => {
  /** Metadata this store last read or wrote per slot (see the module header). */
  const metaCache = new Map<string, SaveSlotMeta>();

  const readMeta = async (slot: string): Promise<SaveSlotMeta | null> => {
    const text = await storage.getItem(metaKey(slot));
    metaCache.delete(slot);
    if (text === null) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch (err) {
      throw new SaveError('parse', metaKey(slot), 'slot metadata is not valid JSON', err);
    }
    if (!isMetaRecord(parsed)) throw new SaveError('validation', metaKey(slot), 'slot metadata has the wrong shape');
    metaCache.set(slot, parsed);
    return parsed;
  };

  const requireMeta = async (slot: string): Promise<SaveSlotMeta> => {
    const meta = await readMeta(assertSlotId(slot));
    if (!meta) throw new SaveError('notFound', metaKey(slot), `no save in slot "${slot}"`);
    return meta;
  };

  const list = async (): Promise<SaveSlotMeta[]> => {
    const keys = await storage.keys(SLOT_KEY_PREFIX);
    const out: SaveSlotMeta[] = [];
    for (const key of keys) {
      const id = key.slice(SLOT_KEY_PREFIX.length);
      if (!SLOT_ID.test(id)) continue; // payload keys carry a ':' suffix
      try {
        const meta = await readMeta(id);
        if (meta) out.push(meta);
      } catch (err) {
        if (!(err instanceof SaveError)) throw err; // storage failures propagate
        out.push(damagedSlotMeta(id, err.message)); // corrupt metadata: listed so the player can see and delete it
      }
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
  };

  const save: SlotStore['save'] = async (slot, league, game = null, opts = {}) => {
    assertSlotId(slot);
    const compress = opts.compress ?? deps.compress ?? false;
    const leagueText = serializeLeague(league, { compress, canonical: false });
    const gameText = game ? serializeGameState(game, { compress, canonical: false }) : null;
    const existing = metaCache.get(slot) ?? (await readMeta(slot));
    const now = deps.now();
    const name = cleanName(opts.name ?? existing?.name ?? `${userTeamName(league)} ${league.year}`);
    const meta = buildSlotMeta(slot, league, game, {
      name,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      sizeBytes: estimateSize(leagueText) + (gameText ? estimateSize(gameText) : 0),
      mode: opts.mode ?? existing?.mode ?? 'franchise',
    });
    if (storage.setItems) {
      await storage.setItems([[leagueKey(slot), leagueText], [gameKey(slot), gameText], [metaKey(slot), JSON.stringify(meta)]]);
    } else {
      await storage.setItem(leagueKey(slot), leagueText);
      if (gameText) await storage.setItem(gameKey(slot), gameText);
      else await storage.removeItem(gameKey(slot));
      await storage.setItem(metaKey(slot), JSON.stringify(meta));
    }
    metaCache.set(slot, meta);
    return meta;
  };

  const load = async (slot: string): Promise<LoadedSlot> => {
    const meta = await requireMeta(slot);
    const leagueText = await storage.getItem(leagueKey(slot));
    if (leagueText === null) throw new SaveError('notFound', leagueKey(slot), `slot "${slot}" has metadata but no league payload`);
    const league = leagueFromRaw(parseSaveText(leagueText));
    const gameText = await storage.getItem(gameKey(slot));
    if (gameText === null) return { meta, league, game: null };
    try {
      return { meta, league, game: gameStateFromRaw(parseSaveText(gameText)) };
    } catch (err) {
      // A stale or corrupt mid-game payload must not make the whole franchise unloadable.
      if (!(err instanceof SaveError)) throw err;
      return { meta, league, game: null, gameError: err };
    }
  };

  const remove = async (slot: string): Promise<void> => {
    assertSlotId(slot);
    metaCache.delete(slot);
    await storage.removeItem(metaKey(slot));
    await storage.removeItem(leagueKey(slot));
    await storage.removeItem(gameKey(slot));
  };

  const rename = async (slot: string, name: string): Promise<SaveSlotMeta> => {
    const meta = { ...(await requireMeta(slot)), name: cleanName(name) };
    await storage.setItem(metaKey(slot), JSON.stringify(meta));
    metaCache.set(slot, meta);
    return meta;
  };

  const exportSlot = async (slot: string): Promise<string> => {
    const { meta, league, game } = await load(slot);
    // The league was just validated by load(): embed its compact file form (a full-line export is several times larger).
    return stableStringify({ format: EXPORT_FORMAT, formatVersion: EXPORT_FORMAT_VERSION, exportedAt: deps.now(), meta, league: leagueToDiskForm(league, false), game });
  };

  const nextFreeSlot = async (): Promise<string> => {
    const taken = new Set((await list()).map((m) => m.id));
    for (let i = 1; ; i++) if (!taken.has(`slot-${i}`)) return `slot-${i}`;
  };

  const importSlot: SlotStore['import'] = async (text, opts = {}) => {
    const raw = parseSaveText(text);
    let leagueRaw: unknown = raw;
    let gameRaw: unknown = null;
    let name = opts.name;
    let mode: SlotMode | undefined;
    if (typeof raw === 'object' && raw !== null && (raw as Record<string, unknown>).format === EXPORT_FORMAT) {
      const env = raw as Record<string, unknown>;
      if (env.formatVersion !== EXPORT_FORMAT_VERSION) throw new SaveError('format', '$.formatVersion', `unsupported export format version ${String(env.formatVersion)}`);
      leagueRaw = env.league;
      gameRaw = env.game ?? null;
      if (isMetaRecord(env.meta)) {
        if (name === undefined) name = env.meta.name;
        // The game mode travels with the file: a Season or Playoffs export must not come back as a franchise.
        mode = isSlotMode(env.meta.mode) ? env.meta.mode : 'franchise';
      }
    }
    const league = leagueFromRaw(leagueRaw);
    const game = gameRaw === null ? null : gameStateFromRaw(gameRaw);
    const slot = opts.slot === undefined ? await nextFreeSlot() : assertSlotId(opts.slot);
    return save(slot, league, game, { ...(name === undefined ? {} : { name }), ...(mode === undefined ? {} : { mode }) });
  };

  return {
    list,
    exists: async (slot) => (await readMeta(assertSlotId(slot))) !== null,
    save,
    load,
    delete: remove,
    rename,
    export: exportSlot,
    import: importSlot,
  };
};

/** Version stamped on new exports; exposed for UI "about this file" displays. */
export const exportVersionInfo = (): { format: string; formatVersion: number; leagueVersion: number } => ({
  format: EXPORT_FORMAT,
  formatVersion: EXPORT_FORMAT_VERSION,
  leagueVersion: CURRENT_SAVE_VERSION,
});
