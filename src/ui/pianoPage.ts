/**
 * 钢琴页 —— 核心编排：渲染、播放、编辑、练习
 */
import { Midi } from '@tonejs/midi';
import {
  assignHandForNote,
  buildAtomsForHand,
  flattenNotes,
  getMeasureContext,
  measureCount,
  assignNoteKeys,
  type FlatNote,
  type Hand,
} from '../core/midiScore';
import { playheadXInMeasureOverlay, renderGrandStaffRow, renderGrandStaffRowSVG, renderStaveHead, staffNoteY, type GrandStaffColumn } from '../rendering/renderScore';
import { NOTE_COLORS } from '../core/pitchUtil';
import { applyKeyVisuals, createPianoKeyboard, isWhiteKey } from '../rendering/pianoKeyboard';
import { autoAssignFingers } from '../core/fingerAssigner';
import { detectChord } from '../core/chordDetector';
import type { FallingNotesHandle } from '../rendering/fallingNotes';
import { playNotes, type PlaybackController } from '../features/playback';
import { startKeyboardPractice } from '../features/keyboardPractice';
import { createStaffEditState, type EditTool } from '../features/staffEditor';
import { ScoringEngine } from '../core/scoring';
import type { NoteState } from '../core/midiMatchEngine';
import { ensurePiano } from '../audio/salamanderPiano';
import type { PlayMode, PlayHistoryEntry } from '../core/types';
import { loadSettings } from './settings';
import { addHistoryEntry, getHistoryForSong } from './history';
import { showResultScreen, type ResultPageElements } from './resultScreen';
import { countdown } from './countdown';
import { updateProgressBar, resetProgressBar, formatTime } from './progressBar';
import { updateScoreUI, resetScoreUI } from './scoreDisplay';
import { MidiSetup } from './midiSetup';
import { PracticeControls, type MeasureErrorInfo } from './practiceControls';
import { renderLiveAccuracyChart, renderLiveTimelineChart, renderLiveErrorChart, renderLiveTimeRatioChart, updateTimingDots, updateLiveAccuracyFromEngine } from './pianoCharts';
import {
  toggleEditMode,
  setEditTool,
  handleStemToggle,
  saveEdits,
  saveToJson,
  handleEditKeydown,
  handleScoreMouseDown,
  handleScoreMouseMove,
  handleScoreMouseUp,
  createFingerMenu,
  handleScoreContextMenu,
  handleScoreNoteClick,
  hideFingerMenu,
  handleFallingNoteClick,
} from './pianoEdit';

/* ── 常量 ── */
const SCORE_LAYOUT = { measuresPerRow: 2 } as const;

interface ScorePagerState {
  ctx: ReturnType<typeof getMeasureContext>;
  midi: Midi;
  nMeas: number;
  measureWidth: number;
  /** 谱线起点（高音谱表 y），仅 image 模式有值 */
  y0?: number;
  /** 乐谱画布高度，仅 image 模式有值 */
  canvasHeight?: number;
  /** 自动缩放比例（<1 表示缩小以适配容器高度），仅 image 模式有值 */
  scaleY?: number;
  /** 垂直居中平移（px），仅 image 模式有值；屏幕 y = 原始 y * scaleY + yOffset */
  yOffset?: number;
}

/* ── Piano 页状态 ── */
export class PianoPage {
  // 曲谱状态
  currentMidi: Midi | null = null;
  flatNotes: FlatNote[] = [];
  totalDurationSec = 0;
  currentSongFile: string | null = null;
  currentSongName = '';

  // DOM 引用
  pianoPageEl: HTMLDivElement;
  scoreEl: HTMLDivElement;
  scoreScrollEl: HTMLDivElement;
  scorePagerEl: HTMLDivElement;
  keyboardHost: HTMLDivElement;
  keyboardStack: HTMLDivElement;
  keyboardHint: HTMLParagraphElement;
  chordSidePanel: HTMLDivElement;
  chordDisplay: HTMLDivElement;
  chordDisplayNotes: HTMLSpanElement;
  chordDisplayChord: HTMLSpanElement;
  measureInfoEl: HTMLSpanElement;
  progressBar: HTMLInputElement;
  progressTime: HTMLSpanElement;
  practiceTime: HTMLSpanElement;
  scoreDisplay: HTMLDivElement;

  // 按钮
  btnPlay: HTMLButtonElement;
  btnStop: HTMLButtonElement;
  btnEdit: HTMLButtonElement;
  btnFinger: HTMLButtonElement;
  btnSlur: HTMLButtonElement;
  btnTie: HTMLButtonElement;
  btnStem: HTMLButtonElement;
  btnSaveEdits: HTMLButtonElement;
  editToolbar: HTMLDivElement;

  // 渲染组件
  keyEls: Map<number, HTMLElement>;
  fallingNotes: FallingNotesHandle;
  scoringEngine = new ScoringEngine();
  /** 当前曲谱的指法映射表（MIDI → 手指编号 1-5） */
  currentFingerMap: Map<number, number> = new Map();

  // 播放状态
  playback: PlaybackController | null = null;
  seeking = false;
  finalWallTimeSec = 0;
  /** 当前游戏时间（秒），供实时准度图表使用 */
  lastGameTimeSec = 0;
  /** 最后一次键盘弹奏的录制事件（用于回放） */
  lastRecordedEvents: import('../features/playback').MidiEventRecord[] = [];
  /** 最后一次弹奏的模式（用于回放时匹配正确的 freePlay） */
  lastRecordedMode: string = '';

  // 乐谱状态
  scorePagerState: ScorePagerState | null = null;
  staffEditState = createStaffEditState();
  editModeActive = false;

  /** 跟弹模式：五线谱实时按键高亮（直接修改 SVG 音符元素，无叠加图片） */
  private staffLivePressed = new Set<number>();
  private staffLiveNotes: NoteState[] = [];
  private staffLiveTimeSec = 0;
  /** 全曲音符时间线（时间 → 滚动条内 x，按时间排序去重），供滚动精确对齐 */
  private staffNoteTimeline: Array<{ t: number; x: number }> = [];
  /** atom 键（小节:手:atom）→ SVG 音符组元素 */
  private staffAtomEls = new Map<string, SVGElement>();
  /** 当前被高亮的音符元素 */
  private staffHighlightedEls: SVGElement[] = [];
  /** 引擎判定的错键集合（按住期间保持红色） */
  private staffWrongMidis = new Set<number>();
  /** 临时错键红色音符元素 */
  private staffWrongNoteEls: Element[] = [];
  /** 自动缩放：五线谱 SVG / 固定谱头 SVG 与内容包围盒（供窗口高度变化时重新适配） */
  private scoreFitSvg: SVGSVGElement | null = null;
  private scoreFitHeadSvg: SVGSVGElement | null = null;
  private scoreFitBB: { y: number; height: number } | null = null;
  /** 自适应缩放：逐音符 y 范围（按 x 升序），供按当前视图计算目标缩放 */
  private staffFitAtoms: Array<{ x: number; top: number; bottom: number }> = [];
  /** 平滑后的当前状态（指数平滑，保证缩放/位移衔接光滑） */
  private staffFitSmooth = { s: 1, top: 0, h: 0, lastTx: Number.NEGATIVE_INFINITY };
  /** 谱表本身的范围（任何视图都含谱表，作为并集下限） */
  private staffFitStaveTop = 0;
  private staffFitStaveBottom = 0;
  private staffFitRaf = 0;
  private staffFitLastT = 0;
  private staffFitHeadW = 0;
  editTool: EditTool = 'select';
  selectedNoteKeys = new Set<string>();
  selDragStart: { x: number; y: number } | null = null;
  selRectEl: HTMLDivElement | null = null;
  /** 右键指法弹出菜单 */
  fingerMenuEl: HTMLDivElement;
  /** 当前右键点击的音符 noteKey */
  fingerMenuNoteKey: string | null = null;

  // 乐谱状态
  // 练习模式
  practice = new PracticeControls({
    controlsBar: document.querySelector<HTMLDivElement>('#practice-controls-bar')!,
    startLabel: document.querySelector<HTMLInputElement>('#practice-start-label')!,
    endLabel: document.querySelector<HTMLInputElement>('#practice-end-label')!,
    loopCounter: document.querySelector<HTMLSpanElement>('#practice-loop-counter')!,
    loopBest: document.querySelector<HTMLSpanElement>('#practice-loop-best')!,
    startDec: document.querySelector<HTMLButtonElement>('#practice-start-dec')!,
    startInc: document.querySelector<HTMLButtonElement>('#practice-start-inc')!,
    endDec: document.querySelector<HTMLButtonElement>('#practice-end-dec')!,
    endInc: document.querySelector<HTMLButtonElement>('#practice-end-inc')!,
    sidePanel: document.querySelector<HTMLDivElement>('#practice-side-panel')!,
    sideHeader: document.querySelector<HTMLDivElement>('#practice-side-header')!,
    sideScores: document.querySelector<HTMLDivElement>('#practice-side-scores')!,
    progressBar: document.querySelector<HTMLInputElement>('#progress-bar')!,
    leftPanel: document.querySelector<HTMLDivElement>('#practice-left-panel')!,
    leftContent: document.querySelector<HTMLDivElement>('#practice-left-content')!,
    groupSizeInput: document.querySelector<HTMLInputElement>('#practice-group-size-input')!,
  });
  practiceActive = false;
  practiceRestarting = false;
  practiceLoopNotes: FlatNote[] = [];
  practiceLoopStartFn: (() => void) | null = null;
  practiceLoopDurationSec = 0;
  /** 当前练习循环在原曲中的起始时间（秒），用于将 loop-relative NoteResult.time 映射回原曲小节 */
  private practiceLoopStartTimeSec = 0;
  practiceCurrentWallSec = 0;

  // 计分 UI 元素
  scoreValueEl: HTMLSpanElement;
  scoreAccuEl: HTMLSpanElement;
  scoreComboEl: HTMLSpanElement;
  scoreJudgeEl: HTMLSpanElement;
  scoreWrongEl: HTMLSpanElement;
  scoreSidePanel: HTMLDivElement;
  centerJudgeEl: HTMLDivElement;

  // 结果页
  resultElements: ResultPageElements;

  // 实时准度面板
  liveAccuracyPanel: HTMLDivElement;
  liveAccuracyCanvas: HTMLCanvasElement;
  liveTimelineCanvas: HTMLCanvasElement;
  liveErrorCanvas: HTMLCanvasElement;
  /** 用时占比面板 */
  liveTimeRatioSection: HTMLDivElement;
  liveTimeRatioCanvas: HTMLCanvasElement;
  /** 实时准度数据点（时间, 准确率） */
  liveAccuracyPoints: Array<{ timeSec: number; accuracy: number }> = [];
  /** 用时占比数据点（游戏时间, 实际耗时比例%） */
  liveTimeRatioPoints: Array<{ gameSec: number; ratio: number }> = [];

