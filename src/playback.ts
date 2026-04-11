import type { FlatNote } from './midiScore';

export interface PlaybackController {
  stop: () => void;
  isPlaying: () => boolean;
}

/** 极简复音：三角波 + 包络；用 setTimeout 对齐 note on/off 以高亮键盘 */
export function playNotes(
  notes: FlatNote[],
  durationSec: number,
  onKeys: (active: Set<number>) => void,
  onEnded?: () => void,
  onTimeSec?: (sec: number) => void,
): PlaybackController {
  const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const ctx = new AudioCtx();
  const active = new Set<number>();
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
        active.add(n.midi);
        onKeys(new Set(active));

        const t = ctx.currentTime;
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'triangle';
        osc.frequency.value = 440 * Math.pow(2, (n.midi - 69) / 12);
        osc.connect(gain);
        gain.connect(ctx.destination);

        const peak = 0.11;
        const dur = Math.max(0.06, n.duration);
        const rel = Math.min(0.28, dur * 0.45);

        gain.gain.setValueAtTime(0.0001, t);
        gain.gain.linearRampToValueAtTime(peak, t + 0.018);
        gain.gain.exponentialRampToValueAtTime(0.0001, t + dur + rel);

        osc.start(t);
        osc.stop(t + dur + rel + 0.04);
      }),
    );

    timers.push(
      scheduleAt(tOff, () => {
        if (stopped) return;
        active.delete(n.midi);
        onKeys(new Set(active));
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
      void ctx.close();
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
      void ctx.close();
    },
    isPlaying: () => !stopped,
  };
}
