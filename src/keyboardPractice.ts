import type { Midi } from '@tonejs/midi';
import type { KeyboardFallingState, NoteState } from './fallingNotes';
import { assignHandForNote, type FlatNote, type Hand } from './midiScore';
import { applyKeyVisuals } from './pianoKeyboard';
import type { PlaybackController } from './playback';
import { playPianoMidi, releaseAllPiano, startPianoNote, releasePianoNote } from './salamanderPiano';
import { ScoringEngine, type ScoreState } from './scoring';

const LOG_STORAGE_KEY = 'midi-piano-logs';

/** 写日志：同时输出到 console、localStorage，并通过 POST 实时写入本地文件 */
function midiLog(msg: string) {
  console.log(msg);
  // 实时写入本地文件（通过 Vite 开发服务器中间件）
  try {
    navigator.sendBeacon('/api/log', msg + '\n');
  } catch { /* sendBeacon 失败时静默忽略 */ }
  // 同时保留 localStorage 备份
  try {
    const prev = localStorage.getItem(LOG_STORAGE_KEY) || '';
    const updated = prev + msg + '\n';
    if (updated.length > 500_000) {
      localStorage.setItem(LOG_STORAGE_KEY, updated.slice(-400_000));
    } else {
      localStorage.setItem(LOG_STORAGE_KEY, updated);
    }
  } catch { /* localStorage 不可用时静默忽略 */ }
}

/** 开始新弹奏 → 创建新日志文件并清除 localStorage 备份 */
export async function resetLogFile() {
  // 清除本地备份
  try { localStorage.removeItem(LOG_STORAGE_KEY); } catch {}
  // 让服务端创建新文件
  try {
    await fetch('/api/log/new', { method: 'POST' });
  } catch { /* 静默忽略 */ }
}

/** 获取日志文件路径 */
export async function getLogFilePath(): Promise<string> {
  try {
    const res = await fetch('/api/log/file');
    const data = await res.json();
    return data.path || '';
  } catch {
    return '';
  }
}

