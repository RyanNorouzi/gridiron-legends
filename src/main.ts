/** Browser entry point: loads persisted settings (falling back to defaults), then boots the app. */
import { DEFAULT_SETTINGS, type Settings } from './core/settings';
import { createSaveSystem } from './save';
import { startApp } from './ui/app';

const canvas = document.getElementById('game') as HTMLCanvasElement | null;
if (!canvas) throw new Error('Missing #game canvas');

const loadPersistedSettings = async (): Promise<Settings> => {
  try {
    return await createSaveSystem().loadSettings();
  } catch (err: unknown) {
    console.warn('settings not loaded; using defaults', err);
    return { ...DEFAULT_SETTINGS };
  }
};

void loadPersistedSettings().then((settings) => startApp(canvas, { settings }));
