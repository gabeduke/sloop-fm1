// SPDX-License-Identifier: GPL-3.0-only
// SLOOP LIVE: the page. Connects (USB Web MIDI, a WebSocket bridge, or the demo), reads what the device
// has (INFO, the master parameters by DESC label, TRACK), watches it, and follows the live state with a
// PERFORM STATE request every ~120 ms; the pads and buttons send PERFORM ops ahead of that.
import { CMD, PF, NONE, FX_NAMES, Link, v14, parseInfo, parseDesc, parseTrack, parsePerform, Reader } from "./proto.js";
import { WebMidiTransport, WebSocketTransport } from "./transports.js";

const $ = (id) => document.getElementById(id);
const QS = new URLSearchParams(location.search);
const TC = ["var(--t1)", "var(--t2)", "var(--t3)", "var(--t4)"];
const POLL_MS = 120;
const LONG_MS = 550;                                  /* a section held this long: store the loop into it */

let dev = null;                                       /* {transport, link, info, g: {label: {id, desc, value}}, tracks, live} */
let wakeLock = null;

/* ------------------------------------------------------------ connect --- */
function gateSay(msg, err = false) { const m = $("gatemsg"); m.textContent = msg; m.classList.toggle("err", err); }
function toast(msg, ms = 1800) {
  const t = $("toast");
  t.textContent = msg; t.hidden = false;
  clearTimeout(toast.t); toast.t = setTimeout(() => { t.hidden = true; }, ms);
}

async function connect(transport) {
  gateSay("Connecting...");
  $("connect").disabled = $("demo").disabled = true;
  try {
    let link;
    await transport.open((d) => link && link.receive(d), () => lost());
    link = new Link((d) => transport.send(d), { onPush, onTimeout: () => {} });
    const info = parseInfo(await link.request(CMD.INFO, [], { timeout: 500, retries: 2 }));
    dev = { transport, link, info, g: {}, tracks: [], live: null, perform: info.proto >= 11 };
    /* the master parameters, found by their labels (ids move between versions) */
    for (let id = 0; id < info.gCount; id++) {
      const d = parseDesc(await link.request(CMD.DESC, [1, id]));
      if (["BPM", "SWING", "DUST", "DUCK", "FILT", "ROLL"].includes(d.label)) {
        const r = new Reader(await link.request(CMD.GET, [1, id]));
        r.b(); r.b();
        dev.g[d.label] = { id, desc: d, value: r.v() };
      }
    }
    await readTracks();
    await link.request(CMD.WATCH, [3], { timeout: 400 }).catch(() => {});
    $("gate").hidden = true;
    $("app").hidden = false;
    const ban = $("banner");
    ban.hidden = dev.perform;
    ban.textContent = dev.perform ? "" : `${info.version} speaks protocol v${info.proto}. The mix works; the pads, sections and transport need SLOOP with protocol v11 (PERFORM).`;
    build();
    poll();
    keepAwake();
  } catch (e) {
    console.error(e);
    try { transport.close && transport.close(); } catch (_) {}
    dev = null;
    gateSay(/timeout/.test(e.message) ? "The FM-1 did not answer. Is SLOOP installed on it? Unplug it, plug it back in and connect again." : e.message, true);
  } finally {
    $("connect").disabled = $("demo").disabled = false;
  }
}

function lost() {
  if (!dev) return;
  dev.link.close();
  try { dev.transport.close(); } catch (_) {}
  dev = null;
  clearTimeout(poll.t);
  releaseAll();
  $("app").hidden = true;
  $("gate").hidden = false;
  gateSay("The FM-1 went away. Plug it back in and connect again.", true);
}

async function keepAwake() {                           /* the phone stays awake while it plays */
  try { if ("wakeLock" in navigator && !wakeLock) wakeLock = await navigator.wakeLock.request("screen"); wakeLock.onrelease = () => { wakeLock = null; }; } catch (_) {}
}
document.addEventListener("visibilitychange", () => {
  if (document.hidden) releaseAll();                   /* (the device lets go too: no request for 1.5 s) */
  else if (dev) keepAwake();
});

/* ------------------------------------------------------------ the device --- */
async function readTracks() {
  const t = parseTrack(await dev.link.request(CMD.TRACK, []));
  dev.tracks = t.tracks;
  dev.solo = t.solo;
}

