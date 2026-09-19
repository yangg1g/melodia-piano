import { Dot, Factory, VoiceMode } from 'vexflow';
import type { StaveNote } from 'vexflow';
import { vexVoiceTimeStr, type Hand, type MeasureContext, type VoiceAtom } from '../core/midiScore';
import { colorForVexKey } from '../core/pitchUtil';
import type { NoteKey, StaffEditState } from '../features/staffEditor';

const BASE_SCORE_HEIGHT = 220;
const BASE_SYSTEM_Y = 12;

/**
 * VexFlow 支持的调号 → 升降号数量，与 VexFlow 内置 keySignature 表保持一致。
 * 大调/小调共 30 个；个别 VexFlow 未收录的降号小调在 {@link toVexKeySpec} 中做同音异名兜底。
 */
const KEY_SIG_COUNTS: Record<string, number> = {
  // 无升降号
  C: 0, Am: 0,
  // 升号调（含关系小调）
  G: 1, Em: 1,
  D: 2, Bm: 2,
  A: 3, 'F#m': 3,
  E: 4, 'C#m': 4,
  B: 5, 'G#m': 5,
  'F#': 6, 'D#m': 6,
  'C#': 7, 'A#m': 7,
  // 降号调（含关系小调）
  F: 1, Dm: 1,
  Bb: 2, Gm: 2,
  Eb: 3, Cm: 3,
  Ab: 4, Fm: 4,
  Db: 5, Bbm: 5,
  Gb: 6, Ebm: 6,
  Cb: 7, Abm: 7,
};

/** 将 MIDI 调号字符串转为 VexFlow 支持的 key spec（未知调号回退 'C'） */
function toVexKeySpec(key: string): string {
  const k = (key ?? '').trim();
  if (KEY_SIG_COUNTS[k] !== undefined) return k;
  // 同音异名兜底：VexFlow 未收录 Cb/Gb/Db 小调，映射到等价调
  const ENH: Record<string, string> = { Cbm: 'Bm', Gbm: 'F#m', Dbm: 'C#m' };
  const mapped = ENH[k];
  if (mapped && KEY_SIG_COUNTS[mapped] !== undefined) return mapped;
  return 'C';
}

/** 五度圈：升号调依次升 F C G D A E B，降号调依次降 B E A D G C F */
const SHARP_ORDER = ['f', 'c', 'g', 'd', 'a', 'e', 'b'];
const FLAT_ORDER = ['b', 'e', 'a', 'd', 'g', 'c', 'f'];
/** 降号调（大调 + 小调），其余非零调号按升号调处理 */
const FLAT_KEYS = new Set(['F', 'Bb', 'Eb', 'Ab', 'Db', 'Gb', 'Cb', 'Dm', 'Gm', 'Cm', 'Fm', 'Bbm', 'Ebm', 'Abm']);

/** 返回调号中被升/降的音名集合（小写字母），C 大调返回空集 */
function keySigAlteredLetters(keySpec: string): Set<string> {
  const spec = toVexKeySpec(keySpec);
  const count = KEY_SIG_COUNTS[spec] ?? 0;
  if (count === 0) return new Set();
  const order = FLAT_KEYS.has(spec) ? FLAT_ORDER : SHARP_ORDER;
  return new Set(order.slice(0, count));
}

/**
 * 依据调号补齐音符的临时记号（升号/降号/还原号）。
 * VexFlow 5 的 StaveNote 不会从 key 字符串渲染临时记号，故在此手动添加：
 * - 音名与调号一致（如 B 大调的 F#）→ 省略记号（调号已隐含）；
 * - 调号中有该音名的升降但音符为自然音 → 还原号 ♮；
 * - 调号中该音名为自然音但音符带升降号 → 升号 ♯ / 降号 ♭。
 */
function applyKeySigAccidentals(factory: Factory, note: StaveNote, keySpec: string): void {
  const spec = toVexKeySpec(keySpec);
  const altered = keySigAlteredLetters(spec);
  const keys = note.getKeys();
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i] ?? '';
    const slash = k.indexOf('/');
    if (slash <= 0) continue;
    const letter = k[0].toLowerCase();
    const acc = k.slice(1, slash); // '' | '#' | 'b'
    const inKeySig = altered.has(letter);
    if (acc === '' && inKeySig) {
      // 调号含该音名的升降，而本音为自然音 → 还原号 ♮
      note.addModifier(factory.Accidental({ type: 'n' }), i);
    } else if (acc !== '' && !inKeySig) {
      // 音符自带升降号且调号未含该音名 → 显示 ♯ / ♭
      note.addModifier(factory.Accidental({ type: acc === 'b' ? 'b' : '#' }), i);
    }
    // 其余情况（与调号一致的升降号）已隐含，无需显示
  }
}

