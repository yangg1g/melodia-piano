/**
 * MIDI 乐谱与键盘 —— 入口
 *
 * 项目结构：
 *   core/       — 核心领域逻辑（MIDI 数据结构、计分、匹配引擎、音高工具）
 *   audio/      — 音频引擎
 *   rendering/  — 视觉渲染（钢琴键盘、下落音符、五线谱渲染）
 *   features/   — 功能模块（自动播放、键盘练习、编辑、示例 MIDI）
 *   ui/         — 页面与组件（设置、历史、结算、选歌、MIDI 管理、练习控制、钢琴页编排）
 */
import './style.css';
import type { Midi } from '@tonejs/midi';
import type { SongDataJson } from './core/types';

import type { AppSettings } from './core/types';
import { DIFFICULTY_WINDOWS } from './core/types';
import { createFallingNotesLane } from './rendering/fallingNotes';
import { flattenNotes } from './core/midiScore';
import { createMidiFromJson } from './core/midiScore';
import { loadSettings, saveSettings, applySettings, applySettingsToUI, collectSettingsFromUI } from './ui/settings';
import { MidiSetup } from './ui/midiSetup';
import { fetchSongList, updateHistoryPanel, refreshSongBest, startPreview, stopPreview } from './ui/songList';
import { PianoPage } from './ui/pianoPage';
import { formatTime } from './ui/progressBar';
import { hideResultScreen, showResultScreen } from './ui/resultScreen';
import { startMidiReplay } from './features/playback';
import { showConfirm } from './ui/confirmDialog';
import { downloadMidiLogs } from './features/keyboardPractice';
import { getBestForSong } from './ui/history';
import { appTemplate } from './ui/appTemplate';

/* ═══════════════════ DOM 结构 ═══════════════════ */

const app = document.querySelector<HTMLDivElement>('#app')!;

app.innerHTML = appTemplate;

/* ═══════════════════ DOM 引用 ═══════════════════ */

const songListPage = document.querySelector<HTMLDivElement>('#song-list-page')!;
const pianoPageEl = document.querySelector<HTMLDivElement>('#piano-page')!;
const settingsPage = document.querySelector<HTMLDivElement>('#settings-page')!;

const songList = document.querySelector<HTMLDivElement>('#song-list')!;
const fileInput = document.querySelector<HTMLInputElement>('#midi-file')!;
const historyList = document.querySelector<HTMLDivElement>('#history-list')!;
const btnSongPractice = document.querySelector<HTMLButtonElement>('#btn-song-practice')!;

const scoreEl = document.querySelector<HTMLDivElement>('#score')!;
const scoreScrollEl = document.querySelector<HTMLDivElement>('#score-scroll')!;
const scorePagerEl = document.querySelector<HTMLDivElement>('#score-pager')!;
const keyboardHost = document.querySelector<HTMLDivElement>('#keyboard-host')!;
const keyboardStack = document.querySelector<HTMLDivElement>('#keyboard-stack')!;
const centerJudgeEl = document.querySelector<HTMLDivElement>('#center-judge')!;
const keyboardHint = document.querySelector<HTMLParagraphElement>('#keyboard-hint')!;
const chordDisplay = document.querySelector<HTMLDivElement>('#chord-display')!;
const chordDisplayNotes = document.querySelector<HTMLSpanElement>('#chord-display-notes')!;
const chordDisplayChord = document.querySelector<HTMLSpanElement>('#chord-display-chord')!;
const measureInfoEl = document.querySelector<HTMLSpanElement>('#measure-info')!;
const progressBar = document.querySelector<HTMLInputElement>('#progress-bar')!;
const progressTime = document.querySelector<HTMLSpanElement>('#progress-time')!;
const practiceTime = document.querySelector<HTMLSpanElement>('#practice-time')!;
const scoreDisplay = document.querySelector<HTMLDivElement>('#score-display')!;
const liveAccuracyPanel = document.querySelector<HTMLDivElement>('#live-accuracy-panel')!;
const liveAccuracyCanvas = document.querySelector<HTMLCanvasElement>('#live-accuracy-canvas')!;
const liveTimelineCanvas = document.querySelector<HTMLCanvasElement>('#live-timeline-canvas')!;
const liveErrorCanvas = document.querySelector<HTMLCanvasElement>('#live-error-canvas')!;
const liveTimeRatioSection = document.querySelector<HTMLDivElement>('#live-time-ratio-section')!;
const liveTimeRatioCanvas = document.querySelector<HTMLCanvasElement>('#live-time-ratio-canvas')!;
const scoreValueEl = document.querySelector<HTMLSpanElement>('#score-value')!;
const scoreAccuEl = document.querySelector<HTMLSpanElement>('#score-accu')!;
const scoreComboEl = document.querySelector<HTMLSpanElement>('#score-combo')!;
const scoreJudgeEl = document.querySelector<HTMLSpanElement>('#score-judge')!;
const scoreWrongEl = document.querySelector<HTMLSpanElement>('#score-wrong')!;

