/** Simple object pool to avoid per-tick allocations in hot paths. */
export class ObjectPool<T> {
  private free: T[] = [];
  constructor(
    private readonly factory: () => T,
    private readonly reset: (item: T) => void,
    prewarm = 0,
  ) {
    for (let i = 0; i < prewarm; i++) this.free.push(factory());
  }
  acquire(): T {
    const item = this.free.pop();
    return item ?? this.factory();
  }
  release(item: T): void {
    this.reset(item);
    this.free.push(item);
  }
  get available(): number {
    return this.free.length;
  }
}
