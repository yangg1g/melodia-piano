import type { Midi } from '@tonejs/midi';
import type { KeyboardFallingState, NoteState } from './fallingNotes';
import { assignHandForNote, type FlatNote, type Hand } from './midiScore';
import { applyKeyVisuals } from './pianoKeyboard';
import type { PlaybackController } from './playback';
import { playPianoMidi, releaseAllPiano } from './salamanderPiano';

function parseMidiKey(data: Uint8Array): { note: number; down: boolean } | null {
  const st = data[0];
  if (st >= 0x90 && st < 0xa0) {
    const vel = data[2];
    return { note: data[1], down: vel > 0 };
  }
  if (st >= 0x80 && st < 0x90) {
    return { note: data[1], down: false };
  }
  return null;
}

function parseNoteOn(data: Uint8Array): number | null {
  const st = data[0];
  if (st >= 0x90 && st < 0xa0) {
    const vel = data[2];
    if (vel > 0) return data[1];
  }
  return null;
}

/**
 * 所有音符同时加载、同时计时；弹对后记录击中时间。
 */
export function startKeyboardPractice(
  flatNotes: FlatNote[],
  midiFile: Midi,
  keyEls: Map<number, HTMLElement>,
  midiInput: MIDIInput,
  onEnded?: () => void,
  onTimeSec?: (sec: number) => void,
  onPracticePaint?: (state: KeyboardFallingState) => void,
): PlaybackController {
  let stopped = false;
  const pressedMidis = new Set<number>();
  let animFrameId = 0;

  /** 时间轴基准：所有音符中最早的 time */
  const firstNoteTime = flatNotes.length > 0
    ? Math.min(...flatNotes.map((n) => n.time))
    : 0;

  /** 累加器：当前有效时间（从第一个音符前1.5秒开始） */
  let accumulatedTimeSec = firstNoteTime - 1.5;
  /** 上一帧的时间戳，用于计算帧间隔 */
  let lastFrameTimeMs = performance.now();

  /** 每个音符的状态 */
  const noteStates: NoteState[] = flatNotes.map((note) => ({
    note,
    isHit: false,
    hitTimeSec: null,
  }));

  const clearPendingUi = () => {};

  const RELEASE_GRACE_SEC = 0.1;

  /**
   * 获取当前有效时间（累加器模式）
   */
  const getEffectiveTimeSec = (): number => {
    return accumulatedTimeSec;
  };

  /**
   * 更新累加器时间：
   * - 如果有音符卡住（已过 hit 时间但未弹对），检查按键状态
   * - 卡住的音符必须保持按下对应 MIDI 键，否则时间暂停
   */
  const updateAccumulatedTime = (): boolean => {
    const nowMs = performance.now();
    const deltaTimeSec = (nowMs - lastFrameTimeMs) / 1000;
    lastFrameTimeMs = nowMs;

    if (flatNotes.length === 0) {
      accumulatedTimeSec += deltaTimeSec;
      return false;
    }

    for (const ns of noteStates) {
      const noteEnd = ns.note.time + Math.max(0, ns.note.duration);
      if (accumulatedTimeSec >= ns.note.time && accumulatedTimeSec < noteEnd - RELEASE_GRACE_SEC) {
        if (!pressedMidis.has(ns.note.midi)) {
          return true;
        }
      }
    }

    accumulatedTimeSec += deltaTimeSec;
    return false;
  };

  const scheduleAnimFrame = () => {
    if (animFrameId) return;
    animFrameId = requestAnimationFrame(() => {
      animFrameId = 0;
      if (!stopped) {
        paint();
        scheduleAnimFrame();
      }
    });
  };

  const paint = () => {
    updateAccumulatedTime();
    const effectiveTimeSec = getEffectiveTimeSec();

    const expected = new Map<number, Hand>();
    for (const ns of noteStates) {
      if (effectiveTimeSec >= ns.note.time && effectiveTimeSec < ns.note.time + Math.max(0, ns.note.duration) - RELEASE_GRACE_SEC) {
        expected.set(ns.note.midi, assignHandForNote(ns.note, midiFile));
      }
    }

    applyKeyVisuals(keyEls, {
      expected,
      active: undefined,
      pressed: pressedMidis,
    });

    onPracticePaint?.({
      notes: noteStates,
      currentTimeSec: effectiveTimeSec,
    });

    onTimeSec?.(effectiveTimeSec);
  };

  const finish = () => {
    if (stopped) return;
    clearPendingUi();
    stopped = true;
    if (animFrameId) {
      cancelAnimationFrame(animFrameId);
      animFrameId = 0;
    }
    midiInput.onmidimessage = null;
    pressedMidis.clear();
    applyKeyVisuals(keyEls, {});
    onPracticePaint?.({
      notes: noteStates,
      currentTimeSec: getEffectiveTimeSec(),
    });
    releaseAllPiano();
    onEnded?.();
  };

  const onMidi = (ev: MIDIMessageEvent) => {
    if (stopped) return;
    const data = ev.data;
    if (!data || data.length < 3) return;

    const keyEv = parseMidiKey(data);
    if (keyEv && keyEls.has(keyEv.note)) {
      if (keyEv.down) pressedMidis.add(keyEv.note);
      else pressedMidis.delete(keyEv.note);
      paint();
    }

    const note = parseNoteOn(data);
    if (note === null) return;

    const nowSec = getEffectiveTimeSec();

    const matchingStates = noteStates.filter(
      (ns) => ns.note.midi === note && !ns.isHit && Math.abs(ns.note.time - nowSec) < 0.15
    );

    if (matchingStates.length === 0) {
      playPianoMidi(note, 0.3, 0.6);
      return;
    }

    for (const ns of matchingStates) {
      ns.isHit = true;
      ns.hitTimeSec = nowSec;
      playPianoMidi(ns.note.midi, Math.max(0, ns.note.duration), 0.82);
    }

    paint();

    const allDone = noteStates.every((ns) => {
      return ns.note.time + Math.max(0, ns.note.duration) < nowSec;
    });

    if (allDone && flatNotes.length > 0) {
      setTimeout(() => finish(), 500);
    }
  };

  midiInput.onmidimessage = onMidi;
  paint();
  scheduleAnimFrame();

  return {
    stop: () => {
      if (stopped) return;
      clearPendingUi();
      stopped = true;
      if (animFrameId) {
        cancelAnimationFrame(animFrameId);
        animFrameId = 0;
      }
      midiInput.onmidimessage = null;
      pressedMidis.clear();
      applyKeyVisuals(keyEls, {});
      onPracticePaint?.({
        notes: noteStates,
        currentTimeSec: getEffectiveTimeSec(),
      });
      releaseAllPiano();
    },
    isPlaying: () => !stopped,
  };
}
