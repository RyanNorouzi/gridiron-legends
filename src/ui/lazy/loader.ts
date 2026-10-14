/**
 * Loads a lazily split bundle for a screen action: caches the module, shows a "LOADING" toast when the chunk
 * takes a moment (first use on a slow connection) and reports a failed load instead of throwing. Only one load
 * of a bundle is in flight at a time; a second action on the same bundle waits for it and replaces the first.
 */

/** A bundle loader with a cached result. */
export interface LazyBundle<M> {
  /** The module when already loaded, else null. */
  readonly loaded: M | null;
  /** Loads (once) and resolves the module. */
  load(): Promise<M>;
}

/** Wraps a dynamic import. */
export const lazyBundle = <M>(importer: () => Promise<M>, onLoaded?: (m: M) => void): LazyBundle<M> => {
  let mod: M | null = null;
  let pending: Promise<M> | null = null;
  return {
    get loaded() { return mod; },
    load: () => {
      if (mod) return Promise.resolve(mod);
      pending ??= importer().then((m) => {
        mod = m;
        onLoaded?.(m);
        return m;
      }).finally(() => { pending = null; });
      return pending;
    },
  };
};

/** Milliseconds before the loading toast shows. */
export const LOADING_TOAST_DELAY_MS = 150;

/** Latest waiting request per bundle: a menu stays live while a chunk loads, so only the last choice may run. */
const latestRequest = new WeakMap<LazyBundle<unknown>, number>();
let requestCounter = 0;

/**
 * Runs `use` with the bundle's module: synchronously when it is already loaded, else after loading it (toast
 * "LOADING..." when slow, toast the error when the chunk cannot be fetched). While a load is in flight, a newer
 * request for the same bundle replaces the older one, so pressing a mode twice opens it once.
 */
export const withBundle = <M>(bundle: LazyBundle<M>, toast: (msg: string, seconds?: number) => void, use: (m: M) => void): void => {
  const ready = bundle.loaded;
  if (ready) {
    use(ready);
    return;
  }
  const id = ++requestCounter;
  latestRequest.set(bundle, id);
  const timer = setTimeout(() => toast('LOADING...', 1), LOADING_TOAST_DELAY_MS);
  void bundle.load().then((m) => {
    clearTimeout(timer);
    if (latestRequest.get(bundle) === id) use(m);
  }).catch((err: unknown) => {
    clearTimeout(timer);
    console.warn('lazy bundle failed to load', err);
    toast('Could not load that mode - check the connection and try again', 3);
  });
};
