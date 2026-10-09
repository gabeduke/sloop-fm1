// SPDX-License-Identifier: GPL-3.0-only
// How SLOOP LIVE reaches the FM-1. Each transport opens, gives send(bytes) and calls onData(bytes) for
// every MIDI message it receives; onLost() when the device goes away. Today: USB through Web MIDI
// (Chrome on Android, desktop Chrome / Edge). A bridge that relays raw MIDI over a WebSocket (a Pi next
// to the synth, for iPhones) fits behind the same three calls: ?ws=ws://host:port.

const PORT = /felucca|sloop/i;                       /* the FM-1 keeps the port name "Felucca" */

export class WebMidiTransport {
  static get supported() { return !!navigator.requestMIDIAccess; }
  get label() { return "USB"; }
  async open(onData, onLost) {
    let access;
    try { access = await navigator.requestMIDIAccess({ sysex: true }); }
    catch (e) { throw Object.assign(new Error("MIDI access was refused. Allow MIDI devices for this site, then connect again."), { code: "denied" }); }
    const pick = (m) => [...m.values()].find((p) => PORT.test(p.name || "") && p.state !== "disconnected");
    const input = pick(access.inputs), output = pick(access.outputs);
    if (!input || !output) {
      throw Object.assign(new Error("No FM-1 found. Plug it in with a data cable (an OTG adapter on a phone), then connect again."), { code: "nodevice" });
    }
    if (input.open) await input.open().catch(() => {});
    input.onmidimessage = (e) => onData(e.data);
    access.onstatechange = (e) => {
      if ((e.port === input || e.port === output) && e.port.state === "disconnected") onLost();
    };
    this.close = () => { input.onmidimessage = null; access.onstatechange = null; };
    this.send = (d) => output.send(d);
  }
}

export class WebSocketTransport {
  constructor(url) { this.url = url; }
  static get supported() { return "WebSocket" in window; }
  get label() { return "bridge"; }
  open(onData, onLost) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url);
      ws.binaryType = "arraybuffer";
      let up = false;
      ws.onopen = () => { up = true; resolve(); };
      ws.onerror = () => { if (!up) reject(new Error("The bridge at " + this.url + " did not answer.")); };
      ws.onclose = () => { if (up) onLost(); };
      ws.onmessage = (e) => onData(new Uint8Array(e.data));
      this.send = (d) => ws.send(d);
      this.close = () => { ws.onclose = null; ws.close(); };
    });
  }
}