const btnPlay = document.querySelector<HTMLButtonElement>('#btn-play')!;
const btnStop = document.querySelector<HTMLButtonElement>('#btn-stop')!;
const btnEdit = document.querySelector<HTMLButtonElement>('#btn-edit')!;
const btnFinger = document.querySelector<HTMLButtonElement>('#btn-finger')!;
const btnSlur = document.querySelector<HTMLButtonElement>('#btn-slur')!;
const btnTie = document.querySelector<HTMLButtonElement>('#btn-tie')!;
const btnStem = document.querySelector<HTMLButtonElement>('#btn-stem')!;
const btnSaveEdits = document.querySelector<HTMLButtonElement>('#btn-save-edits')!;
const editToolbar = document.querySelector<HTMLDivElement>('.edit-toolbar')!;

const settingsBtn = document.querySelector<HTMLButtonElement>('#settings-btn')!;
const settingsBackBtn = document.querySelector<HTMLButtonElement>('#settings-back-btn')!;
const settingsFallingSpeed = document.querySelector<HTMLInputElement>('#settings-falling-speed')!;
const settingsFallingSpeedVal = document.querySelector<HTMLSpanElement>('#settings-falling-speed-val')!;
const settingsPlaybackSpeed = document.querySelector<HTMLInputElement>('#settings-playback-speed')!;
const settingsPlaybackSpeedVal = document.querySelector<HTMLSpanElement>('#settings-playback-speed-val')!;
const settingsMeasureWidth = document.querySelector<HTMLInputElement>('#settings-measure-width')!;
const settingsMeasureWidthVal = document.querySelector<HTMLSpanElement>('#settings-measure-width-val')!;
const settingsDifficultyInfo = document.querySelector<HTMLSpanElement>('#settings-difficulty-info')!;
const settingsOffsetAdjust = document.querySelector<HTMLInputElement>('#settings-offset-adjust')!;
const settingsOffsetAdjustVal = document.querySelector<HTMLSpanElement>('#settings-offset-adjust-val')!;
const settingsChordLangRadios = document.querySelectorAll<HTMLInputElement>('input[name="settings-chord-lang"]')!;
const settingsSummaryEl = document.querySelector<HTMLDivElement>('#settings-summary')!;

const songListMidiSelect = document.querySelector<HTMLSelectElement>('#song-list-midi-input')!;
const songListMidiRefresh = document.querySelector<HTMLButtonElement>('#song-list-midi-refresh')!;
const songListMidiStatus = document.querySelector<HTMLSpanElement>('#song-list-midi-status')!;

const midiInputSelect = document.querySelector<HTMLSelectElement>('#midi-input')!;
const btnMidiRefresh = document.querySelector<HTMLButtonElement>('#btn-midi-refresh')!;

const resultOverlay = document.querySelector<HTMLDivElement>('#result-overlay')!;

const resultBackBtn = document.querySelector<HTMLButtonElement>('#result-back-btn')!;
const resultReplayBtn = document.querySelector<HTMLButtonElement>('#result-replay-btn')!;