function onPush(f) {
  if (!dev) return;
  const r = new Reader(f.a);
  if (f.cmd === CMD.CHANGED) {
    const scope = r.b(), id = r.b(), v = r.v();
    if (scope === 1) for (const p of Object.values(dev.g)) if (p.id === id) { p.value = v; paintFaders(); }
  } else if (f.cmd === CMD.TRACK_CHANGED || f.cmd === CMD.RELOAD) {
    readTracks().then(paintTracks).catch(() => {});
  }
}

/* the live state, ~8 times a second, between the other requests (a newer one replaces a queued one) */
async function poll() {
  clearTimeout(poll.t);
  if (!dev) return;
  try {
    if (dev.perform) {
      const s = parsePerform(await dev.link.request(CMD.PERFORM, [PF.STATE], { key: "state" }));
      dev.live = s;
      paint();
    } else {
      await dev.link.request(CMD.PING, [], { key: "ping" });
      poll.n = (poll.n || 0) + 1;
      if (poll.n % 8 === 0) { await readTracks(); paintTracks(); }
    }
    $("lost").hidden = true;
  } catch (e) {
    if (!dev) return;
    $("lost").hidden = false;
  }
  poll.t = setTimeout(poll, POLL_MS);
}

/* an op from a pad or a button: ahead of the polls; its reply is the state */
async function perform(op, args = [], key) {
  if (!dev || !dev.perform) return null;
  try {
    const s = parsePerform(await dev.link.request(CMD.PERFORM, [op, ...args], { front: true, key, timeout: 200 }));
    dev.live = s;
    paint();
    return s;
  } catch (e) { return null; }
}

function setGlobal(label, value) {
  const p = dev && dev.g[label];
  if (!p) return;
  p.value = Math.max(p.desc.min, Math.min(p.desc.max, Math.round(value)));
  dev.link.request(CMD.SET, [1, p.id, ...v14(p.value)], { key: "set" + p.id }).catch(() => {});
}
function setLevel(t, level) {
  const tr = dev.tracks[t];
  tr.level = Math.round(level);
  dev.link.request(CMD.TRACK_MIX, [t, ...v14(tr.level), tr.mute ? 1 : 0], { key: "mix" + t }).catch(() => {});
}

/* ------------------------------------------------------------ the pads --- */
const held = [];                                     /* FX pads down, in order: the last one plays */
let latch = false;
function fxSend() { perform(PF.FX, [held.length ? held[held.length - 1] : NONE], "fx"); }
function padDown(i) {
  if (latch) {
    const on = dev.live && dev.live.fx === i;
    held.length = 0;
    if (!on) held.push(i);
  } else {
    const k = held.indexOf(i);
    if (k >= 0) held.splice(k, 1);
    held.push(i);
  }
  if (navigator.vibrate) navigator.vibrate(8);
  fxSend();
  paintPads();
}
function padUp(i) {
  if (latch) return;
  const k = held.indexOf(i);
  if (k < 0) return;
  held.splice(k, 1);
  fxSend();
  paintPads();
}
function releaseAll() {
  if (held.length) { held.length = 0; if (dev) fxSend(); }
  if (fillHeld) { fillHeld = false; if (dev) perform(PF.FILL, [0]); }
  paintPads();
}

/* press / release for a pointer, with capture, so a finger sliding off still lets go */
function holdable(el, down, up) {
  el.addEventListener("pointerdown", (e) => { e.preventDefault(); el.setPointerCapture(e.pointerId); down(e); });
  const end = (e) => { if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId); up(e); };
  el.addEventListener("pointerup", end);
  el.addEventListener("pointercancel", end);
  el.addEventListener("contextmenu", (e) => e.preventDefault());
  el.addEventListener("keydown", (e) => { if ((e.key === " " || e.key === "Enter") && !e.repeat) { e.preventDefault(); down(e); } });
  el.addEventListener("keyup", (e) => { if (e.key === " " || e.key === "Enter") up(e); });
}

