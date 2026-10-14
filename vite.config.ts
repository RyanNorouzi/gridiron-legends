import { defineConfig } from 'vitest/config';
import { fileURLToPath, URL } from 'node:url';

/**
 * Chunking of the lazily loaded code (the boot chunk is whatever main.ts reaches statically: shell, menus,
 * settings, input, rendering, audio, saves). Modes load through dynamic imports (src/ui/app-modes.ts); their
 * code is grouped by architecture layer so no chunk passes 500 kB and chunk imports follow the layer order
 * (base <- ai <- engine <- game-ui <- franchise-ui, franchise-core), which keeps them acyclic:
 * - base: core, players, playbook, teams, statistics, physics, data, the game leaf modules ai/ may import
 *   (types, engine-api, athlete) and franchise/contracts (used by the shared UI kit)
 * - ai; engine (game + simulation); game-ui (the rest of ui/ and tools/: Game, replay, practice, tutorial, the
 *   franchise kit, the game and practice bundle entries); franchise-core (franchise/); franchise-ui
 *   (ui/franchise/ and the franchise bundle entry).
 * Modules the boot graph holds go to a 'boot' chunk and are never moved into a layer.
 */
const LAYERS: readonly (readonly [RegExp, string])[] = [
  [/\/src\/game\/(types|engine-api|athlete)\.ts$/, 'base'],
  [/\/src\/franchise\/contracts\.ts$/, 'base'],
  [/\/src\/(core|players|playbook|teams|statistics|physics|data)\//, 'base'],
  [/\/src\/ai\//, 'ai'],
  [/\/src\/(game|simulation)\//, 'engine'],
  [/\/src\/franchise\//, 'franchise-core'],
  // The franchise UI kit and shell widgets are shared with Custom Game: they travel with the game UI.
  [/\/src\/ui\/franchise\/(kit\/|shell\/widgets\.ts$)/, 'game-ui'],
  [/\/src\/ui\/franchise\//, 'franchise-ui'],
  // Each lazy bundle entry lives in its layer's chunk (left alone, Rollup merges the three tiny facades into one
  // chunk that imports every layer).
  [/\/src\/ui\/lazy\/franchise-bundle\.ts$/, 'franchise-ui'],
  [/\/src\/(ui|tools)\//, 'game-ui'],
];

interface ChunkMeta {
  getModuleIds(): IterableIterator<string>;
  getModuleInfo(id: string): { isEntry: boolean; importedIds: readonly string[] } | null;
}

/** Every module an entry reaches through static imports only (the first load). */
const bootGraph = (meta: ChunkMeta): Set<string> => {
  const out = new Set<string>();
  const queue = [...meta.getModuleIds()].filter((id) => meta.getModuleInfo(id)?.isEntry);
  while (queue.length > 0) {
    const id = queue.pop() as string;
    if (out.has(id)) continue;
    out.add(id);
    for (const dep of meta.getModuleInfo(id)?.importedIds ?? []) queue.push(dep);
  }
  return out;
};

export default defineConfig(() => {
  let boot: Set<string> | null = null;
  return {
    resolve: {
      alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
    },
    // The league simulator's Web Worker (src/ui/franchise/shell/sim-worker.ts) is a module worker: ES output keeps
    // it one self-contained module that shares nothing with the page's chunks.
    worker: { format: 'es' as const },
    build: {
      target: 'es2022',
      sourcemap: true,
      rollupOptions: {
        output: {
          manualChunks: (id: string, meta: ChunkMeta): string | undefined => {
            boot ??= bootGraph(meta);
            // Boot modules get their own named chunk: left unassigned, Rollup would pull the ones a layer chunk
            // depends on INTO that layer chunk, and the first load would then fetch the whole layer.
            if (boot.has(id)) return meta.getModuleInfo(id)?.isEntry ? undefined : 'boot';
            if (id.includes('node_modules')) return undefined;
            return LAYERS.find(([re]) => re.test(id))?.[1];
          },
        },
      },
    },
    test: {
      environment: 'node',
      include: ['tests/**/*.test.ts'],
      // Simulation-heavy suites are CPU- and memory-bound; unbounded parallelism pushes a 16 GB machine into swap
      // and turns 10 s files into 15-minute timeouts. Override with VITEST_MAX_WORKERS when you have headroom.
      maxWorkers: Number(process.env.VITEST_MAX_WORKERS ?? 4),
      minWorkers: 1,
    },
  };
});