/** 下载日志为 .txt 文件 */
export function downloadMidiLogs() {
  try {
    const content = localStorage.getItem(LOG_STORAGE_KEY) || '';
    if (!content) {
      console.warn('[MIDI] 无日志可下载');
      return;
    }
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    const now = new Date();
    const ts = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}_${String(now.getHours()).padStart(2, '0')}-${String(now.getMinutes()).padStart(2, '0')}-${String(now.getSeconds()).padStart(2, '0')}`;
    a.download = `midi-log_${ts}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    localStorage.removeItem(LOG_STORAGE_KEY);
  } catch {
    console.error('[MIDI] 下载日志失败');
  }
}

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
  // 每次弹奏创建新的日志文件
  resetLogFile();

  let stopped = false;
  const pressedMidis = new Set<number>();
  /** 跟弹模式下已起音但尚未释音的音符（松开键盘时需调用 releasePianoNote） */
  const sustainedNotes = new Set<number>();
  /** 已被命中消费掉的琴键按下事件（同音符重复出现时需松开再按才能通过） */
  const consumedPresses = new Set<number>();
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
        if (ns.isHit || missedNotes.has(noteStates.indexOf(ns))) continue;
        // 键没按住 → 暂停等待
        // 或者键被之前的同音已消费 → 暂停等待松开再按
        if (!pressedMidis.has(ns.note.midi) || consumedPresses.has(ns.note.midi)) {
          if (consumedPresses.has(ns.note.midi)) {
            midiLog(`[MIDI] 跟弹暂停  note=${ns.note.midi} (已消费，等松开再按)  期望时间=${ns.note.time.toFixed(3)}s  游戏时间=${accumulatedTimeSec.toFixed(3)}s  consumed=[${[...consumedPresses].join(',')}]`);
          }
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
      const wallTimeSec = (performance.now() - startWallTimeMs) / 1000;
      for (const ns of noteStates) {
        if (!ns.isHit && !missedNotes.has(noteStates.indexOf(ns))) {
          // 跟弹模式：和弦中已有其他音被命中时，取已命中音的最大命中墙上时间作为参考起点
          // （防止用整个练习开始时的 wallTime 导致立即 MISS）
          let siblingMaxHit = -1;
          if (!freePlay) {
            for (const other of noteStates) {
              if (other !== ns && Math.abs(other.note.time - ns.note.time) < 0.001 && other.isHit && other.hitTimeSec !== null) {
                siblingMaxHit = Math.max(siblingMaxHit, other.hitTimeSec);
              }
            }
          }
          const refSec = freePlay
            ? effectiveTimeSec
            : (siblingMaxHit >= 0 ? Math.max(effectiveTimeSec, siblingMaxHit) : effectiveTimeSec);
          const offsetMs = (refSec - ns.note.time) * 1000;
          if (offsetMs > hitWindowMs) {
            midiLog(
              `[MIDI] MISS  note=${ns.note.midi}  期望时间=${ns.note.time.toFixed(3)}s  偏移=${offsetMs.toFixed(0)}ms  |  游戏时间=${effectiveTimeSec.toFixed(3)}s  墙上时间=${wallTimeSec.toFixed(3)}s  |  siblingMaxHit=${siblingMaxHit >= 0 ? siblingMaxHit.toFixed(3) : '无'}`
            );
            missedNotes.add(noteStates.indexOf(ns));
            ns.isHit = true;
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
        midiLog(`[MIDI] 所有音符时间已过，自动结束。游戏时间=${effectiveTimeSec.toFixed(3)}s`);
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

    const nowMs = performance.now();
    const wallTimeSec = (nowMs - startWallTimeMs) / 1000;
    const gameSec = getEffectiveTimeSec();
    const modeLabel = freePlay ? '普通' : '跟弹';

    const keyEv = parseMidiKey(data);
    if (keyEv && keyEls.has(keyEv.note)) {
      if (keyEv.down) {
        pressedMidis.add(keyEv.note);
        const wasConsumed = consumedPresses.has(keyEv.note);
        consumedPresses.delete(keyEv.note);
        midiLog(
          `[MIDI] 按下  note=${keyEv.note}  |  游戏时间=${gameSec.toFixed(3)}s  墙上时间=${wallTimeSec.toFixed(3)}s  |  模式=${modeLabel}  |  当前按住键: [${[...pressedMidis].join(',')}]  |  consumed=[${[...consumedPresses].join(',')}]  wasConsumed=${wasConsumed}`
        );
      } else {
        pressedMidis.delete(keyEv.note);
        consumedPresses.delete(keyEv.note);
        midiLog(
          `[MIDI] 松开  note=${keyEv.note}  |  游戏时间=${gameSec.toFixed(3)}s  墙上时间=${wallTimeSec.toFixed(3)}s  |  模式=${modeLabel}  |  当前按住键: [${[...pressedMidis].join(',')}]  |  sustained: [${[...sustainedNotes].join(',')}]  |  consumed=[${[...consumedPresses].join(',')}]`
        );
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

    // 跟弹模式：和弦已有音命中时，用相邻音的墙上命中时间差判定，避免空等
    const nowSec = freePlay ? gameSec : Math.max(gameSec, wallTimeSec);

    const matchingStates = noteStates.filter(
      (ns) => {
        if (ns.note.midi !== noteEv.note || ns.isHit || missedNotes.has(noteStates.indexOf(ns))) return false;
        // 找和弦中已命中音的最大墙上命中时间
        let siblingHitWall = -1;
        for (const other of noteStates) {
          if (other !== ns && Math.abs(other.note.time - ns.note.time) < 0.001 && other.isHit && other.hitTimeSec !== null) {
            siblingHitWall = Math.max(siblingHitWall, other.hitTimeSec);
          }
        }
        if (freePlay) {
          return Math.abs(ns.note.time - gameSec) < hitWindowSec;
        } else if (siblingHitWall >= 0) {
          // 和弦中已有音命中：用当前按下的墙上时间 与 相邻音的墙上命中时间 之差判定
          return Math.abs(wallTimeSec - siblingHitWall) < hitWindowSec;
        } else {
          return Math.abs(ns.note.time - gameSec) < hitWindowSec;
        }
      }
    );

    if (matchingStates.length === 0) {
      const noteIdx = noteStates.findIndex(ns => ns.note.midi === noteEv.note && !ns.isHit && !missedNotes.has(noteStates.indexOf(ns)));
      const closestTime = noteIdx >= 0 ? noteStates[noteIdx].note.time.toFixed(3) : '无';
      midiLog(
        `[MIDI] 错音  note=${noteEv.note}  vel=${noteEv.velocity.toFixed(3)}  |  游戏时间=${gameSec.toFixed(3)}s  墙上时间=${wallTimeSec.toFixed(3)}s  最近未命中音符时间=${closestTime}s  |  窗口=${hitWindowMs}ms  |  模式=${modeLabel}`
      );
      // 错音：弹响但不计分（用固定短时长，不与跟弹关联）
      playPianoMidi(noteEv.note, 0.3, noteEv.velocity);
      if (scoring) {
        scoring.wrongKey(noteEv.note, nowSec);
        onScoreUpdate?.(scoring.getState());
      }
      return;
    }

    for (const ns of matchingStates) {
      const offsetMs = (nowSec - ns.note.time) * 1000;
      ns.isHit = true;
      ns.hitTimeSec = nowSec;
      consumedPresses.add(ns.note.midi);
      midiLog(
        `[MIDI] 命中  note=${ns.note.midi}  期望时间=${ns.note.time.toFixed(3)}s  偏差=${offsetMs.toFixed(1)}ms  |  游戏时间=${gameSec.toFixed(3)}s  墙上时间=${wallTimeSec.toFixed(3)}s  |  模式=${modeLabel}  |  consumed=[${[...consumedPresses].join(',')}]`
      );
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
      midiLog(`[MIDI] 所有音符已弹完，即将结束。游戏时间=${nowSec.toFixed(3)}s`);
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
    getLogs: () => {
      try { return localStorage.getItem(LOG_STORAGE_KEY) || ''; }
      catch { return ''; }
    },
    downloadLogs: () => downloadMidiLogs(),
  };
}
