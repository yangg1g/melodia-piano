import type { Midi } from '@tonejs/midi';
import type { KeyboardFallingState } from '../rendering/fallingNotes';
import { assignHandForNote, type FlatNote } from '../core/midiScore';
import { applyKeyVisuals } from '../rendering/pianoKeyboard';
import type { PlaybackController } from './playback';
import { playPianoMidi, releaseAllPiano, startPianoNote, releasePianoNote } from '../audio/salamanderPiano';
import { ScoringEngine, type ScoreState } from '../core/scoring';
import { MidiMatchEngine, type MidiMatchCallbacks } from '../core/midiMatchEngine';

const LOG_STORAGE_KEY = 'midi-piano-logs';

/** 写日志：同时输出到 console、localStorage，并通过 POST 实时写入本地文件 */
function midiLog(msg: string) {
  console.log(msg);
  try {
    navigator.sendBeacon('/api/log', msg + '\n');
  } catch { /* sendBeacon 失败时静默忽略 */ }
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
  try { localStorage.removeItem(LOG_STORAGE_KEY); } catch {}
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
  freePlay = false,
  speedMultiplier = 1,
  onWallTimeSec?: (wallSec: number) => void,
): PlaybackController {
  // 每次弹奏创建新的日志文件
  resetLogFile();
  midiLog(`[MIDI] ========================================`);
  midiLog(`[MIDI] 开始弹奏: ${midiFile.name}`);
  midiLog(`[MIDI] ========================================`);

  const startWallTimeMs = performance.now();
  const hitWindowMs = scoring ? scoring.windows.ok : 180;

  let animFrameId = 0;
  let lastFrameTimeMs = performance.now();

  // 构建回调
  const callbacks: MidiMatchCallbacks = {
    log: midiLog,

    onNoteStart(midi, velocity) {
      startPianoNote(midi, velocity);
    },
    onNoteRelease(midi) {
      releasePianoNote(midi);
    },
    onWrongKey(midi, velocity) {
      playPianoMidi(midi, 0.3, velocity);
    },

    onVisualUpdate(expected, pressed) {
      applyKeyVisuals(keyEls, { expected, active: undefined, pressed });
    },
    onPaintState(notes, effectiveTimeSec) {
      onPracticePaint?.({ notes, currentTimeSec: effectiveTimeSec });
    },

    onTimeSec,
    onWallTimeSec,

    onEnded() {
      releaseAllPiano();
      onEnded?.();
    },

    onScoreUpdate() {
      if (scoring) onScoreUpdate?.(scoring.getState());
    },
  };

  // 创建匹配引擎
  const engine = new MidiMatchEngine(flatNotes, callbacks, {
    freePlay,
    speedMultiplier,
    hitWindowMs,
    perfectMs: scoring?.windows.perfect ?? 25,
    scoring,
    getHandForNote: (note) => assignHandForNote(note, midiFile),
    startWallTimeMs,
  });

  // 动画帧循环
  const scheduleAnimFrame = () => {
    if (animFrameId) return;
    animFrameId = requestAnimationFrame(() => {
      animFrameId = 0;
      if (!engine.stopped) {
        paint();
        scheduleAnimFrame();
      }
    });
  };

  const paint = () => {
    const nowMs = performance.now();
    const deltaSec = (nowMs - lastFrameTimeMs) / 1000;
    lastFrameTimeMs = nowMs;
    const wallTimeSec = (nowMs - startWallTimeMs) / 1000;

    engine.processFrame(deltaSec, wallTimeSec);

    // 引擎可能通过 setTimeout 调用 stop
    if (engine.stopped && animFrameId) {
      cancelAnimationFrame(animFrameId);
      animFrameId = 0;
    }
  };

  // MIDI 输入处理
  const onMidi = (ev: MIDIMessageEvent) => {
    if (engine.stopped) return;
    const data = ev.data;
    if (!data || data.length < 3) return;

    const wallTimeSec = (performance.now() - startWallTimeMs) / 1000;
    engine.processMidiEvent(data, wallTimeSec);

    // processMidiEvent 可能通过 setTimeout 设 stop
    if (engine.stopped && animFrameId) {
      cancelAnimationFrame(animFrameId);
      animFrameId = 0;
    }
  };

  midiInput.onmidimessage = onMidi;
  paint();
  scheduleAnimFrame();

  return {
    stop: () => {
      if (engine.stopped) return;
      midiInput.onmidimessage = null;
      if (animFrameId) {
        cancelAnimationFrame(animFrameId);
        animFrameId = 0;
      }
      engine.stop();
    },
    isPlaying: () => !engine.stopped,
    getLogs: () => {
      try { return localStorage.getItem(LOG_STORAGE_KEY) || ''; }
      catch { return ''; }
    },
    downloadLogs: () => downloadMidiLogs(),
  };
}