/* ------------------------------------------------------------ faders --- */
/* a touch fader: drag anywhere on it (relative, so a tap does not jump), double tap: default */
function fader(el, { min, max, get, set, label, center = false, vertical = false, fmt = (v) => v }) {
  el.classList.add(vertical ? "v" : "h");
  el.setAttribute("role", "slider");
  el.tabIndex = 0;
  el.setAttribute("aria-label", label);
  el.setAttribute("aria-valuemin", min);
  el.setAttribute("aria-valuemax", max);
  el.innerHTML = '<div class="fill"></div><span class="lab"></span>';
  const fill = el.firstChild, lab = el.lastChild;
  let start = null, lastTap = 0;
  const paint = () => {
    const v = get(), f = (v - min) / (max - min);
    if (vertical) fill.style.height = f * 100 + "%";
    else if (center) {
      const z = (0 - min) / (max - min);
      fill.style.left = Math.min(f, z) * 100 + "%";
      fill.style.width = Math.abs(f - z) * 100 + "%";
    } else { fill.style.left = 0; fill.style.width = f * 100 + "%"; }
    lab.textContent = label + " " + fmt(v);
    el.setAttribute("aria-valuenow", v);
    el.setAttribute("aria-valuetext", fmt(v));
  };
  el.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    el.setPointerCapture(e.pointerId);
    const now = performance.now();
    if (now - lastTap < 300) { set(center ? 0 : el.dataset.def !== undefined ? +el.dataset.def : get()); paint(); }
    lastTap = now;
    start = { x: e.clientX, y: e.clientY, v: get() };
  });
  el.addEventListener("pointermove", (e) => {
    if (!start || !el.hasPointerCapture(e.pointerId)) return;
    const r = el.getBoundingClientRect();
    const d = vertical ? (start.y - e.clientY) / r.height : (e.clientX - start.x) / r.width;
    let v = start.v + d * (max - min);
    if (center && Math.abs(v) < (max - min) * 0.03) v = 0;   /* a detent in the middle */
    set(Math.max(min, Math.min(max, Math.round(v))));
    paint();
  });
  const end = () => { start = null; };
  el.addEventListener("pointerup", end);
  el.addEventListener("pointercancel", end);
  el.addEventListener("keydown", (e) => {
    const step = { ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1, PageUp: 8, PageDown: -8 }[e.key];
    if (!step) return;
    e.preventDefault();
    set(Math.max(min, Math.min(max, get() + step)));
    paint();
  });
  el.paint = paint;
  paint();
  return el;
}

/* ------------------------------------------------------------ build --- */
let chainMode = false, chainBuild = [], fillHeld = false, storeArm = -1;
const faders = [];

function engName(t) { return t.eng >= dev.info.engines.length ? "drums" : dev.info.engines[t.eng].toLowerCase(); }