  // MIDI 设备
  midiSetup: MidiSetup;

  // 回调
  onGoBack?: () => void;

  constructor(elements: {
    pianoPageEl: HTMLDivElement;
    scoreEl: HTMLDivElement;
    scoreScrollEl: HTMLDivElement;
    scorePagerEl: HTMLDivElement;
    keyboardHost: HTMLDivElement;
    keyboardStack: HTMLDivElement;
    keyboardHint: HTMLParagraphElement;
    chordSidePanel: HTMLDivElement;
    chordDisplay: HTMLDivElement;
    chordDisplayNotes: HTMLSpanElement;
    chordDisplayChord: HTMLSpanElement;
    measureInfoEl: HTMLSpanElement;
    progressBar: HTMLInputElement;
    progressTime: HTMLSpanElement;
    practiceTime: HTMLSpanElement;
    scoreDisplay: HTMLDivElement;
    btnPlay: HTMLButtonElement;
    btnStop: HTMLButtonElement;
    btnEdit: HTMLButtonElement;
    btnFinger: HTMLButtonElement;
    btnSlur: HTMLButtonElement;
    btnTie: HTMLButtonElement;
    btnStem: HTMLButtonElement;
    btnSaveEdits: HTMLButtonElement;
    editToolbar: HTMLDivElement;
    scoreValueEl: HTMLSpanElement;
    scoreAccuEl: HTMLSpanElement;
    scoreComboEl: HTMLSpanElement;
    scoreJudgeEl: HTMLSpanElement;
    scoreWrongEl: HTMLSpanElement;
    scoreSidePanel: HTMLDivElement;
    resultElements: ResultPageElements;
    midiSetup: MidiSetup;
    fallingNotes: FallingNotesHandle;
    liveAccuracyPanel: HTMLDivElement;
    liveAccuracyCanvas: HTMLCanvasElement;
    liveTimelineCanvas: HTMLCanvasElement;
    liveErrorCanvas: HTMLCanvasElement;
    centerJudgeEl: HTMLDivElement;
    liveTimeRatioSection: HTMLDivElement;
    liveTimeRatioCanvas: HTMLCanvasElement;
  }) {
    this.pianoPageEl = elements.pianoPageEl;
    this.scoreEl = elements.scoreEl;
    this.scoreScrollEl = elements.scoreScrollEl;
    this.scorePagerEl = elements.scorePagerEl;
    this.keyboardHost = elements.keyboardHost;
    this.keyboardStack = elements.keyboardStack;
    this.keyboardHint = elements.keyboardHint;
    this.chordSidePanel = elements.chordSidePanel;
    this.chordDisplay = elements.chordDisplay;
    this.chordDisplayNotes = elements.chordDisplayNotes;
    this.chordDisplayChord = elements.chordDisplayChord;
    this.measureInfoEl = elements.measureInfoEl;
    this.progressBar = elements.progressBar;
    this.progressTime = elements.progressTime;
    this.practiceTime = elements.practiceTime;
    this.scoreDisplay = elements.scoreDisplay;
    this.btnPlay = elements.btnPlay;
    this.btnStop = elements.btnStop;
    this.btnEdit = elements.btnEdit;
    this.btnFinger = elements.btnFinger;
    this.btnSlur = elements.btnSlur;
    this.btnTie = elements.btnTie;
    this.btnStem = elements.btnStem;
    this.btnSaveEdits = elements.btnSaveEdits;
    this.editToolbar = elements.editToolbar;
    this.scoreValueEl = elements.scoreValueEl;
    this.scoreAccuEl = elements.scoreAccuEl;
    this.scoreComboEl = elements.scoreComboEl;
    this.scoreJudgeEl = elements.scoreJudgeEl;
    this.scoreWrongEl = elements.scoreWrongEl;
    this.scoreSidePanel = elements.scoreSidePanel;
    this.resultElements = elements.resultElements;
    this.midiSetup = elements.midiSetup;
    this.fallingNotes = elements.fallingNotes;
    this.liveAccuracyPanel = elements.liveAccuracyPanel;
    this.liveAccuracyCanvas = elements.liveAccuracyCanvas;
    this.liveTimelineCanvas = elements.liveTimelineCanvas;
    this.liveErrorCanvas = elements.liveErrorCanvas;
    this.centerJudgeEl = elements.centerJudgeEl;
    this.liveTimeRatioSection = elements.liveTimeRatioSection;
    this.liveTimeRatioCanvas = elements.liveTimeRatioCanvas;
    this.keyEls = createPianoKeyboard(this.keyboardHost);
    // 创建右键指法弹出菜单
    this.fingerMenuEl = this.createFingerMenu();
    // 下落音符点击回调
    this.fallingNotes.setOnNoteClick((noteKey, midi) => this.handleFallingNoteClick(noteKey, midi));
    this.practice.onJumpToMeasure = (measureStart, measureEnd) => {
      this.practice.measureStart = measureStart;
      this.practice.measureEnd = measureEnd;
      this.practice.updateUI();
      this.restartPracticeLoop();
    };
    this.initEvents();
    // 窗口高度变化时（28vh 容器随之变化）重新计算五线谱缩放，保持音符完整可见
    window.addEventListener('resize', () => this.handleScoreResize());
  }

