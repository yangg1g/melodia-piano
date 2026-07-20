/**
 * 钢琴音频引擎 —— 使用 MIDI.js + Web Audio API
 * 与 piastudy.com 一致的方案：
 *   1. 页面预加载 midi-min.js（暴露全局 window.MIDI）
 *   2. 运行时调用 MIDI.loadPlugin 拉取单个 SoundFont JS 文件
 *      → /soundfont/acoustic_grand_piano-mp3.js（~4.5MB，内含 88 个 base64 MP3）
 *   3. 通过 MIDI.noteOn / MIDI.noteOff 发 / 收音符
 */

declare global {
  interface Window {
    MIDI: {
      soundfontUrl: string;
      lang: string;
      loadPlugin: (options: {
        targetFormat?: string;
        instrument?: string | string[];
        instruments?: string | string[];
        callback: () => void;
      }) => void;
      noteOn: (channel: number, note: number, velocity: number, delay: number) => void;
      noteOff: (channel: number, note: number, delay: number) => void;
      setVolume: (channel: number, volume: number) => void;
      noteOffAll: () => void;
      WebAudio: { context?: AudioContext };
      Player: {
        timeWarp: number;
        addListener: (fn: (data: { now: number; end: number; channel: number; message: number; note: number; velocity: number }) => void) => void;
        removeListener: (fn: unknown) => void;
        loadFile: (dataUri: string, callback: () => void) => void;
        start: (callback?: () => void) => void;
        stop: () => void;
        pause: () => void;
        resume: () => void;
        currentTime: number;
        endTime: number;
        playing: boolean;
      };
    };
  }
}

let ready = false;
let initPromise: Promise<void> | null = null;
let audioCtx: AudioContext | null = null;

/** 用于 stop all 时清理所有正在发声的音符 */
const playingNotes = new Set<number>();
const noteOffTimers = new Map<number, number>();

function toMidiVelocity(velocity01: number): number {
  const boosted = Math.pow(Math.max(0, Math.min(1, velocity01)), 0.3);
  return Math.round(boosted * 127);
}

/** 获取当前音频时间（用于播放调度同步） */
export function getPianoAudioTime(): number {
  return audioCtx?.currentTime ?? 0;
}

/** 音频引擎是否就绪 */
export function isPianoReady(): boolean {
  return ready;
}

/**
 * 加载 SoundFont 音色库（与 piastudy.com 同款方案）。
 * 底层只请求单个 JS 文件，浏览器可长缓存。
 */
export function preloadPiano(): Promise<void> {
  if (initPromise) return initPromise;

  initPromise = new Promise<void>((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      initPromise = null;
      reject(new Error('音频引擎加载超时(30s)'));
    }, 30000);

    try {
      audioCtx = new AudioContext();
      if (audioCtx.state === 'suspended') {
        audioCtx.resume();
      }
    } catch {
      // AudioContext 创建失败不阻塞，MIDI.js 内部会自行创建
    }

    // 指向 public/soundfonts/ 目录
    window.MIDI.soundfontUrl = '/soundfont/';

    window.MIDI.loadPlugin({
      targetFormat: 'mp3',
      callback: () => {
        clearTimeout(timeoutId);
        ready = true;
        window.MIDI.setVolume(0, 100);
        // 尝试从 MIDI.js 内部获取 AudioContext（用于时间同步）
        try {
          const ctx = window.MIDI.WebAudio?.context;
          if (ctx && !audioCtx) audioCtx = ctx;
        } catch { /* ignore */ }
        console.log('[piano] SoundFont 加载完成');
        resolve();
      },
    });
  });

  return initPromise.catch((err: unknown) => {
    console.error('[piano] 加载失败:', err);
    initPromise = null;
    throw err;
  });
}

export async function ensurePiano(): Promise<void> {
  await preloadPiano();
}

/**
 * 播放一个固定时长的 MIDI 音符（自动结束后关断）
 */
export function playPianoMidi(midi: number, durationSec: number, velocity: number): void {
  if (!ready) return;
  const vel = toMidiVelocity(velocity);
  window.MIDI.noteOn(0, midi, vel, 0);
  playingNotes.add(midi);

  if (durationSec > 0) {
    const tid = window.setTimeout(() => {
      window.MIDI.noteOff(0, midi, 0);
      playingNotes.delete(midi);
      noteOffTimers.delete(midi);
    }, durationSec * 1000);
    // 如果已有定时器则清理旧的重置
    const prev = noteOffTimers.get(midi);
    if (prev) clearTimeout(prev);
    noteOffTimers.set(midi, tid);
  }
}

/**
 * 起音（不自动关断，需调用 releasePianoNote 停止）
 */
export function startPianoNote(midi: number, velocity: number): void {
  if (!ready) return;
  const vel = toMidiVelocity(velocity);
  window.MIDI.noteOn(0, midi, vel, 0);
  playingNotes.add(midi);
}

/**
 * 释放指定音符
 */
export function releasePianoNote(midi: number): void {
  if (!ready) return;
  window.MIDI.noteOff(0, midi, 0);
  playingNotes.delete(midi);
  const tid = noteOffTimers.get(midi);
  if (tid) {
    clearTimeout(tid);
    noteOffTimers.delete(midi);
  }
}

/**
 * 立即停止所有正在发声的音符
 */
export function releaseAllPiano(): void {
  if (!ready) return;
  for (const tid of noteOffTimers.values()) clearTimeout(tid);
  noteOffTimers.clear();
  for (const midi of playingNotes) {
    window.MIDI.noteOff(0, midi, 0);
  }
  playingNotes.clear();
  // 强制切断所有残留延音
  try { window.MIDI.noteOffAll(); } catch { /* ignore */ }
}
