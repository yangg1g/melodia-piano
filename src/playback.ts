import type { Midi } from '@tonejs/midi';
import { getContext } from 'tone';
import { assignHandForNote, type FlatNote, type Hand } from './midiScore';
import { playPianoMidi, releaseAllPiano } from './salamanderPiano';

export interface PlaybackController {
  stop: () => void;
  isPlaying: () => boolean;
}

/** 自动播放：Salamander 采样钢琴；用 setTimeout 对齐 note on/off 以高亮键盘（按左右手上色） */
export function playNotes(
  notes: FlatNote[],
  midiFile: Midi,
  durationSec: number,
  onKeys: (active: Map<number, Hand>) => void,
  onEnded?: () => void,
  onTimeSec?: (sec: number) => void,
): PlaybackController {
  const ctx = getContext();
  const active = new Map<number, Hand>();
  const timers: number[] = [];
  let stopped = false;

  const scheduleAt = (audioTime: number, fn: () => void) => {
    const delayMs = Math.max(0, (audioTime - ctx.currentTime) * 1000);
    return window.setTimeout(fn, delayMs);
  };

  const base = ctx.currentTime + 0.06;
  let raf = 0;

  const tick = () => {
    if (stopped) return;
    if (onTimeSec) {
      onTimeSec(Math.max(0, ctx.currentTime - base));
      raf = requestAnimationFrame(tick);
    }
  };
  if (onTimeSec) {
    raf = requestAnimationFrame(tick);
  }

  for (const n of notes) {
    const tOn = base + n.time;
    const tOff = tOn + Math.max(0.04, n.duration);

    timers.push(
      scheduleAt(tOn, () => {
        if (stopped) return;
        active.set(n.midi, assignHandForNote(n, midiFile));
        onKeys(new Map(active));
        playPianoMidi(n.midi, Math.max(0.06, n.duration), 0.78);
      }),
    );

    timers.push(
      scheduleAt(tOff, () => {
        if (stopped) return;
        active.delete(n.midi);
        onKeys(new Map(active));
      }),
    );
  }

  const endId = window.setTimeout(
    () => {
      if (stopped) return;
      stopped = true;
      cancelAnimationFrame(raf);
      active.clear();
      onKeys(active);
      onEnded?.();
    },
    (durationSec + 0.6) * 1000,
  );

  return {
    stop: () => {
      stopped = true;
      cancelAnimationFrame(raf);
      for (const id of timers) clearTimeout(id);
      clearTimeout(endId);
      active.clear();
      onKeys(active);
      releaseAllPiano();
    },
    isPlaying: () => !stopped,
  };
}