function build() {
  /* sections: tap plays (stopped: loads; playing: the next bar), held stores, chain mode builds a chain */
  const secs = $("sections");
  secs.innerHTML = "";
  for (let s = 0; s < 4; s++) {
    const b = document.createElement("button");
    b.className = "sec";
    b.style.setProperty("--c", TC[s]);
    b.textContent = "ABCD"[s];
    b.setAttribute("aria-label", "Section " + "ABCD"[s]);
    let timer = 0, stored = false;
    holdable(b, () => {
      stored = false;
      b.classList.add("held");
      timer = setTimeout(async () => {
        stored = true;
        const wasUsed = dev.live && (dev.live.ready >> s & 1);
        const st = await perform(PF.STORE, [s]);
        if (navigator.vibrate) navigator.vibrate([10, 40, 10]);
        if (!st) return;
        if (!wasUsed || storeArm === s) { toast("Saved the loop into " + "ABCD"[s]); storeArm = -1; }
        else { toast("Hold " + "ABCD"[s] + " again to replace it", 3000); storeArm = s; setTimeout(() => { if (storeArm === s) storeArm = -1; }, 3000); }
      }, LONG_MS);
    }, () => {
      clearTimeout(timer);
      b.classList.remove("held");
      if (stored) return;
      if (chainMode) {
        if (chainBuild.length < 8) chainBuild.push(s);
        paintChain();
      } else perform(PF.SECTION, [s]).then((st) => {
        if (st && !(st.ready >> s & 1)) toast("Section " + "ABCD"[s] + " is empty. Hold it to save the loop into it.", 2600);
      });
    });
    secs.appendChild(b);
  }
  /* tracks: the big part mutes, S solos */
  const trs = $("tracks");
  trs.innerHTML = "";
  dev.tracks.forEach((t, i) => {
    const d = document.createElement("div");
    d.className = "trk";
    d.style.setProperty("--c", TC[i]);
    d.innerHTML = `<button class="m" aria-label="Mute track ${i + 1}">${i + 1}<span></span></button><button class="s" aria-label="Solo track ${i + 1}">solo</button>`;
    d.querySelector(".m").addEventListener("click", () => perform(PF.MUTE, [i, 2]).then(() => { if (!dev.perform) { t.mute = !t.mute; setLevel(i, t.level); paintTracks(); } }));
    d.querySelector(".s").addEventListener("click", () => perform(PF.SOLO, [i, 2]));
    trs.appendChild(d);
  });
  /* the 16 punch-in pads, in the order of the FM-1's white keys */
  const pads = $("pads");
  pads.innerHTML = "";
  FX_NAMES.forEach((n, i) => {
    const b = document.createElement("button");
    b.className = "pad" + (i % 4 === 0 ? " mark" : "");
    b.style.setProperty("--c", TC[i >> 2]);
    b.innerHTML = `<b>${i + 1}</b>${n}`;
    b.setAttribute("aria-label", "Punch-in " + n);
    holdable(b, () => padDown(i), () => padUp(i));
    pads.appendChild(b);
  });
  /* the master */
  faders.length = 0;
  const g = (k) => dev.g[k];
  const gf = (id, k, label, fmt, opt = {}) => {
    const el = $(id);
    el.hidden = !g(k);
    if (!g(k)) return;
    el.dataset.def = g(k).desc.def;
    faders.push(fader(el, { min: g(k).desc.min, max: g(k).desc.max, get: () => g(k).value, set: (v) => setGlobal(k, v), label, fmt, ...opt }));
  };
  gf("filt", "FILT", "filter", (v) => v === 0 ? "off" : v < 0 ? "low " + Math.round(-v * 100 / 64) + "%" : "high " + Math.round(v * 100 / 63) + "%", { center: true });
  gf("dust", "DUST", "dust", (v) => Math.round(v * 100 / 127) + "%");
  gf("duck", "DUCK", "duck", (v) => Math.round(v * 100 / 127) + "%");
  gf("swing", "SWING", "swing", (v) => (50 + v / 4).toFixed(v % 4 ? 1 : 0) + "%");
  gf("roll", "ROLL", "roll rate", (v) => g("ROLL").desc.names[v] || v);
  /* the mixer */
  const mix = $("mixer");
  mix.innerHTML = "";
  dev.tracks.forEach((t, i) => {
    const c = document.createElement("div");
    c.className = "chan";
    c.style.setProperty("--c", TC[i]);
    const f = document.createElement("div");
    f.className = "fader";
    c.appendChild(f);
    const n = document.createElement("div");
    n.className = "name";
    n.textContent = `${i + 1} ${engName(t)}`;
    c.appendChild(n);
    mix.appendChild(c);
    faders.push(fader(f, { min: 0, max: 127, get: () => dev.tracks[i].level, set: (v) => setLevel(i, v), label: "", vertical: true }));
  });
  paint();
  paintTracks();
}


/* ------------------------------------------------------------ paint --- */
function paint() {
  const s = dev && dev.live;
  const perf = !!(dev && dev.perform);
  for (const id of ["play", "tap", "fill", "fillnext", "chainbtn", "songbtn", "srecbtn", "latch"]) $(id).disabled = !perf;
  $("bpm").disabled = !perf;
  document.querySelectorAll(".sec, .pad, .trk .s").forEach((b) => { b.disabled = !perf; });
  if (!s) { paintFaders(); return; }
  const play = $("play");
  play.classList.toggle("on", s.playing);
  play.setAttribute("aria-label", s.playing ? "Stop" : "Play");
  $("bpm").textContent = s.bpm;
  if (dev.g.BPM) dev.g.BPM.value = s.bpm;
  const beat = s.playing ? s.beat % 4 : -1;
  document.querySelectorAll(".beats i").forEach((d, i) => d.classList.toggle("on", i === beat));
  $("bar").textContent = s.playing ? "bar " + ((s.beat >> 2) + 1) : "stopped";
  document.querySelectorAll(".sec").forEach((b, i) => {
    b.classList.toggle("empty", !(s.ready >> i & 1));
    b.classList.toggle("cur", s.section === i);
    b.classList.toggle("next", s.next === i);
  });
  $("songbtn").setAttribute("aria-pressed", s.songMode);
  $("srecbtn").setAttribute("aria-pressed", s.songrec > 0);
  $("srecbtn").textContent = s.songrec === 2 ? "song rec ●" : s.songrec === 1 ? "song rec: next bar" : "song rec";
  $("fill").classList.toggle("on", s.fillHeld);
  $("fillnext").classList.toggle("arm", s.fillNext);
  for (let i = 0; i < 4 && i < dev.tracks.length; i++) dev.tracks[i].mute = !!(s.mute >> i & 1);
  dev.solo = s.solo;
  paintTracks();
  paintPads();
  paintChain();
}
function paintTracks() {
  if (!dev) return;
  document.querySelectorAll(".trk").forEach((d, i) => {
    const t = dev.tracks[i];
    if (!t) return;
    d.classList.toggle("muted", t.mute);
    d.classList.toggle("solo", !!(dev.solo >> i & 1));
    d.classList.toggle("quiet", !!dev.solo && !(dev.solo >> i & 1));
    d.querySelector(".m span").textContent = t.mute ? "muted" : engName(t);
    d.querySelector(".m").setAttribute("aria-pressed", t.mute);
  });
  paintFaders();
}
function paintPads() {
  const fx = dev && dev.live ? dev.live.fx : -1, remote = dev && dev.live && dev.live.fxRemote;
  document.querySelectorAll(".pad").forEach((b, i) => {
    const mine = held.length ? held[held.length - 1] === i : remote && fx === i;
    b.classList.toggle("on", mine);
    b.classList.toggle("dev", !mine && fx === i);   /* played from the FM-1's own keys */
    b.setAttribute("aria-pressed", mine);
  });
}
function paintChain() {
  const s = dev && dev.live;
  const line = $("chainline");
  if (chainMode) line.textContent = chainBuild.length ? "chain " + chainBuild.map((k) => "ABCD"[k]).join(" ") + ", then play chain" : "tap sections in the order to play them";
  else if (s && s.chain.length) line.textContent = "chain " + s.chain.map((k, i) => (i === s.chainI ? "[" + "ABCD"[k] + "]" : "ABCD"[k])).join(" ");
  else line.textContent = s && s.songPlays ? "the song plays" : "";
}
function paintFaders() { for (const f of faders) f.paint(); }

