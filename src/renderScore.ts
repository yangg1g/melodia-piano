import { Dot, Factory, Voice, VoiceMode } from 'vexflow';
import { vexVoiceTimeStr, type Hand, type MeasureContext, type VoiceAtom } from './midiScore';

const BASE_SCORE_HEIGHT = 220;
const BASE_SYSTEM_Y = 12;

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

function atomToNote(factory: Factory, atom: VoiceAtom, clef: Hand) {
  const keys = atom.rest ? atom.keys : [...atom.keys].sort();
  const note = atom.rest
    ? factory.StaveNote({
        keys,
        duration: atom.duration,
        dots: atom.dots,
        type: 'r',
        clef,
        autoStem: true,
      })
    : factory.StaveNote({
        keys,
        duration: atom.duration,
        dots: atom.dots,
        clef,
        autoStem: true,
      });

  /** VexFlow 5：`dots` 只参与时值 tick；可见附点需挂 {@link Dot} 修饰符（与 EasyScore 一致） */
  const nDots = atom.dots ?? 0;
  if (nDots > 0) {
    const dotAttachOpts = !atom.rest && keys.length > 1 ? ({ all: true } as const) : undefined;
    for (let i = 0; i < nDots; i++) {
      Dot.buildAndAttach([note], dotAttachOpts);
    }
  }
  return note;
}

function voiceFromAtoms(factory: Factory, atoms: VoiceAtom[], timeSig: [number, number], clef: Hand): Voice {
  const voice = factory.Voice({ time: vexVoiceTimeStr(timeSig) });
  voice.setMode(VoiceMode.SOFT);
  for (const atom of atoms) {
    voice.addTickables([atomToNote(factory, atom, clef)]);
  }
  return voice;
}

export type GrandStaffColumn = {
  measureIndex: number;
  trebleAtoms: VoiceAtom[];
  bassAtoms: VoiceAtom[];
  showStaffHeader: boolean;
};

/**
 * 将一行内多小节渲染成图片（Canvas → data URL → <img>），
 * 小节 System 横向首尾相接。
 * `columnWidth` 为版面分配给每小节的宽度。
 * `hideOverlays` 为 true 时不生成播放头 overlay。
 */
export function renderGrandStaffRow(
  container: HTMLElement,
  columns: GrandStaffColumn[],
  ctx: MeasureContext,
  columnWidth: number,
  hideOverlays = false,
): { height: number; totalWidth: number } {
  const n = columns.length;
  if (n === 0) return { height: 0, totalWidth: 0 };

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

  // 离屏 Canvas：VexFlow 以 Canvas 后端绘制，之后导出为 data URL
  const canvasId = `vf-canvas-${Math.random().toString(36).slice(2)}`;
  const canvas = document.createElement('canvas');
  canvas.id = canvasId;
  canvas.width = totalWidth;
  canvas.height = height;
  canvas.style.cssText = 'position:absolute;left:-99999px;top:0;width:1px;height:1px';
  host.appendChild(canvas);

  if (!hideOverlays) {
    for (let i = 0; i < n; i++) {
      const col = columns[i];
      const overlay = document.createElement('div');
      overlay.className = 'score-measure';
      overlay.dataset.measureIndex = String(col.measureIndex);
      overlay.dataset.hasStaffHeader = col.showStaffHeader ? '1' : '0';
      overlay.style.cssText = `position:absolute;left:${i * columnWidth}px;top:0;width:${columnWidth}px;height:100%;pointer-events:none`;
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

  container.appendChild(host);

  // --- VexFlow 绘制到 Canvas ---
  const factory = new Factory({
    renderer: { elementId: canvasId, width: totalWidth, height },
  });

  for (let i = 0; i < n; i++) {
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

    const trebleVoice = voiceFromAtoms(factory, col.trebleAtoms, ctx.timeSig, 'treble');
    const bassVoice = voiceFromAtoms(factory, col.bassAtoms, ctx.timeSig, 'bass');

    let trebleStave = system.addStave({ voices: [trebleVoice], options: staveBarOpts });
    if (col.showStaffHeader) {
      trebleStave = trebleStave.addClef('treble').addTimeSignature(ctx.timeSigStr);
    }

    let bassStave = system.addStave({ voices: [bassVoice], options: staveBarOpts });
    if (col.showStaffHeader) {
      bassStave = bassStave.addClef('bass').addTimeSignature(ctx.timeSigStr);
    }

    if (i === 0) {
      system.addConnector('brace');
    }
    system.addConnector('singleRight');
    system.addConnector('singleLeft');
  }

  factory.draw();

  // --- 导出 Canvas → PNG → <img> ---
  const img = document.createElement('img');
  img.src = canvas.toDataURL('image/png');
  img.alt = '乐谱';
  img.style.cssText = `display:block;width:${totalWidth}px;height:${height}px`;
  host.insertBefore(img, canvas);
  host.removeChild(canvas);

  return { height: height + 8, totalWidth };
}
