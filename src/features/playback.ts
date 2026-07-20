import type { Midi } from '@tonejs/midi';
import { assignHandForNote, type FlatNote, type Hand } from '../core/midiScore';
import { playPianoMidi, releaseAllPiano, getPianoAudioTime, startPianoNote, releasePianoNote } from '../audio/salamanderPiano';
import { MidiMatchEngine } from '../core/midiMatchEngine';
import { ScoringEngine } from '../core/scoring';
import { applyKeyVisuals } from '../rendering/pianoKeyboard';

export interface PlaybackController {
  stop: () => void;
  isPlaying: () => boolean;
  /** 获取实时日志文本（键盘练习模式） */
  getLogs?: () => string;
  /** 下载日志文件（键盘练习模式） */
  downloadLogs?: () => void;
  /** 录制的 MIDI 事件（用于回放） */
  getRecordedEvents?: () => MidiEventRecord[];
}

/** 录制的单个 MIDI 事件 */
export interface MidiEventRecord {
  data: Uint8Array;
  wallTimeSec: number;
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

      /** 回放录制的 MIDI 事件 */
      export function startMidiReplay(
        events: MidiEventRecord[],
        flatNotes: FlatNote[],
        midiFile: Midi,
        keyEls: Map<number, HTMLElement>,
        scoring: ScoringEngine,
        freePlay: boolean,
        onPaintState?: (notes: import('../core/midiMatchEngine').NoteState[], timeSec: number) => void,
        onTimeSec?: (sec: number) => void,
        onEnded?: () => void,
      ): PlaybackController {
        const base = performance.now();
        let stopped = false;
        let raf: number | null = null;
        const timers: number[] = [];

        const log = (msg: string) => console.log('[REPLAY]', msg);

        scoring.reset({ totalNotes: flatNotes.length });

        const engine = new MidiMatchEngine(flatNotes, {
          log,
          onNoteStart: (midi, vel) => startPianoNote(midi, vel),
          onNoteRelease: (midi) => releasePianoNote(midi),
          onWrongKey: (midi, vel) => playPianoMidi(midi, 0.3, vel),
          onVisualUpdate: (expected, pressed) => applyKeyVisuals(keyEls, { expected, active: undefined, pressed }),
          onPaintState: (notes, t) => onPaintState?.(notes, t),
          onScoreUpdate: () => {},
          onTimeSec: (t) => onTimeSec?.(t),
          onEnded: () => { releaseAllPiano(); onEnded?.(); },
        }, {
          freePlay,
          speedMultiplier: 1,
          hitWindowMs: scoring.windows.ok,
          perfectMs: scoring.windows.perfect,
          scoring,
          getHandForNote: (note) => assignHandForNote(note, midiFile),
          startWallTimeMs: base,
        });

        // 按 wallTimeSec 排序
        const sorted = [...events].sort((a, b) => a.wallTimeSec - b.wallTimeSec);
        const shiftSec = sorted.length > 0 ? sorted[0].wallTimeSec : 0;

        for (const ev of sorted) {
          const delayMs = (ev.wallTimeSec - shiftSec) * 1000;
          timers.push(window.setTimeout(() => {
            if (stopped) return;
            engine.processMidiEvent(new Uint8Array(ev.data), ev.wallTimeSec - shiftSec);
          }, delayMs));
        }

        // 动画帧循环推进 engine
        let lastMs = performance.now();
        const tick = () => {
          if (stopped) return;
          const nowMs = performance.now();
          const delta = (nowMs - lastMs) / 1000;
          lastMs = nowMs;
          const wallTimeSec = (nowMs - base) / 1000;
          engine.processFrame(delta, wallTimeSec);
          if (!engine.stopped) {
            raf = requestAnimationFrame(tick);
          }
        };
        raf = requestAnimationFrame(tick);

        return {
          stop: () => {
            stopped = true;
            if (raf) cancelAnimationFrame(raf);
            for (const id of timers) clearTimeout(id);
            engine.stop();
            releaseAllPiano();
          },
          isPlaying: () => !stopped,
        };
      }
