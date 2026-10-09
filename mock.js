// SPDX-License-Identifier: GPL-3.0-only
// A pretend FM-1 running SLOOP (protocol v11), for trying SLOOP LIVE without the synth: ?mock=1.
// It answers the commands the page sends, runs a clock and plays sections, chains and fills like the device.
import { CMD, PF, NONE, frame, unframe, v14 } from "./proto.js";

const ENG = ["ANALOG", "FM4", "PHASE", "TRIO", "ORGAN", "VOICE", "GRAIN", "LOFI", "SAMPLE"];
const G = [["BPM", 9, 40, 240, 112], ["SWING", 14, 0, 100, 12], ["CLICK", 8, 0, 2, 0], ["TUNE", 0, -50, 50, 0],
  ["DUST", 1, 0, 127, 0], ["DUCK", 1, 0, 127, 30], ["FILT", 15, -64, 63, 0], ["ROLL", 8, 0, 4, 1]];
const ROLL = ["1/8", "1/16", "1/32", "32T", "1/64"];
const str = (s) => [...s].map((c) => c.charCodeAt(0)).concat(0);

export class MockTransport {
  constructor(proto = 11) { this.proto = proto; }        /* (10: firmware without PERFORM, ?mock=10) */
  get label() { return "demo"; }
  async open(onData) {
    const g = G.map((x) => x[4]);
    const trk = [{ eng: 0, level: 96, mute: 0 }, { eng: 1, level: 88, mute: 0 }, { eng: 4, level: 70, mute: 1 }, { eng: ENG.length, level: 100, mute: 0 }];
    const st = { playing: true, beat: 0, fx: NONE, fxRemote: 0, solo: 0, ready: 0b0111, section: 0, next: NONE, songMode: 0,
      songrec: 0, chain: [], chainI: 0, chainBars: 0, barIn: 0, fillHeld: 0, fillNext: 0, taps: [], storeArm: -1, storeT: 0 };
    let last = performance.now();
    const reply = (cmd, a) => setTimeout(() => onData(frame(cmd, a)), 4 + Math.random() * 10);
    /* the clock: one beat per 60 / BPM s; sections and chains change on the bar */
    const tick = () => {
      if (!st.playing) return;
      st.beat = (st.beat + 1) & 127;
      if (st.beat % 4) return;
      st.barIn++;
      st.fillNext = 0;
      if (st.chain.length && st.next === NONE && st.barIn >= st.chainBars) {
        st.chainI = (st.chainI + 1) % st.chain.length;
        st.next = st.chain[st.chainI];
      }
      if (st.next !== NONE) { st.section = st.next; st.next = NONE; st.barIn = 0; st.beat = 0; st.chainBars = 1 + (st.section & 1); }
    };
    const loop = () => { tick(); this.timer = setTimeout(loop, 60000 / g[0]); };
    loop();
    const state = () => {
      const mute = trk.reduce((m, t, i) => m | (t.mute ? 1 << i : 0), 0);
      const flags = (st.playing ? 1 : 0) | (st.songMode ? 2 : 0) | (st.fillHeld ? 8 : 0) | (st.fillNext ? 16 : 0) | (st.fxRemote ? 32 : 0);
      return [flags, ...v14(g[0]), st.beat, st.fx, mute, st.solo, 0, st.ready, st.section, st.next, st.songrec,
        st.chain.length, st.chainI, ...st.chain];
    };
    const perform = (a) => {
      const op = a.length ? a[0] : 0, x = a.slice(1);
      let rc = 0;
      last = performance.now();
      switch (op) {
        case PF.STATE: break;
        case PF.FX: st.fx = x[0] < 16 ? x[0] : NONE; st.fxRemote = st.fx !== NONE ? 1 : 0; break;
        case PF.SECTION:
          if (x[0] > 3) { rc = 1; break; }
          if (!(st.ready >> x[0] & 1)) break;
          st.chain = [];
          if (st.playing) st.next = x[0]; else { st.section = x[0]; st.beat = 0; }
          break;
        case PF.CHAIN: {
          const s = x.slice(1, 1 + x[0]);
          if (!st.playing) { rc = 1; break; }
          if (s.some((k) => !(st.ready >> k & 1))) { rc = 2; break; }
          st.next = s[0]; st.chain = s.length > 1 ? s : []; st.chainI = 0; st.chainBars = 1 + (s[0] & 1);
          break;
        }
        case PF.MUTE: trk[x[0]].mute = x[1] === 2 ? !trk[x[0]].mute : x[1]; break;
        case PF.SOLO: { const on = x[1] === 2 ? !(st.solo >> x[0] & 1) : x[1]; st.solo = on ? st.solo | 1 << x[0] : st.solo & ~(1 << x[0]); break; }
        case PF.TRANSPORT: st.playing = x[0] === 0 ? !st.playing : x[0] === 1; if (st.playing) { st.beat = 127; st.barIn = 0; } else { st.fillHeld = st.fillNext = 0; } break;
        case PF.FILL: if (x[0] === 2) st.fillNext = !st.fillNext; else st.fillHeld = x[0]; break;
        case PF.TAP: {
          const now = performance.now();
          st.taps = st.taps.filter((t) => now - t < 2000).concat(now);
          if (st.taps.length >= 2) {
            const d = (st.taps.at(-1) - st.taps[0]) / (st.taps.length - 1);
            g[0] = Math.max(40, Math.min(240, Math.round(60000 / d)));
          }
          break;
        }
        case PF.SONGMODE: st.songMode = x[0] === 2 ? !st.songMode : x[0]; break;
        case PF.SONGREC: st.songrec = st.songrec ? 0 : 1; break;
        case PF.STORE: {
          const now = performance.now();
          if ((st.ready >> x[0] & 1) && !(st.storeArm === x[0] && now - st.storeT < 3000)) { st.storeArm = x[0]; st.storeT = now; break; }
          st.storeArm = -1; st.ready |= 1 << x[0]; st.section = x[0];
          break;
        }
        default: rc = 1;
      }
      return [op, rc, ...state()];
    };
    /* a remote hold ends when the remote goes quiet, as on the device */
    this.dog = setInterval(() => { if (performance.now() - last > 1500) { if (st.fxRemote) { st.fx = NONE; st.fxRemote = 0; } st.fillHeld = 0; } }, 250);
    this.send = (d) => {
      const f = unframe(d);
      if (!f) return;
      const a = f.a;
      last = performance.now();
      switch (f.cmd) {
        case CMD.INFO: reply(f.cmd, [...str("SLOOP 2.4 demo"), ENG.length, 58, G.length, 64, 50, ...ENG.flatMap(str), 4, this.proto]); break;
        case CMD.DESC: {
          if (a[0] !== 1 || a[1] >= G.length) return;
          const [label, fmt, min, max, def] = G[a[1]];
          reply(f.cmd, [1, a[1], fmt, ...v14(min), ...v14(max), ...v14(def), ...str(label), ...str(""),
            ...(label === "ROLL" ? ROLL.flatMap(str) : label === "CLICK" ? ["OFF", "ON", "REC"].flatMap(str) : [])]);
          break;
        }
        case CMD.GET: reply(f.cmd, [a[0], a[1], ...v14(g[a[1]])]); break;
        case CMD.SET: {
          const [, , min, max] = G[a[1]];
          g[a[1]] = Math.max(min, Math.min(max, (a[2] | a[3] << 7) - 8192));
          reply(f.cmd, [a[0], a[1], ...v14(g[a[1]])]);
          break;
        }
        case CMD.WATCH: reply(f.cmd, [a[0] & 3]); break;
        case CMD.PING: reply(f.cmd, [0]); break;
        case CMD.TRACK:
          reply(f.cmd, [3, 4, ...trk.flatMap((t) => [t.eng, 0, ...v14(t.level), t.mute ? 1 : 0, 0]), st.solo]);
          break;
        case CMD.TRACK_MIX: {
          const t = trk[a[0]];
          if (a.length >= 4) { t.level = Math.max(0, Math.min(127, (a[1] | a[2] << 7) - 8192)); t.mute = a[3]; }
          reply(f.cmd, [a[0], ...v14(t.level), t.mute ? 1 : 0]);
          break;
        }
        case CMD.PERFORM: if (this.proto >= 11) reply(f.cmd, perform(a)); break;
        default: break;
      }
    };
    this.close = () => { clearTimeout(this.timer); clearInterval(this.dog); };
  }
}
