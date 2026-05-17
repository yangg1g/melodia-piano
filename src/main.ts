import './style.css';
import { Midi } from '@tonejs/midi';
import {
  assignHandForNote,
  buildAtomsForHand,
  flattenNotes,
  getMeasureContext,
  measureCount,
  type FlatNote,
  type MeasureContext,
} from './midiScore';
import { renderGrandStaffRow, type GrandStaffColumn } from './renderScore';
import { createFallingNotesLane } from './fallingNotes';
import { applyKeyVisuals, createPianoKeyboard } from './pianoKeyboard';
import { playNotes, type PlaybackController } from './playback';
import { startKeyboardPractice } from './keyboardPractice';
import { ScoringEngine } from './scoring';
import type { ScoreState } from './scoring';
import { ensureSalamanderPiano, playPianoMidi, releaseAllPiano } from './salamanderPiano';

const app = document.querySelector<HTMLDivElement>('#app')!;

app.innerHTML = `
  <!-- ===== 选歌页 ===== -->
  <div id="song-list-page" class="page">
    <header class="song-list-header">
      <div class="song-list-header-row">
        <h1 class="song-list-title">🎹 MIDI Piano</h1>
        <button type="button" id="settings-btn" class="btn secondary settings-header-btn">⚙</button>
      </div>
      <p class="song-list-subtitle">选择一首歌曲开始练习</p>
      <div id="settings-summary" class="settings-summary">普通 · 下落 3.0s · 速度 1.0× · 普通判定</div>
    </header>
    <div class="song-list-body">
      <div class="history-panel">
        <div class="history-panel-header">
          <h3 class="history-panel-title">历史成绩</h3>
        </div>
        <div id="history-list" class="history-list">
          <div class="history-empty">选择歌曲后显示历史成绩</div>
        </div>
      </div>
      <div class="song-list-column">
        <div id="song-list" class="song-list" tabindex="0">
          <div class="song-list-loading">加载中…</div>
        </div>
        <div class="song-list-actions">
          <label class="file-btn file-btn--local">
            打开本地 MIDI 文件
            <input type="file" id="midi-file" accept=".mid,.midi,audio/midi" hidden />
          </label>
        </div>
      </div>
    </div>
  </div>

  <!-- ===== 钢琴页 ===== -->
  <div id="piano-page" class="page" hidden>
    <header class="toolbar">
      <h1 class="title">MIDI 乐谱</h1>
      <span id="measure-info" class="measure-info"></span>
      <div class="toolbar-actions">
        <button type="button" id="btn-back" class="btn secondary">← 返回</button>
        <div class="mode-group">
          <span>模式</span>
          <label><input type="radio" name="play-mode" value="normal" checked /> 普通模式</label>
          <label><input type="radio" name="play-mode" value="auto" /> 自动播放</label>
          <label><input type="radio" name="play-mode" value="keyboard" /> MIDI 跟弹</label>
        </div>
        <div id="midi-row" class="midi-row" hidden>
          <label for="midi-input">MIDI 输入</label>
          <select id="midi-input" aria-label="MIDI 输入设备"></select>
          <button type="button" id="btn-midi-refresh" class="btn secondary">刷新设备</button>
        </div>
        <button type="button" id="btn-play" class="btn primary">播放</button>
        <button type="button" id="btn-stop" class="btn secondary" disabled>停止</button>
      </div>
    </header>
    <div class="progress-bar-wrap">
      <input type="range" id="progress-bar" class="progress-bar" min="0" max="1000" value="0" step="1" aria-label="播放进度" />
      <span id="progress-time" class="progress-time">0:00 / 0:00</span>
    </div>
    <main class="main">
      <div id="score-scroll" class="score-scroll">
        <div id="score-pager" class="score-pager" hidden>
          <button type="button" id="score-prev" class="btn secondary">上一页</button>
          <span id="score-page-info" class="score-page-info"></span>
          <button type="button" id="score-next" class="btn secondary">下一页</button>
        </div>
        <div id="score" class="score"></div>
      </div>
      <section class="keyboard-section">
        <div id="score-display" class="score-display" hidden>
          <span class="score-display-score" id="score-value">0</span>
          <span class="score-display-combo" id="score-combo"></span>
          <span class="score-display-accu" id="score-accu">100.00%</span>
          <span class="score-display-judge" id="score-judge"></span>
        </div>
        <p class="hint" id="keyboard-hint"></p>
        <div id="keyboard-stack" class="keyboard-stack">
          <div id="keyboard-host"></div>
        </div>
      </section>
    </main>
  </div>

  <!-- ===== 结果页 ===== -->
  <div id="result-page" class="page" hidden>
    <div class="result-card">
      <div class="result-title">结算</div>
      <div class="result-score-section">
        <div class="result-score-label">最终得分</div>
        <div class="result-score" id="result-score">0</div>
      </div>
      <div class="result-accuracy-section">
        <div class="result-accuracy" id="result-accuracy">100.00%</div>
        <div class="result-maxcombo" id="result-maxcombo">最高 Combo: 0</div>
      </div>
      <div class="result-judgements">
        <div class="result-judge-row"><span class="judge-label judge--perfect">PERFECT</span><span class="judge-count" id="judge-perfect">0</span></div>
        <div class="result-judge-row"><span class="judge-label judge--great">GREAT</span><span class="judge-count" id="judge-great">0</span></div>
        <div class="result-judge-row"><span class="judge-label judge--good">GOOD</span><span class="judge-count" id="judge-good">0</span></div>
        <div class="result-judge-row"><span class="judge-label judge--ok">OK</span><span class="judge-count" id="judge-ok">0</span></div>
        <div class="result-judge-row"><span class="judge-label judge--meh">MEH</span><span class="judge-count" id="judge-meh">0</span></div>
        <div class="result-judge-row"><span class="judge-label judge--miss">MISS</span><span class="judge-count" id="judge-miss">0</span></div>
      </div>
      <button type="button" id="result-back-btn" class="btn primary result-back-btn">返回选歌</button>
    </div>
  </div>

  <!-- ===== 设置页 ===== -->
  <div id="settings-page" class="page" hidden>
    <div class="settings-card">
      <div class="settings-header">
        <h2 class="settings-title">设置</h2>
        <button type="button" id="settings-back-btn" class="btn secondary">← 返回</button>
      </div>
      <div class="settings-body">
        <div class="settings-group">
          <label class="settings-label">默认模式</label>
          <div class="settings-mode-group">
            <label><input type="radio" name="settings-mode" value="normal" checked /> 普通模式</label>
            <label><input type="radio" name="settings-mode" value="auto" /> 自动播放</label>
            <label><input type="radio" name="settings-mode" value="keyboard" /> MIDI 跟弹</label>
          </div>
        </div>

        <div class="settings-group">
          <label class="settings-label" for="settings-falling-speed">下落速度</label>
          <div class="settings-slider-row">
            <span>快</span>
            <input type="range" id="settings-falling-speed" min="0.5" max="6" step="0.5" value="3" />
            <span>慢</span>
            <span class="settings-value" id="settings-falling-speed-val">3.0s</span>
          </div>
        </div>

        <div class="settings-group">
          <label class="settings-label" for="settings-playback-speed">播放速度</label>
          <div class="settings-slider-row">
            <span>0.5×</span>
            <input type="range" id="settings-playback-speed" min="0.5" max="2" step="0.1" value="1" />
            <span>2.0×</span>
            <span class="settings-value" id="settings-playback-speed-val">1.0×</span>
          </div>
        </div>

        <div class="settings-group">
          <label class="settings-label">判定难度</label>
          <div class="settings-difficulty-group">
            <label><input type="radio" name="settings-difficulty" value="easy" /> 宽松</label>
            <label><input type="radio" name="settings-difficulty" value="normal" checked /> 普通</label>
            <label><input type="radio" name="settings-difficulty" value="hard" /> 严格</label>
          </div>
          <div class="settings-difficulty-info" id="settings-difficulty-info">PERFECT ≤ 25ms · GREAT ≤ 60ms · GOOD ≤ 100ms</div>
        </div>
      </div>
    </div>
  </div>
`;