/* ── 共享布局计算 ── */

/** 音名在七声音阶中的序号（C=0 … B=6），按 MIDI 音高（含升降） */
const DIATONIC_INDEX = [0, 0, 1, 1, 2, 3, 3, 4, 4, 5, 5, 6];

function diatonicOf(midi: number): number {
  const oct = Math.floor(midi / 12) - 1;
  return oct * 7 + DIATONIC_INDEX[((midi % 12) + 12) % 12];
}

/**
 * MIDI 音高在五线谱上的 y（相对乐谱容器顶部）。
 * 与 VexFlow 5 实际渲染几何一致（已用 DOM 谱线位置核对）：
 * - VexFlow 5 默认 spaceAboveStaffLn=4、线距 10 → 顶部线 = 谱表 y + 4×10 + 0.5(线宽对齐)；
 *   底部线为第 4 线 → 谱表 y + 80（线与音符均以 80 为几何中心，0.5 为描边像素校正）
 * - 高音谱底部线 = E4（音级 30），低音谱底部线 = G2（音级 18）
 * - 相邻线/间 = 1 音级 = 5px
 */
export function staffNoteY(midi: number, hand: Hand, y0: number): number {
  const base = hand === 'treble' ? 30 : 18;
  const staveY = hand === 'treble' ? y0 : y0 + 100;
  return staveY + 80 - (diatonicOf(midi) - base) * 5;
}

/** 根据音符八度估算上下留白，避免加线音符被 canvas 裁切 */
function canvasPaddingForAtoms(treble: VoiceAtom[], bass: VoiceAtom[]): { padTop: number; padBottom: number } {
  let minOct = 99;
  let maxOct = -99;
  const scan = (atoms: VoiceAtom[]) => {
    for (const a of atoms) {
      if (a.rest) continue;
      for (const k of a.keys) {
        const slash = k.lastIndexOf('/');
        if (slash <= 0) continue;
        const oct = parseInt(k.slice(slash + 1), 10);
        if (!Number.isFinite(oct)) continue;
        minOct = Math.min(minOct, oct);
        maxOct = Math.max(maxOct, oct);
      }
    }
  };
  scan(treble);
  scan(bass);
  if (minOct === 99) minOct = 3;
  if (maxOct === -99) maxOct = 5;

  let padBottom = 32;
  if (minOct <= 3) padBottom += 12;
  if (minOct <= 2) padBottom += 44;
  if (minOct <= 1) padBottom += 40;
  if (minOct <= 0) padBottom += 36;

  let padTop = 20;
  if (maxOct >= 6) padTop += 28;
  if (maxOct >= 7) padTop += 32;

  return { padTop, padBottom };
}

/** 创建小节 overlay（播放头占位） */
function createMeasureOverlays(host: HTMLElement, columns: GrandStaffColumn[], columnWidth: number): void {
  for (let i = 0; i < columns.length; i++) {
    const col = columns[i];
    const overlay = document.createElement('div');
    overlay.className = 'score-measure';
    overlay.dataset.measureIndex = String(col.measureIndex);
    overlay.dataset.hasStaffHeader = col.showStaffHeader ? '1' : '0';
    overlay.style.cssText = `position:absolute;left:${i * columnWidth}px;top:0;width:${columnWidth}px;height:100%;pointer-events:none;box-sizing:border-box`;
    const wrap = document.createElement('div');
    wrap.className = 'score-measure-wrap';
    wrap.style.cssText = 'position:relative;height:100%';
    const playhead = document.createElement('div');
    playhead.className = 'playhead';
    playhead.setAttribute('aria-hidden', 'true');
    wrap.appendChild(playhead);
    overlay.appendChild(wrap);
    host.appendChild(overlay);
  }
}

