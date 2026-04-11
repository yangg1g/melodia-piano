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
import { renderGrandStaffRow, type GrandStaffColumn } from './renderScore';
import { createPianoKeyboard, setActiveKeys } from './pianoKeyboard';
import { playNotes, type PlaybackController } from './playback';

const app = document.querySelector<HTMLDivElement>('#app')!;

app.innerHTML = `
  <header class="toolbar">
    <h1 class="title">MIDI 乐谱</h1>
    <div class="toolbar-actions">
      <label class="file-btn">
        打开 MIDI
        <input type="file" id="midi-file" accept=".mid,.midi,audio/midi" hidden />
      </label>
      <button type="button" id="btn-demo" class="btn secondary">示例：欢乐颂</button>
      <button type="button" id="btn-play" class="btn primary">播放</button>
      <button type="button" id="btn-stop" class="btn secondary" disabled>停止</button>
    </div>
  </header>
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
      <p class="hint">根据 MIDI 生成的五线谱（高音 / 低音谱表）与键盘高亮</p>
      <div id="keyboard-host"></div>
    </section>
  </main>
`;

const scoreScroll = document.querySelector<HTMLDivElement>('#score-scroll')!;
const scoreEl = document.querySelector<HTMLDivElement>('#score')!;
const scorePagerEl = document.querySelector<HTMLDivElement>('#score-pager')!;
const scorePageInfo = document.querySelector<HTMLSpanElement>('#score-page-info')!;
const btnScorePrev = document.querySelector<HTMLButtonElement>('#score-prev')!;
const btnScoreNext = document.querySelector<HTMLButtonElement>('#score-next')!;
const fileInput = document.querySelector<HTMLInputElement>('#midi-file')!;
const btnDemo = document.querySelector<HTMLButtonElement>('#btn-demo')!;
const btnPlay = document.querySelector<HTMLButtonElement>('#btn-play')!;
const btnStop = document.querySelector<HTMLButtonElement>('#btn-stop')!;
const keyboardHost = document.querySelector<HTMLDivElement>('#keyboard-host')!;

let currentMidi: Midi | null = null;
let flatNotes: FlatNote[] = [];
let keyEls = createPianoKeyboard(keyboardHost);
let playback: PlaybackController | null = null;

/** 与 VexFlow System(x≈12、有/无谱号区) 大致对齐的横向映射 */
function playheadXInScorePx(scoreWidth: number, progress01: number, hasStaffHeader: boolean): number {
  const left = hasStaffHeader ? 96 : 14;
  const right = 18;
  const span = Math.max(12, scoreWidth - left - right);
  return left + Math.min(1, Math.max(0, progress01)) * span;
}

function hideScorePlayhead() {
  for (const ph of scoreEl.querySelectorAll<HTMLElement>('.playhead')) {
    ph.classList.remove('is-visible');
  }
}

function ensureMeasurePageVisible(measureIndex: number) {
  const st = scorePagerState;
  if (!st || st.totalPages <= 1) return;
  const page = Math.floor(measureIndex / st.perPage);
  if (page >= 0 && page < st.totalPages && page !== st.currentPage) {
    st.currentPage = page;
    renderCurrentScorePage();
  }
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
  const spm = st.ctx.secPerMeasure;
  let m = Math.floor(timeSec / spm);
  if (m < 0) m = 0;
  if (m >= st.nMeas) m = st.nMeas - 1;
  ensureMeasurePageVisible(m);
  const local = timeSec - m * spm;
  const progress = Math.min(1, Math.max(0, local / spm));
  const w = st.measureWidth;
  for (const row of scoreEl.querySelectorAll<HTMLElement>('.score-measure')) {
    const ph = row.querySelector<HTMLElement>('.playhead');
    if (!ph) continue;
    const midx = Number(row.dataset.measureIndex);
    if (midx !== m) {
      ph.classList.remove('is-visible');
      continue;
    }
    const hasHeader = row.dataset.hasStaffHeader === '1';
    const colOff = Number(row.dataset.columnOffsetPx || 0);
    ph.style.left = `${colOff + playheadXInScorePx(w, progress, hasHeader)}px`;
    ph.classList.add('is-visible');
  }
}

interface ScorePagerState {
  ctx: MeasureContext;
  midi: Midi;
  nMeas: number;
  measuresPerRow: number;
  perPage: number;
  totalPages: number;
  currentPage: number;
  width: number;
  measureWidth: number;
}

let scorePagerState: ScorePagerState | null = null;