/* ── DOM 引用 ── */

const songListPage = document.querySelector<HTMLDivElement>('#song-list-page')!;
const pianoPage = document.querySelector<HTMLDivElement>('#piano-page')!;
const songList = document.querySelector<HTMLDivElement>('#song-list')!;
const fileInput = document.querySelector<HTMLInputElement>('#midi-file')!;
const btnBack = document.querySelector<HTMLButtonElement>('#btn-back')!;
const scoreEl = document.querySelector<HTMLDivElement>('#score')!;
const scoreScrollEl = document.querySelector<HTMLDivElement>('#score-scroll')!;
const scorePagerEl = document.querySelector<HTMLDivElement>('#score-pager')!;
const btnPlay = document.querySelector<HTMLButtonElement>('#btn-play')!;
const btnStop = document.querySelector<HTMLButtonElement>('#btn-stop')!;
const keyboardStack = document.querySelector<HTMLDivElement>('#keyboard-stack')!;
const keyboardHost = document.querySelector<HTMLDivElement>('#keyboard-host')!;
const fallingNotes = createFallingNotesLane(keyboardStack);
const midiRow = document.querySelector<HTMLDivElement>('#midi-row')!;
const midiInputSelect = document.querySelector<HTMLSelectElement>('#midi-input')!;
const btnMidiRefresh = document.querySelector<HTMLButtonElement>('#btn-midi-refresh')!;
const keyboardHint = document.querySelector<HTMLParagraphElement>('#keyboard-hint')!;
const measureInfoEl = document.querySelector<HTMLSpanElement>('#measure-info')!;
const progressBar = document.querySelector<HTMLInputElement>('#progress-bar')!;
const progressTime = document.querySelector<HTMLSpanElement>('#progress-time')!;
const scoreDisplay = document.querySelector<HTMLDivElement>('#score-display')!;
const scoreValueEl = document.querySelector<HTMLSpanElement>('#score-value')!;
const scoreComboEl = document.querySelector<HTMLSpanElement>('#score-combo')!;
const scoreAccuEl = document.querySelector<HTMLSpanElement>('#score-accu')!;
const scoreJudgeEl = document.querySelector<HTMLSpanElement>('#score-judge')!;
const scoringEngine = new ScoringEngine();

const resultPage = document.querySelector<HTMLDivElement>('#result-page')!;
const resultOverlay = document.querySelector<HTMLDivElement>('#result-overlay')!;
const resultScoreEl = document.querySelector<HTMLSpanElement>('#result-score')!;
const resultAccuracyEl = document.querySelector<HTMLSpanElement>('#result-accuracy')!;
const resultMaxComboEl = document.querySelector<HTMLSpanElement>('#result-maxcombo')!;
const resultJudgePerfect = document.querySelector<HTMLSpanElement>('#judge-perfect')!;
const resultJudgeGreat = document.querySelector<HTMLSpanElement>('#judge-great')!;
const resultJudgeGood = document.querySelector<HTMLSpanElement>('#judge-good')!;
const resultJudgeOk = document.querySelector<HTMLSpanElement>('#judge-ok')!;
const resultJudgeMeh = document.querySelector<HTMLSpanElement>('#judge-meh')!;
const resultJudgeMiss = document.querySelector<HTMLSpanElement>('#judge-miss')!;
const resultBackBtn = document.querySelector<HTMLButtonElement>('#result-back-btn')!;
const historyList = document.querySelector<HTMLDivElement>('#history-list')!;

