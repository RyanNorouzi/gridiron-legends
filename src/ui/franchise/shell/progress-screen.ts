/**
 * Overlay that runs a SimJob a slice at a time so the screen keeps drawing: each tick it steps the job for up to
 * `budgetMs`, and after a heavy step (the real simulator needs ~0.5 s per game) it idles for a few ticks so the
 * loop gets to render the progress bar. With the Web Worker pool (SimJob `offThread`) the games run elsewhere and a
 * tick here only checks for results, so the screen animates at full rate. Back (B / L / Esc) or the STOP button
 * cancel (the week in progress is discarded; nothing is half-applied). When the job finishes the overlay pops itself and hands the result to `onDone`.
 *
 * Hidden tabs: browsers pause animation frames for a hidden document, so `update` stops being called. While the
 * document is hidden the overlay keeps the job going itself: it waits on `SimJob.settled()` (worker answers are not
 * throttled) or yields through a MessageChannel (chained timers are) and steps the job until it finishes or the tab
 * is shown again, when the frame loop takes over.
 */
import type { InputState } from '../../input/types';
import { drawText } from '../../render/text';
import type { RenderContext, Screen, ScreenServices } from '../../screens/screen';
import { drawPanel } from '../../widgets/panel';
import { fitCell } from '../kit/data-table-view';
import { inRect, pressed, type Rect } from '../kit/list';
import { leagueDateText } from './hub-model';
import type { SimJob, SimJobResult } from './sim-job';
import { dimBackdrop, drawButton, drawProgress } from './widgets';

/** Options of the progress overlay. */
export interface SimProgressOptions {
  title?: string;
  onDone(result: SimJobResult): void;
  /** Milliseconds of work per tick (default 12). */
  budgetMs?: number;
  /** Clock for the budget (default performance.now / Date.now). */
  now?: () => number;
  /** Allow cancelling (default true). */
  cancellable?: boolean;
}

const defaultNow = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/** The part of `document` the hidden-tab pump uses (a test stubs it). */
interface VisibilityDoc {
  readonly hidden: boolean;
  addEventListener(type: 'visibilitychange', cb: () => void): void;
  removeEventListener(type: 'visibilitychange', cb: () => void): void;
}

const visibilityDoc = (): VisibilityDoc | null =>
  typeof document !== 'undefined' && typeof document.addEventListener === 'function' ? (document as VisibilityDoc) : null;

/** Yields to the event loop without timer throttling (MessageChannel), falling back to setTimeout. */
const yieldTask = (): Promise<void> => new Promise<void>((resolve) => {
  if (typeof MessageChannel === 'undefined') {
    setTimeout(resolve, 0);
    return;
  }
  const ch = new MessageChannel();
  ch.port1.onmessage = () => {
    ch.port1.close();
    resolve();
  };
  ch.port2.postMessage(0);
});

/** Frame-friendly runner of a SimJob. */
export class SimProgressScreen implements Screen {
  readonly id = 'franchise-sim-progress';
  readonly overlay = true;
  private services: ScreenServices | null = null;
  private cooldown = 0;
  private finished = false;
  private stopRect: Rect | null = null;
  private doc: VisibilityDoc | null = null;
  private pumping = false;
  private readonly onVisibility = (): void => { void this.pumpHidden(); };

  constructor(readonly job: SimJob, private readonly opts: SimProgressOptions) {}

  enter(services: ScreenServices): void {
    this.services = services;
    this.doc = visibilityDoc();
    this.doc?.addEventListener('visibilitychange', this.onVisibility);
    if (this.doc?.hidden) void this.pumpHidden();
  }

  exit(): void {
    this.doc?.removeEventListener('visibilitychange', this.onVisibility);
    this.doc = null;
    this.services = null;
  }

  /** True while the hidden-tab pump is driving the job. */
  get backgroundPumping(): boolean { return this.pumping; }

  /**
   * Drives the job while the document is hidden (no animation frames). Resolves when the job finished, the tab is
   * shown again or the overlay left the stack. Never runs twice at once.
   */
  async pumpHidden(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      const active = (): boolean => !this.finished && this.doc !== null && this.doc.hidden;
      while (active()) {
        if (this.job.waiting) await this.job.settled();
        else await yieldTask();
        if (!active()) break;
        if (this.job.step()) {
          this.finish();
          break;
        }
      }
    } finally {
      this.pumping = false;
    }
  }

  /** Requests a stop (the job finishes its bookkeeping on the next step). */
  cancel(): void {
    if (this.opts.cancellable === false) return;
    this.job.cancel();
  }

  update(_dt: number, input: InputState): void {
    if (this.finished) return;
    const p = input.pointer;
    if (pressed(input, ['back']) || (p?.justDown && this.stopRect && inRect(this.stopRect, p.x, p.y))) this.cancel();
    if (this.cooldown > 0) {
      this.cooldown--;
      return;
    }
    const now = this.opts.now ?? defaultNow;
    const start = now();
    const budget = this.opts.budgetMs ?? 12;
    let done = this.job.step();
    // While the games are out at the workers a step only checks for results: no point spinning on it.
    while (!done && !this.job.waiting && now() - start < budget) done = this.job.step();
    const spent = now() - start;
    this.cooldown = Math.min(5, Math.floor(spent / 16));
    if (done) this.finish();
  }

  private finish(): void {
    if (this.finished) return;
    this.finished = true;
    const s = this.services;
    if (s && s.stack.top === this) s.stack.pop();
    this.opts.onDone(this.job.result);
  }

  /** Status line: date plus the game count of the week being prepared. */
  statusText(): string {
    const w = this.job.weekProgress;
    const date = leagueDateText(this.job.league);
    return w && w.total > 0 ? `${date} - game ${Math.min(w.total, w.done + 1)} of ${w.total}` : date;
  }

  render(rc: RenderContext): void {
    const theme = this.services?.theme ?? rc.theme;
    const { ctx, width, height } = rc;
    dimBackdrop(ctx, theme, width, height);
    const w = Math.min(width - theme.pad * 2, 320);
    const h = theme.lineHeight * 5 + theme.pad * 2;
    const x = Math.round((width - w) / 2);
    const y = Math.round((height - h) / 2);
    const content = drawPanel(ctx, theme, x, y, w, h, { title: this.opts.title ?? 'SIMULATING', style: 'raised', border: theme.colors.accent });
    const size = theme.textScale;
    drawText(ctx, fitCell(this.statusText(), content.w, size), content.x, content.y, { color: theme.colors.text, size });
    drawProgress(ctx, theme, { x: content.x, y: content.y + theme.lineHeight + theme.gap, w: content.w, h: Math.max(6, theme.glyphH) }, this.job.progress);
    drawText(ctx, `${Math.round(this.job.progress * 100)}%`, content.x, content.y + theme.lineHeight * 2 + theme.gap * 2, { color: theme.colors.textDim, size });
    if (this.opts.cancellable !== false) {
      this.stopRect = drawButton(ctx, theme, 'STOP', content.x + content.w, content.y + theme.lineHeight * 2 + theme.gap, true, 'right');
    }
  }
}