const btnBack = document.querySelector<HTMLButtonElement>('#btn-back')!;
const btnDownloadLog = document.querySelector<HTMLButtonElement>('#btn-download-log')!;

const confirmDialogEl = document.querySelector<HTMLDivElement>('#confirm-dialog')!;
const confirmDialogMsgEl = document.querySelector<HTMLParagraphElement>('#confirm-dialog-msg')!;
const confirmDialogOkEl = document.querySelector<HTMLButtonElement>('#confirm-dialog-ok')!;
const confirmDialogCancelEl = document.querySelector<HTMLButtonElement>('#confirm-dialog-cancel')!;

/* ═══════════════════ 初始化组件 ═══════════════════ */

const fallingNotes = createFallingNotesLane(keyboardStack);

const midiSetup = new MidiSetup({
  pianoSelect: midiInputSelect,
  pianoRefresh: btnMidiRefresh,
  songListSelect: songListMidiSelect,
  songListRefresh: songListMidiRefresh,
  songListStatus: songListMidiStatus,
});

const resultElements = {
  page: document.querySelector<HTMLDivElement>('#result-page')!,
  overlay: resultOverlay,
  scoreEl: document.querySelector<HTMLSpanElement>('#result-score')!,
  maxScoreEl: document.querySelector<HTMLDivElement>('#result-max-score')!,
  accuracyEl: document.querySelector<HTMLSpanElement>('#result-accuracy')!,
  maxComboEl: document.querySelector<HTMLSpanElement>('#result-maxcombo')!,
  judgePerfect: document.querySelector<HTMLSpanElement>('#judge-perfect')!,
  judgeOk: document.querySelector<HTMLSpanElement>('#judge-ok')!,
  judgeBad: document.querySelector<HTMLSpanElement>('#judge-bad')!,
  judgeMiss: document.querySelector<HTMLSpanElement>('#judge-miss')!,
  judgeWrong: document.querySelector<HTMLSpanElement>('#judge-wrong')!,
  timingSection: document.querySelector<HTMLDivElement>('#result-timing-section')!,
  timingOriginal: document.querySelector<HTMLSpanElement>('#result-timing-original')!,
  timingActual: document.querySelector<HTMLSpanElement>('#result-timing-actual')!,
  timingSlower: document.querySelector<HTMLSpanElement>('#result-timing-slower')!,
  chartCanvas: document.querySelector<HTMLCanvasElement>('#result-chart-canvas')!,
  errorCurveCanvas: document.querySelector<HTMLCanvasElement>('#result-error-curve-canvas')!,
  accuracyCurveCanvas: document.querySelector<HTMLCanvasElement>('#result-accuracy-curve-canvas')!,
  avgErrorEl: document.querySelector<HTMLSpanElement>('#result-avg-error')!,
  accuracyCurveInfoEl: document.querySelector<HTMLSpanElement>('#result-accuracy-curve-info')!,
  timeRatioSection: document.querySelector<HTMLDivElement>('#result-time-ratio-section')!,
  timeRatioCanvas: document.querySelector<HTMLCanvasElement>('#result-time-ratio-canvas')!,
  timeRatioInfoEl: document.querySelector<HTMLSpanElement>('#result-time-ratio-info')!,
  replayBtn: resultReplayBtn,
};

const pianoPage = new PianoPage({
  pianoPageEl, scoreEl, scoreScrollEl, scorePagerEl, keyboardHost, keyboardStack,
  keyboardHint, chordDisplay, chordDisplayNotes, chordDisplayChord,
  measureInfoEl, progressBar, progressTime, practiceTime, scoreDisplay,
  btnPlay, btnStop, btnEdit, btnFinger, btnSlur, btnTie, btnStem, btnSaveEdits, editToolbar,
  scoreValueEl, scoreAccuEl, scoreComboEl, scoreJudgeEl, scoreWrongEl,
  resultElements, midiSetup, fallingNotes,
  liveAccuracyPanel, liveAccuracyCanvas, liveTimelineCanvas, liveErrorCanvas, centerJudgeEl,
  liveTimeRatioSection, liveTimeRatioCanvas,
});

