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
import { playheadXInMeasureOverlay, renderGrandStaffRow, type GrandStaffColumn } from './renderScore';
import { createFallingNotesLane } from './fallingNotes';
import { applyKeyVisuals, createPianoKeyboard } from './pianoKeyboard';
import { playNotes, type PlaybackController } from './playback';
import { startKeyboardPractice } from './keyboardPractice';
import { ensureSalamanderPiano, playPianoMidi, releaseAllPiano } from './salamanderPiano';

const app = document.querySelector<HTMLDivElement>('#app')!;

app.innerHTML = `
  <!-- ===== 选歌页 ===== -->
  <div id="song-list-page" class="page">
    <header class="song-list-header">
      <h1 class="song-list-title">🎹 MIDI Piano</h1>
      <p class="song-list-subtitle">选择一首歌曲开始练习</p>
    </header>
    <div class="song-list-body">
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

  <!-- ===== 钢琴页 ===== -->
  <div id="piano-page" class="page" hidden>
    <header class="toolbar">
      <h1 class="title">MIDI 乐谱</h1>
      <span id="measure-info" class="measure-info"></span>
      <div class="toolbar-actions">
        <button type="button" id="btn-back" class="btn secondary">← 返回</button>
        <div class="mode-group">
          <span>模式</span>
          <label><input type="radio" name="play-mode" value="auto" checked /> 自动播放</label>
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
        <p class="hint" id="keyboard-hint"></p>
        <div id="keyboard-stack" class="keyboard-stack">
          <div id="keyboard-host"></div>
        </div>
      </section>
    </main>
  </div>
`;

/* ── DOM 引用 ── */

const songListPage = document.querySelector<HTMLDivElement>('#song-list-page')!;
const pianoPage = document.querySelector<HTMLDivElement>('#piano-page')!;
const songList = document.querySelector<HTMLDivElement>('#song-list')!;
const fileInput = document.querySelector<HTMLInputElement>('#midi-file')!;
const btnBack = document.querySelector<HTMLButtonElement>('#btn-back')!;
const scoreEl = document.querySelector<HTMLDivElement>('#score')!;
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

let currentMidi: Midi | null = null;
let flatNotes: FlatNote[] = [];
let keyEls = createPianoKeyboard(keyboardHost);
let playback: PlaybackController | null = null;
let midiAccess: MIDIAccess | null = null;
let totalDurationSec = 0;
let seeking = false;

/* ── 页面切换 ── */

function showSongList() {
  stopPreview();
  pianoPage.hidden = true;
  songListPage.hidden = false;
  stopPlayback();
  refreshSongList();
}

async function enterPianoPageAndPlay(midi: Midi) {
  stopPreview();
  songListPage.hidden = true;
  pianoPage.hidden = false;
  renderAll(midi);
  // 切换到自动模式并立即播放
  const autoRadio = document.querySelector<HTMLInputElement>('input[name="play-mode"][value="auto"]');
  if (autoRadio) autoRadio.checked = true;
  syncModeUi();
  await startPlayFrom(0);
}

btnBack.addEventListener('click', showSongList);

/* ── 歌曲列表（音游式选择） ── */

let songFiles: string[] = [];
let selectedIndex = 0;

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
      item.innerHTML = `
        <span class="song-list-index">${i + 1}</span>
        <span class="song-list-body-col">
          <span class="song-list-name">${name}</span>
          <span class="song-list-stars">${stars}</span>
          ${meta}
        </span>
        <span class="song-list-arrow">▶</span>
      `;
      item.addEventListener('click', () => loadAndGo(f));
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

function getPlayMode(): 'auto' | 'keyboard' {
  const el = document.querySelector<HTMLInputElement>('input[name="play-mode"]:checked');
  return el?.value === 'keyboard' ? 'keyboard' : 'auto';
}

function updateKeyboardHint() {
  keyboardHint.textContent =
    getPlayMode() === 'auto'
      ? '根据 MIDI 生成的五线谱（高音 / 低音谱表）。琴键上方为下落式音符（绿左 / 蓝右；白键稍亮、黑键更深），与跟弹共用同一套下落与缩短节奏，落线时刻与发声对齐。键盘高亮同上。'
      : 'MIDI 跟弹：绿色 / 蓝色描边为当前应弹的左 / 右手音；上方条先落到判定线再等你按键，弹对后条缩短并发声前进；紫红色外圈为正在按下的键，错音不出声。';
}