/* ------------------------------------------------------------ wiring --- */
$("play").addEventListener("click", () => perform(PF.TRANSPORT, [0]).then((s) => { if (s && s.rc === 1) toast("Song mode, but a section of the song is empty"); }));
$("bpm").addEventListener("pointerdown", () => perform(PF.TAP));
$("tap").addEventListener("pointerdown", () => perform(PF.TAP));
holdable($("fill"), () => { fillHeld = true; perform(PF.FILL, [1]); }, () => { fillHeld = false; perform(PF.FILL, [0]); });
$("fillnext").addEventListener("click", () => perform(PF.FILL, [2]));
$("songbtn").addEventListener("click", () => perform(PF.SONGMODE, [2]));
$("srecbtn").addEventListener("click", () => perform(PF.SONGREC));
$("latch").addEventListener("click", () => {
  latch = !latch;
  $("latch").setAttribute("aria-pressed", latch);
  held.length = 0;
  fxSend();
  paintPads();
});
$("chainbtn").addEventListener("click", async () => {
  if (chainMode && chainBuild.length) {
    const st = await perform(PF.CHAIN, [chainBuild.length, ...chainBuild]);
    if (st && st.rc) toast(st.rc === 1 ? "Press play first: a chain starts on the next bar" : st.rc === 2 ? "A section in the chain is empty" : "Stop the song first");
    else if (st) { chainMode = false; chainBuild = []; }
  } else { chainMode = !chainMode; chainBuild = []; }
  $("chainbtn").setAttribute("aria-pressed", chainMode);
  $("chainbtn").textContent = chainMode ? "play chain" : "chain";
  paintChain();
});
for (const [btn, view] of [["v-play", "playview"], ["v-mix", "mixview"]]) {
  $(btn).addEventListener("click", () => {
    for (const [b, v] of [["v-play", "playview"], ["v-mix", "mixview"]]) {
      $(b).setAttribute("aria-pressed", b === btn);
      $(v).hidden = v !== view;
    }
    paintFaders();
  });
}

const midiOk = WebMidiTransport.supported;
$("connect").addEventListener("click", () => connect(QS.get("ws") ? new WebSocketTransport(QS.get("ws")) : new WebMidiTransport()));
$("demo").addEventListener("click", async () => { const { MockTransport } = await import("./mock.js"); connect(new MockTransport(+QS.get("mock") === 10 ? 10 : 11)); });
if (!midiOk && !QS.get("ws")) {
  $("connect").disabled = true;
  gateSay("This browser has no Web MIDI (Safari on iPhone and iPad does not). Use Chrome on Android, or Chrome or Edge on a computer. The demo works anywhere.");
}
if (QS.get("mock")) $("demo").click();
if ("serviceWorker" in navigator && location.protocol !== "file:") navigator.serviceWorker.register("sw.js").catch(() => {});