/** 将 atom 转成 StaveNote（共享逻辑） */
function atomToNote(factory: Factory, atom: VoiceAtom, clef: Hand) {
  const keys = atom.rest ? atom.keys : [...atom.keys].sort();
  const note = factory.StaveNote({
    keys,
    duration: atom.duration,
    dots: atom.dots,
    clef,
    autoStem: true,
    ...(atom.rest ? { type: 'r' as const } : {}),
  });
  const nDots = atom.dots ?? 0;
  if (nDots > 0) {
    const dotAttachOpts = !atom.rest && keys.length > 1 ? ({ all: true } as const) : undefined;
    for (let i = 0; i < nDots; i++) {
      Dot.buildAndAttach([note], dotAttachOpts);
    }
  }
  return note;
}

/**
 * 和弦多符头逐键上色：VexFlow 只能整音符设置一种颜色（取首键音色），
 * 此处绘制后按每个键给对应符头单独设置音高颜色（如 B+F 和弦中 B=青、F=蓝）。
 */
function applyPerKeyNoteheadColors(atomNotes: Map<string, StaveNote>): void {
  for (const [, note] of atomNotes) {
    const keys = note.getKeys();
    if (keys.length <= 1) continue;
    const noteheads = note.getSVGElement()?.querySelectorAll<SVGElement>('.vf-notehead');
    if (!noteheads || noteheads.length === 0) continue;
    keys.forEach((k, i) => {
      const head = noteheads[i];
      if (!head) return;
      const color = colorForVexKey(k);
      head.querySelectorAll<SVGElement>('text').forEach((t) => {
        t.style.fill = color;
        t.style.stroke = color;
      });
    });
  }
}

/** 核心：构建 VexFlow System 并返回 noteMap 与 atom→StaveNote 引用（供绘制后读取音符实际 x） */
function buildSystems(
  factory: Factory,
  columns: GrandStaffColumn[],
  ctx: MeasureContext,
  y0: number,
  segW: number,
  editState?: StaffEditState,
): { noteMap: Map<NoteKey, { note: StaveNote; keyIdx: number }>; atomNotes: Map<string, StaveNote> } {
  const noteMap = new Map<NoteKey, { note: StaveNote; keyIdx: number }>();
  const atomNotes = new Map<string, StaveNote>();
  const vexKeySpec = toVexKeySpec(ctx.keySignature);

  for (let i = 0; i < columns.length; i++) {
    const col = columns[i];
    const sysX = 12 + i * segW;
    const system = factory.System({
      x: sysX,
      y: y0,
      width: segW,
      spaceBetweenStaves: 10,
      formatOptions: { alignRests: true },
    });

    const staveBarOpts = { leftBar: col.showStaffHeader, rightBar: true };

    // 高音谱
    const trebleVoice = factory.Voice({ time: vexVoiceTimeStr(ctx.timeSig) });
    trebleVoice.setMode(VoiceMode.SOFT);
    for (let ai = 0; ai < col.trebleAtoms.length; ai++) {
      const sn = atomToNote(factory, col.trebleAtoms[ai], 'treble');
      trebleVoice.addTickables([sn]);
      if (!col.trebleAtoms[ai].rest) {
        atomNotes.set(`${col.measureIndex}:treble:${ai}`, sn);
        applyKeySigAccidentals(factory, sn, ctx.keySignature);
        if (sn.getKeys().length > 0) {
          const color = colorForVexKey(sn.getKeys()[0]);
          sn.setStyle({ fillStyle: color, strokeStyle: color });
        }
      }
      if (editState && !col.trebleAtoms[ai].rest) {
        for (let ki = 0; ki < sn.getKeys().length; ki++) {
          noteMap.set(`${col.measureIndex}:treble:${ai}:${ki}` as NoteKey, { note: sn, keyIdx: ki });
        }
      }
    }

    // 低音谱
    const bassVoice = factory.Voice({ time: vexVoiceTimeStr(ctx.timeSig) });
    bassVoice.setMode(VoiceMode.SOFT);
    for (let ai = 0; ai < col.bassAtoms.length; ai++) {
      const sn = atomToNote(factory, col.bassAtoms[ai], 'bass');
      bassVoice.addTickables([sn]);
      if (!col.bassAtoms[ai].rest) {
        atomNotes.set(`${col.measureIndex}:bass:${ai}`, sn);
        applyKeySigAccidentals(factory, sn, ctx.keySignature);
        if (sn.getKeys().length > 0) {
          const color = colorForVexKey(sn.getKeys()[0]);
          sn.setStyle({ fillStyle: color, strokeStyle: color });
        }
      }
      if (editState && !col.bassAtoms[ai].rest) {
        for (let ki = 0; ki < sn.getKeys().length; ki++) {
          noteMap.set(`${col.measureIndex}:bass:${ai}:${ki}` as NoteKey, { note: sn, keyIdx: ki });
        }
      }
    }

    let trebleStave = system.addStave({ voices: [trebleVoice], options: staveBarOpts });
    if (col.showStaffHeader) {
      trebleStave = trebleStave.addClef('treble').addKeySignature(vexKeySpec).addTimeSignature(ctx.timeSigStr);
    }

    let bassStave = system.addStave({ voices: [bassVoice], options: staveBarOpts });
    if (col.showStaffHeader) {
      bassStave = bassStave.addClef('bass').addKeySignature(vexKeySpec).addTimeSignature(ctx.timeSigStr);
    }

    if (i === 0) {
      system.addConnector('brace');
    }
    system.addConnector('singleRight');
    system.addConnector('singleLeft');
  }

  return { noteMap, atomNotes };
}