pianoPage.onGoBack = () => showSongList();

/* ═══════════════════ 曲目/文件加载 ═══════════════════ */

let songFiles: string[] = [];
let selectedIndex = 0;
/** 结算页面是从历史记录打开的（而非弹奏结束），返回时不要刷新列表 */
let resultFromHistory = false;

async function loadSongFile(filename: string): Promise<Midi> {
  const url = `/songs/json/${encodeURIComponent(filename)}`;
  console.log('[loadSong] fetching:', url);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const json: SongDataJson = await res.json();
  console.log('[loadSong] loaded:', json.name, json.noteCount, 'notes');
  return createMidiFromJson(json);
}

/** 加载歌曲元数据（从 JSON 文件读取） */
async function fetchSongMeta(filename: string): Promise<{ starRating: number; noteCount: number; bpm: number } | null> {
  try {
    const res = await fetch(`/songs/json/${encodeURIComponent(filename)}`);
    if (!res.ok) return null;
    const json: SongDataJson = await res.json();
    return {
      starRating: 1,
      noteCount: json.noteCount,
      bpm: json.header.tempos[0]?.bpm ?? 120,
    };
  } catch {
    return null;
  }
}

function renderStars(rating: number): string {
  const full = Math.floor(rating);
  const frac = rating - full;
  let html = '';
  for (let i = 0; i < full; i++) html += '★';
  if (frac >= 0.5) html += '☆';
  if (!html) return '';
  const numeric = rating > 0 ? ` (${rating.toFixed(1)})` : '';
  return `<span class="star-display">${html}${numeric}</span>`;
}

async function goPlaySong(filename: string): Promise<void> {
  stopPreview();
  await new Promise(r => setTimeout(r, 80));
  pianoPage.currentSongFile = filename;
  pianoPage.currentSongName = filename.replace(/\.json$/i, '');
  pianoPage.pianoPageEl.hidden = false;
  songListPage.hidden = true;
  try {
    const midi = await loadSongFile(filename);
    await pianoPage.enterAndPlay(midi);
  } catch (err) {
    console.error('[goPlaySong] error:', err);
    alert(`加载歌曲失败：${filename}`);
  }
}

async function goPractice(filename: string): Promise<void> {
  stopPreview();
  await new Promise(r => setTimeout(r, 80));
  pianoPage.currentSongFile = filename;
  pianoPage.currentSongName = filename.replace(/\.json$/i, '');
  pianoPage.pianoPageEl.hidden = false;
  songListPage.hidden = true;
  try {
    const midi = await loadSongFile(filename);
    await pianoPage.enterPractice(midi);
  } catch (err) {
    console.error('[goPractice] error:', err);
    alert(`加载歌曲失败：${filename}`);
  }
}

/* ═══════════════════ 歌曲列表 ═══════════════════ */

async function refreshSongList(): Promise<void> {
  try {
    songFiles = await fetchSongList();
  } catch {
    songList.innerHTML = '<div class="song-list-empty">无法加载曲目列表</div>';
    return;
  }

  if (songFiles.length === 0) {
    songList.innerHTML = '<div class="song-list-empty">public/songs/ 目录为空，请放入 .mid 文件</div>';
    btnSongPractice.disabled = true;
    return;
  }

  const metas = await Promise.all(songFiles.map(fetchSongMeta));

  songList.innerHTML = '';
  for (let i = 0; i < songFiles.length; i++) {
    const f = songFiles[i];
    const info = metas[i];
    const name = f.replace(/\.json$/i, '');
    const stars = info ? renderStars(info.starRating) : '';
    const meta = info
      ? `<span class="song-list-meta">${info.noteCount} 音符 · ${info.bpm}BPM</span>`
      : '';
    const best = getBestForSong(f);
    const historyHtml = best
      ? `<span class="song-list-history">最佳 <span class="history-score">${best.bestScore.toLocaleString()}</span> · ${(best.bestAccuracy * 100).toFixed(1)}% · ${best.totalPlays} 次</span>`
      : '';

    const item = document.createElement('div');
    item.className = i === selectedIndex ? 'song-list-item selected' : 'song-list-item';
    item.dataset.file = f;
    item.dataset.index = String(i);
    item.innerHTML = `
      <span class="song-list-index">${i + 1}</span>
      <div class="song-list-body-col">
        <span class="song-list-name">${name}</span>
        <span class="song-list-stars">${stars}</span>
        ${meta}
        ${historyHtml}
      </div>
      <span class="song-list-arrow">›</span>
    `;

    item.addEventListener('click', () => {
      const idx = songFiles.indexOf(f);
      if (idx === selectedIndex) {
        goPlaySong(f);
      } else {
        selectSong(idx);
      }
    });

    songList.appendChild(item);
  }

  if (songFiles.length > 0) {
    selectSong(selectedIndex, false);
  }
}

