import type { Midi } from '@tonejs/midi';
import { assignHandForNote, type FlatNote, type Hand } from './midiScore';
import { playPianoMidi, releaseAllPiano, getPianoAudioTime } from './salamanderPiano';

export interface PlaybackController {
  stop: () => void;
  isPlaying: () => boolean;
}

/** 自动播放：用 setTimeout 对齐 note on/off 以高亮键盘（按左右手上色） */
export function playNotes(
  notes: FlatNote[],
  midiFile: Midi,
  durationSec: number,
  onKeys: (active: Map<number, Hand>) => void,
  onEnded?: () => void,
  onTimeSec?: (sec: number) => void,
  /** 从指定秒偏移处开始播放（用于进度条跳转） */
  startOffset = 0,
  speed = 1,
): PlaybackController {
  const active = new Map<number, Hand>();
  const timers: number[] = [];
  let stopped = false;

  const scheduleAt = (audioTime: number, fn: () => void) => {
    const delayMs = Math.max(0, (audioTime - getPianoAudioTime()) * 1000);
    return window.setTimeout(fn, delayMs);
  };

  const base = getPianoAudioTime() + 0.06;
  let raf = 0;

  const tick = () => {
    if (stopped) return;
    if (onTimeSec) {
      onTimeSec(Math.max(0, getPianoAudioTime() - base) * speed + startOffset);
      raf = requestAnimationFrame(tick);
    }
  };
  if (onTimeSec) {
    raf = requestAnimationFrame(tick);
  }

  // 只调度 startOffset 之后的音符
  const filteredNotes = notes.filter((n) => n.time + n.duration >= startOffset);

  for (const n of filteredNotes) {
    const playTime = Math.max(n.time, startOffset);
    const releaseTime = n.time + Math.max(0, n.duration);

    const tOn = base + (playTime - startOffset) / speed;
    const tOff = base + (releaseTime - startOffset) / speed;

    timers.push(
      scheduleAt(tOn, () => {
        if (stopped) return;
        active.set(n.midi, assignHandForNote(n, midiFile));
        onKeys(new Map(active));
        playPianoMidi(n.midi, Math.max(0, n.duration - (playTime - n.time)), n.velocity);
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
    (durationSec - startOffset + 0.6) / speed * 1000,
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
