import { now, FMSynth, PolySynth, start } from 'tone';

const NOTES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'] as const;

function midiToNote(midi: number): string {
  return NOTES[midi % 12] + (Math.floor(midi / 12) - 1);
}

/**
 * FM 合成钢琴音色，零外部依赖，完全离线
 */
function createPiano(): PolySynth<FMSynth> {
  const piano = new PolySynth(FMSynth, {
    harmonicity: 1.5,
    modulationIndex: 4,
    oscillator: { type: 'sine' },
    modulation: { type: 'sine' },
    envelope: {
      attack: 0.005,
      decay: 0.6,
      sustain: 0.08,
      release: 1.8,
    },
    modulationEnvelope: {
      attack: 0.005,
      decay: 0.3,
      sustain: 0.05,
      release: 1.2,
    },
  }).toDestination();
  piano.maxPolyphony = 32;
  piano.volume.value = -8;
  return piano;
}

let piano: PolySynth<FMSynth> | null = null;
let initPromise: Promise<void> | null = null;

export function preloadPiano(): Promise<void> {
  if (initPromise) return initPromise;
  initPromise = start().then(() => {
    if (!piano) piano = createPiano();
  });
  return initPromise;
}

export async function ensureSalamanderPiano(): Promise<void> {
  await preloadPiano();
}

export function playPianoMidi(midi: number, durationSec: number, velocity: number): void {
  if (!piano) return;
  const dur = Math.max(1e-4, durationSec);
  // 传入音名而非数字，避免 Tone.js 误作 Hz
  piano.triggerAttackRelease(midiToNote(midi), dur, now(), velocity);
}

export function releaseAllPiano(): void {
  piano?.releaseAll(now());
}
