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
import { Midi } from '@tonejs/midi';

import type { AppSettings } from './core/types';
import { DIFFICULTY_WINDOWS } from './core/types';
import { createFallingNotesLane } from './rendering/fallingNotes';
import { flattenNotes } from './core/midiScore';
import { loadSettings, saveSettings, applySettings, applySettingsToUI, collectSettingsFromUI } from './ui/settings';
import { MidiSetup } from './ui/midiSetup';
import { fetchSongList, updateHistoryPanel, refreshSongBest, startPreview, stopPreview } from './ui/songList';
import { PianoPage } from './ui/pianoPage';
import { hideResultScreen, showResultScreen } from './ui/resultScreen';
import { startMidiReplay } from './features/playback';
import { showConfirm } from './ui/confirmDialog';
import { downloadMidiLogs } from './features/keyboardPractice';
import { getBestForSong } from './ui/history';

/* ═══════════════════ DOM 结构 ═══════════════════ */

const app = document.querySelector<HTMLDivElement>('#app')!;

app.innerHTML = `
  <div id="song-list-page" class="page">
    <header class="song-list-header">
      <div class="song-list-header-row">
        <h1 class="song-list-title">🎹 MIDI Piano</h1>
        <button type="button" id="settings-btn" class="btn secondary settings-header-btn">⚙</button>
      </div>
      <p class="song-list-subtitle">选择一首歌曲开始练习</p>
      <div id="settings-summary" class="settings-summary">普通 · 下落 3.0s · 速度 1.0× · 普通判定</div>
      <div id="song-list-midi-row" class="song-list-midi-row">
        <label class="song-list-midi-label" for="song-list-midi-input">MIDI 输入</label>
        <select id="song-list-midi-input" class="song-list-midi-select" aria-label="MIDI 输入设备"></select>
        <button type="button" id="song-list-midi-refresh" class="btn secondary song-list-midi-btn">刷新设备</button>
        <span id="song-list-midi-status" class="song-list-midi-status"></span>
      </div>
    </header>
    <div class="song-list-body">
      <div class="history-panel">
        <div class="history-panel-header"><h3 class="history-panel-title">历史成绩</h3></div>
        <div id="history-list" class="history-list"><div class="history-empty">选择歌曲后显示历史成绩</div></div>
      </div>
      <div class="song-list-column">
        <div id="song-list" class="song-list" tabindex="0"><div class="song-list-loading">加载中…</div></div>
        <div class="song-list-actions">
          <button type="button" id="btn-song-practice" class="btn primary" disabled>🎹 练习模式</button>
          <label class="file-btn file-btn--local">
            打开本地 MIDI 文件
            <input type="file" id="midi-file" accept=".mid,.midi,audio/midi" hidden />
          </label>
        </div>
      </div>
    </div>
  </div>

  <div id="piano-page" class="page" hidden>
    <header class="toolbar">
      <h1 class="title">MIDI 乐谱</h1>
      <span id="measure-info" class="measure-info"></span>
      <div id="chord-display" class="chord-display" hidden>
        <span class="chord-display-notes" id="chord-display-notes"></span>
        <span class="chord-display-chord" id="chord-display-chord"></span>
      </div>
      <div class="toolbar-actions">
        <button type="button" id="btn-back" class="btn secondary">← 返回</button>
        <button type="button" id="btn-play" class="btn primary">播放</button>
        <button type="button" id="btn-stop" class="btn secondary" disabled>停止</button>
        <button type="button" id="btn-edit" class="btn secondary" hidden>编辑</button>
        <button type="button" id="btn-download-log" class="btn secondary" title="下载按键日志">📥 日志</button>
        <select id="midi-input" hidden aria-label="MIDI 输入设备"></select>
        <button id="btn-midi-refresh" hidden></button>
      </div>
      <div class="edit-toolbar" hidden>
        <button type="button" id="btn-finger" class="btn secondary">指法</button>
        <button type="button" id="btn-slur" class="btn secondary">连音</button>
        <button type="button" id="btn-tie" class="btn secondary">连尾</button>
        <button type="button" id="btn-stem" class="btn secondary">符尾方向</button>
        <button type="button" id="btn-save-edits" class="btn secondary">保存</button>
      </div>
    </header>
    <div class="progress-bar-wrap">
      <input type="range" id="progress-bar" class="progress-bar" min="0" max="1000" value="0" step="1" aria-label="播放进度" />
      <span id="progress-time" class="progress-time">0:00 / 0:00</span>
      <span id="practice-time" class="practice-time" hidden></span>
    </div>
    <div id="practice-controls-bar" class="practice-controls-bar" hidden>
      <div class="practice-measure-range">
        <span>循环小节</span>
        <button type="button" id="practice-start-dec" class="btn secondary practice-btn-sm">◀</button>
        <input type="number" class="practice-measure-input" id="practice-start-label" value="1" min="1" step="1" />
        <button type="button" id="practice-start-inc" class="btn secondary practice-btn-sm">▶</button>
        <span>–</span>
        <button type="button" id="practice-end-dec" class="btn secondary practice-btn-sm">◀</button>
        <input type="number" class="practice-measure-input" id="practice-end-label" value="1" min="1" step="1" />
        <button type="button" id="practice-end-inc" class="btn secondary practice-btn-sm">▶</button>
      </div>
      <div class="practice-loop-info">
        <span class="practice-loop-counter" id="practice-loop-counter">第 1 轮</span>
        <span class="practice-loop-best" id="practice-loop-best"></span>
      </div>
      <div class="practice-group-size">
        <span class="practice-group-size-label">合并小节</span>
        <input type="number" class="practice-measure-input" id="practice-group-size-input" value="1" min="1" max="50" step="1" />
      </div>
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
        <p class="hint" id="keyboard-hint"></p>
        <div id="keyboard-stack" class="keyboard-stack">
          <div id="keyboard-host"></div>
        </div>
      </section>
    </main>
    <div id="practice-left-panel" class="practice-left-panel" hidden>
      <div class="practice-left-panel-header">错误分析</div>
      <div id="practice-left-content" class="practice-left-content"></div>
    </div>
    <div id="practice-side-panel" class="practice-side-panel" hidden>
      <div id="score-display" class="score-display score-display--side" hidden>
        <span class="score-display-score" id="score-value">0</span>
        <span class="score-display-accu" id="score-accu">100.00%</span>
        <span class="score-display-combo" id="score-combo"></span>
        <span class="score-display-judge" id="score-judge"></span>
        <span class="score-display-wrong" id="score-wrong"></span>
      </div>
      <div class="practice-side-panel-header" id="practice-side-header">练习记录</div>
      <div id="practice-side-scores" class="practice-side-scores"></div>
    </div>
  </div>

  <div id="result-page" class="page" hidden>
    <div class="result-card">
      <div class="result-title">结算</div>
      <div class="result-header">
        <div class="result-score" id="result-score">0</div>
        <div class="result-max-score" id="result-max-score">理论最高 0</div>
      </div>
      <div class="result-sub-row">
        <span class="result-accuracy" id="result-accuracy">100.00%</span>
      </div>
      <div class="result-sub-row">
        <span class="result-score-label">Max Combo</span>
        <span class="result-maxcombo" id="result-maxcombo">0</span>
      </div>
      <div class="result-timing-section" id="result-timing-section" hidden>
        <div class="result-timing-title">用时统计（跟弹模式）</div>
        <div class="result-timing-row"><span class="result-timing-label">原曲时长</span><span class="result-timing-value" id="result-timing-original">0:00</span></div>
        <div class="result-timing-row"><span class="result-timing-label">实际用时</span><span class="result-timing-value" id="result-timing-actual">0:00</span></div>
        <div class="result-timing-row result-timing-row--highlight"><span class="result-timing-label">用时占比</span><span class="result-timing-value" id="result-timing-slower">0%</span></div>
      </div>
      <div class="result-judgements">
        <div class="result-judge-row"><span class="judge-label judge--perfect">PERFECT</span><span class="judge-count" id="judge-perfect">0</span></div>
        <div class="result-judge-row"><span class="judge-label judge--ok">OK</span><span class="judge-count" id="judge-ok">0</span></div>
        <div class="result-judge-row"><span class="judge-label judge--bad">BAD</span><span class="judge-count" id="judge-bad">0</span></div>
        <div class="result-judge-row"><span class="judge-label judge--miss">MISS</span><span class="judge-count" id="judge-miss">0</span></div>
        <div class="result-judge-row"><span class="judge-label judge--wrong">WRONG</span><span class="judge-count" id="judge-wrong">0</span></div>
      </div>
      <div class="result-chart-legend">
        <span class="detail-legend-item"><span class="detail-dot detail-dot--perfect"></span> PERFECT</span>
        <span class="detail-legend-item"><span class="detail-dot detail-dot--ok"></span> OK</span>
        <span class="detail-legend-item"><span class="detail-dot detail-dot--bad"></span> BAD</span>
        <span class="detail-legend-item"><span class="detail-dot detail-dot--miss"></span> MISS</span>
        <span class="detail-legend-item"><span class="detail-dot detail-dot--wrong"></span> WRONG</span>
      </div>
      <div class="result-chart-wrap"><canvas id="result-chart-canvas" class="result-chart-canvas"></canvas></div>
      <div class="result-error-section">
        <div class="result-error-header"><span class="result-error-title">按键偏差曲线</span><span class="result-error-avg" id="result-avg-error">平均偏差 0.0ms</span></div>
        <div class="result-chart-wrap"><canvas id="result-error-curve-canvas" class="result-chart-canvas"></canvas></div>
      </div>
      <div class="result-buttons">
        <button type="button" id="result-replay-btn" class="btn secondary result-replay-btn" hidden>回放</button>
        <button type="button" id="result-back-btn" class="btn primary result-back-btn">返回选歌</button>
      </div>
    </div>
  </div>

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
          <label class="settings-label">五线谱渲染方式</label>
          <div class="settings-mode-group">
            <label><input type="radio" name="settings-render" value="image" checked /> 图片滚动</label>
            <label><input type="radio" name="settings-render" value="original" /> 原始五线谱</label>
          </div>
        </div>
        <div class="settings-group">
          <label class="settings-label" for="settings-falling-speed">下落速度</label>
          <div class="settings-slider-row">
            <span>快</span><input type="range" id="settings-falling-speed" min="0.5" max="6" step="0.5" value="3" /><span>慢</span>
            <span class="settings-value" id="settings-falling-speed-val">3.0s</span>
          </div>
        </div>
        <div class="settings-group">
          <label class="settings-label" for="settings-playback-speed">播放速度</label>
          <div class="settings-slider-row">
            <span>0.5×</span><input type="range" id="settings-playback-speed" min="0.5" max="2" step="0.1" value="1" /><span>2.0×</span>
            <span class="settings-value" id="settings-playback-speed-val">1.0×</span>
          </div>
        </div>
        <div class="settings-group">
          <label class="settings-label" for="settings-measure-width">小节宽度</label>
          <div class="settings-slider-row">
            <span>100</span><input type="range" id="settings-measure-width" min="100" max="400" step="10" value="180" /><span>400</span>
            <span class="settings-value" id="settings-measure-width-val">180px</span>
          </div>
        </div>
        <div class="settings-group">
          <label class="settings-label">判定难度</label>
          <div class="settings-difficulty-group">
            <label><input type="radio" name="settings-difficulty" value="easy" /> 宽松</label>
            <label><input type="radio" name="settings-difficulty" value="normal" checked /> 普通</label>
            <label><input type="radio" name="settings-difficulty" value="hard" /> 严格</label>
          </div>
          <div class="settings-difficulty-info" id="settings-difficulty-info">PERFECT ≤ 25ms · OK ≤ 180ms · BAD ≤ 260ms</div>
        </div>
        <div class="settings-group">
          <label class="settings-label" for="settings-offset-adjust">判定偏移补偿</label>
          <div class="settings-slider-row">
            <span>-200ms</span><input type="range" id="settings-offset-adjust" min="-200" max="200" step="5" value="0" /><span>+200ms</span>
            <span class="settings-value" id="settings-offset-adjust-val">0ms</span>
          </div>
          <div class="settings-hint">正向 = 补偿按晚，负向 = 补偿按早</div>
        </div>
        <div class="settings-group">
          <label class="settings-label">和弦显示语言</label>
          <div class="settings-mode-group">
            <label><input type="radio" name="settings-chord-lang" value="zh" checked /> 中文</label>
            <label><input type="radio" name="settings-chord-lang" value="en" /> 英文</label>
          </div>
        </div>
      </div>
    </div>
  </div>

  <div id="confirm-dialog" class="confirm-dialog" hidden>
    <div class="confirm-dialog-card">
      <p id="confirm-dialog-msg" class="confirm-dialog-msg"></p>
      <div class="confirm-dialog-actions">
        <button type="button" id="confirm-dialog-cancel" class="btn secondary">取消</button>
        <button type="button" id="confirm-dialog-ok" class="btn primary" style="background:var(--accent);color:#fff;">确定</button>
      </div>
    </div>
  </div>
`;

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
const keyboardHint = document.querySelector<HTMLParagraphElement>('#keyboard-hint')!;
const chordDisplay = document.querySelector<HTMLDivElement>('#chord-display')!;
const chordDisplayNotes = document.querySelector<HTMLSpanElement>('#chord-display-notes')!;
const chordDisplayChord = document.querySelector<HTMLSpanElement>('#chord-display-chord')!;
const measureInfoEl = document.querySelector<HTMLSpanElement>('#measure-info')!;
const progressBar = document.querySelector<HTMLInputElement>('#progress-bar')!;
const progressTime = document.querySelector<HTMLSpanElement>('#progress-time')!;
const practiceTime = document.querySelector<HTMLSpanElement>('#practice-time')!;
const scoreDisplay = document.querySelector<HTMLDivElement>('#score-display')!;
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
  avgErrorEl: document.querySelector<HTMLSpanElement>('#result-avg-error')!,
  replayBtn: resultReplayBtn,
};