const settingsPage = document.querySelector<HTMLDivElement>('#settings-page')!;
const settingsBtn = document.querySelector<HTMLButtonElement>('#settings-btn')!;
const settingsBackBtn = document.querySelector<HTMLButtonElement>('#settings-back-btn')!;
const settingsFallingSpeed = document.querySelector<HTMLInputElement>('#settings-falling-speed')!;
const settingsFallingSpeedVal = document.querySelector<HTMLSpanElement>('#settings-falling-speed-val')!;
const settingsPlaybackSpeed = document.querySelector<HTMLInputElement>('#settings-playback-speed')!;
const settingsPlaybackSpeedVal = document.querySelector<HTMLSpanElement>('#settings-playback-speed-val')!;
const settingsDifficultyInfo = document.querySelector<HTMLSpanElement>('#settings-difficulty-info')!;
const settingsSummaryEl = document.querySelector<HTMLDivElement>('#settings-summary')!;

function updateSettingsSummary(s: AppSettings) {
  const modeLabel = s.mode === 'normal' ? '普通模式' : s.mode === 'auto' ? '自动播放' : 'MIDI跟弹';
  const diffLabel = s.difficulty === 'easy' ? '宽松' : s.difficulty === 'normal' ? '普通' : '严格';
  settingsSummaryEl.textContent = `${modeLabel} · 下落 ${s.fallingSpeed.toFixed(1)}s · 速度 ${s.playbackSpeed.toFixed(1)}× · ${diffLabel}判定`;
}

let currentMidi: Midi | null = null;
let flatNotes: FlatNote[] = [];
let keyEls = createPianoKeyboard(keyboardHost);
let playback: PlaybackController | null = null;
let midiAccess: MIDIAccess | null = null;
let totalDurationSec = 0;
let seeking = false;
/** 当前正在播放的歌曲文件名（用于保存历史） */
let currentSongFile: string | null = null;
let currentSongName: string = '';

/* ── 历史成绩持久化（完整记录列表） ── */

interface PlayHistoryEntry {
  songFile: string;
  songName: string;
  score: number;
  accuracy: number;
  maxCombo: number;
  mode: string;
  date: string; // ISO
  /** 当时的设置快照 */
  settings: {
    fallingSpeed: number;
    playbackSpeed: number;
    difficulty: string;
  };
}

const HISTORY_KEY = 'midi-piano-history';

function loadHistory(): PlayHistoryEntry[] {
  try {
    return JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
  } catch {
    return [];
  }
}

function addHistoryEntry(entry: PlayHistoryEntry) {
  const all = loadHistory();
  all.push(entry);
  // 最多保留 500 条
  if (all.length > 500) all.splice(0, all.length - 500);
  localStorage.setItem(HISTORY_KEY, JSON.stringify(all));
}

function clearAllHistory() {
  localStorage.removeItem(HISTORY_KEY);
}

/** 删除单条历史记录（根据 date 精确匹配） */
function deleteHistoryEntry(songFile: string, date: string) {
  const all = loadHistory();
  const idx = all.findIndex(e => e.songFile === songFile && e.date === date);
  if (idx !== -1) {
    all.splice(idx, 1);
    localStorage.setItem(HISTORY_KEY, JSON.stringify(all));
    return true;
  }
  return false;
}

/** 获取某首歌的最佳记录（从完整历史中推导） */
function getBestForSong(songFile: string): { bestScore: number; bestAccuracy: number; bestCombo: number; totalPlays: number } | null {
  const entries = loadHistory().filter(e => e.songFile === songFile);
  if (entries.length === 0) return null;
  let bestScore = 0, bestAccuracy = 0, bestCombo = 0;
  for (const e of entries) {
    if (e.score > bestScore) bestScore = e.score;
    if (e.accuracy > bestAccuracy) bestAccuracy = e.accuracy;
    if (e.maxCombo > bestCombo) bestCombo = e.maxCombo;
  }
  return { bestScore, bestAccuracy, bestCombo, totalPlays: entries.length };
}

/** 获取某首歌的历史条目（按分数降序） */
function getHistoryForSong(songFile: string): PlayHistoryEntry[] {
  return loadHistory().filter(e => e.songFile === songFile).sort((a, b) => b.score - a.score);
}

/* ── 设置系统 ── */

interface AppSettings {
  mode: PlayMode;
  fallingSpeed: number;   // VISIBLE_WINDOW_SEC (1.5 ~ 5)
  playbackSpeed: number;  // 倍率 (0.5 ~ 2.0)
  difficulty: 'easy' | 'normal' | 'hard';
}

const DIFFICULTY_WINDOWS: Record<AppSettings['difficulty'], { label: string; windows: Partial<import('./scoring').TimingWindows> }> = {
  easy: {
    label: 'PERFECT ≤ 40ms · GREAT ≤ 80ms · GOOD ≤ 140ms',
    windows: { perfect: 40, great: 80, good: 140, ok: 200, meh: 260 },
  },
  normal: {
    label: 'PERFECT ≤ 25ms · GREAT ≤ 60ms · GOOD ≤ 100ms',
    windows: { perfect: 25, great: 60, good: 100, ok: 140, meh: 180 },
  },
  hard: {
    label: 'PERFECT ≤ 15ms · GREAT ≤ 35ms · GOOD ≤ 60ms',
    windows: { perfect: 15, great: 35, good: 60, ok: 90, meh: 120 },
  },
};

