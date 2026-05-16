// ─── Procedural Sound System (Web Audio API) ──────────────────────

let ctx: AudioContext | null = null;
let masterGain: GainNode | null = null;
let masterVolume = 0.5;

function getCtxSync(): AudioContext {
  if (!ctx) {
    ctx = new AudioContext();
    masterGain = ctx.createGain();
    masterGain.gain.value = masterVolume;
    masterGain.connect(ctx.destination);
  }
  if (ctx.state === 'suspended') {
    ctx.resume(); // fire-and-forget; sound may be silent until user gesture
  }
  return ctx;
}

export function setMasterVolume(v: number) {
  masterVolume = v;
  if (masterGain) masterGain.gain.value = v;
}

function out(): GainNode {
  const g = getCtxSync().createGain();
  g.connect(masterGain!);
  return g;
}

function now(): number {
  return getCtxSync().currentTime;
}

// ─── Sound Effects ─────────────────────────────

export function playPlace() {
  const c = getCtxSync();
  const t = now();

  // Low thump
  const osc = c.createOscillator();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(180, t);
  osc.frequency.exponentialRampToValueAtTime(60, t + 0.12);
  const g = out();
  g.gain.setValueAtTime(0.35, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + 0.15);
  osc.connect(g);
  osc.start(t);
  osc.stop(t + 0.15);

  // Tiny click for attack
  const noise = c.createBufferSource();
  const buf = c.createBuffer(1, c.sampleRate * 0.02, c.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * Math.exp(-i / (c.sampleRate * 0.005));
  noise.buffer = buf;
  const ng = out();
  ng.gain.setValueAtTime(0.15, t);
  ng.gain.exponentialRampToValueAtTime(0.001, t + 0.02);
  noise.connect(ng);
  noise.start(t);
  noise.stop(t + 0.02);
}

export function playDelete() {
  const c = getCtxSync();
  const t = now();

  const noise = c.createBufferSource();
  const duration = 0.3;
  const buf = c.createBuffer(1, c.sampleRate * duration, c.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1);
  noise.buffer = buf;

  const bp = c.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.setValueAtTime(2000, t);
  bp.frequency.exponentialRampToValueAtTime(200, t + duration);
  bp.Q.value = 1.5;

  const g = out();
  g.gain.setValueAtTime(0.25, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + duration);

  noise.connect(bp);
  bp.connect(g);
  noise.start(t);
  noise.stop(t + duration);
}

export function playPaint() {
  const c = getCtxSync();
  const t = now();

  const noise = c.createBufferSource();
  const duration = 0.1;
  const buf = c.createBuffer(1, c.sampleRate * duration, c.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1);
  noise.buffer = buf;

  const bp = c.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.value = 800;
  bp.Q.value = 3;

  const g = out();
  g.gain.setValueAtTime(0.12, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + duration);

  noise.connect(bp);
  bp.connect(g);
  noise.start(t);
  noise.stop(t + duration);
}

export function playUndo() {
  const c = getCtxSync();
  const t = now();

  const osc = c.createOscillator();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(600, t);
  osc.frequency.exponentialRampToValueAtTime(300, t + 0.08);
  const g = out();
  g.gain.setValueAtTime(0.12, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + 0.08);
  osc.connect(g);
  osc.start(t);
  osc.stop(t + 0.08);
}

export function playRedo() {
  const c = getCtxSync();
  const t = now();

  const osc = c.createOscillator();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(300, t);
  osc.frequency.exponentialRampToValueAtTime(600, t + 0.08);
  const g = out();
  g.gain.setValueAtTime(0.12, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + 0.08);
  osc.connect(g);
  osc.start(t);
  osc.stop(t + 0.08);
}