const pianoPage = new PianoPage({
  pianoPageEl, scoreEl, scoreScrollEl, scorePagerEl, keyboardHost, keyboardStack,
  keyboardHint, chordDisplay, chordDisplayNotes, chordDisplayChord,
  measureInfoEl, progressBar, progressTime, practiceTime, scoreDisplay,
  btnPlay, btnStop, btnEdit, btnFinger, btnSlur, btnTie, btnStem, btnSaveEdits, editToolbar,
  scoreValueEl, scoreAccuEl, scoreComboEl, scoreJudgeEl, scoreWrongEl,
  resultElements, midiSetup, fallingNotes,
});

pianoPage.onGoBack = () => showSongList();

/* ═══════════════════ 曲目/文件加载 ═══════════════════ */

let songFiles: string[] = [];
let selectedIndex = 0;
/** 结算页面是从历史记录打开的（而非弹奏结束），返回时不要刷新列表 */
let resultFromHistory = false;

async function loadSongFile(filename: string): Promise<Midi> {
  const res = await fetch(`/songs/${encodeURIComponent(filename)}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = await res.arrayBuffer();
  return new Midi(buf);
}

/** 加载歌曲元数据 JSON（{filename}.json） */
async function fetchSongMeta(filename: string): Promise<{ starRating: number; noteCount: number; bpm: number } | null> {
  try {
    const res = await fetch(`/songs/${encodeURIComponent(filename)}.json`);
    if (!res.ok) return null;
    return await res.json() as { starRating: number; noteCount: number; bpm: number };
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
  pianoPage.currentSongName = filename.replace(/\.(mid|midi)$/i, '');
  pianoPage.pianoPageEl.hidden = false;
  songListPage.hidden = true;
  try {
    const midi = await loadSongFile(filename);
    await pianoPage.enterAndPlay(midi);
  } catch {
    alert(`加载歌曲失败：${filename}`);
  }
}

async function goPractice(filename: string): Promise<void> {
  stopPreview();
  await new Promise(r => setTimeout(r, 80));
  pianoPage.currentSongFile = filename;
  pianoPage.currentSongName = filename.replace(/\.(mid|midi)$/i, '');
  pianoPage.pianoPageEl.hidden = false;
  songListPage.hidden = true;
  try {
    const midi = await loadSongFile(filename);
    await pianoPage.enterPractice(midi);
  } catch {
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
    const name = f.replace(/\.(mid|midi)$/i, '');
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
      pianoPage.progressTime.textContent = `${formatTimeSec(t)} / ${formatTimeSec(pianoPage.totalDurationSec)}`;
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

function formatTimeSec(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

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