function loadSettings(): AppSettings {
  try {
    return { ...{ mode: 'normal' as PlayMode, fallingSpeed: 3, playbackSpeed: 1, difficulty: 'normal' as AppSettings['difficulty'] }, ...JSON.parse(localStorage.getItem('midi-piano-settings') || '{}') };
  } catch {
    return { mode: 'normal', fallingSpeed: 3, playbackSpeed: 1, difficulty: 'normal' };
  }
}

function saveSettings(s: AppSettings) {
  localStorage.setItem('midi-piano-settings', JSON.stringify(s));
}

function applySettingsToUI(s: AppSettings) {
  // 模式
  const modeRadio = document.querySelector<HTMLInputElement>(`input[name="settings-mode"][value="${s.mode}"]`);
  if (modeRadio) modeRadio.checked = true;
  // 下落速度
  settingsFallingSpeed.value = String(s.fallingSpeed);
  settingsFallingSpeedVal.textContent = `${s.fallingSpeed.toFixed(1)}s`;
  // 播放速度
  settingsPlaybackSpeed.value = String(s.playbackSpeed);
  settingsPlaybackSpeedVal.textContent = `${s.playbackSpeed.toFixed(1)}×`;
  // 判定难度
  const diffRadio = document.querySelector<HTMLInputElement>(`input[name="settings-difficulty"][value="${s.difficulty}"]`);
  if (diffRadio) diffRadio.checked = true;
  settingsDifficultyInfo.textContent = DIFFICULTY_WINDOWS[s.difficulty].label;
}

function applySettings(s: AppSettings) {
  // 模式
  setPlayMode(s.mode);
  // 下落速度
  fallingNotes.setSpeed(s.fallingSpeed);
  // 判定窗口
  scoringEngine.setWindows(DIFFICULTY_WINDOWS[s.difficulty].windows);
  // 更新选歌页摘要
  updateSettingsSummary(s);
}

// 打开/关闭设置
settingsBtn.addEventListener('click', () => {
  const s = loadSettings();
  applySettingsToUI(s);
  songListPage.hidden = true;
  settingsPage.hidden = false;
});

settingsBackBtn.addEventListener('click', () => {
  // 保存设置
  const mode = document.querySelector<HTMLInputElement>('input[name="settings-mode"]:checked')?.value as PlayMode ?? 'normal';
  const fallingSpeed = Number(settingsFallingSpeed.value);
  const playbackSpeed = Number(settingsPlaybackSpeed.value);
  const difficulty = document.querySelector<HTMLInputElement>('input[name="settings-difficulty"]:checked')?.value as AppSettings['difficulty'] ?? 'normal';
  const s: AppSettings = { mode, fallingSpeed, playbackSpeed, difficulty };
  saveSettings(s);
  applySettings(s);
  settingsPage.hidden = true;
  songListPage.hidden = false;
});

// 设置滑块实时显示
settingsFallingSpeed.addEventListener('input', () => {
  settingsFallingSpeedVal.textContent = `${Number(settingsFallingSpeed.value).toFixed(1)}s`;
});
settingsPlaybackSpeed.addEventListener('input', () => {
  settingsPlaybackSpeedVal.textContent = `${Number(settingsPlaybackSpeed.value).toFixed(1)}×`;
});

// 判定难度切换显示说明
document.querySelectorAll<HTMLInputElement>('input[name="settings-difficulty"]').forEach((r) => {
  r.addEventListener('change', () => {
    if (!r.checked) return;
    settingsDifficultyInfo.textContent = DIFFICULTY_WINDOWS[r.value as AppSettings['difficulty']].label;
  });
});

// 初始化：加载已保存的设置
const initialSettings = loadSettings();
applySettings(initialSettings);

/* ── 页面切换 ── */

function showSongList() {
  stopPreview();
  pianoPage.hidden = true;
  songListPage.hidden = false;
  stopPlayback();
  refreshSongList();
}

resultBackBtn.addEventListener('click', () => {
  resultPage.hidden = true;
  resultOverlay.hidden = true;
  scoringEngine.reset();
  showSongList();
});

function showResultScreen(songFile: string | null = currentSongFile) {
  const state = scoringEngine.getState();
  const finalScore = scoringEngine.getFinalScore();

  // 保存本次成绩到完整历史（含设置快照）
  if (songFile) {
    const curSettings = loadSettings();
    addHistoryEntry({
      songFile,
      songName: currentSongName,
      score: finalScore,
      accuracy: state.accuracy,
      maxCombo: state.maxCombo,
      mode: curSettings.mode,
      date: new Date().toISOString(),
      settings: {
        fallingSpeed: curSettings.fallingSpeed,
        playbackSpeed: curSettings.playbackSpeed,
        difficulty: curSettings.difficulty,
      },
    });
  }

  resultScoreEl.textContent = finalScore.toLocaleString();
  resultAccuracyEl.textContent = `${(state.accuracy * 100).toFixed(2)}%`;
  resultMaxComboEl.textContent = `最大 Combo: ${state.maxCombo}`;
  resultJudgePerfect.textContent = String(state.counts.PERFECT);
  resultJudgeGreat.textContent = String(state.counts.GREAT);
  resultJudgeGood.textContent = String(state.counts.GOOD);
  resultJudgeOk.textContent = String(state.counts.OK);
  resultJudgeMeh.textContent = String(state.counts.MEH);
  resultJudgeMiss.textContent = String(state.counts.MISS);

  pianoPage.hidden = true;
  resultOverlay.hidden = false;
  resultPage.hidden = false;
}

async function enterPianoPageAndPlay(midi: Midi) {
  stopPreview();
  songListPage.hidden = true;
  pianoPage.hidden = false;
  renderAll(midi);
  // 使用设置中的模式
  setPlayMode(loadSettings().mode);

  // 3 秒倒计时
  await countdown(3);
  await startPlayFrom(0);
}

