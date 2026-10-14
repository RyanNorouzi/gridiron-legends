/**
 * Screen stack: push/pop/replace with enter/exit/pause/resume hooks, input routed to the top screen only,
 * rendering of the topmost opaque screen and every overlay above it, and a short fade-from-black transition
 * (skipped under reduced motion). Pure logic; the render context is whatever the app passes in.
 */
import type { InputState } from '../input/types';
import type { RenderContext, Screen, ScreenServices } from './screen';

export interface ScreenStackOptions {
  /** Length of the fade after a push/pop/replace, in seconds. 0 disables transitions. */
  fadeSeconds?: number;
}

export class ScreenStack {
  private readonly screens: Screen[] = [];
  private services: ScreenServices | null = null;
  private fade = 0;
  private readonly fadeTotal: number;

  constructor(opts: ScreenStackOptions = {}) {
    this.fadeTotal = Math.max(0, opts.fadeSeconds ?? 0.25);
  }

  /** Binds the services passed to screen hooks. Must run before the first push. */
  attach(services: ScreenServices): void {
    this.services = services;
  }

  get size(): number {
    return this.screens.length;
  }

  get top(): Screen | null {
    return this.screens[this.screens.length - 1] ?? null;
  }

  /** Bottom to top. */
  get all(): readonly Screen[] {
    return this.screens;
  }

  /** Remaining transition fade 0..1 (1 = fully black). */
  get transition(): number {
    return this.fadeTotal > 0 ? this.fade / this.fadeTotal : 0;
  }

  find(id: string): Screen | null {
    return this.screens.find((s) => s.id === id) ?? null;
  }

  push(screen: Screen): void {
    const services = this.requireServices();
    this.top?.pause?.(services);
    this.screens.push(screen);
    screen.enter(services);
    this.startFade();
  }

  pop(): Screen | null {
    const services = this.requireServices();
    const screen = this.screens.pop();
    if (!screen) return null;
    screen.exit(services);
    this.top?.resume?.(services);
    this.startFade();
    return screen;
  }

  /** Swaps the top screen without touching those beneath. */
  replace(screen: Screen): Screen | null {
    const services = this.requireServices();
    const old = this.screens.pop() ?? null;
    old?.exit(services);
    this.screens.push(screen);
    screen.enter(services);
    this.startFade();
    return old;
  }

  /** Pops until the given screen is on top (no-op when it is not in the stack). */
  popTo(screen: Screen): void {
    if (!this.screens.includes(screen)) return;
    while (this.top !== screen) this.pop();
  }

  clear(): void {
    while (this.screens.length > 0) this.pop();
  }

  /** Advances the transition and updates the top screen with this tick's input. */
  update(dt: number, input: InputState): void {
    const services = this.requireServices();
    if (this.fade > 0) this.fade = Math.max(0, this.fade - dt);
    this.top?.update(dt, input, services);
  }

  /** Index of the lowest screen that must be drawn (the topmost non-overlay, or 0). */
  firstVisibleIndex(): number {
    for (let i = this.screens.length - 1; i >= 0; i--) if (!this.screens[i]?.overlay) return i;
    return 0;
  }

  render(rc: RenderContext): void {
    const first = this.firstVisibleIndex();
    const snapshot = this.screens.slice(first);
    for (const s of snapshot) s.render(rc);
    if (this.fade > 0 && this.fadeTotal > 0) {
      const prev = rc.ctx.globalAlpha;
      rc.ctx.globalAlpha = Math.min(1, this.fade / this.fadeTotal);
      rc.ctx.fillStyle = rc.theme.colors.overlay;
      rc.ctx.fillRect(0, 0, rc.width, rc.height);
      rc.ctx.globalAlpha = prev;
    }
  }

  private startFade(): void {
    if (this.fadeTotal <= 0 || this.services?.theme.reducedMotion) {
      this.fade = 0;
      return;
    }
    this.fade = this.fadeTotal;
  }

  private requireServices(): ScreenServices {
    if (!this.services) throw new Error('ScreenStack: attach(services) must be called before use');
    return this.services;
  }
}
