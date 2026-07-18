import type { Midi } from '@tonejs/midi';
import type { KeyboardFallingState, NoteState } from './fallingNotes';
import { assignHandForNote, type FlatNote, type Hand } from './midiScore';
import { applyKeyVisuals } from './pianoKeyboard';
import type { PlaybackController } from './playback';
import { playPianoMidi, releaseAllPiano, startPianoNote, releasePianoNote } from './salamanderPiano';
import { ScoringEngine, type ScoreState } from './scoring';

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

function parseNoteOn(data: Uint8Array): { note: number; velocity: number } | null {
  const st = data[0];
  if (st >= 0x90 && st < 0xa0) {
    const vel = data[2];
    if (vel > 0) return { note: data[1], velocity: vel / 127 };
  }
  return null;
}

export function startKeyboardPractice(
  flatNotes: FlatNote[],
  midiFile: Midi,
  keyEls: Map<number, HTMLElement>,
  midiInput: MIDIInput,
  onEnded?: () => void,
  onTimeSec?: (sec: number) => void,
  onPracticePaint?: (state: KeyboardFallingState) => void,
  scoring?: ScoringEngine,
  onScoreUpdate?: (state: ScoreState) => void,
  /** true = 时间自动前进（普通模式），false = 等待用户弹奏（跟弹模式） */
  freePlay = false,
  speedMultiplier = 1,
  /** 跟弹模式：回调当前已流逝的真实时间（秒） */
  onWallTimeSec?: (wallSec: number) => void,
): PlaybackController {
  let stopped = false;
  const pressedMidis = new Set<number>();
  /** 跟弹模式下已起音但尚未释音的音符（松开键盘时需调用 releasePianoNote） */
  const sustainedNotes = new Set<number>();
  let animFrameId = 0;
  let finishScheduled = false;
  /** 跟弹模式：开始时的真实时间戳（用于统计用户实际用时） */
  const startWallTimeMs = performance.now();

  const firstNoteTime = flatNotes.length > 0
    ? Math.min(...flatNotes.map((n) => n.time))
    : 0;

  let accumulatedTimeSec = firstNoteTime - 1.5;
  let lastFrameTimeMs = performance.now();

  const noteStates: NoteState[] = flatNotes.map((note) => ({
    note,
    isHit: false,
    hitTimeSec: null,
  }));

  const clearPendingUi = () => {};

  const RELEASE_GRACE_SEC = 0.1;

  /** 判定窗口（毫秒），使用 ScoringEngine 的 ok 窗口 */
  const hitWindowMs = scoring ? scoring.windows.ok : 180;
  const hitWindowSec = hitWindowMs / 1000;

  /** 用于标记已放过 Miss 的音符 */
  const missedNotes = new Set<number>();

  const getEffectiveTimeSec = (): number => accumulatedTimeSec;

  const updateAccumulatedTime = (): boolean => {
    const nowMs = performance.now();
    const deltaTimeSec = (nowMs - lastFrameTimeMs) / 1000;
    lastFrameTimeMs = nowMs;

    if (freePlay || flatNotes.length === 0) {
      // 普通模式：时间一直前进（乘以速度倍率）
      accumulatedTimeSec += deltaTimeSec * speedMultiplier;
      return false;
    }

    for (const ns of noteStates) {
      const noteEnd = ns.note.time + Math.max(0, ns.note.duration);
      if (accumulatedTimeSec >= ns.note.time && accumulatedTimeSec < noteEnd - RELEASE_GRACE_SEC) {
        // 已弹过的音符不再等待按键（松开后时间继续前进）
        if (!ns.isHit && !pressedMidis.has(ns.note.midi)) {
          return true;
        }
      }
    }

    accumulatedTimeSec += deltaTimeSec * speedMultiplier;
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

    // Miss 检测：已过判定窗口但未命中的音符
    if (scoring) {
      for (const ns of noteStates) {
        if (!ns.isHit && !missedNotes.has(noteStates.indexOf(ns))) {
          const offsetMs = (effectiveTimeSec - ns.note.time) * 1000;
          if (offsetMs > hitWindowMs) {
            missedNotes.add(noteStates.indexOf(ns));
            scoring.miss(ns.note.midi, ns.note.time);
            onScoreUpdate?.(scoring.getState());
          }
        }
      }
    }

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

    // 所有音符结束后自动结束（防止 freePlay 模式下无人按键永远不触发 finish）
    if (!finishScheduled && flatNotes.length > 0) {
      const allDone = noteStates.every((ns) => {
        return ns.note.time + Math.max(0, ns.note.duration) < effectiveTimeSec;
      });
      if (allDone) {
        finishScheduled = true;
        setTimeout(() => finish(), 500);
        return;
      }
    }

    onTimeSec?.(effectiveTimeSec);
    onWallTimeSec?.((performance.now() - startWallTimeMs) / 1000);
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
    sustainedNotes.clear();
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
      if (keyEv.down) {
        pressedMidis.add(keyEv.note);
      } else {
        pressedMidis.delete(keyEv.note);
        // 松开琴键 → 停止该音符的发声
        if (sustainedNotes.has(keyEv.note)) {
          sustainedNotes.delete(keyEv.note);
          releasePianoNote(keyEv.note);
        }
      }
      paint();
    }

    const noteEv = parseNoteOn(data);
    if (noteEv === null) return;

    const nowSec = getEffectiveTimeSec();

    const matchingStates = noteStates.filter(
      (ns) => ns.note.midi === noteEv.note && !ns.isHit && Math.abs(ns.note.time - nowSec) < hitWindowSec
    );

    if (matchingStates.length === 0) {
      // 错音：弹响但不计分（用固定短时长，不与跟弹关联）
      playPianoMidi(noteEv.note, 0.3, noteEv.velocity);
      if (scoring) {
        scoring.wrongKey(noteEv.note, nowSec);
        onScoreUpdate?.(scoring.getState());
      }
      return;
    }

    for (const ns of matchingStates) {
      ns.isHit = true;
      ns.hitTimeSec = nowSec;
      // 跟弹模式：按下起音，松开后由上面的 Note Off 分支调用 releasePianoNote 停止
      startPianoNote(ns.note.midi, noteEv.velocity);
      sustainedNotes.add(ns.note.midi);

      if (scoring) {
        const hitOffsetMs = (nowSec - ns.note.time) * 1000;
        scoring.hit(hitOffsetMs, ns.note.midi, ns.note.time);
        onScoreUpdate?.(scoring.getState());
      }
    }

    paint();

    const allDone = noteStates.every((ns) => {
      return ns.note.time + Math.max(0, ns.note.duration) < nowSec;
    });

    if (allDone && flatNotes.length > 0) {
      finishScheduled = true;
      setTimeout(() => finish(), 500);
    }
  };

  if (scoring) {
    scoring.reset({ totalNotes: flatNotes.length });
    onScoreUpdate?.(scoring.getState());
  }

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
      sustainedNotes.clear();
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