function selectSong(index: number, scroll = true): void {
  index = Math.max(0, Math.min(songFiles.length - 1, index));
  selectedIndex = index;

  for (const item of songList.querySelectorAll<HTMLElement>('.song-list-item')) {
    item.classList.toggle('selected', Number(item.dataset.index) === index);
  }

  const file = songFiles[index];
  if (file) {
    startPreview(file);
    updateHistoryPanel(file, songFiles, historyList, {
      onShowResult: (entry) => {
        resultFromHistory = true;
        // 从历史记录加载回放数据
        if (entry.recordedEvents && entry.recordedEvents.length > 0) {
          pianoPage.lastRecordedEvents = entry.recordedEvents.map(e => ({
            data: new Uint8Array(e.data),
            wallTimeSec: e.wallTimeSec,
          }));
          pianoPage.lastRecordedMode = entry.mode;
          // 确保 MIDI 已加载（回放需要 currentMidi 和 flatNotes）
          if (!pianoPage.currentMidi || pianoPage.currentSongFile !== entry.songFile) {
            loadSongFile(entry.songFile).then(midi => {
              pianoPage.currentSongFile = entry.songFile;
              pianoPage.currentSongName = entry.songName;
              pianoPage.currentMidi = midi;
              pianoPage.flatNotes = flattenNotes(midi);
              pianoPage.totalDurationSec = midi.duration;
            }).catch(() => {});
          }
        } else {
          pianoPage.lastRecordedEvents = [];
          pianoPage.lastRecordedMode = '';
        }
        showResultScreen(entry, pianoPage.scoringEngine.getMaxTheoreticalScore(), resultElements,
          entry.recordedEvents && entry.recordedEvents.length > 0);
        songListPage.hidden = true;
      },
      onShowConfirm: (msg) => showConfirm(msg, {
        dialog: confirmDialogEl,
        msgEl: confirmDialogMsgEl,
        okBtn: confirmDialogOkEl,
        cancelBtn: confirmDialogCancelEl,
      }),
    });
    btnSongPractice.disabled = false;
  }

  if (scroll) {
    const item = songList.querySelector<HTMLElement>(`.song-list-item[data-index="${index}"]`);
    if (item) {
      item.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }
}

/* ── 歌曲列表键盘导航 ── */

document.addEventListener('keydown', (e) => {
  if (songListPage.hidden || songFiles.length === 0) return;

  if (e.key === 'ArrowDown') {
    e.preventDefault();
    selectSong(selectedIndex + 1);
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    selectSong(selectedIndex - 1);
  } else if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    const file = songFiles[selectedIndex];
    if (file) goPlaySong(file);
  }
});

/* ═══════════════════ 页面路由 ═══════════════════ */

function showSongList(): void {
  stopPreview();
  pianoPage.pianoPageEl.hidden = true;
  songListPage.hidden = false;
  pianoPage.stopPlayback();
  refreshSongList();
}

btnBack.addEventListener('click', showSongList);