/** 应用编辑注解（符尾方向、连线、连尾、指法、选中高亮） */
function applyEditDecorations(
  factory: Factory,
  noteMap: Map<NoteKey, { note: StaveNote; keyIdx: number }>,
  editState?: StaffEditState,
  selectedNoteKeys?: Set<NoteKey>,
): void {
  if (!editState) {
    // 仅选中高亮
    if (selectedNoteKeys) {
      for (const nk of selectedNoteKeys) {
        const entry = noteMap.get(nk);
        if (entry) entry.note.setStyle({ fillStyle: '#e53935', strokeStyle: '#e53935' });
      }
    }
    return;
  }

  // 符尾方向
  for (const [nk, dir] of editState.stemDirections) {
    const entry = noteMap.get(nk);
    if (entry) entry.note.setStemDirection(dir);
  }

  // 连音线
  for (const slur of editState.slurs) {
    const from = noteMap.get(slur.from);
    const to = noteMap.get(slur.to);
    if (from && to) {
      factory.StaveTie({
        from: from.note, to: to.note,
        firstIndexes: [from.keyIdx], lastIndexes: [to.keyIdx],
      });
    }
  }

  // 连尾
  for (const tie of editState.ties) {
    const pf = tie.from.split(':'), pt = tie.to.split(':');
    if (pf[0] !== pt[0] || pf[1] !== pt[1]) continue;
    const sA = Math.min(Number(pf[2]), Number(pt[2]));
    const eA = Math.max(Number(pf[2]), Number(pt[2]));
    const seen = new Set<StaveNote>();
    const beamNotes: StaveNote[] = [];
    for (let ai = sA; ai <= eA; ai++) {
      const prefix = `${pf[0]}:${pf[1]}:${ai}:`;
      for (const [nk, entry] of noteMap) {
        if (nk.startsWith(prefix) && !seen.has(entry.note)) {
          seen.add(entry.note);
          beamNotes.push(entry.note);
        }
      }
    }
    if (beamNotes.length >= 2) factory.Beam({ notes: beamNotes });
  }

  // 指法编号（有符尾时放在左侧避免遮挡）
  for (const [nk, finger] of editState.fingerNumbers) {
    const entry = noteMap.get(nk);
    if (entry) {
      const dur = entry.note.getDuration();
      const hasFlag = ['8', '16', '32', '64'].includes(dur);
      const fing = factory.Fingering({ number: String(finger), position: hasFlag ? 'left' : 'above' });
      entry.note.addModifier(fing, entry.keyIdx);
    }
  }

  // 选中高亮
  if (selectedNoteKeys) {
    for (const nk of selectedNoteKeys) {
      const entry = noteMap.get(nk);
      if (entry) entry.note.setStyle({ fillStyle: '#e53935', strokeStyle: '#e53935' });
    }
  }
}

/* ── 公开 API ── */

export type GrandStaffColumn = {
  measureIndex: number;
  trebleAtoms: VoiceAtom[];
  bassAtoms: VoiceAtom[];
  showStaffHeader: boolean;
};