function countdown(seconds: number): Promise<void> {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'countdown-overlay';
    pianoPage.appendChild(overlay);

    let remaining = seconds;
    const tick = () => {
      overlay.textContent = String(remaining);
      remaining--;
      if (remaining < 0) {
        overlay.remove();
        resolve();
      } else {
        setTimeout(tick, 1000);
      }
    };
    tick();
  });
}

btnBack.addEventListener('click', showSongList);

/* ── 歌曲列表（音游式选择） ── */

let songFiles: string[] = [];
let selectedIndex = 0;

function updateHistoryPanel(songFile: string | null) {
  if (!songFile || !songFiles.includes(songFile)) {
    historyList.innerHTML = '<div class="history-empty">选择歌曲后显示历史成绩</div>';
    return;
  }
  const entries = getHistoryForSong(songFile);
  if (entries.length === 0) {
    historyList.innerHTML = '<div class="history-empty">该歌曲暂无历史成绩</div>';
    return;
  }
  historyList.innerHTML = entries.map((e, i) => {
    const date = new Date(e.date);
    const dateStr = `${date.getMonth() + 1}/${date.getDate()} ${date.getHours().toString().padStart(2, '0')}:${date.getMinutes().toString().padStart(2, '0')}`;
    const modeLabel = e.mode === 'normal' ? '普通' : e.mode === 'keyboard' ? '跟弹' : e.mode;
    const diffLabel = e.settings?.difficulty === 'easy' ? '宽松' : e.settings?.difficulty === 'hard' ? '严格' : '普通';
    const speedLabel = e.settings?.playbackSpeed !== undefined ? `${e.settings.playbackSpeed.toFixed(1)}×` : '';
    return `<div class="history-entry ${i === 0 ? 'history-entry--latest' : ''}" data-song="${e.songFile}" data-date="${e.date}">
      <div class="history-entry-score">${e.score.toLocaleString()}</div>
      <div class="history-entry-meta">
        <span class="history-entry-accu">${(e.accuracy * 100).toFixed(1)}%</span>
        <span class="history-entry-combo">×${e.maxCombo}</span>
        <span class="history-entry-mode">${modeLabel}</span>
        ${speedLabel ? `<span class="history-entry-speed">${speedLabel}</span>` : ''}
        <span class="history-entry-diff">${diffLabel}</span>
      </div>
      <div class="history-entry-date">${dateStr}</div>
    </div>`;
  }).join('');

  // 右键删除单条记录
  historyList.querySelectorAll<HTMLElement>('.history-entry').forEach((el) => {
    el.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const song = el.dataset.song;
      const date = el.dataset.date;
      if (!song || !date) return;
      if (confirm(`确定删除这条成绩（${el.querySelector('.history-entry-score')?.textContent}）？`)) {
        deleteHistoryEntry(song, date);
        updateHistoryPanel(songFile);
      }
    });
  });
}

function selectSong(index: number) {
  const items = songList.querySelectorAll<HTMLElement>('.song-list-item');
  if (index < 0) index = 0;
  if (index >= items.length) index = items.length - 1;
  selectedIndex = index;

  for (let i = 0; i < items.length; i++) {
    items[i].classList.toggle('selected', i === index);
  }

  // 滚动到可见
  items[index]?.scrollIntoView({ block: 'center', behavior: 'smooth' });

  // 更新左侧历史面板
  updateHistoryPanel(songFiles[index] ?? null);

  // 自动预览选中歌曲
  if (songFiles[index]) startPreview(songFiles[index]);
}

/** 加载单首歌曲的元数据 JSON（{midName}.json） */
async function fetchSongMeta(filename: string) {
  try {
    const res = await fetch(`/songs/${encodeURIComponent(filename)}.json`);
    if (!res.ok) return null;
    return await res.json() as { starRating: number; noteCount: number; bpm: number };
  } catch {
    return null;
  }
}

async function refreshSongList() {
  songList.innerHTML = '<div class="song-list-loading">加载中…</div>';
  try {
    const res = await fetch('/api/songs');
    const files: string[] = await res.json();
    songFiles = files;

    if (files.length === 0) {
      songList.innerHTML = '<div class="song-list-empty">暂无歌曲，请将 .mid 文件放入 public/songs/ 目录</div>';
      return;
    }

    // 并行加载所有歌曲的元数据
    const metas = await Promise.all(files.map(fetchSongMeta));

    songList.innerHTML = '';
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      const info = metas[i];
      const name = f.replace(/\.(mid|midi)$/i, '');
      const stars = info ? renderStars(info.starRating) : '';
      const meta = info
        ? `<span class="song-list-meta">${info.noteCount} 音符 · ${info.bpm}BPM</span>`
        : '';

      const item = document.createElement('div');
      item.className = 'song-list-item';
      item.dataset.file = f;
      const best = getBestForSong(f);
      const historyHtml = best
        ? `<span class="song-list-history">最佳 <span class="history-score">${best.bestScore.toLocaleString()}</span> · ${(best.bestAccuracy * 100).toFixed(1)}% · ${best.totalPlays} 次</span>`
        : '';
      item.innerHTML = `
        <span class="song-list-index">${i + 1}</span>
        <span class="song-list-body-col">
          <span class="song-list-name">${name}</span>
          <span class="song-list-stars">${stars}</span>
          ${meta}
          ${historyHtml}
        </span>
        <span class="song-list-arrow">▶</span>
      `;
      item.addEventListener('click', () => {
        const idx = songFiles.indexOf(f);
        if (idx === selectedIndex) {
          // 已选中，进入游戏
          loadAndGo(f);
        } else {
          // 未选中，切换到该歌曲
          selectSong(idx);
        }
      });
      songList.appendChild(item);
    }

    selectedIndex = 0;
    selectSong(0);
    songList.focus();
  } catch {
    songList.innerHTML = '<div class="song-list-empty">无法加载歌曲列表（仅开发模式支持）</div>';
  }
}