resultBackBtn.addEventListener('click', () => {
  const wasHistory = resultFromHistory;
  resultFromHistory = false;
  resultReplayBtn.hidden = true;
  hideResultScreen(resultElements);
  pianoPage.scoringEngine.reset();
  pianoPage.pianoPageEl.hidden = true;
  pianoPage.hideScorePlayhead();
  pianoPage.fallingNotes.clear();
  pianoPage.progressBar.value = '0';
  pianoPage.progressTime.textContent = '0:00 / 0:00';
  pianoPage.practiceTime.hidden = true;
  pianoPage.finalWallTimeSec = 0;
  songListPage.hidden = false;
  if (pianoPage.currentSongFile) {
    refreshSongBest(pianoPage.currentSongFile, songList);
  }
  // 历史记录返回：列表还在，只刷新最佳成绩；弹奏返回：重建列表并恢复预览
  if (!wasHistory) {
    refreshSongList();
  }
});

resultReplayBtn.addEventListener('click', () => {
  const events = pianoPage.lastRecordedEvents;
  if (!events || events.length === 0 || !pianoPage.currentMidi) return;
  stopPreview();
  hideResultScreen(resultElements);
  pianoPage.pianoPageEl.hidden = false;
  pianoPage.scoringEngine.reset({ totalNotes: pianoPage.flatNotes.length });
  pianoPage.fallingNotes.clear();
  pianoPage.progressBar.value = '0';
  pianoPage.progressTime.textContent = '0:00 / 0:00';
  pianoPage.btnPlay.disabled = true;
  pianoPage.btnStop.disabled = false;
  pianoPage.scoreDisplay.hidden = false;
  pianoPage.updateKeyboardHint();
  pianoPage.renderAll();
  const isKeyboardMode = pianoPage.lastRecordedMode !== 'auto';
  pianoPage.playback = startMidiReplay(
    events,
    pianoPage.flatNotes,
    pianoPage.currentMidi,
    pianoPage.keyEls,
    pianoPage.scoringEngine,
    !isKeyboardMode,
    (_notes, t) => {
      pianoPage.fallingNotes.update(t);
      pianoPage.updateScorePlayhead(t);
      const pct = pianoPage.totalDurationSec > 0 ? (t / pianoPage.totalDurationSec) * 100 : 0;
      pianoPage.progressBar.value = String(pct);
      pianoPage.progressTime.textContent = `${formatTime(t)} / ${formatTime(pianoPage.totalDurationSec)}`;
    },
    undefined,
    () => {
      pianoPage.btnPlay.disabled = false;
      pianoPage.btnStop.disabled = true;
      pianoPage.hideScorePlayhead();
      pianoPage.fallingNotes.clear();
      pianoPage.progressBar.value = '0';
      pianoPage.progressTime.textContent = '0:00 / 0:00';
      pianoPage.pianoPageEl.hidden = true;
      songListPage.hidden = false;
      refreshSongList();
    },
  );
});

/* ═══════════════════ 设置 ═══════════════════ */

settingsBtn.addEventListener('click', () => {
  const s = loadSettings();
  applySettingsToUI(s, {
    modeRadios: document.querySelectorAll<HTMLInputElement>('input[name="settings-mode"]'),
    fallingSpeed: settingsFallingSpeed,
    fallingSpeedVal: settingsFallingSpeedVal,
    playbackSpeed: settingsPlaybackSpeed,
    playbackSpeedVal: settingsPlaybackSpeedVal,
    measureWidth: settingsMeasureWidth,
    measureWidthVal: settingsMeasureWidthVal,
    diffRadios: document.querySelectorAll<HTMLInputElement>('input[name="settings-difficulty"]'),
    difficultyInfo: settingsDifficultyInfo,
    renderRadios: document.querySelectorAll<HTMLInputElement>('input[name="settings-render"]'),
    offsetAdjustMs: settingsOffsetAdjust,
    offsetAdjustMsVal: settingsOffsetAdjustVal,
    chordLangRadios: settingsChordLangRadios,
  });
  songListPage.hidden = true;
  settingsPage.hidden = false;
});

settingsBackBtn.addEventListener('click', () => {
  const s = collectSettingsFromUI();
  saveSettings(s);
  applySettings(s, fallingNotes, pianoPage.scoringEngine, settingsSummaryEl);
  settingsPage.hidden = true;
  songListPage.hidden = false;
});