/**
 * 与 {@link renderGrandStaffRowSVG} 中 VexFlow System（x≈12、segW、行内相接）一致；
 * 坐标为「单行内该小节 overlay 局部」，与绝对定位的 column 左缘对齐。
 */
export function playheadXInMeasureOverlay(
  measuresInRow: number,
  columnWidth: number,
  columnIndexInRow: number,
  hasStaffHeader: boolean,
  progress01: number,
  keySignature = 'C',
): number {
  const n = Math.max(1, measuresInRow);
  const totalW = n * columnWidth;
  const segW = Math.max(40, Math.floor((totalW - 24) / n));
  const systemLocalLeft = 12 + columnIndexInRow * (segW - columnWidth);
  // 调号每增一个升降号，谱表头部约加宽 10px（与 VexFlow 内部排版一致）
  const keySigExtra = hasStaffHeader ? (KEY_SIG_COUNTS[toVexKeySpec(keySignature)] ?? 0) * 10 : 0;
  const innerLeft = (hasStaffHeader ? 84 : 14) + keySigExtra;
  const rightPad = 12;
  const span = Math.max(12, segW - innerLeft - rightPad);
  const p = Math.min(1, Math.max(0, progress01));
  return systemLocalLeft + innerLeft + p * span;
}

/**
 * 将一行内多小节渲染为 SVG 矢量谱（整曲一条滚动条）。
 * 与 Canvas 版本相比：每个音符是独立的 SVG 元素（可逐音符操作），任意 DPI 下清晰。
 * `columnWidth` 为版面分配给每小节的宽度。
 * `hideOverlays` 为 true 时不生成播放头 overlay。
 * 返回高度（含底部留白）、总宽度、谱线起点 y0、谱面高度与音符实际 x，供固定谱头/滚动/叠加层对齐使用。
 */