  /* ── 事件绑定 ── */
  private initEvents(): void {
    this.btnPlay.addEventListener('click', () => this.startPlayFrom(0));
    this.btnStop.addEventListener('click', () => this.stopPlayback());
    this.btnEdit.addEventListener('click', () => this.toggleEditMode());
    this.btnFinger.addEventListener('click', () => this.setEditTool('select', '指法编辑：左键点击五线谱音符弹出指法面板（1-5 / ✕清除），自动保存'));
    this.btnSlur.addEventListener('click', () => { this.setEditTool('slur', '连音编辑：依次单击两个音符创建连线'); this.selectedNoteKeys.clear(); this.renderAll(); });
    this.btnTie.addEventListener('click', () => { this.setEditTool('tie', '连尾编辑：依次单击两个相邻音符将其符杆/符尾相连'); this.selectedNoteKeys.clear(); this.renderAll(); });
    this.btnStem.addEventListener('click', () => this.handleStemToggle());
    this.btnSaveEdits.addEventListener('click', () => this.saveEdits());

    // 进度条
    let wasPlayingBeforeSeek = false;
    this.progressBar.addEventListener('input', () => {
      if (this.getPlayMode() === 'keyboard' && !this.practiceActive) return;
      this.seeking = true;
      if (this.playback && !wasPlayingBeforeSeek) {
        wasPlayingBeforeSeek = true;
        this.playback.stop();
        this.playback = null;
        this.btnPlay.disabled = false;
        this.btnStop.disabled = true;
      }
      if (!this.currentMidi || this.flatNotes.length === 0) return;
      const pct = Number(this.progressBar.value) / 1000;
      const timeSec = pct * this.totalDurationSec;
      this.seekPreview(timeSec);
    });

    this.progressBar.addEventListener('change', () => {
      if (this.getPlayMode() === 'keyboard' && !this.practiceActive) return;
      this.seeking = false;
      if (!this.currentMidi || this.flatNotes.length === 0) return;
      const pct = Number(this.progressBar.value) / 1000;

      if (this.practiceActive) {
        // 练习模式：跳到对应小节重新开始
        const timeSec = pct * this.totalDurationSec;
        const midi = this.currentMidi;
        const ctx = getMeasureContext(midi);
        const ticksPerMeasure = ctx.ticksPerMeasure;
        const absTick = midi.header.secondsToTicks(timeSec);
        const targetMeasure = Math.floor(absTick / ticksPerMeasure);
        this.practice.measureStart = this.practice.clampMeasure(targetMeasure);
        this.practice.measureEnd = this.practice.measureStart;
        this.practice.updateUI();
        wasPlayingBeforeSeek = false;
        this.restartPracticeLoop();
        return;
      }

      const dur = this.totalDurationSec;
      const timeSec = pct * dur;
      updateProgressBar(this.progressBar, this.progressTime, timeSec, dur, false);
      if (wasPlayingBeforeSeek) {
        wasPlayingBeforeSeek = false;
        this.startPlayFrom(timeSec);
      }
    });

    // 练习范围控制
    this.practice.elements.startDec.addEventListener('click', () => this.handlePracticeStartChange(this.practice.measureStart - 1));
    this.practice.elements.startInc.addEventListener('click', () => this.handlePracticeStartChange(this.practice.measureStart + 1));
    this.practice.elements.endDec.addEventListener('click', () => this.handlePracticeEndChange(this.practice.measureEnd - 1));
    this.practice.elements.endInc.addEventListener('click', () => this.handlePracticeEndChange(this.practice.measureEnd + 1));
    this.practice.elements.startLabel.addEventListener('change', () => {
      const v = parseInt(this.practice.elements.startLabel.value, 10);
      if (!isNaN(v) && v >= 1) this.handlePracticeStartChange(v - 1);
      else this.practice.updateUI();
    });
    this.practice.elements.endLabel.addEventListener('change', () => {
      const v = parseInt(this.practice.elements.endLabel.value, 10);
      if (!isNaN(v) && v >= 1) this.handlePracticeEndChange(v - 1);
      else this.practice.updateUI();
    });

    // 合并小节数变更
    this.practice.elements.groupSizeInput.addEventListener('change', () => {
      const v = parseInt(this.practice.elements.groupSizeInput.value, 10);
      if (!isNaN(v) && v >= 1) {
        this.practice.measureGroupSize = v;
        this.loadHistoryAnalysis();
        if (this.practice.records.length > 0) this.updateMeasureErrors();
      }
    });

    // 编辑模式键盘事件
    document.addEventListener('keydown', (e) => this.handleEditKeydown(e));

    // 关闭页面前保存指法编辑
    window.addEventListener('beforeunload', () => {
      void this.saveToJson();
    });

    // 音符选择 + 框选
    this.scoreEl.addEventListener('mousedown', (e) => this.handleScoreMouseDown(e));
    this.scoreScrollEl.addEventListener('mousemove', (e) => this.handleScoreMouseMove(e));
    document.addEventListener('mouseup', () => this.handleScoreMouseUp());

    // 右键指法菜单
    this.scoreScrollEl.addEventListener('contextmenu', (e) => this.handleScoreContextMenu(e));

    // 左键指法：document 委托，确保事件不被 DOM 结构拦截
    // 左键指法：document 委托（五线谱音符）
    document.addEventListener('click', (e) => {
      if (e.button !== 0) return;
      // 五线谱音符（original 模式）
      const hit = (e.target as HTMLElement).closest<HTMLElement>('.note-hitarea');
      if (hit?.dataset.noteKey) {
        this.handleScoreNoteClick(hit.dataset.noteKey, hit);
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      // 点击其他位置关闭菜单
      if (!this.fingerMenuEl.contains(e.target as Node)) {
        this.hideFingerMenu();
      }
    });
  }

  /* ── 模式 ── */
  getPlayMode(): PlayMode {
    return loadSettings().mode;
  }

  getRenderMode(): 'image' | 'original' {
    return loadSettings().renderMode;
  }

  updateKeyboardHint(): void {
    const mode = this.getPlayMode();
    if (mode === 'auto') {
      this.keyboardHint.textContent = '根据 MIDI 生成的五线谱（高音 / 低音谱表）。琴键上方为下落式音符（绿左 / 蓝右；白键稍亮、黑键更深）。键盘高亮同上。左键点击音符可标注指法。';
    } else if (mode === 'keyboard') {
      this.keyboardHint.textContent = 'MIDI 跟弹：绿色 / 蓝色描边为当前应弹的左 / 右手音；弹对后条缩短并发声前进；紫红色外圈为正在按下的键，错音不出声。左键点击音符可标注指法。';
    } else {
      this.keyboardHint.textContent = '普通模式：自动播放曲目，可同时使用 MIDI 键盘弹奏，实时判定计分。左键点击音符可标注指法。';
    }
  }

  /** 更新和弦显示：根据当前按下的 MIDI 键显示和弦信息（右侧边栏） */
  updateChordDisplay(pressed: Set<number>): void {
    if (pressed.size === 0) {
      this.chordDisplayNotes.textContent = '-';
      this.chordDisplayChord.textContent = '-';
      return;
    }

    const chord = detectChord(pressed);
    if (!chord) {
      this.chordDisplayNotes.textContent = '';
      this.chordDisplayChord.textContent = '';
      return;
    }

    const lang = loadSettings().chordLang;
    this.chordDisplayNotes.textContent = chord.noteNames.join(' ');

    if (chord.type) {
      // 有和弦类型：显示和弦名
      if (lang === 'zh') {
        this.chordDisplayChord.textContent = chord.cnName
          ? `${chord.rootName}${chord.cnName}和弦`
          : chord.fullName;
      } else {
        this.chordDisplayChord.textContent = chord.fullName;
      }
    } else if (pressed.size === 1) {
      // 单音
      this.chordDisplayChord.textContent = lang === 'zh'
        ? `${chord.rootName} 单音`
        : chord.rootName;
    } else {
      this.chordDisplayChord.textContent = chord.fullName;
    }
  }

  /** 统一设置所有面板显隐 */
  syncPanels(): void {
    const isPractice = this.practiceActive;
    const isAuto = this.getPlayMode() === 'auto';

    // 左侧：错误分析（仅练习）
    this.practice.elements.leftPanel.hidden = !isPractice;
    // 中栏：实时图表（非 auto）
    this.liveAccuracyPanel.hidden = isAuto;
    // 右侧：成绩（非 auto）
    this.scoreSidePanel.hidden = isAuto;
    // 右侧：练习记录（仅练习）
    this.practice.elements.sidePanel.hidden = !isPractice;
    this.practice.elements.sideHeader.hidden = !isPractice;
    this.practice.elements.sideScores.hidden = !isPractice;
    // 练习控制栏（仅练习）
    this.practice.elements.controlsBar.hidden = !isPractice;
    // 和弦（始终显示）
    this.chordSidePanel.hidden = false;

    this.updateKeyboardHint();
    this.btnEdit.hidden = this.pianoPageEl.hidden || this.getRenderMode() !== 'original';
    const isKeyboard = this.getPlayMode() === 'keyboard';
    this.progressBar.style.pointerEvents = (isKeyboard && !isPractice) ? 'none' : '';
    this.progressBar.style.opacity = (isKeyboard && !isPractice) ? '0.55' : '';
  }

  /** 自动分配指法：基于音高范围计算 MIDI → 手指编号 */
  autoAssignFingerNumbers(): void {
    if (!this.currentMidi || this.flatNotes.length === 0) return;
    const result = autoAssignFingers(this.flatNotes, this.currentMidi);
    this.currentFingerMap = result.midiToFinger;
    this.fallingNotes.setFingerData(this.staffEditState.fingerNumbers, this.flatNotes);

    // 重新渲染以在五线谱上显示指法
    this.renderAll();

    // 同时将指法写入 NoteKey 格式的 staffEditState，使乐谱也可显示
    const ctx = getMeasureContext(this.currentMidi);
    const totalMeasures = measureCount(this.currentMidi, ctx);

    for (let mi = 0; mi < totalMeasures; mi++) {
      const trebleAtoms = buildAtomsForHand(this.flatNotes, this.currentMidi, 'treble', ctx, mi);
      const bassAtoms = buildAtomsForHand(this.flatNotes, this.currentMidi, 'bass', ctx, mi);

      for (const [hand, atoms] of [['treble', trebleAtoms], ['bass', bassAtoms]] as const) {
        for (let ai = 0; ai < atoms.length; ai++) {
          const atom = atoms[ai];
          if (atom.rest) continue;
          for (let ki = 0; ki < atom.keys.length; ki++) {
            const vexKey = atom.keys[ki];
            // 在 flatNotes 中找到对应 MIDI
            const measureStartSec = mi * ctx.secPerMeasure;
            const measureEndSec = (mi + 1) * ctx.secPerMeasure;
            const fn = this.flatNotes.find(n => {
              return n.vexKey === vexKey
                && n.time >= measureStartSec && n.time < measureEndSec
                && assignHandForNote(n, this.currentMidi!) === hand;
            });
            if (fn) {
              const finger = result.timeFinger.get(`${fn.midi}:${fn.time.toFixed(3)}`);
              if (finger !== undefined) {
                const nk = `${mi}:${hand}:${ai}:${ki}`;
                this.staffEditState.fingerNumbers.set(nk, finger);
              }
            }
          }
        }
      }
    }

    this.keyboardHint.textContent = '已自动分配指法。播放时琴键将显示手指编号（1-5）。';
  }

  /** 从 staffEditState.fingerNumbers（NoteKey 格式）构建 MIDI → 手指的映射 */
  buildFingerMapFromEditState(): void {
    if (!this.currentMidi) return;
    const ctx = getMeasureContext(this.currentMidi);
    this.currentFingerMap = new Map();

    for (const [nk, finger] of this.staffEditState.fingerNumbers) {
      const [mStr, hand, aStr, kStr] = nk.split(':');
      const mi = Number(mStr);
      const ai = Number(aStr);
      const ki = Number(kStr);

      const atoms = buildAtomsForHand(this.flatNotes, this.currentMidi, hand as 'treble' | 'bass', ctx, mi);
      if (ai < atoms.length) {
        const atom = atoms[ai];
        if (!atom.rest && ki < atom.keys.length) {
          const vexKey = atom.keys[ki];
          const measureStartSec = mi * ctx.secPerMeasure;
          const measureEndSec = (mi + 1) * ctx.secPerMeasure;
          const fn = this.flatNotes.find(n => {
            return n.vexKey === vexKey
              && n.time >= measureStartSec && n.time < measureEndSec
              && assignHandForNote(n, this.currentMidi!) === hand;
          });
          if (fn) {
              this.currentFingerMap.set(fn.midi, finger);
            }
          }
        }
      }
      this.fallingNotes.setFingerData(this.staffEditState.fingerNumbers, this.flatNotes);
    }

  /** 同步指法到下落音符 */
  syncFingerMapToFallingNotes(): void {
    this.fallingNotes.setFingerData(this.staffEditState.fingerNumbers, this.flatNotes);
  }

  /* ── 乐谱渲染 ── */

  renderAll(midi?: Midi): void {
    const m = midi ?? this.currentMidi;
    if (!m) return;
    this.currentMidi = m;
    this.flatNotes = flattenNotes(m);
    assignNoteKeys(this.flatNotes, m, getMeasureContext(m));
    this.scoreEl.innerHTML = '';

    const settings = loadSettings();
    const mode = settings.renderMode;
    const measureWidth = settings.measureWidth;

    if (mode === 'image') {
      this.scoreEl.style.cssText = 'position:relative;will-change:transform';
      this.scoreScrollEl.style.cssText = 'overflow:hidden;position:relative';
      this.removeFixedStaveHead();
      this.resetStaffLiveHighlight();
      this.renderStaffImage(this.scoreEl, m, measureWidth);
      this.addJudgmentLine();
      this.scrollStaffToProgress(0);
    } else {
      this.scoreEl.style.cssText = '';
      this.scoreScrollEl.style.cssText = 'overflow:auto;position:relative';
      this.scoreScrollEl.querySelector('.judgment-line')?.remove();
      this.removeFixedStaveHead();
      this.resetStaffLiveHighlight();
      this.renderStaffOriginal(this.scoreEl, m, measureWidth);
      this.hideScorePlayhead();
    }

    const range = noteRange(this.flatNotes);
    // 根据游戏区域宽度扩展键盘，延迟到下一帧获取准确布局
    const doExpand = () => {
      const container = this.keyboardHost?.parentElement;
      const availW = container?.clientWidth ?? 700;
      const expanded = expandRangeToFill(range, availW);
      if (expanded.min !== range.min || expanded.max !== range.max) {
        this.keyEls = createPianoKeyboard(this.keyboardHost, expanded.min, expanded.max);
        this.fallingNotes.setRange(expanded.min, expanded.max);
      }
    };
    this.keyEls = createPianoKeyboard(this.keyboardHost, range.min, range.max);
    this.fallingNotes.setRange(range.min, range.max);
    requestAnimationFrame(() => requestAnimationFrame(doExpand));
    this.fallingNotes.setSource(this.flatNotes, m);
    this.fallingNotes.clear();

    if (this.scorePagerState) this.updateMeasureInfo(0, this.scorePagerState.nMeas);

    this.totalDurationSec = m.duration;
    resetProgressBar(this.progressBar, this.progressTime, this.totalDurationSec);
  }

  /* ── 设置/进入/离开 ── */

  async setupPianoPage(midi: Midi): Promise<void> {
    this.editModeActive = false;
    this.selectedNoteKeys.clear();
    this.staffEditState = createStaffEditState();

    this.renderAll(midi);
    this.syncPanels();

    // 从 JSON 预置指法加载
    this.loadJsonFingers();
  }

  /** 从 flatNotes 中的 finger 字段加载 JSON 预置指法 */
  private loadJsonFingers(): void {
    let changed = false;
    for (const fn of this.flatNotes) {
      if (fn.finger !== undefined && fn.noteKey) {
        this.staffEditState.fingerNumbers.set(fn.noteKey, fn.finger);
        changed = true;
      }
    }
    console.log('[loadJsonFingers] loaded:', this.staffEditState.fingerNumbers.size, 'finger entries, changed:', changed);
    if (changed) {
      this.syncFingerMapToFallingNotes();
      this.renderAll();
    }
  }

  async enterAndPlay(midi: Midi): Promise<void> {
    await this.setupPianoPage(midi);
    this.practiceActive = false;
    this.syncPanels();
    // 清理并显示实时图表
    this.liveAccuracyPoints = [];
    this.liveTimeRatioPoints = [];
    this.lastGameTimeSec = 0;
    resetScoreUI();
    this.centerJudgeEl.className = 'center-judge';
    this.centerJudgeEl.textContent = '';
    for (const c of [this.liveTimelineCanvas, this.liveErrorCanvas, this.liveAccuracyCanvas, this.liveTimeRatioCanvas]) {
      const w = this.liveAccuracyPanel.clientWidth - 28;
      const ctx = c.getContext('2d');
      if (ctx) { c.width = w * (window.devicePixelRatio || 1); ctx.clearRect(0, 0, c.width, c.height); }
    }
    this.renderLiveTimelineChart();
    this.renderLiveErrorChart();
    this.renderLiveAccuracyChart();
    await countdown(3, this.pianoPageEl);
    await this.startPlayFrom(0);
  }

  async enterPractice(midi: Midi): Promise<void> {
    await this.setupPianoPage(midi);
    this.practiceActive = true;
    this.syncPanels();
    this.practice.elements.sideScores.innerHTML = '';
    this.practice.init(measureCount(midi, getMeasureContext(midi)));
    this.practice.updateUI();
    this.loadHistoryAnalysis();
    this.btnPlay.disabled = true;
    this.btnStop.disabled = false;
    // 清理并显示实时图表
    this.liveAccuracyPoints = [];
    this.liveTimeRatioPoints = [];
    this.lastGameTimeSec = 0;
    resetScoreUI();
    this.centerJudgeEl.className = 'center-judge';
    this.centerJudgeEl.textContent = '';
    for (const c of [this.liveTimelineCanvas, this.liveErrorCanvas, this.liveAccuracyCanvas, this.liveTimeRatioCanvas]) {
      const w = this.liveAccuracyPanel.clientWidth - 28;
      const ctx = c.getContext('2d');
      if (ctx) { c.width = w * (window.devicePixelRatio || 1); ctx.clearRect(0, 0, c.width, c.height); }
    }
    this.renderLiveTimelineChart();
    this.renderLiveErrorChart();
    this.renderLiveAccuracyChart();
    await this.startPlayFrom(0);
  }

  stopPlayback(): void {
    if (this.practiceActive && this.practice.records.length > 0) {
      const best = this.practice.getBestRecord();
      if (best) {
        let maxComboRun = 0;
        let curRun = 0;
        for (const nr of best.noteResults) {
          if (nr.judgement !== 'MISS') { curRun++; if (curRun > maxComboRun) maxComboRun = curRun; }
          else curRun = 0;
        }
        const entry = this.buildHistoryEntry(best.score, best.accuracy, maxComboRun, 'practice');
        if (this.currentSongFile) {
          try { addHistoryEntry(entry); } catch { /* ignore */ }
        }
        this.pianoPageEl.hidden = true;
        showResultScreen(entry, this.scoringEngine.getMaxTheoreticalScore(), this.resultElements,
          this.lastRecordedEvents.length > 0);
      }
    }

    this.lastRecordedEvents = this.playback?.getRecordedEvents?.() ?? [];
    this.playback?.stop();
    this.playback = null;
    this.hideScorePlayhead();
    if (this.scorePagerState) this.updateMeasureInfo(0, this.scorePagerState.nMeas);
    this.fallingNotes.clear();
    applyKeyVisuals(this.keyEls, {});
    this.btnPlay.disabled = false;
    this.btnStop.disabled = true;
    resetProgressBar(this.progressBar, this.progressTime, this.totalDurationSec);
    this.practiceTime.hidden = true;
    this.finalWallTimeSec = 0;
    this.practiceActive = false;
    this.progressBar.style.background = '';
    this.practice.elements.sideScores.innerHTML = '';
    this.liveAccuracyPanel.hidden = true;
  }

  /* ── 播放逻辑 ── */

  async startPlayFrom(offsetSec: number): Promise<void> {
    if (!this.currentMidi || this.flatNotes.length === 0) return;
    const wasPracticeActive = this.practiceActive;
    this.stopPlayback();
    this.practiceActive = wasPracticeActive;

    this.btnPlay.disabled = true;
    this.btnStop.disabled = false;

    // 显示并重置实时面板
    this.liveAccuracyPoints = [];
    this.liveTimeRatioPoints = [];
    this.lastGameTimeSec = 0;
    resetScoreUI();
    this.centerJudgeEl.className = 'center-judge';
    this.centerJudgeEl.textContent = '';
    this.liveAccuracyPanel.hidden = false;
    // 先清空所有 canvas 避免上一局残留
    for (const c of [this.liveTimelineCanvas, this.liveErrorCanvas, this.liveAccuracyCanvas, this.liveTimeRatioCanvas]) {
      const w = this.liveAccuracyPanel.clientWidth - 28;
      const ctx = c.getContext('2d');
      if (ctx) { c.width = w * (window.devicePixelRatio || 1); ctx.clearRect(0, 0, c.width, c.height); }
    }
    this.renderLiveTimelineChart();
    this.renderLiveErrorChart();
    this.renderLiveAccuracyChart();

    const mode = this.getPlayMode();
    this.liveTimeRatioSection.hidden = mode !== 'keyboard';

    const settings = loadSettings();

    const onPlaybackEnded = (completed?: boolean) => {
      // 隐藏实时准度面板
      this.liveAccuracyPanel.hidden = true;

      // 保存录制事件和模式（用于回放）
      this.lastRecordedEvents = this.playback?.getRecordedEvents?.() ?? [];
      this.lastRecordedMode = mode;
      this.hideScorePlayhead();
      this.fallingNotes.clear();
      this.btnPlay.disabled = false;
      this.btnStop.disabled = true;
      this.playback = null;
      resetProgressBar(this.progressBar, this.progressTime, this.totalDurationSec);

      // 只有完成整首才写入历史
      if (completed && this.getPlayMode() !== 'auto') {
        const modeForHistory = loadSettings().mode;
        const state = this.scoringEngine.getState();
        const entry = this.buildHistoryEntry(this.scoringEngine.getScore(), state.accuracy, state.maxCombo, modeForHistory);
        if (this.currentSongFile) {
          try { addHistoryEntry(entry); } catch { /* 忽略存储错误 */ }
        }
        // 先隐藏钢琴页，再显示结算画面
        this.pianoPageEl.hidden = true;
        showResultScreen(entry, this.scoringEngine.getMaxTheoreticalScore(), this.resultElements,
          this.lastRecordedEvents.length > 0);
      }
    };

    // 音频初始化重试
    {
      let retries = 3;
      let lastErr: unknown;
      while (retries > 0) {
        try {
          await ensurePiano();
          lastErr = undefined;
          break;
        } catch (err) {
          lastErr = err;
          retries--;
          if (retries > 0) {
            console.warn(`音频引擎初始化失败，剩余重试次数: ${retries}`, err);
            await new Promise(r => setTimeout(r, 500));
          }
        }
      }
      if (lastErr) {
        console.error('[startPlayFrom] 重试耗尽，初始化失败:', lastErr);
        alert('音频引擎初始化失败，请刷新页面重试。');
        onPlaybackEnded();
        return;
      }
    }

    /* ── 自动播放模式 ── */
    if (mode === 'auto') {
      const sorted = [...this.flatNotes].sort((a, b) => {
        const ha = assignHandForNote(a, this.currentMidi!);
        const hb = assignHandForNote(b, this.currentMidi!);
        if (ha !== hb) return ha === 'treble' ? -1 : 1;
        return a.time - b.time || a.midi - b.midi;
      });
      this.scoreSidePanel.hidden = true;
      this.playback = playNotes(
        sorted,
        this.currentMidi!,
        this.currentMidi!.duration,
        (active) => applyKeyVisuals(this.keyEls, { active }),
        onPlaybackEnded,
        (t) => {
          this.updateScorePlayhead(t);
          this.fallingNotes.update(t);
          updateProgressBar(this.progressBar, this.progressTime, t, this.totalDurationSec, this.seeking);
        },
        offsetSec,
        settings.playbackSpeed,
      );
      return;
    }

    /* ── 需要 MIDI 输入的模式 ── */
    const access = await this.midiSetup.ensureAccess();
    if (!access) {
      alert('当前浏览器不支持 Web MIDI，或用户拒绝了权限。请使用 Chrome / Edge 等浏览器。');
      onPlaybackEnded();
      return;
    }
    this.midiSetup.refillSelects();
    const input = this.midiSetup.getSelectedInput();
    if (!input) {
      alert('未检测到 MIDI 输入设备。请先连接键盘，或点击「刷新设备」后再试。');
      onPlaybackEnded();
      return;
    }
    try { await input.open(); } catch {
      alert('无法打开所选 MIDI 输入端口。');
      onPlaybackEnded();
      return;
    }

    /* ── 练习模式 ── */
    if (this.practiceActive) {
      this.practice.loopRound = 0;
      this.practice.records = [];
      this.practice.bestScore = 0;
      this.practice.updateUI();

      const midi = this.currentMidi!;
      const ctx = getMeasureContext(midi);
      const ticksPerMeasure = ctx.ticksPerMeasure;
      const startTick = this.practice.measureStart * ticksPerMeasure;
      const endTick = (this.practice.measureEnd + 1) * ticksPerMeasure;
      const startTimeSec = midi.header.ticksToSeconds(startTick);
      const endTimeSec = midi.header.ticksToSeconds(endTick);
      this.practiceLoopDurationSec = endTimeSec - startTimeSec;
      this.practiceLoopStartTimeSec = startTimeSec;
      this.fallingNotes.setLoopRange(startTimeSec, endTimeSec);

      this.practiceLoopNotes = this.flatNotes
        .filter(n => n.ticks >= startTick && n.ticks < endTick)
        .map(n => ({ ...n, time: n.time - startTimeSec, ticks: n.ticks - startTick }));

      this.scoreSidePanel.hidden = false;

      const startLoop = () => {
        if (!this.practiceActive) return;

        const holdCount = this.practiceLoopNotes.filter(n => Math.max(0, n.duration) >= 0.05).length;
        this.scoringEngine.reset({ totalNotes: this.practiceLoopNotes.length, holdNoteCount: holdCount });
        this.lastPushedResultIdx = 0;
        updateScoreUI(this.scoringEngine.getState(), this.scoreElements());
        this.practiceCurrentWallSec = 0;

        const onLoopEnded = (_completed?: boolean) => {
          this.hideScorePlayhead();
          this.fallingNotes.clear();
          this.fallingNotes.setLoopRange(this.practiceLoopStartTimeSec, this.practiceLoopStartTimeSec + this.practiceLoopDurationSec);
          this.playback = null;

          if (!this.practiceActive || this.seeking || this.practiceRestarting) {
            this.btnPlay.disabled = false;
            this.btnStop.disabled = true;
            return;
          }
          resetProgressBar(this.progressBar, this.progressTime, this.totalDurationSec);
          if (this.practiceRestarting) return;

          const snap = this.scoringEngine.snapshot();
          this.practice.addRecord({
            round: this.practice.loopRound + 1,
            score: snap.score,
            maxScore: snap.maxScore,
            accuracy: snap.accuracy,
            elapsedSec: this.practiceCurrentWallSec,
            loopDurationSec: this.practiceLoopDurationSec,
            counts: snap.counts,
            noteResults: snap.noteResults,
            wrongKeyRecords: snap.wrongKeyRecords,
          });
          this.updateMeasureErrors();

          setTimeout(() => {
            if (!this.practiceActive) return;
            startLoop();
          }, 500);
        };

        this.playback = startKeyboardPractice(
          this.practiceLoopNotes,
          midi,
          this.keyEls,
          input,
          onLoopEnded,
          (t) => {
            const absTime = this.practiceLoopStartTimeSec + t;
            this.lastGameTimeSec = absTime;
            this.updateScorePlayhead(absTime);
            updateProgressBar(this.progressBar, this.progressTime, absTime, this.totalDurationSec, this.seeking);
            const currentTick = startTick + midi.header.secondsToTicks(t);
            const currentMeasure = Math.floor(currentTick / ticksPerMeasure);
            const loopMeasure = Math.max(0, Math.min(currentMeasure - this.practice.measureStart, this.practice.measureEnd - this.practice.measureStart));
            this.updateMeasureInfo(loopMeasure, this.practice.measureEnd - this.practice.measureStart + 1);
          },
          (s) => this.handlePracticePaint(s),
          this.scoringEngine,
          () => this.onScoreTick(),
          false,
          settings.playbackSpeed,
          (wallSec) => { this.practiceCurrentWallSec = wallSec; },
          (pressed) => this.updateChordDisplay(pressed),
          undefined,
          this.currentFingerMap,
          (expected, pressed) => this.handleVisualState(expected, pressed),
          (midi) => { this.staffWrongMidis.add(midi); },
        );
      };

      this.practiceLoopStartFn = startLoop;
      startLoop();
      return;
    }

    /* ── 普通模式 ── */
    if (mode === 'normal') {
      this.scoreSidePanel.hidden = false;
      const holdCount = this.flatNotes.filter(n => Math.max(0, n.duration) >= 0.05).length;
      this.scoringEngine.reset({ totalNotes: this.flatNotes.length, holdNoteCount: holdCount });
      this.lastPushedResultIdx = 0;
      updateScoreUI(this.scoringEngine.getState(), this.scoreElements());

      this.playback = startKeyboardPractice(
        this.flatNotes,
        this.currentMidi!,
        this.keyEls,
        input,
        onPlaybackEnded,
        (t) => {
          this.lastGameTimeSec = t;
          this.updateScorePlayhead(t);
          updateProgressBar(this.progressBar, this.progressTime, t, this.totalDurationSec, this.seeking);
        },
        (s) => this.handlePracticePaint(s),
        this.scoringEngine,
        () => this.onScoreTick(),
        true,
        settings.playbackSpeed,
        undefined,
        (pressed) => this.updateChordDisplay(pressed),
        undefined,
        this.currentFingerMap,
        (expected, pressed) => this.handleVisualState(expected, pressed),
        (midi) => { this.staffWrongMidis.add(midi); },
      );
      return;
    }

    /* ── MIDI 跟弹模式 ── */
    if (mode === 'keyboard') {
      this.scoreSidePanel.hidden = false;
      const holdCount = this.flatNotes.filter(n => Math.max(0, n.duration) >= 0.05).length;
      this.scoringEngine.reset({ totalNotes: this.flatNotes.length, holdNoteCount: holdCount });
      this.lastPushedResultIdx = 0;
      updateScoreUI(this.scoringEngine.getState(), this.scoreElements());

      this.practiceTime.hidden = false;
      this.finalWallTimeSec = 0;
      let lastGameTimeSec = 0;

      this.playback = startKeyboardPractice(
        this.flatNotes,
        this.currentMidi!,
        this.keyEls,
        input,
        onPlaybackEnded,
        (t) => {
          this.lastGameTimeSec = t;
          this.updateScorePlayhead(t);
          updateProgressBar(this.progressBar, this.progressTime, t, this.totalDurationSec, this.seeking);
          lastGameTimeSec = t;
        },
        (s) => this.handlePracticePaint(s),
        this.scoringEngine,
        () => this.onScoreTick(),
        false,
        settings.playbackSpeed,
        (wallSec) => {
          this.finalWallTimeSec = wallSec;
          const refTimeSec = lastGameTimeSec > 0 ? lastGameTimeSec : this.totalDurationSec;
          const pct = refTimeSec > 0 ? Math.max(0, (wallSec / refTimeSec) * 100) : 0;
          this.practiceTime.textContent = `用时 ${formatTime(wallSec)} · ${pct.toFixed(1)}%`;
          // 至少命中一个音符后开始记录（MISS 不算，因为跟弹模式会自动 MISS 未弹音符）
          const hasHit = this.scoringEngine.noteResults.some(n => n.judgement !== 'MISS');
          if (lastGameTimeSec > 1 && hasHit) {
            this.liveTimeRatioPoints.push({ gameSec: wallSec, ratio: wallSec / lastGameTimeSec * 100 });
            this.renderLiveTimeRatioChart();
          }
        },
        (pressed) => this.updateChordDisplay(pressed),
        undefined,
        this.currentFingerMap,
        (expected, pressed) => this.handleVisualState(expected, pressed),
        (midi) => { this.staffWrongMidis.add(midi); },
      );
      return;
    }
  }

  /** 用绝对时间统一更新五线谱、进度条、小节信息（拖动时预览用） */
  private seekPreview(timeSec: number): void {
    updateProgressBar(this.progressBar, this.progressTime, timeSec, this.totalDurationSec, false);
    this.updateScorePlayhead(timeSec);
    this.fallingNotes.update(timeSec);
    if (this.currentMidi) {
      const ctx = getMeasureContext(this.currentMidi);
      const tick = this.currentMidi.header.secondsToTicks(Math.max(0, timeSec));
      const m = Math.floor(tick / ctx.ticksPerMeasure);
      const total = measureCount(this.currentMidi, ctx);
      this.updateMeasureInfo(Math.min(m, total - 1), total);
    }
  }

  /** 更新乐谱播放头位置（回放也用到） */
  updateScorePlayhead(sec: number): void {
    if (this.getRenderMode() === 'image') {
      this.updatePlayheadImage(sec);
    } else {
      this.updatePlayheadOriginal(sec);
    }
  }

  hideScorePlayhead(): void {
    this.clearStaffLiveHighlight();
    if (this.getRenderMode() === 'image') {
      this.resetStaffScroll();
    } else {
      for (const ph of this.scoreEl.querySelectorAll<HTMLElement>('.playhead')) {
        ph.classList.remove('is-visible');
      }
    }
  }

  /* ── 编辑模式 ── */

  private toggleEditMode(): void { toggleEditMode(this); }

  private setEditTool(tool: EditTool, hint: string): void { setEditTool(this, tool, hint); }

  private handleStemToggle(): void { handleStemToggle(this); }

  private async saveEdits(): Promise<void> { await saveEdits(this); }

  private async saveToJson(): Promise<void> { await saveToJson(this); }

  private handleEditKeydown(e: KeyboardEvent): void { handleEditKeydown(this, e); }

  private handleScoreMouseDown(e: MouseEvent): void { handleScoreMouseDown(this, e); }

  private handleScoreMouseMove(e: MouseEvent): void { handleScoreMouseMove(this, e); }

  private handleScoreMouseUp(): void { handleScoreMouseUp(this); }



  /* ── 右键指法菜单 ── */

  private createFingerMenu(): HTMLDivElement { return createFingerMenu(this); }

  private handleScoreContextMenu(e: MouseEvent): void { handleScoreContextMenu(this, e); }

  /** 五线谱音符左键点击 → 弹出指法菜单 */
  private handleScoreNoteClick(nk: string, hit: HTMLElement): void { handleScoreNoteClick(this, nk, hit); }

  private hideFingerMenu(): void { hideFingerMenu(this); }

  /** 下落音符点击 */
  private handleFallingNoteClick(noteKey: string | null, midi: number): void { handleFallingNoteClick(this, noteKey, midi); }

  private handlePracticeStartChange(newVal: number): void {
    this.practice.handleStartChange(newVal);
    this.restartPracticeLoop();
  }

  private handlePracticeEndChange(newVal: number): void {
    this.practice.handleEndChange(newVal);
    this.restartPracticeLoop();
  }

  /** 计算每小节的错误统计 */
  private computeMeasureStats(includeCurrentRound: boolean): {
    measureTotalNotes: Map<number, number>;
    measureStats: Map<number, { missCount: number; badCount: number; wrongCount: number }>;
    totalMeasures: number;
  } | null {
    if (!this.currentMidi || !this.currentSongFile) return null;
    const midi = this.currentMidi;
    const ctx = getMeasureContext(midi);
    const ticksPerMeasure = ctx.ticksPerMeasure;
    if (ticksPerMeasure <= 0) return null;
    const totalMeasures = measureCount(midi, ctx);

    // 统计全曲各小节音符数
    const measureTotalNotes = new Map<number, number>();
    for (const n of this.flatNotes) {
      const mIdx = Math.floor(n.ticks / ticksPerMeasure);
      measureTotalNotes.set(mIdx, (measureTotalNotes.get(mIdx) ?? 0) + 1);
    }

    const measureStats = new Map<number, { missCount: number; badCount: number; wrongCount: number }>();
    const initM = (idx: number) => {
      if (!measureStats.has(idx)) measureStats.set(idx, { missCount: 0, badCount: 0, wrongCount: 0 });
      return measureStats.get(idx)!;
    };

    // 扫描历史记录
    const historyEntries = getHistoryForSong(this.currentSongFile);
    for (const entry of historyEntries) {
      for (const nr of entry.noteResults ?? []) {
        // 历史记录中 NoteResult.time 是原始 MIDI 时间
        const tick = midi.header.secondsToTicks(nr.time);
        const mIdx = Math.floor(tick / ticksPerMeasure);
        if (mIdx >= 0 && mIdx < totalMeasures) {
          const s = initM(mIdx);
          if (nr.judgement === 'MISS') s.missCount++;
          else if (nr.judgement === 'BAD') s.badCount++;
        }
      }
      for (const wr of entry.wrongKeyRecords ?? []) {
        const tick = midi.header.secondsToTicks(wr.timeSec);
        const mIdx = Math.floor(tick / ticksPerMeasure);
        if (mIdx >= 0 && mIdx < totalMeasures) {
          initM(mIdx).wrongCount++;
        }
      }
    }

    // 当前轮记录（NoteResult.time 是 loop-relative）
    if (includeCurrentRound) {
      const startTimeSec = this.practiceLoopStartTimeSec;
      for (const record of this.practice.records) {
        for (const nr of record.noteResults) {
          const originalTime = startTimeSec + nr.time;
          const tick = midi.header.secondsToTicks(originalTime);
          const mIdx = Math.floor(tick / ticksPerMeasure);
          if (mIdx >= 0 && mIdx < totalMeasures) {
            const s = initM(mIdx);
            if (nr.judgement === 'MISS') s.missCount++;
            else if (nr.judgement === 'BAD') s.badCount++;
          }
        }
        for (const wr of record.wrongKeyRecords) {
          const originalTime = startTimeSec + wr.timeSec;
          const tick = midi.header.secondsToTicks(originalTime);
          const mIdx = Math.floor(tick / ticksPerMeasure);
          if (mIdx >= 0 && mIdx < totalMeasures) {
            initM(mIdx).wrongCount++;
          }
        }
      }
    }

    return { measureTotalNotes, measureStats, totalMeasures };
  }

  /** 将小节统计合并、分组、排序 */
  private buildMeasureErrorsFromStats(stats: {
    measureTotalNotes: Map<number, number>;
    measureStats: Map<number, { missCount: number; badCount: number; wrongCount: number }>;
    totalMeasures: number;
  }): MeasureErrorInfo[] {
    const { measureTotalNotes, measureStats, totalMeasures } = stats;
    const groupSize = this.practice.measureGroupSize || 1;
    const errors: MeasureErrorInfo[] = [];
    for (let gStart = 0; gStart < totalMeasures; gStart += groupSize) {
      const gEnd = Math.min(gStart + groupSize - 1, totalMeasures - 1);
      let missCount = 0, badCount = 0, wrongCount = 0, totalNotes = 0;
      for (let i = gStart; i <= gEnd; i++) {
        const s = measureStats.get(i);
        if (s) {
          missCount += s.missCount;
          badCount += s.badCount;
          wrongCount += s.wrongCount;
        }
        totalNotes += measureTotalNotes.get(i) ?? 0;
      }
      const ec = missCount + badCount + wrongCount;
      if (ec > 0) {
        errors.push({
          measureIndex: gStart,
          measureNumber: gStart + 1,
          measureEndIndex: gEnd,
          errorCount: ec,
          missCount,
          badCount,
          wrongCount,
          totalNotes,
        });
      }
    }
    errors.sort((a, b) => b.errorCount - a.errorCount);
    return errors;
  }

  /** 加载历史记录并做全曲分析（进入练习模式时调用） */
  private loadHistoryAnalysis(): void {
    const stats = this.computeMeasureStats(false);
    if (!stats) return;
    this.practice.setMeasureErrors(this.buildMeasureErrorsFromStats(stats));
  }

  /** 分析所有练习轮记录，计算各小节错误数并更新左侧面板 */
  private updateMeasureErrors(): void {
    const stats = this.computeMeasureStats(true);
    if (!stats) return;
    this.practice.setMeasureErrors(this.buildMeasureErrorsFromStats(stats));
  }

  restartPracticeLoop(): void {
    if (!this.practiceActive || !this.currentMidi || !this.practiceLoopStartFn) return;
    this.practiceRestarting = true;
    this.playback?.stop();
    this.playback = null;
    this.fallingNotes.clear();
    // 不调 hideScorePlayhead，而是直接跳到新位置
    this.updateMeasureInfo(0, this.practice.measureEnd - this.practice.measureStart + 1);

    const midi = this.currentMidi;
    const ctx = getMeasureContext(midi);
    const ticksPerMeasure = ctx.ticksPerMeasure;
    const startTick = this.practice.measureStart * ticksPerMeasure;
    const endTick = (this.practice.measureEnd + 1) * ticksPerMeasure;
    const startTimeSec = midi.header.ticksToSeconds(startTick);
    const endTimeSec = midi.header.ticksToSeconds(endTick);
    this.practiceLoopDurationSec = endTimeSec - startTimeSec;
    this.practiceLoopStartTimeSec = startTimeSec;
    this.fallingNotes.setLoopRange(startTimeSec, endTimeSec);

    // 滚动乐谱 + 更新进度条到循环起始位置
    this.seekPreview(startTimeSec);

    this.practiceLoopNotes = this.flatNotes
      .filter(n => n.ticks >= startTick && n.ticks < endTick)
      .map(n => ({ ...n, time: n.time - startTimeSec, ticks: n.ticks - startTick }));

    this.practiceLoopStartFn();
    this.practiceRestarting = false;
  }

  /* ── Score 渲染辅助 ── */

  private scoreElements() {
    return { valueEl: this.scoreValueEl, accuEl: this.scoreAccuEl, comboEl: this.scoreComboEl, judgeEl: this.scoreJudgeEl, wrongEl: this.scoreWrongEl, centerJudgeEl: this.centerJudgeEl };
  }

  private buildHistoryEntry(score: number, accuracy: number, maxCombo: number, mode: string): PlayHistoryEntry {
    const curSettings = loadSettings();
    return {
      songFile: this.currentSongFile ?? '',
      songName: this.currentSongName,
      score,
      accuracy,
      maxCombo,
      mode,
      date: new Date().toISOString(),
      settings: { fallingSpeed: curSettings.fallingSpeed, playbackSpeed: curSettings.playbackSpeed, difficulty: curSettings.difficulty, offsetAdjustMs: curSettings.offsetAdjustMs },
      noteResults: this.scoringEngine.noteResults,
      wrongKeyRecords: this.scoringEngine.wrongKeyRecords,
      wallTimeSec: this.finalWallTimeSec || undefined,
      originalDurationSec: this.totalDurationSec || undefined,
      recordedEvents: this.lastRecordedEvents.length > 0
        ? this.lastRecordedEvents.map(e => ({ data: Array.from(e.data), wallTimeSec: e.wallTimeSec }))
        : undefined,
      timeRatioPoints: this.liveTimeRatioPoints.length > 0 ? [...this.liveTimeRatioPoints] : undefined,
    };
  }

  private onScoreTick(): void {
    updateScoreUI(this.scoringEngine.getState(), this.scoreElements());
    this.updateTimingDots();
    this.updateLiveAccuracyFromEngine();
  }

  /** 已推入预览线的最新结果索引 */
  lastPushedResultIdx = 0;

  /** 更新预览线命中标记 */
  private updateTimingDots(): void {
    updateTimingDots(this);
  }

  /** 从计分引擎同步所有实时图表 */
  private updateLiveAccuracyFromEngine(): void {
    updateLiveAccuracyFromEngine(this);
  }

  /** 绘制实时准度曲线到左侧面板 Canvas */
  private renderLiveAccuracyChart(): void {
    renderLiveAccuracyChart(this);
  }

  /** 绘制错误时间线（仅 Bad / Miss / Wrong） */
  private renderLiveTimelineChart(): void {
    renderLiveTimelineChart(this);
  }

  /** 绘制实时按键偏差散点 */
  private renderLiveErrorChart(): void {
    renderLiveErrorChart(this);
  }

  /** 绘制实时用时占比曲线（跟弹模式） */
  private renderLiveTimeRatioChart(): void {
    renderLiveTimeRatioChart(this);
  }

  private renderStaffImage(stripEl: HTMLElement, midi: Midi, measureWidth: number): void {
    const ctx = getMeasureContext(midi);
    const nMeas = measureCount(midi, ctx);
    const columns: GrandStaffColumn[] = [];
    for (let i = 0; i < nMeas; i++) {
      columns.push({
        // 谱头（谱号/调号/拍号）已由固定元素 {@link renderStaveHead} 呈现，滚动条内不再重复绘制
        measureIndex: i, trebleAtoms: buildAtomsForHand(this.flatNotes, midi, 'treble', ctx, i),
        bassAtoms: buildAtomsForHand(this.flatNotes, midi, 'bass', ctx, i), showStaffHeader: false,
      });
    }
    // 可用显示高度：以容器实际高度为准（28vh，窗口变化时由 handleScoreResize 重新适配）
    const clientH = this.scoreScrollEl.clientHeight;
    const fitHeight = Math.max(140, (clientH > 0 ? clientH : Math.round(window.innerHeight * 0.28)) - 2);
    const { height: stripHeight, y0, canvasHeight, scaleY, yOffset, noteXByAtom } = renderGrandStaffRow(
      stripEl, columns, ctx, measureWidth, true,
      this.staffEditState, this.editModeActive ? this.selectedNoteKeys : undefined,
      fitHeight,
    );
    // 依据音符实际渲染 x 建立「时间 → x」全曲时间线（用于滚动对齐与错键音符定位）。
    // x 为原始坐标；滚动定位时换算屏幕坐标（x * scaleY）。
    this.staffAtomEls.clear();
    const timeline: Array<{ t: number; x: number }> = [];
    const fitAtoms: Array<{ x: number; top: number; bottom: number }> = [];
    for (const fn of this.flatNotes) {
      if (!fn.noteKey) continue;
      const [mStr, hand, aStr] = fn.noteKey.split(':');
      const info = noteXByAtom.get(`${mStr}:${hand}:${aStr}`);
      if (!info) continue;
      if (info.el) this.staffAtomEls.set(`${mStr}:${hand}:${aStr}`, info.el);
      timeline.push({ t: fn.time, x: info.x });
    }
    // 自适应缩放数据：直接遍历全部渲染原子（不依赖 noteKey 匹配，避免部分音符缺失）
    for (const [, info] of noteXByAtom) {
      if (info.top !== undefined && info.bottom !== undefined) {
        fitAtoms.push({ x: info.x, top: info.top, bottom: info.bottom });
      }
    }
    // 按时间排序，相邻同时间（和弦）去重保留首项（同 System 内同时间音符共享同一 x）
    timeline.sort((a, b) => a.t - b.t);
    this.staffNoteTimeline = timeline.filter((v, i) => i === 0 || Math.abs(v.t - timeline[i - 1].t) > 1e-6);
    // 按 x 升序，供自适应缩放二分查询
    fitAtoms.sort((a, b) => a.x - b.x);
    this.staffFitAtoms = fitAtoms;
    // 固定谱头：不随乐谱滚动，始终显示调号等谱表头部信息
    const headEl = document.createElement('div');
    headEl.className = 'stave-head-fixed';
    headEl.style.height = `${canvasHeight}px`;
    this.scoreScrollEl.appendChild(headEl);
    const headWidth = renderStaveHead(headEl, ctx, y0, canvasHeight);
    const s = scaleY ?? 1;
    // 自适应缩放的最大比例可达 1（不放大），谱头宽度按原始尺寸留足，避免缩放变化时被裁切
    headEl.style.width = `${Math.max(1, Math.ceil(headWidth))}px`;
    // 谱头与音符条应用相同的缩放/居中变换，保证谱线完全对齐
    const headSvg = headEl.querySelector<SVGSVGElement>('svg');
    if (headSvg && (s !== 1 || (yOffset ?? 0) !== 0)) {
      headSvg.style.transformOrigin = '0 0';
      headSvg.style.transform = `translate(0, ${(yOffset ?? 0).toFixed(2)}px) scale(${s.toFixed(4)})`;
      this.scoreFitHeadSvg = headSvg;
    }
    this.scorePagerState = { ctx, midi, nMeas, measureWidth, y0, canvasHeight, scaleY: s, yOffset: yOffset ?? 0 };
    // 记录缩放上下文，供自适应缩放循环使用
    this.scoreFitSvg = stripEl.querySelector<SVGSVGElement>('.score-row-host .vf-wrap svg');
    try {
      const bb = this.scoreFitSvg?.getBBox();
      this.scoreFitBB = bb && bb.height > 0 ? { y: bb.y, height: bb.height } : null;
    } catch {
      this.scoreFitBB = null;
    }
    // 自适应缩放：初始状态为整曲适配结果，随后由循环按当前视图平滑过渡
    this.staffFitSmooth = {
      s: s,
      top: this.scoreFitBB?.y ?? y0 + 8,
      h: this.scoreFitBB?.height ?? 140,
      lastTx: Number.NEGATIVE_INFINITY,
    };
    this.staffFitStaveTop = y0 + 8;
    this.staffFitStaveBottom = y0 + 148;
    this.staffFitHeadW = headWidth;
    stripEl.style.minHeight = `${stripHeight}px`;
    this.startStaffFitLoop();
  }

  /** 移除固定谱头（切换渲染模式/重新渲染时调用） */
  private removeFixedStaveHead(): void {
    this.stopStaffFitLoop();
    this.scoreScrollEl.querySelector('.stave-head-fixed')?.remove();
    this.scoreFitSvg = null;
    this.scoreFitHeadSvg = null;
    this.scoreFitBB = null;
    this.staffFitAtoms = [];
  }

  /** 重置实时按键高亮状态（切换渲染模式/重新渲染时调用） */
  private resetStaffLiveHighlight(): void {
    this.clearStaffLiveHighlight();
    this.staffLivePressed.clear();
    this.staffLiveNotes = [];
    this.staffLiveTimeSec = 0;
    this.staffNoteTimeline = [];
    this.staffAtomEls.clear();
    this.staffWrongMidis.clear();
  }

  /** 清空高亮：移除音符样式类与临时错键音符（停止/结束时调用） */
  private clearStaffLiveHighlight(): void {
    for (const el of this.staffHighlightedEls) {
      el.classList.remove('staff-note-pressed');
      el.style.removeProperty('--note-glow');
    }
    this.staffHighlightedEls = [];
    for (const el of this.staffWrongNoteEls) {
      el.remove();
    }
    this.staffWrongNoteEls = [];
  }

  /** 跟弹/普通模式：接收绘制状态并更新逐音符高亮 */
  private handlePracticePaint(s: import('../rendering/fallingNotes').KeyboardFallingState | null): void {
    this.fallingNotes.updateKeyboardPractice(s);
    if (s) {
      this.staffLiveNotes = s.notes as unknown as NoteState[];
      this.staffLiveTimeSec = s.currentTimeSec;
      this.updateStaffLiveHighlight();
    }
  }

  /** 跟弹/普通模式：接收期望/按下状态并更新逐音符高亮 */
  private handleVisualState(_expected: Map<number, Hand>, pressed: Set<number>): void {
    // 同步错键集合：已松开的键不再标红
    for (const m of this.staffWrongMidis) {
      if (!pressed.has(m)) this.staffWrongMidis.delete(m);
    }
    this.staffLivePressed = pressed;
    this.updateStaffLiveHighlight();
  }

  /**
   * 直接修改当前音符元素实现高亮（不叠加图片）：
   * - 按下的正确音符 → 光晕高亮；
   * - 错键（引擎判定）→ 在当前位置注入临时红色空心音符。
   * 当前需要按的期望音符不做任何高亮。
   */
  private updateStaffLiveHighlight(): void {
    this.clearStaffLiveHighlight();
    const st = this.scorePagerState;
    if (!st || st.y0 === undefined) return;
    const svg = this.scoreEl.querySelector<Element>('.score-row-host .vf-wrap svg');
    if (!svg) return;

    // 当前时间附近待匹配/刚命中/正在延音的音符 → 其 SVG 音符组与符头索引（最近优先）
    const elByMidi = new Map<number, { el: SVGElement; keyIdx: number; d: number }>();
    for (const ns of this.staffLiveNotes) {
      if (!ns.note.noteKey) continue;
      const t = ns.note.time;
      const end = t + Math.max(0, ns.note.duration);
      // 含已命中音符：正确按键命中后按住期间仍保持高亮
      if (this.staffLiveTimeSec < t - 0.3 || this.staffLiveTimeSec > end + 0.4) continue;
      const parts = ns.note.noteKey.split(':');
      const atomKey = parts.slice(0, 3).join(':');
      const keyIdx = Number(parts[3]) || 0;
      const el = this.staffAtomEls.get(atomKey);
      if (!el) continue;
      const d = Math.abs(t - this.staffLiveTimeSec);
      const cur = elByMidi.get(ns.note.midi);
      if (!cur || d < cur.d) elByMidi.set(ns.note.midi, { el, keyIdx, d });
    }

    // 按下的键：错键（引擎判定）→ 红色空心音符；正确 → 只高亮对应符头（颜色跟随音高）
    for (const midi of this.staffLivePressed) {
      if (this.staffWrongMidis.has(midi)) {
        const wrong = this.createStaffWrongNote(svg, midi, st.y0);
        if (wrong) this.staffWrongNoteEls.push(wrong);
        continue;
      }
      const ent = elByMidi.get(midi);
      if (ent) {
        const head = ent.el.querySelectorAll<SVGElement>('.vf-notehead')[ent.keyIdx];
        if (!head) continue;
        head.classList.add('staff-note-pressed');
        // 高亮颜色跟随音符音高（与下落音符/符头同色系）
        const pc = ((midi % 12) + 12) % 12;
        const letter = ['c', 'c', 'd', 'd', 'e', 'f', 'f', 'g', 'g', 'a', 'a', 'b'][pc] ?? 'c';
        head.style.setProperty('--note-glow', NOTE_COLORS[letter] ?? '#4f6ef7');
        this.staffHighlightedEls.push(head);
      }
    }
  }

  /**
   * 错键音符应绘制在哪条谱表：与乐谱实际分谱一致（多轨按轨、单轨按音高）。
   * 同一音高在两谱表都出现时，取当前时间最近的一次，贴近实际演奏位置。
   */
  private handForWrongMidi(midi: number, timeSec: number): Hand {
    const file = this.currentMidi;
    if (file) {
      let best: FlatNote | null = null;
      let bestD = Infinity;
      for (const fn of this.flatNotes) {
        if (fn.midi !== midi) continue;
        const d = Math.abs(fn.time - timeSec);
        if (d < bestD) {
          bestD = d;
          best = fn;
        }
      }
      if (best) return assignHandForNote(best, file);
    }
    return midi >= 60 ? 'treble' : 'bass';
  }

  /** 创建错键红色音符（SVG 元素，随乐谱滚动） */
  private createStaffWrongNote(svg: Element, midi: number, y0: number): Element | null {
    const x = this.staffXForTime(this.staffLiveTimeSec);
    if (x === null) return null;
    const hand = this.handForWrongMidi(midi, this.staffLiveTimeSec);
    const y = staffNoteY(midi, hand, y0);
    const NS = 'http://www.w3.org/2000/svg';
    const g = document.createElementNS(NS, 'g');
    g.setAttribute('class', 'staff-wrong-note');
    const inner = document.createElementNS(NS, 'g');
    inner.setAttribute('transform', `translate(${x}, ${y}) rotate(-20)`);
    const head = document.createElementNS(NS, 'ellipse');
    head.setAttribute('cx', '0');
    head.setAttribute('cy', '0');
    head.setAttribute('rx', '5');
    head.setAttribute('ry', '3.6');
    // 红色空心（描边、内部透明）
    head.setAttribute('fill', 'none');
    head.setAttribute('stroke', '#e53935');
    head.setAttribute('stroke-width', '2');
    inner.appendChild(head);
    g.appendChild(inner);
    svg.appendChild(g);
    return g;
  }

  private renderStaffOriginal(parent: HTMLElement, midi: Midi, measureWidth: number): void {
    const ctx = getMeasureContext(midi);
    const nMeas = measureCount(midi, ctx);
    const measuresPerRow = SCORE_LAYOUT.measuresPerRow;
    this.scorePagerState = { ctx, midi, nMeas, measureWidth };

    parent.style.cssText = '';
    this.scoreScrollEl.style.cssText = 'overflow:auto;position:relative';

    for (let start = 0; start < nMeas; start += measuresPerRow) {
      const rowWrap = document.createElement('div');
      rowWrap.className = 'score-measure-row';
      parent.appendChild(rowWrap);
      const end = Math.min(nMeas, start + measuresPerRow);
      const columns: GrandStaffColumn[] = [];
      for (let i = start; i < end; i++) {
        columns.push({
          measureIndex: i, trebleAtoms: buildAtomsForHand(this.flatNotes, midi, 'treble', ctx, i),
          bassAtoms: buildAtomsForHand(this.flatNotes, midi, 'bass', ctx, i), showStaffHeader: i === start,
        });
      }
      renderGrandStaffRowSVG(rowWrap, columns, ctx, measureWidth, this.staffEditState,
        this.editModeActive ? this.selectedNoteKeys : undefined);
    }
  }

  private addJudgmentLine(): void {
    const old = this.scoreScrollEl.querySelector('.judgment-line');
    if (old) old.remove();
    const line = document.createElement('div');
    line.className = 'judgment-line';
    line.setAttribute('aria-hidden', 'true');
    this.scoreScrollEl.appendChild(line);
  }

  /**
   * 计算某时间在滚动条中的 x（基于全曲音符实际渲染位置，相邻音符间线性插值）。
   * 使用全曲统一时间线，避免跨小节边界时的位置突跳。
   * @returns null 表示暂无位置数据
   */
  private staffXForTime(timeSec: number): number | null {
    const tl = this.staffNoteTimeline;
    if (tl.length === 0) return null;
    const first = tl[0];
    const last = tl[tl.length - 1];
    if (timeSec <= first.t) return first.x;
    if (timeSec >= last.t) return last.x;
    for (let k = 1; k < tl.length; k++) {
      if (timeSec <= tl[k].t) {
        const a = tl[k - 1];
        const b = tl[k];
        const f = Math.min(1, Math.max(0, (timeSec - a.t) / Math.max(1e-6, b.t - a.t)));
        return a.x + f * (b.x - a.x);
      }
    }
    return last.x;
  }

  private resetStaffScroll(): void {
    this.scrollStaffToProgress(0);
  }

  private getJudgeX(): number {
    return Math.max(80, Math.floor(this.scoreScrollEl.clientWidth * 0.25));
  }

  /** 滚动乐谱，使当前时间对应的音符精确对齐判定线（基于音符实际渲染 x） */
  private scrollStaffToProgress(progress01: number): void {
    const st = this.scorePagerState;
    if (!st) return;
    this.scrollStaffToTime(progress01 * st.midi.duration);
  }

  private scrollStaffToTime(timeSec: number): void {
    const st = this.scorePagerState;
    if (!st) return;
    const x = this.staffXForTime(timeSec);
    const judgeX = this.getJudgeX();
    // 五线谱自动缩放后，音符实际渲染位置 = 原始 x * scaleY
    const s = st.scaleY ?? 1;
    this.scoreEl.style.transform = x === null
      ? `translateX(${judgeX}px)`
      : `translateX(${judgeX - x * s}px)`;
  }

  /** 窗口高度变化时（28vh 容器随之变化）自适应缩放循环会读取最新容器高度，确保循环在运行即可 */
  private handleScoreResize(): void {
    this.startStaffFitLoop();
  }

  /** 启动自适应缩放循环（rAF，幂等） */
  private startStaffFitLoop(): void {
    if (this.staffFitRaf) return;
    const loop = () => {
      this.staffFitRaf = requestAnimationFrame(loop);
      this.updateStaffFit();
    };
    this.staffFitRaf = requestAnimationFrame(loop);
  }

  /** 停止自适应缩放循环（切换渲染模式/重新渲染时调用） */
  private stopStaffFitLoop(): void {
    if (this.staffFitRaf) {
      cancelAnimationFrame(this.staffFitRaf);
      this.staffFitRaf = 0;
    }
  }

  /** 读取当前滚动 translateX（屏幕坐标） */
  private parseScoreTranslateX(): number {
    const m = this.scoreEl.style.transform.match(/translateX\((-?[\d.]+)px\)/);
    return m ? parseFloat(m[1]) : 0;
  }

  /**
   * 按当前视图自适应缩放：以「可见 x 窗口内音符的 y 并集」为目标范围，
   * 用指数平滑让缩放比例与垂直位置缓慢衔接，避免突变。
   * 缩放后：屏幕 x = 原始 x * s；屏幕 y = 原始 y * s + oy。
   */
  private updateStaffFit(): void {
    const st = this.scorePagerState;
    if (!st || st.y0 === undefined || !this.scoreFitSvg) return;
    const clientH = this.scoreScrollEl.clientHeight;
    const clientW = this.scoreScrollEl.clientWidth;
    if (clientH <= 0 || clientW <= 0) return;

    const sm = this.staffFitSmooth;
    const tx = this.parseScoreTranslateX();
    const sCur = sm.s;
    // 可见原始 x 窗口（谱头覆盖区域不算可视）
    const viewLeft = (this.staffFitHeadW - tx) / sCur;
    const viewRight = (clientW - tx) / sCur;
    // 窗口内音符 y 并集（含谱表本身范围作为下限）
    let top = this.staffFitStaveTop;
    let bottom = this.staffFitStaveBottom;
    if (viewRight > viewLeft && this.staffFitAtoms.length > 0) {
      let a = 0;
      let b = this.staffFitAtoms.length;
      while (a < b) {
        const m = (a + b) >> 1;
        if (this.staffFitAtoms[m].x < viewLeft) a = m + 1;
        else b = m;
      }
      for (let i = a; i < this.staffFitAtoms.length; i++) {
        const at = this.staffFitAtoms[i];
        if (at.x > viewRight) break;
        if (at.top < top) top = at.top;
        if (at.bottom > bottom) bottom = at.bottom;
      }
    }
    const hRaw = Math.max(1, bottom - top);
    const fitH = Math.max(140, clientH - 2);
    const sRaw = Math.min(1, fitH / hRaw);
    // 指数平滑（时间常数 ≈ 140ms），衔接光滑
    const now = performance.now();
    const dt = Math.min(64, Math.max(0, now - this.staffFitLastT));
    this.staffFitLastT = now;
    const k = 1 - Math.exp(-dt / 140);
    const sNew = sm.s + (sRaw - sm.s) * k;
    const topNew = sm.top + (top - sm.top) * k;
    const hNew = sm.h + (hRaw - sm.h) * k;
    const changed = Math.abs(sNew - sCur) > 0.0003
      || Math.abs(topNew - sm.top) > 0.3
      || Math.abs(hNew - sm.h) > 0.3;
    if (!changed && Math.abs(tx - sm.lastTx) < 0.5) return; // 视图与目标均未变化
    sm.s = sNew;
    sm.top = topNew;
    sm.h = hNew;
    sm.lastTx = tx;
    const oy = (fitH - hNew * sNew) / 2 - topNew * sNew;
    const tf = `translate(0, ${oy.toFixed(2)}px) scale(${sNew.toFixed(4)})`;
    this.scoreFitSvg.style.transformOrigin = '0 0';
    this.scoreFitSvg.style.transform = tf;
    if (this.scoreFitHeadSvg) {
      this.scoreFitHeadSvg.style.transformOrigin = '0 0';
      this.scoreFitHeadSvg.style.transform = tf;
    }
    st.scaleY = sNew;
    st.yOffset = oy;
    // 缩放变化会改变音符屏幕 x；空闲时（非播放中）重新对齐判定线
    if (Math.abs(sNew - sCur) > 0.0003 && !this.playback) {
      const total = st.midi.duration;
      const progress01 = total > 0 ? Math.min(1, Math.max(0, Number(this.progressBar.value) / 1000)) : 0;
      this.scrollStaffToProgress(progress01);
    }
  }

  private updateMeasureInfo(current: number, total: number): void {
    if (total <= 0) { this.measureInfoEl.textContent = ''; return; }
    this.measureInfoEl.textContent = `第 ${current + 1} / ${total} 小节`;
  }

  private updatePlayheadImage(timeSec: number): void {
    const st = this.scorePagerState;
    const midi = this.currentMidi;
    if (!st || !midi) { this.resetStaffScroll(); return; }
    if (timeSec >= midi.duration - 1e-3 || timeSec < 0) { this.resetStaffScroll(); return; }
    const ticks = midi.header.secondsToTicks(Math.max(0, timeSec));
    const progress = Math.min(1, Math.max(0, ticks / midi.durationTicks));
    this.scrollStaffToProgress(progress);
    const m = Math.floor(ticks / st.ctx.ticksPerMeasure);
    this.updateMeasureInfo(Math.min(m, st.nMeas - 1), st.nMeas);
  }

  private updatePlayheadOriginal(timeSec: number): void {
    const st = this.scorePagerState;
    const midi = this.currentMidi;
    if (!st || !midi) { this.hideScorePlayhead(); return; }
    if (timeSec >= midi.duration - 1e-3 || timeSec < 0) { this.hideScorePlayhead(); return; }

    const ticks = midi.header.secondsToTicks(Math.max(0, timeSec));
    let m = Math.floor(ticks / st.ctx.ticksPerMeasure);
    if (m < 0) m = 0;
    if (m >= st.nMeas) m = st.nMeas - 1;
    this.updateMeasureInfo(m, st.nMeas);

    const measureStartTick = m * st.ctx.ticksPerMeasure;
    const progress = Math.min(1, Math.max(0, (ticks - measureStartTick) / st.ctx.ticksPerMeasure));
    const measuresPerRow = SCORE_LAYOUT.measuresPerRow;
    const colInRow = m % measuresPerRow;

    for (const row of this.scoreEl.querySelectorAll<HTMLElement>('.score-measure')) {
      const ph = row.querySelector<HTMLElement>('.playhead');
      if (!ph) continue;
      const midx = Number(row.dataset.measureIndex);
      if (midx !== m) { ph.classList.remove('is-visible'); continue; }
      const hasHeader = row.dataset.hasStaffHeader === '1';
      ph.style.left = `${playheadXInMeasureOverlay(measuresPerRow, st.measureWidth, colInRow, hasHeader, progress, st.ctx.keySignature)}px`;
      ph.classList.add('is-visible');
    }
  }
}

function noteRange(notes: FlatNote[]): { min: number; max: number } {
  if (notes.length === 0) return { min: 57, max: 72 };
  let min = 127;
  let max = 0;
  for (const n of notes) {
    min = Math.min(min, n.midi);
    max = Math.max(max, n.midi);
  }
  return { min: Math.max(21, min - 2), max: Math.min(108, max + 2) };
}

/** 根据可用宽度扩展键盘范围，居中对称 */
function expandRangeToFill(range: { min: number; max: number }, availW: number): { min: number; max: number } {
  const whiteW = 28;
  const targetKeys = Math.floor(availW / whiteW);
  if (targetKeys < 1) return range;

  let wc = 0;
  for (let m = range.min; m <= range.max; m++) if (isWhiteKey(m)) wc++;
  let min = range.min;
  let max = range.max;
  while (wc < targetKeys) {
    if (min > 21) { min--; if (isWhiteKey(min)) wc++; }
    if (wc >= targetKeys) break;
    if (max < 108) { max++; if (isWhiteKey(max)) wc++; }
    if (min <= 21 && max >= 108) break;
  }
  return { min, max };
}