function syncModeUi() {
  midiRow.hidden = getPlayMode() !== 'keyboard';
  updateKeyboardHint();
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

function hideScorePlayhead() {
  for (const ph of scoreEl.querySelectorAll<HTMLElement>('.playhead')) {
    ph.classList.remove('is-visible');
  }
}

function updateMeasureInfo(current: number, total: number) {
  if (total <= 0) {
    measureInfoEl.textContent = '';
    return;
  }
  measureInfoEl.textContent = `第 ${current + 1} / ${total} 小节`;
}

function scrollMeasureIntoView(measureIndex: number) {
  const el = scoreEl.querySelector<HTMLElement>(`.score-measure[data-measure-index="${measureIndex}"]`);
  if (!el) return;
  el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

function updateScorePlayhead(timeSec: number) {
  const st = scorePagerState;
  const midi = currentMidi;
  if (!st || !midi) {
    hideScorePlayhead();
    return;
  }
  if (timeSec >= midi.duration - 1e-3) {
    hideScorePlayhead();
    return;
  }
  const ctx = st.ctx;
  const ticks = midi.header.secondsToTicks(Math.max(0, timeSec));
  let m = Math.floor(ticks / ctx.ticksPerMeasure);
  if (m < 0) m = 0;
  if (m >= st.nMeas) m = st.nMeas - 1;
  updateMeasureInfo(m, st.nMeas);
  scrollMeasureIntoView(m);
  const measureStartTick = m * ctx.ticksPerMeasure;
  const progress = Math.min(1, Math.max(0, (ticks - measureStartTick) / ctx.ticksPerMeasure));
  const w = st.measureWidth;
  const colInRow = m % st.measuresPerRow;
  for (const row of scoreEl.querySelectorAll<HTMLElement>('.score-measure')) {
    const ph = row.querySelector<HTMLElement>('.playhead');
    if (!ph) continue;
    const midx = Number(row.dataset.measureIndex);
    if (midx !== m) {
      ph.classList.remove('is-visible');
      continue;
    }
    const hasHeader = row.dataset.hasStaffHeader === '1';
    ph.style.left = `${playheadXInMeasureOverlay(st.measuresPerRow, w, colInRow, hasHeader, progress)}px`;
    ph.classList.add('is-visible');
  }
}

interface ScorePagerState {
  ctx: MeasureContext;
  midi: Midi;
  nMeas: number;
  measuresPerRow: number;
  width: number;
  measureWidth: number;
}

let scorePagerState: ScorePagerState | null = null;

const SCORE_LAYOUT = {
  measuresPerRow: 2,
} as const;

function measureWidthForRow(totalWidthPx: number, measuresPerRow: number): number {
  const n = Math.max(1, measuresPerRow);
  return Math.max(160, Math.floor(totalWidthPx / n));
}

function renderScoreMeasuresInRows(
  parent: HTMLElement,
  fromIdx: number,
  toIdxExclusive: number,
  measuresPerRow: number,
  measureWidth: number,
  ctx: MeasureContext,
  midi: Midi,
) {
  for (let start = fromIdx; start < toIdxExclusive; start += measuresPerRow) {
    const rowWrap = document.createElement('div');
    rowWrap.className = 'score-measure-row';
    parent.appendChild(rowWrap);
    const end = Math.min(toIdxExclusive, start + measuresPerRow);
    const columns: GrandStaffColumn[] = [];
    for (let i = start; i < end; i++) {
      columns.push({
        measureIndex: i,
        trebleAtoms: buildAtomsForHand(flatNotes, midi, 'treble', ctx, i),
        bassAtoms: buildAtomsForHand(flatNotes, midi, 'bass', ctx, i),
        showStaffHeader: i === start,
      });
    }
    renderGrandStaffRow(rowWrap, columns, ctx, measureWidth);
  }
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
  const ctx = getMeasureContext(midi);
  const nMeas = measureCount(midi, ctx);
  const w = Math.min(760, Math.floor(window.innerWidth - 40));
  const measuresPerRow = Math.max(1, SCORE_LAYOUT.measuresPerRow);
  const measureWidth = measureWidthForRow(w, measuresPerRow);

  scorePagerState = { ctx, midi, nMeas, measuresPerRow, width: w, measureWidth };

  updateMeasureInfo(0, nMeas);

  scoreEl.classList.remove('score--paginated');
  scoreEl.innerHTML = '';
  scorePagerEl.hidden = true;
  renderScoreMeasuresInRows(scoreEl, 0, nMeas, measuresPerRow, measureWidth, ctx, midi);

  const range = noteRange(flatNotes);
  keyEls = createPianoKeyboard(keyboardHost, range.min, range.max);
  fallingNotes.setRange(range.min, range.max);
  fallingNotes.setSource(flatNotes, midi);
  fallingNotes.clear();

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

  const onPlaybackEnded = () => {
    hideScorePlayhead();
    fallingNotes.clear();
    btnPlay.disabled = false;
    btnStop.disabled = true;
    playback = null;
    resetProgressBar();
  };

  try {
    await ensureSalamanderPiano();
  } catch {
    alert('音频引擎初始化失败，请刷新页面重试。');
    onPlaybackEnded();
    return;
  }

  if (getPlayMode() === 'auto') {
    const sorted = [...flatNotes].sort((a, b) => {
      const ha = assignHandForNote(a, currentMidi!);
      const hb = assignHandForNote(b, currentMidi!);
      if (ha !== hb) return ha === 'treble' ? -1 : 1;
      return a.time - b.time || a.midi - b.midi;
    });
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
    );
    return;
  }

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
});

progressBar.addEventListener('change', () => {
  seeking = false;
  if (!currentMidi || flatNotes.length === 0) return;
  const pct = Number(progressBar.value) / 1000;
  const timeSec = pct * totalDurationSec;
  updateProgressBar(timeSec);
  if (wasPlayingBeforeSeek && getPlayMode() === 'auto') {
    wasPlayingBeforeSeek = false;
    startPlayFrom(timeSec);
  } else {
    wasPlayingBeforeSeek = false;
  }
});

btnStop.addEventListener('click', () => {
  stopPlayback();
});

syncModeUi();
showSongList();
