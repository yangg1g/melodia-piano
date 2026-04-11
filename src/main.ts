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
import { applyKeyVisuals, createPianoKeyboard } from './pianoKeyboard';
import { playNotes, type PlaybackController } from './playback';
import { startKeyboardPractice } from './keyboardPractice';
import { ensureSalamanderPiano } from './salamanderPiano';

const app = document.querySelector<HTMLDivElement>('#app')!;

app.innerHTML = `
  <header class="toolbar">
    <h1 class="title">MIDI 乐谱</h1>
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
const midiRow = document.querySelector<HTMLDivElement>('#midi-row')!;
const midiInputSelect = document.querySelector<HTMLSelectElement>('#midi-input')!;
const btnMidiRefresh = document.querySelector<HTMLButtonElement>('#btn-midi-refresh')!;
const keyboardHint = document.querySelector<HTMLParagraphElement>('#keyboard-hint')!;

let currentMidi: Midi | null = null;
let flatNotes: FlatNote[] = [];
let keyEls = createPianoKeyboard(keyboardHost);
let playback: PlaybackController | null = null;
let midiAccess: MIDIAccess | null = null;

function getPlayMode(): 'auto' | 'keyboard' {
  const el = document.querySelector<HTMLInputElement>('input[name="play-mode"]:checked');
  return el?.value === 'keyboard' ? 'keyboard' : 'auto';
}

function updateKeyboardHint() {
  keyboardHint.textContent =
    getPlayMode() === 'auto'
      ? '根据 MIDI 生成的五线谱（高音 / 低音谱表）。键盘：左手（低音谱）绿色、右手（高音谱）蓝色表示正在发声的音。'
      : 'MIDI 跟弹：绿色 / 蓝色描边为当前应弹的左 / 右手音；紫红色外圈为键盘上正在按下的键；弹对后才会发声并前进，错音不出声。';
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
  const ctx = st.ctx;
  const ticks = midi.header.secondsToTicks(Math.max(0, timeSec));
  let m = Math.floor(ticks / ctx.ticksPerMeasure);
  if (m < 0) m = 0;
  if (m >= st.nMeas) m = st.nMeas - 1;
  ensureMeasurePageVisible(m);
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
  applyKeyVisuals(keyEls, {});
  btnPlay.disabled = false;
  btnStop.disabled = true;
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
  stopPlayback();
  btnPlay.disabled = true;
  btnStop.disabled = false;

  const onPlaybackEnded = () => {
    hideScorePlayhead();
    btnPlay.disabled = false;
    btnStop.disabled = true;
    playback = null;
  };

  try {
    await ensureSalamanderPiano();
  } catch {
    alert('钢琴音色采样加载失败，请检查网络后重试（需访问 Tone.js 的采样 CDN）。');
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
      (t) => updateScorePlayhead(t),
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
    (t) => updateScorePlayhead(t),
  );
});

btnStop.addEventListener('click', () => {
  stopPlayback();
});

syncModeUi();
renderAll(createDemoMidi());
