import './style.css';
import { Midi } from '@tonejs/midi';
import { createDemoMidi } from './demoMidi';
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
import { ensureSalamanderPiano } from './salamanderPiano';

const app = document.querySelector<HTMLDivElement>('#app')!;

app.innerHTML = `
  <header class="toolbar">
    <h1 class="title">MIDI 乐谱</h1>
    <span id="measure-info" class="measure-info"></span>
    <div class="toolbar-actions">
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
      <label class="file-btn">
        打开 MIDI
        <input type="file" id="midi-file" accept=".mid,.midi,audio/midi" hidden />
      </label>
      <button type="button" id="btn-demo" class="btn secondary">示例：欢乐颂</button>
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
      <p class="hint" id="keyboard-hint">根据 MIDI 生成的五线谱（高音 / 低音谱表）与键盘高亮</p>
      <div id="keyboard-stack" class="keyboard-stack">
        <div id="keyboard-host"></div>
      </div>
    </section>
  </main>
`;

const scoreEl = document.querySelector<HTMLDivElement>('#score')!;
const scorePagerEl = document.querySelector<HTMLDivElement>('#score-pager')!;
const fileInput = document.querySelector<HTMLInputElement>('#midi-file')!;
const btnDemo = document.querySelector<HTMLButtonElement>('#btn-demo')!;
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

/* ── 进度条 ── */

function formatTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function updateProgressBar(timeSec: number) {
  if (seeking) return; // 拖拽中不覆盖用户输入
  const pct = totalDurationSec > 0 ? (timeSec / totalDurationSec) * 1000 : 0;
  progressBar.value = String(Math.round(pct));
  progressTime.textContent = `${formatTime(timeSec)} / ${formatTime(totalDurationSec)}`;
}

/** 在进度条靠近末尾时提前跳回 0 的小阈值 */
function resetProgressBar() {
  progressBar.value = '0';
  progressTime.textContent = `0:00 / ${formatTime(totalDurationSec)}`;
}

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

/** 播放时自动滚动，使当前小节可见 */
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
  const progress = Math.min(
    1,
    Math.max(0, (ticks - measureStartTick) / ctx.ticksPerMeasure),
  );
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

/** 乐谱版面：改这里即可调整每行小节数 */
const SCORE_LAYOUT = {
  /** 同一行（同一系统）内并排的小节数 */
  measuresPerRow: 2,
} as const;

/** 每小节占位宽度（同一行内小节在一张 SVG 中相接，不再预留 HTML 间隙） */
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

  scorePagerState = {
    ctx,
    midi,
    nMeas,
    measuresPerRow,
    width: w,
    measureWidth,
  };

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

for (const r of document.querySelectorAll<HTMLInputElement>('input[name="play-mode"]')) {
  r.addEventListener('change', () => {
    stopPlayback();
    syncModeUi();
  });
}

btnMidiRefresh.addEventListener('click', async () => {
  const access = await ensureMidiAccess();
  if (!access) {
    alert('无法访问 MIDI（浏览器不支持或权限被拒绝）。建议使用 Chrome / Edge。');
    return;
  }
  refillMidiSelect();
});

fileInput.addEventListener('change', async () => {
  const f = fileInput.files?.[0];
  if (!f) return;
  stopPlayback();
  const buf = await f.arrayBuffer();
  const midi = new Midi(buf);
  renderAll(midi);
  fileInput.value = '';
});

btnDemo.addEventListener('click', () => {
  stopPlayback();
  renderAll(createDemoMidi());
});

btnPlay.addEventListener('click', async () => {
  if (!currentMidi || flatNotes.length === 0) return;
  startPlayFrom(0);
});

/** 从指定秒偏移处开始播放 */
let lastAutoSorted: FlatNote[] = [];

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
    lastAutoSorted = sorted;

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

progressBar.addEventListener('input', () => {
  seeking = true;
});

progressBar.addEventListener('change', () => {
  seeking = false;
  if (!currentMidi || getPlayMode() !== 'auto' || flatNotes.length === 0) return;
  const pct = Number(progressBar.value) / 1000;
  const timeSec = pct * totalDurationSec;
  updateProgressBar(timeSec);
  if (playback) {
    startPlayFrom(timeSec);
  }
});

btnStop.addEventListener('click', () => {
  stopPlayback();
});

syncModeUi();
renderAll(createDemoMidi());
