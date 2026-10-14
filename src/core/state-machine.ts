/** Tiny finite state machine with enter/exit/update hooks. */
export interface StateDef<Ctx, S extends string> {
  enter?: (ctx: Ctx, from: S | null) => void;
  update?: (ctx: Ctx, dt: number) => S | void;
  exit?: (ctx: Ctx, to: S) => void;
}

export class StateMachine<Ctx, S extends string> {
  private current: S;
  private timeInState = 0;
  constructor(
    private readonly ctx: Ctx,
    private readonly states: Record<S, StateDef<Ctx, S>>,
    initial: S,
  ) {
    this.current = initial;
    this.states[initial].enter?.(ctx, null);
  }
  get state(): S {
    return this.current;
  }
  get elapsed(): number {
    return this.timeInState;
  }
  transition(to: S): void {
    if (to === this.current) return;
    const from = this.current;
    this.states[from].exit?.(this.ctx, to);
    this.current = to;
    this.timeInState = 0;
    this.states[to].enter?.(this.ctx, from);
  }
  update(dt: number): void {
    this.timeInState += dt;
    const next = this.states[this.current].update?.(this.ctx, dt);
    if (next && next !== this.current) this.transition(next);
  }
}
