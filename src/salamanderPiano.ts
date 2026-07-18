import { SplendidGrandPiano } from 'smplr';
import { start, getContext } from 'tone';

let piano: ReturnType<typeof SplendidGrandPiano> | null = null;
let initPromise: Promise<void> | null = null;

/** 当前正在发声的音符的停止函数映射 */
const activeNoteStops = new Map<number, () => void>();

function toSmplrVelocity(velocity: number): number {
  // velocity 0-1 → 0.4 次方力度曲线 → 0-127 MIDI 力度
  const boosted = Math.pow(Math.max(0, Math.min(1, velocity)), 0.4);
  return Math.round(boosted * 127);
}

/**
 * 加载 SplendidGrandPiano 音色库。
 * 底层只会请求单个 SoundFont 文件，浏览器可长缓存，无需刷新后重新下载。
 * 30 秒超时兜底并允许重试。
 */
export function preloadPiano(): Promise<void> {
  if (initPromise) return initPromise;

  // 超时兜底
  let timeoutId: ReturnType<typeof setTimeout>;
  const timeoutPromise = new Promise<void>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error('音频引擎加载超时(30s)'));
    }, 30000);
  });

  const loadPromise = (async () => {
    await start();
    const ac = getContext().rawContext;
    if (ac.state === 'suspended') {
      await ac.resume();
    }

    piano = SplendidGrandPiano(ac, { volume: 100 });
    await piano.ready;
    console.log('[salamanderPiano] SplendidGrandPiano 加载完成');
  })();

  initPromise = Promise.race([loadPromise, timeoutPromise])
    .finally(() => clearTimeout(timeoutId!))
    .catch((err: unknown) => {
      console.error('[salamanderPiano] 加载失败:', err);
      initPromise = null; // 允许重试
      throw err;
    });

  return initPromise;
}

export async function ensureSalamanderPiano(): Promise<void> {
  await preloadPiano();
}

export function playPianoMidi(midi: number, durationSec: number, velocity: number): void {
  if (!piano) return;
  const ac = piano.context;
  piano.start({
    note: midi,
    velocity: toSmplrVelocity(velocity),
    duration: Math.max(1e-4, durationSec),
    time: ac.currentTime,
  });
}

export function startPianoNote(midi: number, velocity: number): void {
  if (!piano) return;
  const ac = piano.context;
  const stop = piano.start({
    note: midi,
    velocity: toSmplrVelocity(velocity),
    time: ac.currentTime,
  });
  activeNoteStops.set(midi, stop);
}

export function releasePianoNote(midi: number): void {
  if (!piano) return;
  const stop = activeNoteStops.get(midi);
  if (stop) {
    stop();
    activeNoteStops.delete(midi);
  }
}

export function releaseAllPiano(): void {
  if (!piano) return;
  piano.stop();
  activeNoteStops.clear();
}