export function renderGrandStaffRow(
  container: HTMLElement,
  columns: GrandStaffColumn[],
  ctx: MeasureContext,
  columnWidth: number,
  hideOverlays = false,
  editState?: StaffEditState,
  selectedNoteKeys?: Set<NoteKey>,
  fitHeight?: number,
): { height: number; totalWidth: number; y0: number; canvasHeight: number; scaleY: number; yOffset: number; noteXByAtom: Map<string, { x: number; el: SVGElement | null; top?: number; bottom?: number }> } {
  const n = columns.length;
  if (n === 0) return { height: 0, totalWidth: 0, y0: BASE_SYSTEM_Y, canvasHeight: 0, scaleY: 1, yOffset: 0, noteXByAtom: new Map() };

  // 布局计算
  let maxPadTop = 0;
  let maxPadBottom = 0;
  for (const c of columns) {
    const p = canvasPaddingForAtoms(c.trebleAtoms, c.bassAtoms);
    maxPadTop = Math.max(maxPadTop, p.padTop);
    maxPadBottom = Math.max(maxPadBottom, p.padBottom);
  }
  const y0 = BASE_SYSTEM_Y + maxPadTop;
  const height = BASE_SCORE_HEIGHT + maxPadTop + maxPadBottom;
  const totalWidth = n * columnWidth;
  const segW = Math.max(40, Math.floor((totalWidth - 24) / n));

  const host = document.createElement('div');
  host.className = 'score-row-host';
  host.style.cssText = `position:relative;width:${totalWidth}px;height:${height}px;flex-shrink:0`;

  // SVG 渲染容器（音符为独立 DOM 元素）
  const vfId = `vf-strip-${Math.random().toString(36).slice(2)}`;
  const vfWrap = document.createElement('div');
  vfWrap.className = 'vf-wrap';
  vfWrap.id = vfId;
  host.appendChild(vfWrap);

  if (!hideOverlays) {
    createMeasureOverlays(host, columns, columnWidth);
  }
  container.appendChild(host);

  // VexFlow 绘制（SVG 后端）
  const factory = new Factory({
    renderer: { elementId: vfId, width: totalWidth, height },
  });
  const { noteMap, atomNotes } = buildSystems(factory, columns, ctx, y0, segW, editState);
  applyEditDecorations(factory, noteMap, editState, selectedNoteKeys);
  factory.draw();

  // 绘制后读取每个音符符头的实际 x 与 SVG 元素（供滚动对齐 / 逐音符高亮），
  // 并记录每个音符的 y 范围（供按当前视图自适应缩放）。
  // 注意：SVG text 字形的 getBBox 会被字体度量膨胀（单个符头可高 160px+），
  // 因此这里用「真实路径几何（符杆/加线）+ 符头基线 ± 固定墨水高度」估算实际绘制范围。
  const noteXByAtom = new Map<string, { x: number; el: SVGElement | null; top?: number; bottom?: number }>();
  for (const [key, note] of atomNotes) {
    let top: number | undefined;
    let bottom: number | undefined;
    try {
      const el = note.getSVGElement();
      if (el) {
        let t = Infinity;
        let b = -Infinity;
        // 真实路径：符杆 / 加线 / 连音弧线等（path 的 bbox 不膨胀）
        el.querySelectorAll<SVGGraphicsElement>('path').forEach((p) => {
          try {
            const r = p.getBBox();
            t = Math.min(t, r.y);
            b = Math.max(b, r.y + r.height);
          } catch {
            // 忽略单个路径失败
          }
        });
        // 符头字形：取基线 y 属性 + 固定墨水高度（真实符头约 13px，居基线略上）
        el.querySelectorAll<SVGTextElement>('.vf-notehead text').forEach((tx) => {
          const base = parseFloat(tx.getAttribute('y') ?? '');
          if (Number.isFinite(base)) {
            t = Math.min(t, base - 15);
            b = Math.max(b, base + 10);
          }
        });
        if (Number.isFinite(t)) {
          // 横梁位于符杆顶端上方约 14px，统一加余量
          top = t - 14;
          bottom = b;
        }
      }
    } catch {
      // 提取失败时忽略 y 范围
    }
    noteXByAtom.set(key, { x: note.getAbsoluteX(), el: note.getSVGElement() ?? null, top, bottom });
  }
  applyPerKeyNoteheadColors(atomNotes);

  // 自动缩放 + 垂直居中：SVG 内容包围盒超出可用高度时整体等比缩小（避免音符被容器裁切），
  // 缩放以 (0,0) 为原点、以 CSS transform 应用到 svg 根元素（不触碰 VexFlow 内部组结构）。
  // 变换后：屏幕 x = 原始 x * s；屏幕 y = 原始 y * s + yOffset。
  // 调用方须用 scaleY 换算滚动定位（translateX 用 x*s），错键音符等叠加元素直接使用原始坐标即可。
  let scaleY = 1;
  let yOffset = 0;
  if (fitHeight && fitHeight > 0) {
    const svg = vfWrap.querySelector<SVGSVGElement>('svg');
    if (svg) {
      try {
        const bb = svg.getBBox();
        if (bb.height > 1) {
          const s = Math.min(1, fitHeight / bb.height);
          const oy = (fitHeight - bb.height * s) / 2 - bb.y * s;
          if (Math.abs(s - 1) > 0.002 || Math.abs(oy) > 0.5) {
            svg.style.transformOrigin = '0 0';
            svg.style.transform = `translate(0, ${oy.toFixed(2)}px) scale(${s.toFixed(4)})`;
            scaleY = s;
            yOffset = oy;
          }
        }
      } catch {
        // getBBox 失败（罕见）时保持原始尺寸
      }
    }
  }

  return { height: height + 8, totalWidth, y0, canvasHeight: height, scaleY, yOffset, noteXByAtom };
}

/**
 * 单独渲染大谱表头部（花括号 + 高/低音谱号 + 调号 + 拍号），不包含音符。
 * 用于游戏滚动视图：谱头固定在左侧，音符条在其下方滚动。
 * 谱线垂直位置与 {@link renderGrandStaffRow} 一致（使用相同 y0）。
 * @returns 谱头宽度（px）
 */
