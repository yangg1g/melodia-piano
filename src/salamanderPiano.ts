import { Frequency, Sampler, now, start } from 'tone';

/** Tone.js 官方托管的 Salamander Grand Piano（采样 + 插值），比简单振荡器更接近真钢。 */
const BASE_URL = 'https://tonejs.github.io/audio/salamander/';

const SAMPLE_URLS: Record<string, string> = {
  A0: 'A0.mp3',
  C1: 'C1.mp3',
  'D#1': 'Ds1.mp3',
  'F#1': 'Fs1.mp3',
  A1: 'A1.mp3',
  C2: 'C2.mp3',
  'D#2': 'Ds2.mp3',
  'F#2': 'Fs2.mp3',
  A2: 'A2.mp3',
  C3: 'C3.mp3',
  'D#3': 'Ds3.mp3',
  'F#3': 'Fs3.mp3',
  A3: 'A3.mp3',
  C4: 'C4.mp3',
  'D#4': 'Ds4.mp3',
  'F#4': 'Fs4.mp3',
  A4: 'A4.mp3',
  C5: 'C5.mp3',
  'D#5': 'Ds5.mp3',
  'F#5': 'Fs5.mp3',
  A5: 'A5.mp3',
  C6: 'C6.mp3',
  'D#6': 'Ds6.mp3',
  'F#6': 'Fs6.mp3',
  A6: 'A6.mp3',
  C7: 'C7.mp3',
  'D#7': 'Ds7.mp3',
  'F#7': 'Fs7.mp3',
  A7: 'A7.mp3',
  C8: 'C8.mp3',
};

let piano: Sampler | null = null;
let loadPromise: Promise<Sampler> | null = null;

/**
 * 在用户手势里调用（如点击播放）。首次会从 CDN 拉采样，需联网。
 */
export async function ensureSalamanderPiano(): Promise<Sampler> {
  await start();
  if (piano) return piano;
  if (!loadPromise) {
    loadPromise = new Promise<Sampler>((resolve, reject) => {
      const s = new Sampler({
        urls: SAMPLE_URLS,
        release: 1,
        baseUrl: BASE_URL,
        onload: () => {
          s.volume.value = 1;
          piano = s;
          resolve(s);
        },
        onerror: (err) => {
          s.dispose();
          loadPromise = null;
          reject(err);
        },
      }).toDestination();
    });
  }
  return loadPromise;
}

export function playPianoMidi(midi: number, durationSec: number, velocity: number): void {
  if (!piano) return;
  const note = Frequency(midi, 'midi').toNote();
  /** 仅避免 0 或负值让 Tone 行为异常，不按短音人为加长 */
  const dur = Math.max(1e-4, durationSec);
  piano.triggerAttackRelease(note, dur, now(), velocity);
}

/** 停止跟弹 / 自动播放时切断余音 */
export function releaseAllPiano(): void {
  piano?.releaseAll(now());
}