/** 乐谱版面：改这里即可调整每行、每页小节数 */
const SCORE_LAYOUT = {
  /** 同一行（同一系统）内并排的小节数 */
  measuresPerRow: 2,
  /** 分页时每页的小节总数（应 ≥ measuresPerRow，且建议为 measuresPerRow 的整数倍以便排满行） */
  measuresPerPage: 4,
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

function updateScorePagerUi() {
  const st = scorePagerState;
  if (!st) {
    scorePagerEl.hidden = true;
    return;
  }
  const show = st.totalPages > 1;
  scorePagerEl.hidden = !show;
  scorePageInfo.textContent = show ? `第 ${st.currentPage + 1} / ${st.totalPages} 页` : '';
  btnScorePrev.disabled = !show || st.currentPage <= 0;
  btnScoreNext.disabled = !show || st.currentPage >= st.totalPages - 1;
}

/** 只渲染当前页的小节（多页时每次仅一页在 DOM 中） */
function renderCurrentScorePage() {
  const st = scorePagerState;
  if (!st) return;
  const { ctx, midi, nMeas, measuresPerRow, perPage, currentPage, measureWidth } = st;
  scoreEl.innerHTML = '';
  const start = currentPage * perPage;
  const end = Math.min(nMeas, start + perPage);

  if (st.totalPages > 1) {
    scoreEl.classList.add('score--paginated');
    const wrap = document.createElement('div');
    wrap.className = 'score-page';
    const inner = document.createElement('div');
    inner.className = 'score-page-measures';
    wrap.appendChild(inner);
    scoreEl.appendChild(wrap);
    renderScoreMeasuresInRows(inner, start, end, measuresPerRow, measureWidth, ctx, midi);
  }

  updateScorePagerUi();
  scoreScroll.scrollTop = 0;
}

function renderAll(midi: Midi) {
  currentMidi = midi;
  flatNotes = flattenNotes(midi);
  const ctx = getMeasureContext(midi);
  const nMeas = measureCount(midi, ctx);
  const w = Math.min(760, Math.floor(window.innerWidth - 40));
  const measuresPerRow = Math.max(1, SCORE_LAYOUT.measuresPerRow);
  const perPage = Math.max(1, SCORE_LAYOUT.measuresPerPage);
  const measureWidth = measureWidthForRow(w, measuresPerRow);
  const totalPages = Math.max(1, Math.ceil(nMeas / perPage));

  scorePagerState = {
    ctx,
    midi,
    nMeas,
    measuresPerRow,
    perPage,
    totalPages,
    currentPage: 0,
    width: w,
    measureWidth,
  };

  scoreEl.innerHTML = '';
  if (totalPages <= 1) {
    scoreEl.classList.remove('score--paginated');
    renderScoreMeasuresInRows(scoreEl, 0, nMeas, measuresPerRow, measureWidth, ctx, midi);
    updateScorePagerUi();
  } else {
    renderCurrentScorePage();
  }

  const range = noteRange(flatNotes);
  keyEls = createPianoKeyboard(keyboardHost, range.min, range.max);
}

function goScorePage(delta: number) {
  const st = scorePagerState;
  if (!st || st.totalPages <= 1) return;
  const next = st.currentPage + delta;
  if (next < 0 || next >= st.totalPages) return;
  st.currentPage = next;
  renderCurrentScorePage();
}

btnScorePrev.addEventListener('click', () => goScorePage(-1));
btnScoreNext.addEventListener('click', () => goScorePage(1));

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

function stopPlayback() {
  playback?.stop();
  playback = null;
  hideScorePlayhead();
  setActiveKeys(keyEls, new Set());
  btnPlay.disabled = false;
  btnStop.disabled = true;
}

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

btnPlay.addEventListener('click', () => {
  if (!currentMidi || flatNotes.length === 0) return;
  stopPlayback();
  btnPlay.disabled = true;
  btnStop.disabled = false;
  const sorted = [...flatNotes].sort((a, b) => {
    const ha = assignHandForNote(a, currentMidi!);
    const hb = assignHandForNote(b, currentMidi!);
    if (ha !== hb) return ha === 'treble' ? -1 : 1;
    return a.time - b.time || a.midi - b.midi;
  });
  playback = playNotes(
    sorted,
    currentMidi.duration,
    (active) => setActiveKeys(keyEls, active),
    () => {
      hideScorePlayhead();
      btnPlay.disabled = false;
      btnStop.disabled = true;
      playback = null;
    },
    (t) => updateScorePlayhead(t),
  );
});

btnStop.addEventListener('click', () => {
  stopPlayback();
});

renderAll(createDemoMidi());