export function renderStaveHead(container: HTMLElement, ctx: MeasureContext, y0: number, height: number): number {
  const keySpec = toVexKeySpec(ctx.keySignature);
  const vfId = `vf-head-${Math.random().toString(36).slice(2)}`;
  const wrap = document.createElement('div');
  wrap.className = 'stave-head';
  wrap.id = vfId;
  container.appendChild(wrap);

  const factory = new Factory({ renderer: { elementId: vfId, width: 400, height } });
  const staveOpts = { leftBar: true, rightBar: false };
  const treble = factory.Stave({ x: 0, y: y0, width: 400, options: staveOpts });
  treble.addClef('treble').addKeySignature(keySpec).addTimeSignature(ctx.timeSigStr);
  // System 排版：低音谱表 y = 高音谱表 y + spaceBetweenStaves(10) × 行距(10)
  const bass = factory.Stave({ x: 0, y: y0 + 100, width: 400, options: staveOpts });
  bass.addClef('bass').addKeySignature(keySpec).addTimeSignature(ctx.timeSigStr);
  factory.StaveConnector({ topStave: treble, bottomStave: bass, type: 'brace' });
  factory.draw();

  const width = Math.ceil(Math.max(treble.getNoteStartX(), bass.getNoteStartX()));
  wrap.style.width = `${width}px`;
  wrap.style.height = `${height}px`;
  return width;
}

/**
 * 原始 SVG 渲染：VexFlow 内联 SVG + 小节播放头 overlay。
 * 用于 "original" 渲染模式。
 */
export function renderGrandStaffRowSVG(
  container: HTMLElement,
  columns: GrandStaffColumn[],
  ctx: MeasureContext,
  columnWidth: number,
  editState?: StaffEditState,
  selectedNoteKeys?: Set<NoteKey>,
): number {
  const n = columns.length;
  if (n === 0) return 0;

  // 布局计算
  let maxPadTop = 0;
  let maxPadBottom = 0;
  for (const c of columns) {
    const p = canvasPaddingForAtoms(c.trebleAtoms, c.bassAtoms);
    maxPadTop = Math.max(maxPadTop, p.padTop);
    maxPadBottom = Math.max(maxPadBottom, p.padBottom);
  }
  const y0 = BASE_SYSTEM_Y + maxPadTop;
  const height = BASE_SCORE_HEIGHT + maxPadTop + maxPadBottom;
  const totalWidth = n * columnWidth;
  const segW = Math.max(40, Math.floor((totalWidth - 24) / n));

  const host = document.createElement('div');
  host.className = 'score-row-host';
  host.style.position = 'relative';
  host.style.width = `${totalWidth}px`;
  host.style.flexShrink = '0';

  const vfId = `vf-row-${Math.random().toString(36).slice(2)}`;
  const vfWrap = document.createElement('div');
  vfWrap.className = 'vf-wrap';
  vfWrap.id = vfId;
  host.appendChild(vfWrap);

  createMeasureOverlays(host, columns, columnWidth);
  container.appendChild(host);

  const factory = new Factory({
    renderer: { elementId: vfId, width: totalWidth, height },
  });
  const { noteMap, atomNotes } = buildSystems(factory, columns, ctx, y0, segW, editState);
  applyEditDecorations(factory, noteMap, editState, selectedNoteKeys);
  factory.draw();
  applyPerKeyNoteheadColors(atomNotes);

  // 为每个音符符头创建精确 hit area（用于右键指法菜单和编辑选择）
  if (editState) {
    const hostRect = host.getBoundingClientRect();
    const byNote = new Map();
    for (const [nk, { note, keyIdx }] of noteMap) {
      const arr = byNote.get(note) ?? [];
      arr.push({ keyIdx, nk });
      byNote.set(note, arr);
    }
    for (const [note, entries] of byNote) {
      const rootEl = note.getSVGElement();
      if (!rootEl) continue;
      // 只取符头 <text>（避免还原/升降号、指法等 modifier 打乱索引）
      const textEls = rootEl.querySelectorAll('.vf-notehead text');
      for (const entry of entries) {
        const t = textEls[entry.keyIdx];
        if (!t) continue;
        const r = t.getBoundingClientRect();
        const hit = document.createElement('div');
        hit.className = 'note-hitarea';
        hit.dataset.noteKey = entry.nk;
        const cursorStyle = selectedNoteKeys ? 'cursor:pointer;' : 'cursor:default;';
        hit.style.cssText = `position:absolute;left:${r.left - hostRect.left}px;top:${r.top - hostRect.top}px;width:${r.width}px;height:${r.height}px;${cursorStyle}z-index:5;background:transparent`;
        host.appendChild(hit);
      }
    }
  }

  return height + 8;
}