function renderStars(rating: number): string {
  const full = Math.floor(rating);
  const frac = rating - full;
  let html = '';
  for (let i = 0; i < full; i++) html += '★';
  if (frac >= 0.25) html += '☆';
  const numeric = rating.toFixed(2);
  return `<span class="star-display" title="${numeric}">${html}</span>`;
}

/* ── 键盘选择 ── */

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
    if (file) loadAndGo(file);
  }
});

async function loadAndGo(filename: string) {
  stopPreview(); // 立即停止预览，防止 fetch 期间音频重叠
  currentSongFile = filename;
  currentSongName = filename.replace(/\.(mid|midi)$/i, '');
  try {
    const res = await fetch(`/songs/${encodeURIComponent(filename)}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = await res.arrayBuffer();
    const midi = new Midi(buf);
    await enterPianoPageAndPlay(midi);
  } catch {
    alert(`加载歌曲失败：${filename}`);
  }
}

/* ── 悬浮预览 ── */

let previewTimers: number[] = [];
let previewCancelled = false;

async function startPreview(filename: string) {
  stopPreview();
  previewCancelled = false;

  try {
    await ensureSalamanderPiano();

    const res = await fetch(`/songs/${encodeURIComponent(filename)}`);
    if (!res.ok || previewCancelled) return;
    const buf = await res.arrayBuffer();
    const midi = new Midi(buf);
    if (previewCancelled) return;

    const PREVIEW_SEC = 8;

    for (const track of midi.tracks) {
      for (const note of track.notes) {
        if (note.time > PREVIEW_SEC) continue;
        if (previewCancelled) return;

        const delayMs = note.time * 1000;
        const dur = Math.max(0.05, note.duration);
        const vel = (note.velocity as number) ?? 0.78;

        const id = window.setTimeout(() => {
          if (previewCancelled) return;
          playPianoMidi(note.midi, dur, vel);
        }, delayMs);

        previewTimers.push(id);
      }
    }
  } catch {
    // preview 失败静默处理
  }
}

function stopPreview() {
  previewCancelled = true;
  for (const id of previewTimers) clearTimeout(id);
  previewTimers = [];
  releaseAllPiano();
}

fileInput.addEventListener('change', async () => {
  const f = fileInput.files?.[0];
  if (!f) return;
  currentSongFile = null;
  currentSongName = f.name.replace(/\.(mid|midi)$/i, '');
  try {
    const buf = await f.arrayBuffer();
    const midi = new Midi(buf);
    await enterPianoPageAndPlay(midi);
  } catch {
    alert('加载 MIDI 文件失败');
  }
  fileInput.value = '';
});

/* ── 进度条 ── */

function formatTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function updateProgressBar(timeSec: number) {
  if (seeking) return;
  const pct = totalDurationSec > 0 ? (timeSec / totalDurationSec) * 1000 : 0;
  progressBar.value = String(Math.round(pct));
  progressTime.textContent = `${formatTime(timeSec)} / ${formatTime(totalDurationSec)}`;
}

function resetProgressBar() {
  progressBar.value = '0';
  progressTime.textContent = `0:00 / ${formatTime(totalDurationSec)}`;
}

/* ── 模式切换 ── */

type PlayMode = 'normal' | 'auto' | 'keyboard';

function getPlayMode(): PlayMode {
  const el = document.querySelector<HTMLInputElement>('input[name="play-mode"]:checked');
  return (el?.value as PlayMode) ?? 'normal';
}

function setPlayMode(mode: PlayMode) {
  const radio = document.querySelector<HTMLInputElement>(`input[name="play-mode"][value="${mode}"]`);
  if (radio) radio.checked = true;
  syncModeUi();
}

function updateKeyboardHint() {
  const mode = getPlayMode();
  if (mode === 'auto') {
    keyboardHint.textContent = '根据 MIDI 生成的五线谱（高音 / 低音谱表）。琴键上方为下落式音符（绿左 / 蓝右；白键稍亮、黑键更深）。键盘高亮同上。';
  } else if (mode === 'keyboard') {
    keyboardHint.textContent = 'MIDI 跟弹：绿色 / 蓝色描边为当前应弹的左 / 右手音；弹对后条缩短并发声前进；紫红色外圈为正在按下的键，错音不出声。';
  } else {
    keyboardHint.textContent = '普通模式：自动播放曲目，可同时使用 MIDI 键盘弹奏，实时判定计分。';
  }
}

function syncModeUi() {
  midiRow.hidden = getPlayMode() !== 'keyboard';
  scoreDisplay.hidden = getPlayMode() === 'auto';
  updateKeyboardHint();
}

/** 计分 UI 更新 */
function updateScoreUI(state: ScoreState) {
  scoreValueEl.textContent = `${state.score.toLocaleString()}`;
  scoreValueEl.title = `${state.score.toLocaleString()} / ${state.maxScore.toLocaleString()} (含 combo 加成)`;
  scoreAccuEl.textContent = `${(state.accuracy * 100).toFixed(2)}%`;
  if (state.combo > 1) {
    scoreComboEl.textContent = `${state.combo} combo`;
  } else {
    scoreComboEl.textContent = '';
  }

  // 判定闪烁提示
  if (state.lastJudgement) {
    const judgeMap: Record<string, string> = {
      PERFECT: 'PERFECT',
      GREAT: 'GREAT',
      GOOD: 'GOOD',
      OK: 'OK',
      MEH: 'MEH',
      MISS: 'MISS',
    };
    scoreJudgeEl.textContent = judgeMap[state.lastJudgement] ?? '';
    scoreJudgeEl.className = 'score-display-judge';
    // 触发 CSS 动画
    requestAnimationFrame(() => {
      scoreJudgeEl.classList.add(`judge--${state.lastJudgement.toLowerCase()}`);
    });
  }
}

for (const r of document.querySelectorAll<HTMLInputElement>('input[name="play-mode"]')) {
  r.addEventListener('change', () => {
    stopPlayback();
    syncModeUi();
  });
}

async function ensureMidiAccess(): Promise<MIDIAccess | null> {
  if (!navigator.requestMIDIAccess) return null;
  try {
    const access = await navigator.requestMIDIAccess({ sysex: false });
    midiAccess = access;
    access.onstatechange = () => refillMidiSelect();
    return access;
  } catch {
    return null;
  }
}

function refillMidiSelect() {
  const sel = midiInputSelect;
  const prev = sel.value;
  sel.innerHTML = '';
  if (!midiAccess) return;
  midiAccess.inputs.forEach((input) => {
    const opt = document.createElement('option');
    opt.value = input.id;
    opt.textContent = input.name || input.id || 'MIDI 输入';
    sel.appendChild(opt);
  });
  if (prev && [...sel.options].some((o) => o.value === prev)) {
    sel.value = prev;
  }
}

btnMidiRefresh.addEventListener('click', async () => {
  const access = await ensureMidiAccess();
  if (!access) {
    alert('无法访问 MIDI（浏览器不支持或权限被拒绝）。建议使用 Chrome / Edge。');
    return;
  }
  refillMidiSelect();
});

interface ScorePagerState {
  ctx: MeasureContext;
  midi: Midi;
  nMeas: number;
  measureWidth: number;
}

let scorePagerState: ScorePagerState | null = null;

function renderStaff(stripEl: HTMLElement, midi: Midi) {
  const ctx = getMeasureContext(midi);
  const nMeas = measureCount(midi, ctx);
  // 每小节渲染宽度（像素），180px 兼顾可读性与 canvas 体积
  const measureWidth = 180;

  const columns: GrandStaffColumn[] = [];
  for (let i = 0; i < nMeas; i++) {
    columns.push({
      measureIndex: i,
      trebleAtoms: buildAtomsForHand(flatNotes, midi, 'treble', ctx, i),
      bassAtoms: buildAtomsForHand(flatNotes, midi, 'bass', ctx, i),
      showStaffHeader: i === 0,
    });
  }
  const { height: stripHeight } = renderGrandStaffRow(stripEl, columns, ctx, measureWidth, true);

  scorePagerState = { ctx, midi, nMeas, measureWidth };
  stripEl.style.minHeight = `${stripHeight}px`;
}

function addJudgmentLine() {
  // 移除旧的判定线
  const old = scoreScrollEl.querySelector('.judgment-line');
  if (old) old.remove();
  const line = document.createElement('div');
  line.className = 'judgment-line';
  line.setAttribute('aria-hidden', 'true');
  scoreScrollEl.appendChild(line);
}

function resetStaffScroll() {
  scoreEl.style.transform = `translateX(${getJudgeX()}px)`;
}

function getJudgeX(): number {
  const vpW = scoreScrollEl.clientWidth;
  return Math.max(80, Math.floor(vpW * 0.25));
}

function scrollStaffToProgress(progress01: number) {
  const st = scorePagerState;
  if (!st) return;
  const totalStrip = st.nMeas * st.measureWidth;
  scoreEl.style.transform = `translateX(${getJudgeX() - progress01 * totalStrip}px)`;
}

function updateMeasureInfo(current: number, total: number) {
  if (total <= 0) {
    measureInfoEl.textContent = '';
    return;
  }
  measureInfoEl.textContent = `第 ${current + 1} / ${total} 小节`;
}

function updateScorePlayhead(timeSec: number) {
  const st = scorePagerState;
  const midi = currentMidi;
  if (!st || !midi) {
    resetStaffScroll();
    return;
  }
  if (timeSec >= midi.duration - 1e-3 || timeSec < 0) {
    resetStaffScroll();
    return;
  }

  const ticks = midi.header.secondsToTicks(Math.max(0, timeSec));
  const progress = Math.min(1, Math.max(0, ticks / midi.durationTicks));

  scrollStaffToProgress(progress);

  // 更新小节信息
  const m = Math.floor(ticks / st.ctx.ticksPerMeasure);
  updateMeasureInfo(Math.min(m, st.nMeas - 1), st.nMeas);
}

function hideScorePlayhead() {
  resetStaffScroll();
}

function noteRange(notes: typeof flatNotes): { min: number; max: number } {
  if (notes.length === 0) return { min: 57, max: 72 };
  let min = 127;
  let max = 0;
  for (const n of notes) {
    min = Math.min(min, n.midi);
    max = Math.max(max, n.midi);
  }
  const pad = 2;
  return {
    min: Math.max(21, min - pad),
    max: Math.min(108, max + pad),
  };
}

function renderAll(midi: Midi) {
  currentMidi = midi;
  flatNotes = flattenNotes(midi);

  scoreEl.innerHTML = '';
  scoreEl.style.cssText = 'position:relative;will-change:transform';
  scoreScrollEl.style.cssText = 'overflow:hidden;position:relative';

  renderStaff(scoreEl, midi);
  addJudgmentLine();

  // 初始定位：开头对准判定线，避免播放瞬间跳跃
  scoreEl.style.transform = `translateX(${getJudgeX()}px)`;

  const range = noteRange(flatNotes);
  keyEls = createPianoKeyboard(keyboardHost, range.min, range.max);
  fallingNotes.setRange(range.min, range.max);
  fallingNotes.setSource(flatNotes, midi);
  fallingNotes.clear();

  if (scorePagerState) updateMeasureInfo(0, scorePagerState.nMeas);

  totalDurationSec = midi.duration;
  resetProgressBar();
}

function stopPlayback() {
  playback?.stop();
  playback = null;
  hideScorePlayhead();
  if (scorePagerState) updateMeasureInfo(0, scorePagerState.nMeas);
  fallingNotes.clear();
  applyKeyVisuals(keyEls, {});
  btnPlay.disabled = false;
  btnStop.disabled = true;
  resetProgressBar();
}

btnPlay.addEventListener('click', async () => {
  if (!currentMidi || flatNotes.length === 0) return;
  startPlayFrom(0);
});

async function startPlayFrom(offsetSec: number) {
  if (!currentMidi || flatNotes.length === 0) return;
  stopPlayback();
  btnPlay.disabled = true;
  btnStop.disabled = false;

  const mode = getPlayMode();
  const settings = loadSettings();

  const onPlaybackEnded = () => {
    hideScorePlayhead();
    fallingNotes.clear();
    btnPlay.disabled = false;
    btnStop.disabled = true;
    playback = null;
    resetProgressBar();

    // 非自动播放模式显示结算画面
    if (getPlayMode() !== 'auto') {
      showResultScreen();
    }
  };

  try {
    await ensureSalamanderPiano();
  } catch {
    alert('音频引擎初始化失败，请刷新页面重试。');
    onPlaybackEnded();
    return;
  }

  /* ── 自动播放模式 ── */
  if (mode === 'auto') {
    const sorted = [...flatNotes].sort((a, b) => {
      const ha = assignHandForNote(a, currentMidi!);
      const hb = assignHandForNote(b, currentMidi!);
      if (ha !== hb) return ha === 'treble' ? -1 : 1;
      return a.time - b.time || a.midi - b.midi;
    });
    scoreDisplay.hidden = true;
    playback = playNotes(
      sorted,
      currentMidi,
      currentMidi.duration,
      (active) => applyKeyVisuals(keyEls, { active }),
      onPlaybackEnded,
      (t) => {
        updateScorePlayhead(t);
        fallingNotes.update(t);
        updateProgressBar(t);
      },
      offsetSec,
      settings.playbackSpeed,
    );
    return;
  }

  /* ── 需要 MIDI 输入的模式 ── */
  const access = await ensureMidiAccess();
  if (!access) {
    alert('当前浏览器不支持 Web MIDI，或用户拒绝了权限。请使用 Chrome / Edge 等浏览器。');
    onPlaybackEnded();
    return;
  }
  refillMidiSelect();
  let input: MIDIInput | undefined;
  const id = midiInputSelect.value;
  if (id) input = access.inputs.get(id);
  if (!input) {
    const first = [...access.inputs.values()][0];
    input = first;
  }
  if (!input) {
    alert('未检测到 MIDI 输入设备。请先连接键盘，或点击「刷新设备」后再试。');
    onPlaybackEnded();
    return;
  }
  try {
    await input.open();
  } catch {
    alert('无法打开所选 MIDI 输入端口。');
    onPlaybackEnded();
    return;
  }

  /* ── 普通模式：MIDI 键盘自由弹奏 + 计分 ── */
  if (mode === 'normal') {
    scoreDisplay.hidden = false;
    scoringEngine.reset({ totalNotes: flatNotes.length });
    updateScoreUI(scoringEngine.getState());

    playback = startKeyboardPractice(
      flatNotes,
      currentMidi,
      keyEls,
      input,
      onPlaybackEnded,
      (t) => {
        updateScorePlayhead(t);
        updateProgressBar(t);
      },
      (s) => fallingNotes.updateKeyboardPractice(s),
      scoringEngine,
      updateScoreUI,
      true, // freePlay → 时间自动前进，不等待按键
      settings.playbackSpeed,
    );
    return;
  }

  /* ── MIDI 跟弹模式 ── */
  scoreDisplay.hidden = false;
  scoringEngine.reset({ totalNotes: flatNotes.length });
  updateScoreUI(scoringEngine.getState());

  playback = startKeyboardPractice(
    flatNotes,
    currentMidi,
    keyEls,
    input,
    onPlaybackEnded,
    (t) => {
      updateScorePlayhead(t);
      updateProgressBar(t);
    },
    (s) => fallingNotes.updateKeyboardPractice(s),
    scoringEngine,
    updateScoreUI,
    false, // freePlay = false → 跟弹等待模式
    settings.playbackSpeed,
  );
}

/* ── 进度条拖拽跳转 ── */

let wasPlayingBeforeSeek = false;

progressBar.addEventListener('input', () => {
  seeking = true;
  if (playback && !wasPlayingBeforeSeek) {
    wasPlayingBeforeSeek = true;
    playback.stop();
    playback = null;
    btnPlay.disabled = false;
    btnStop.disabled = true;
  }

  // 拖拽时同步更新五线谱位置
  if (!currentMidi || flatNotes.length === 0) return;
  const pct = Number(progressBar.value) / 1000;
  const timeSec = pct * totalDurationSec;
  updateProgressBar(timeSec);
  scrollStaffToProgress(pct);
});

progressBar.addEventListener('change', () => {
  seeking = false;
  if (!currentMidi || flatNotes.length === 0) return;
  const pct = Number(progressBar.value) / 1000;
  const timeSec = pct * totalDurationSec;
  updateProgressBar(timeSec);
  scrollStaffToProgress(pct);
  if (wasPlayingBeforeSeek) {
    wasPlayingBeforeSeek = false;
    // 所有模式都支持拖拽跳转
    startPlayFrom(timeSec);
  }
});

btnStop.addEventListener('click', () => {
  stopPlayback();
});

syncModeUi();
showSongList();