settingsFallingSpeed.addEventListener('input', () => {
  settingsFallingSpeedVal.textContent = `${Number(settingsFallingSpeed.value).toFixed(1)}s`;
});
settingsPlaybackSpeed.addEventListener('input', () => {
  settingsPlaybackSpeedVal.textContent = `${Number(settingsPlaybackSpeed.value).toFixed(1)}×`;
});
settingsMeasureWidth.addEventListener('input', () => {
  settingsMeasureWidthVal.textContent = `${Number(settingsMeasureWidth.value)}px`;
});
settingsOffsetAdjust.addEventListener('input', () => {
  const v = Number(settingsOffsetAdjust.value);
  settingsOffsetAdjustVal.textContent = v === 0 ? '0ms' : v > 0 ? `+${v}ms` : `${v}ms`;
});

document.querySelectorAll<HTMLInputElement>('input[name="settings-difficulty"]').forEach((r) => {
  r.addEventListener('change', () => {
    if (!r.checked) return;
    settingsDifficultyInfo.textContent = DIFFICULTY_WINDOWS[r.value as AppSettings['difficulty']].label;
  });
});

/* 初始化设置 */
const initialSettings = loadSettings();
applySettings(initialSettings, fallingNotes, pianoPage.scoringEngine, settingsSummaryEl);

/* ═══════════════════ 按钮事件 ═══════════════════ */

fileInput.addEventListener('change', async () => {
  const f = fileInput.files?.[0];
  if (!f) return;
  pianoPage.currentSongFile = null;
  pianoPage.currentSongName = f.name.replace(/\.(mid|midi)$/i, '');
  try {
    const { Midi } = await import('@tonejs/midi');
    const buf = await f.arrayBuffer();
    const midi = new Midi(buf);
    pianoPage.pianoPageEl.hidden = false;
    songListPage.hidden = true;
    await pianoPage.enterAndPlay(midi);
  } catch {
    alert('加载 MIDI 文件失败');
  }
  fileInput.value = '';
});

btnSongPractice.addEventListener('click', async () => {
  const file = songFiles[selectedIndex];
  if (!file) { alert('请先选择一首歌曲'); return; }
  await goPractice(file);
});

btnDownloadLog.addEventListener('click', () => {
  downloadMidiLogs();
});

/* ═══════════════════ MIDI 设备列表同步 ═══════════════════ */

btnMidiRefresh.addEventListener('click', async () => {
  const access = await midiSetup.ensureAccess();
  if (!access) {
    alert('无法访问 MIDI（浏览器不支持或权限被拒绝）。建议使用 Chrome / Edge。');
    return;
  }
  midiSetup.refillSelects();
});

songListMidiRefresh.addEventListener('click', async () => {
  const access = await midiSetup.ensureAccess();
  if (!access) {
    songListMidiStatus.textContent = '无 MIDI 支持';
    songListMidiStatus.className = 'song-list-midi-status song-list-midi-status--none';
    return;
  }
  midiSetup.refillSelects();
});

songListMidiSelect.addEventListener('change', () => {
  if (midiInputSelect.value !== songListMidiSelect.value) {
    midiInputSelect.value = songListMidiSelect.value;
    midiSetup.updateSongListStatus();
  }
});

midiInputSelect.addEventListener('change', () => {
  if (songListMidiSelect.value !== midiInputSelect.value) {
    songListMidiSelect.value = midiInputSelect.value;
    midiSetup.updateSongListStatus();
  }
});

/* ═══════════════════ 初始化 ═══════════════════ */

// 鼠标离开歌曲列表区域时停止预览

async function init(): Promise<void> {
  const access = await midiSetup.ensureAccess();
  if (access) {
    midiSetup.refillSelects();
  } else {
    songListMidiStatus.textContent = '浏览器不支持 MIDI';
    songListMidiStatus.className = 'song-list-midi-status song-list-midi-status--none';
  }
  pianoPage.syncModeUi();
  showSongList();
}

init();
