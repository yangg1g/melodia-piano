import type { Midi } from '@tonejs/midi';
import { assignHandForNote, type FlatNote, type Hand } from './midiScore';
import { applyKeyVisuals } from './pianoKeyboard';
import type { PlaybackController } from './playback';

function groupByStartTick(notes: FlatNote[]): FlatNote[][] {
  const sorted = [...notes].sort((a, b) => a.ticks - b.ticks || a.midi - b.midi);
  const groups: FlatNote[][] = [];
  for (const n of sorted) {
    const g = groups[groups.length - 1];
    if (!g || g[0].ticks !== n.ticks) groups.push([n]);
    else g.push(n);
  }
  return groups;
}

function requiredHitCounts(group: FlatNote[]): Map<number, number> {
  const m = new Map<number, number>();
  for (const n of group) {
    m.set(n.midi, (m.get(n.midi) ?? 0) + 1);
  }
  return m;
}

function countsSatisfied(required: Map<number, number>, hit: Map<number, number>): boolean {
  for (const [midi, need] of required) {
    if ((hit.get(midi) ?? 0) < need) return false;
  }
  return true;
}

function parseMidiKey(data: Uint8Array): { note: number; down: boolean } | null {
  const st = data[0];
  if (st >= 0x90 && st < 0xa0) {
    const vel = data[2];
    return { note: data[1], down: vel > 0 };
  }
  if (st >= 0x80 && st < 0x90) {
    return { note: data[1], down: false };
  }
  return null;
}

function parseNoteOn(data: Uint8Array): number | null {
  const st = data[0];
  if (st >= 0x90 && st < 0xa0) {
    const vel = data[2];
    if (vel > 0) return data[1];
  }
  return null;
}

function playSynthChord(ctx: AudioContext, notes: FlatNote[]) {
  const t = ctx.currentTime;
  for (const n of notes) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.value = 440 * Math.pow(2, (n.midi - 69) / 12);
    osc.connect(gain);
    gain.connect(ctx.destination);
    const peak = 0.11;
    const dur = Math.max(0.06, n.duration);
    const rel = Math.min(0.28, dur * 0.45);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.linearRampToValueAtTime(peak, t + 0.018);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + dur + rel);
    osc.start(t);
    osc.stop(t + dur + rel + 0.04);
  }
}

function handsMapForGroup(group: FlatNote[], midiFile: Midi): Map<number, Hand> {
  const m = new Map<number, Hand>();
  for (const n of group) {
    m.set(n.midi, assignHandForNote(n, midiFile));
  }
  return m;
}

/**
 * 同一 tick 为一组；弹对后发声前进。键盘描边区分左右手，MIDI 物理按下用 `pressed` 高亮。
 */
export function startKeyboardPractice(
  flatNotes: FlatNote[],
  midiFile: Midi,
  keyEls: Map<number, HTMLElement>,
  midiInput: MIDIInput,
  onEnded?: () => void,
  onTimeSec?: (sec: number) => void,
): PlaybackController {
  const groups = groupByStartTick(flatNotes);
  const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const ctx = new AudioCtx();
  let stopped = false;
  let step = 0;
  const hit = new Map<number, number>();
  const pressedMidis = new Set<number>();
  let flashActive: Map<number, Hand> | null = null;
  let pendingUi: ReturnType<typeof setTimeout> | null = null;

  const clearPendingUi = () => {
    if (pendingUi !== null) {
      clearTimeout(pendingUi);
      pendingUi = null;
    }
  };

  const paint = () => {
    const expected = new Map<number, Hand>();
    if (step < groups.length) {
      for (const n of groups[step]) {
        expected.set(n.midi, assignHandForNote(n, midiFile));
      }
    }
    applyKeyVisuals(keyEls, {
      expected,
      active: flashActive ?? undefined,
      pressed: pressedMidis,
    });
  };

  const applyUiForStep = () => {
    if (stopped) return;
    if (step >= groups.length) {
      pressedMidis.clear();
      flashActive = null;
      applyKeyVisuals(keyEls, {});
      onTimeSec?.(flatNotes.length ? Math.max(...flatNotes.map((n) => n.time + n.duration)) : 0);
      finish();
      return;
    }
    hit.clear();
    flashActive = null;
    onTimeSec?.(groups[step][0].time);
    paint();
  };

  const finish = () => {
    if (stopped) return;
    clearPendingUi();
    stopped = true;
    midiInput.onmidimessage = null;
    pressedMidis.clear();
    flashActive = null;
    applyKeyVisuals(keyEls, {});
    void ctx.close();
    onEnded?.();
  };

  const onMidi = (ev: MIDIMessageEvent) => {
    if (stopped) return;
    const data = ev.data;
    if (!data || data.length < 3) return;

    const keyEv = parseMidiKey(data);
    if (keyEv && keyEls.has(keyEv.note)) {
      if (keyEv.down) pressedMidis.add(keyEv.note);
      else pressedMidis.delete(keyEv.note);
      paint();
    }

    if (flashActive !== null) return;

    const note = parseNoteOn(data);
    if (note === null) return;
    if (step >= groups.length) return;

    const g = groups[step];
    const req = requiredHitCounts(g);
    const need = req.get(note);
    if (need === undefined) return;

    const cur = hit.get(note) ?? 0;
    if (cur >= need) return;
    hit.set(note, cur + 1);

    if (countsSatisfied(req, hit)) {
      playSynthChord(ctx, g);
      flashActive = handsMapForGroup(g, midiFile);
      hit.clear();
      paint();
      clearPendingUi();
      pendingUi = window.setTimeout(() => {
        pendingUi = null;
        if (stopped) return;
        flashActive = null;
        step += 1;
        applyUiForStep();
      }, 120);
    }
  };

  midiInput.onmidimessage = onMidi;
  applyUiForStep();

  return {
    stop: () => {
      if (stopped) return;
      clearPendingUi();
      stopped = true;
      midiInput.onmidimessage = null;
      pressedMidis.clear();
      flashActive = null;
      applyKeyVisuals(keyEls, {});
      void ctx.close();
    },
    isPlaying: () => !stopped,
  };
}
