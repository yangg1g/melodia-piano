import { Factory, Voice, VoiceMode } from 'vexflow';
import type { Hand, MeasureContext, VoiceAtom } from './midiScore';

const BASE_SCORE_HEIGHT = 220;
const BASE_SYSTEM_Y = 12;

/** 根据音符八度估算上下留白，避免加线音符被 SVG 裁切 */
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
  if (atom.rest) {
    return factory.StaveNote({
      keys,
      duration: atom.duration,
      dots: atom.dots,
      type: 'r',
      clef,
    });
  }
  return factory.StaveNote({
    keys,
    duration: atom.duration,
    dots: atom.dots,
    clef,
  });
}

function voiceFromAtoms(factory: Factory, atoms: VoiceAtom[], timeSigStr: string, clef: Hand): Voice {
  const voice = factory.Voice({ time: timeSigStr });
  voice.setMode(VoiceMode.SOFT);
  for (const atom of atoms) {
    voice.addTickables([atomToNote(factory, atom, clef)]);
  }
  return voice;
}

export function renderGrandStaffMeasure(
  container: HTMLElement,
  measureIndex: number,
  ctx: MeasureContext,
  trebleAtoms: VoiceAtom[],
  bassAtoms: VoiceAtom[],
  width = 720,
  showStaffHeader = false,
): number {
  const row = document.createElement('div');
  row.className = 'score-measure';
  row.dataset.measureIndex = String(measureIndex);
  row.dataset.hasStaffHeader = showStaffHeader ? '1' : '0';

  const wrap = document.createElement('div');
  wrap.className = 'score-measure-wrap';

  const playhead = document.createElement('div');
  playhead.className = 'playhead';
  playhead.setAttribute('aria-hidden', 'true');

  const el = document.createElement('div');
  el.className = 'vf-wrap';
  el.id = `vf-m${measureIndex}-${Math.random().toString(36).slice(2)}`;
  wrap.appendChild(playhead);
  wrap.appendChild(el);
  row.appendChild(wrap);
  container.appendChild(row);

  const { padTop, padBottom } = canvasPaddingForAtoms(trebleAtoms, bassAtoms);
  const height = BASE_SCORE_HEIGHT + padTop + padBottom;
  const factory = new Factory({
    renderer: { elementId: el.id, width, height },
  });

  const system = factory.System({
    x: 12,
    y: BASE_SYSTEM_Y + padTop,
    width: width - 24,
    spaceBetweenStaves: 10,
    formatOptions: { alignRests: true },
  });

  const trebleVoice = voiceFromAtoms(factory, trebleAtoms, ctx.timeSigStr, 'treble');
  const bassVoice = voiceFromAtoms(factory, bassAtoms, ctx.timeSigStr, 'bass');

  let trebleStave = system.addStave({ voices: [trebleVoice] });
  if (showStaffHeader) {
    trebleStave = trebleStave.addClef('treble').addTimeSignature(ctx.timeSigStr);
  }

  let bassStave = system.addStave({ voices: [bassVoice] });
  if (showStaffHeader) {
    bassStave = bassStave.addClef('bass').addTimeSignature(ctx.timeSigStr);
  }

  system.addConnector('brace');
  system.addConnector('singleRight');
  system.addConnector('singleLeft');

  factory.draw();
  return height + 8;
}
