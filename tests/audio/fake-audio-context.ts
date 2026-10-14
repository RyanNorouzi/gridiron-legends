/**
 * Minimal in-memory stand-in for the WebAudio API so the real backend graph-building code runs under Node.
 * Records connections, automation events and start/stop times instead of producing sound.
 */
export interface FakeParamEvent {
  kind: 'set' | 'linear' | 'exp' | 'target' | 'cancel';
  v: number;
  t: number;
}

export class FakeParam {
  events: FakeParamEvent[] = [];
  constructor(public value = 0) {}
  setValueAtTime(v: number, t: number): this {
    this.events.push({ kind: 'set', v, t });
    this.value = v;
    return this;
  }
  linearRampToValueAtTime(v: number, t: number): this {
    this.events.push({ kind: 'linear', v, t });
    this.value = v;
    return this;
  }
  exponentialRampToValueAtTime(v: number, t: number): this {
    this.events.push({ kind: 'exp', v, t });
    this.value = v;
    return this;
  }
  setTargetAtTime(v: number, t: number): this {
    this.events.push({ kind: 'target', v, t });
    this.value = v;
    return this;
  }
  cancelScheduledValues(t: number): this {
    this.events.push({ kind: 'cancel', v: 0, t });
    return this;
  }
}

export class FakeNode {
  connections: (FakeNode | FakeParam)[] = [];
  disconnected = false;
  constructor(readonly kind: string) {}
  connect<T extends FakeNode | FakeParam>(dst: T): T {
    this.connections.push(dst);
    return dst;
  }
  disconnect(): void {
    this.connections = [];
    this.disconnected = true;
  }
}

export class FakeGain extends FakeNode {
  gain = new FakeParam(1);
  constructor() {
    super('gain');
  }
}

export class FakeSource extends FakeNode {
  started: number[] = [];
  stopped: number[] = [];
  onended: (() => void) | null = null;
  start(t = 0): void {
    this.started.push(t);
  }
  stop(t = 0): void {
    this.stopped.push(t);
  }
  /** Simulate the browser firing 'ended'. */
  fireEnded(): void {
    this.onended?.();
  }
}

export class FakeOscillator extends FakeSource {
  type = 'sine';
  frequency = new FakeParam(440);
  constructor() {
    super('oscillator');
  }
}

export class FakeBufferSource extends FakeSource {
  buffer: FakeBuffer | null = null;
  loop = false;
  loopStart = 0;
  loopEnd = 0;
  playbackRate = new FakeParam(1);
  offsets: number[] = [];
  override start(t = 0, offset = 0): void {
    super.start(t);
    this.offsets.push(offset);
  }
  constructor() {
    super('bufferSource');
  }
}

export class FakeFilter extends FakeNode {
  type = 'lowpass';
  frequency = new FakeParam(350);
  Q = new FakeParam(1);
  constructor() {
    super('filter');
  }
}

export class FakeCompressor extends FakeNode {
  threshold = new FakeParam(-24);
  knee = new FakeParam(30);
  ratio = new FakeParam(12);
  attack = new FakeParam(0.003);
  release = new FakeParam(0.25);
  constructor() {
    super('compressor');
  }
}

export class FakePanner extends FakeNode {
  pan = new FakeParam(0);
  constructor() {
    super('panner');
  }
}

export class FakeConvolver extends FakeNode {
  buffer: FakeBuffer | null = null;
  constructor() {
    super('convolver');
  }
}

export class FakeBuffer {
  readonly data: Float32Array;
  constructor(readonly length: number, readonly sampleRate: number) {
    this.data = new Float32Array(length);
  }
  getChannelData(): Float32Array {
    return this.data;
  }
}

export class FakeAudioContext {
  currentTime = 0;
  state: 'suspended' | 'running' | 'closed' = 'suspended';
  sampleRate = 8000;
  destination = new FakeNode('destination');
  nodes: FakeNode[] = [];
  buffers: FakeBuffer[] = [];
  resumeCalls = 0;
  closeCalls = 0;
  /** When set, resume() rejects with this error (autoplay-policy / interrupted contexts). */
  resumeError: Error | null = null;

  private track<T extends FakeNode>(n: T): T {
    this.nodes.push(n);
    return n;
  }
  createGain(): FakeGain {
    return this.track(new FakeGain());
  }
  createOscillator(): FakeOscillator {
    return this.track(new FakeOscillator());
  }
  createBufferSource(): FakeBufferSource {
    return this.track(new FakeBufferSource());
  }
  createBiquadFilter(): FakeFilter {
    return this.track(new FakeFilter());
  }
  /** Only when `advanced` is set (the synth tests run against the minimal node set). */
  createDynamicsCompressor?: () => FakeCompressor;
  createStereoPanner?: () => FakePanner;
  createConvolver?: () => FakeConvolver;
  /** Adds the compressor / stereo panner / convolver factories the sample output uses when present. */
  enableAdvancedNodes(): this {
    this.createDynamicsCompressor = () => this.track(new FakeCompressor());
    this.createStereoPanner = () => this.track(new FakePanner());
    this.createConvolver = () => this.track(new FakeConvolver());
    return this;
  }
  createBuffer(_channels: number, length: number, sampleRate: number): FakeBuffer {
    const b = new FakeBuffer(length, sampleRate);
    this.buffers.push(b);
    return b;
  }
  async resume(): Promise<void> {
    this.resumeCalls++;
    if (this.resumeError) throw this.resumeError;
    if (this.state !== 'closed') this.state = 'running';
  }
  async close(): Promise<void> {
    this.closeCalls++;
    this.state = 'closed';
  }

  oscillators(): FakeOscillator[] {
    return this.nodes.filter((n): n is FakeOscillator => n instanceof FakeOscillator);
  }
  bufferSources(): FakeBufferSource[] {
    return this.nodes.filter((n): n is FakeBufferSource => n instanceof FakeBufferSource);
  }
  gains(): FakeGain[] {
    return this.nodes.filter((n): n is FakeGain => n instanceof FakeGain);
  }
  filters(): FakeFilter[] {
    return this.nodes.filter((n): n is FakeFilter => n instanceof FakeFilter);
  }
  /** Category buses in creation order: sfx, crowd, music, commentary. */
  buses(): FakeGain[] {
    return this.gains().filter((g) => g.connections.includes(this.destination));
  }
  asContext(): AudioContext {
    return this as unknown as AudioContext;
  }
}
