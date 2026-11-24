#!/usr/bin/env node
// Minimal client for EseeCloud / Juan based NVRs (Hiseeu and others) speaking the "kp2p" protocol over WebSocket (port 10000).
// Writes the raw H.264 / H.265 video (Annex-B) of one camera to a file or to stdout, and can send PTZ commands.
// No dependencies: Node.js >= 22 (built-in WebSocket and crypto). Only talks to the NVR, never to any cloud.
//
// Usage:
//   node kp2p.js --host 192.168.1.50 --hello                               (connection test, no password needed)
//   node kp2p.js --host 192.168.1.50 --ch 0 --stream 1 --seconds 10 --out cam1.h265
//   node kp2p.js --host 192.168.1.50 --ch 0 --stream 0 --out -             (stdout, for ffmpeg / go2rtc / mediamtx)
//   node kp2p.js --host 192.168.1.50 --ch 0 --ptz left --ms 500 [--speed 4]
//        moves: up down left right zoomin zoomout auto stop,
//        or preset-set / preset-go / preset-clear with --preset N
//
// --ch     camera channel on the NVR, starting at 0
// --stream 0 = main stream (HD), 1 = sub stream (SD)
// --user   NVR user name (default: admin)
// Password: --passfile <file>, otherwise the NVR_PASS environment variable, otherwise asked on the terminal (hidden).
// Node 20: run with --experimental-websocket (the built-in WebSocket is stable from Node 22).
//
// Exit codes: 0 ok, 1 connection / timeout, 2 login refused, 3 unsupported codec, 4 unknown PTZ move,
//             5 PTZ refused, 6 video frozen (watchdog), 7 NVR busy (refusal or "busy" placeholder picture).
'use strict';
const crypto = require('crypto');
const fs = require('fs');

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a.startsWith('--')) {
    const n = process.argv[i + 1];
    if (n === undefined || n.startsWith('--')) args[a.slice(2)] = true; else { args[a.slice(2)] = n; i++; }
  }
}
const log = (...m) => process.stderr.write('[kp2p] ' + m.join(' ') + '\n');
if (!args.host) { log('missing --host <NVR IP address>'); process.exit(1); }
const HOST = args.host;
const PORT = Number(args.port || 10000);
const USER = args.user || 'admin';
const CH = Number(args.ch || 0);
const STREAM = Number(args.stream || 0);
const SECONDS = Number(args.seconds || 0);
const OUT = args.out || '-';

const ARQ_OPEN = Buffer.from('d9ffcc028c38eed2d199ac6026947fae', 'hex');
const ARQ_OPEN_RES = Buffer.from('96d5390d12fcbe8f4790d932ccd849f3', 'hex');
const ARQ_PREFIX = Buffer.from('cefaeffe', 'hex');
const IOT_MAGIC = Buffer.from('abbccdde', 'hex');
const API_MAGIC = 0x4b503250;
const MARF = 0x4652414d, NARF = 0x4652414e;
const IOT = { PING: 17, PONG: 18, DATA: 19, OPEN_REQ: 20, OPEN_RES: 21, DATA_PRIOR: 43 };
const BUSY_WAIT_S = 8, STALL_S = 8;
const CMD = { AUTH_REQ: 10, AUTH_RSP: 11, PTZ_REQ: 20, PTZ_RSP: 21, LIVE_REQ: 30, LIVE_RSP: 31, SETUP_REQ: 80, SETUP_RSP: 81, SETUP2_REQ: 150, SETUP2_RSP: 151 };
const PTZ = { stop: 0, auto: 1, up: 2, down: 3, left: 4, right: 5, 'iris-open': 6, 'iris-close': 7, zoomin: 8, zoomout: 9,
  'focus-far': 10, 'focus-near': 11, aux: 12, 'preset-set': 13, 'preset-go': 14, 'preset-clear': 15 };
// Fixed key used by the Juan / EseeCloud firmware to encrypt the login fields (same on every device).
const AES_KEY = Buffer.from('~!JUAN*&Vision-=', 'latin1');

function aesField(str) {
  const plain = Buffer.alloc(32);
  plain.write(String(str).slice(0, 31), 'utf8');
  const c = crypto.createCipheriv('aes-128-ecb', AES_KEY, null);
  c.setAutoPadding(false);
  return Buffer.concat([c.update(plain), c.final()]);
}

function askPassword() {
  if (args.passfile) return Promise.resolve(fs.readFileSync(args.passfile, 'utf8').replace(/\r?\n$/, ''));
  if (process.env.NVR_PASS !== undefined) return Promise.resolve(process.env.NVR_PASS);
  return new Promise((resolve) => {
    process.stderr.write('NVR password: ');
    const stdin = process.stdin;
    let pw = '';
    stdin.setRawMode && stdin.setRawMode(true);
    stdin.resume(); stdin.setEncoding('utf8');
    const onData = (ch) => {
      for (const c of ch) {
        if (c === '\r' || c === '\n') { stdin.setRawMode && stdin.setRawMode(false); stdin.pause(); stdin.removeListener('data', onData); process.stderr.write('\n'); return resolve(pw); }
        if (c === '\u0003') process.exit(130);
        if (c === '\u007f' || c === '\b') pw = pw.slice(0, -1); else pw += c;
      }
    };
    stdin.on('data', onData);
  });
}

async function main() {
  const password = args.hello ? null : await askPassword();
  const out = args.hello ? null : (OUT === '-' ? process.stdout : fs.createWriteStream(OUT));
  const sid = 1 + Math.floor(Math.random() * 9999);
  let tick = 0, first = true, pingTimer = null, frag = null, bytes = 0, frames = 0, started = null;
  let refused = false, lastFrame = 0;
  // Watchdog: when the video freezes (the NVR keeps the connection open but stops sending frames),
  // quit so that the relay opens a fresh connection instead of waiting forever.
  if (!args.ptz && !args.setup && !args.setup2) {
    setInterval(() => {
      if (frames > 0 && Date.now() - lastFrame > STALL_S * 1000) finish(6, `video frozen for ${STALL_S} s, disconnecting`);
    }, 1000).unref();
  }

  const ws = new WebSocket(`ws://${HOST}:${PORT}`);
  ws.binaryType = 'arraybuffer';
  const sendRaw = (buf) => { const pre = Buffer.alloc(8); ARQ_PREFIX.copy(pre); pre.writeUInt32LE(buf.length, 4); ws.send(pre); ws.send(buf); };
  const iot = (cmd, payload = Buffer.alloc(0)) => {
    const h = Buffer.alloc(32); IOT_MAGIC.copy(h); h[4] = cmd; h[11] = 1;
    h.writeUInt32LE(sid, 16); h.writeUInt32LE(payload.length, 28);
    sendRaw(Buffer.concat([h, payload]));
  };
  const api = (cmd, payload) => {
    tick += 1; const h = Buffer.alloc(24);
    h.writeUInt32LE(API_MAGIC, 0); h.writeUInt32LE(1, 4); h.writeUInt32LE(tick, 8); h.writeUInt32LE(cmd, 12); h.writeUInt32LE(payload.length, 20);
    iot(IOT.DATA, Buffer.concat([h, payload]));
  };
  const apiRaw = (cmd, payload, extra) => {
    tick += 1; const h = Buffer.alloc(24);
    h.writeUInt32LE(API_MAGIC, 0); h.writeUInt32LE(1, 4); h.writeUInt32LE(tick, 8); h.writeUInt32LE(cmd, 12); h.writeUInt32LE(payload.length, 20);
    iot(IOT.DATA, Buffer.concat([h, payload, extra]));
  };
  const finish = (code, msg) => { if (msg) log(msg); clearInterval(pingTimer); try { ws.close(); } catch {} ; if (out && out !== process.stdout) out.end(); setTimeout(() => process.exit(code), 300); };

  let ptzAck = null, setupAck = null;
  // Experimental: settings requests (the JSON "netsdk"-like API used by the EseeCloud app), --setup '<json>' or --setup2.
  const doSetup = async () => {
    started = Date.now();
    let txt = String(args.setup || args.setup2);
    if (txt.startsWith('@')) txt = fs.readFileSync(txt.slice(1), 'utf8');
    if (txt.startsWith('$') || /^[A-Z]\./.test(txt) || /^[A-Za-z]+$/.test(txt)) {
      // EseeCloud app format for an NVR: API path ($.Stream.Ircut, G.xxx...) + Get/Set
      const apiPath = txt, method = String(args.method || 'Get');
      const req = { DEV: 'XVR', Version: '1.0.0', API: apiPath, Method: method };
      if (args.param) req.Parameter = JSON.parse(String(args.param));
      req.Authorization = { UserName: USER, Type: 'Basic', Digest: Buffer.from(`${apiPath}:${USER}:${password}`, 'utf8').toString('base64') };
      txt = JSON.stringify(req);
    }
    txt = txt.replace(/__PASS__/g, password).replace(/__USER__/g, USER);
    const body = Buffer.from(txt, 'utf8');
    const done = new Promise((z) => { setupAck = z; setTimeout(z, 6000); });
    if (args.setup) { const p = Buffer.alloc(2052); p.writeUInt32LE(body.length, 0); body.copy(p, 4, 0, 2047); api(CMD.SETUP_REQ, p); }
    else { const p = Buffer.alloc(36); p.writeUInt32LE(body.length, 32); apiRaw(CMD.SETUP2_REQ, p, body); }
    log(`settings request sent (cmd ${args.setup ? 80 : 150}, ${body.length} bytes)`);
    await done; setTimeout(() => finish(0, 'done'), 500);
  };
  const ptzSend = (action, p1, p2) => new Promise((res) => {
    const p = Buffer.alloc(16); p.writeUInt32LE(CH, 0); p.writeUInt32LE(action, 4); p.writeUInt32LE(p1, 8); p.writeUInt32LE(p2, 12);
    const t = setTimeout(() => { ptzAck = null; res(null); }, 3000);
    ptzAck = (r) => { clearTimeout(t); ptzAck = null; res(r); };
    api(CMD.PTZ_REQ, p);
  });
  const doPtz = async () => {
    started = Date.now();
    const name = String(args.ptz).toLowerCase();
    if (!(name in PTZ)) return finish(4, 'unknown move: ' + name + ' (possible: ' + Object.keys(PTZ).join(' ') + ')');
    const action = PTZ[name];
    const speed = Number(args.speed || 4);
    const p1 = name.startsWith('preset') ? Number(args.preset || 1) : speed;
    log(`move ${name} channel=${CH} param=${p1} param2=${args.p2 || 0}`);
    const p2 = Number(args.p2 || 0);
    const r = await ptzSend(action, p1, p2);
    if (r === null) log('no answer to the move (timeout)');
    const ms = Number(args.ms || 0);
    if (ms > 0 && action >= 2 && action <= 11) { await new Promise((z) => setTimeout(z, ms)); await ptzSend(PTZ.stop, 0, 0); }
    finish(r === 0 ? 0 : 5, 'done');
  };

  const emitVideo = (data, ftype) => {
    if (refused) return;                     // placeholder picture after a refusal: ignored
    if (ftype !== 1 && ftype !== 2) return; // 0 = audio: ignored
    lastFrame = Date.now();
    if (!started && ftype !== 1) return;     // start on a key frame
    if (!started) { started = Date.now(); log('first key frame received'); if (SECONDS) setTimeout(() => finish(0, `end: ${frames} frames, ${bytes} bytes`), SECONDS * 1000); }
    frames++; bytes += data.length; out.write(data);
  };

  const onData = (r) => {
    if (frag) {
      const isApi = r.length >= 24 && r.readUInt32LE(0) === API_MAGIC && r.readUInt32LE(20) === r.length - 24;
      if (!isApi) { frag.chunks.push(r); frag.got += r.length; if (frag.got >= frag.size) { const d = Buffer.concat(frag.chunks, frag.got).subarray(0, frag.size); const t = frag.ftype; frag = null; emitVideo(d, t); } return; }
    }
    if (r.length < 4) return;
    const magic = r.readUInt32LE(0);
    if (magic === API_MAGIC && r.length >= 24) {
      const cmd = r.readUInt32LE(12), result = r.readInt32LE(16);
      if (cmd === CMD.AUTH_RSP) {
        if (result !== 0) return finish(2, `login refused (wrong password?) code=${result}`);
        log('login OK');
        if (args.ptz) return doPtz();
        if (args.setup || args.setup2) return doSetup();
        const p = Buffer.alloc(12); p.writeUInt32LE(CH, 0); p.writeUInt32LE(STREAM, 4); p.writeUInt32LE(2, 8);
        api(CMD.LIVE_REQ, p); log(`requesting camera ch=${CH} stream=${STREAM}`);
      } else if (cmd === CMD.SETUP_RSP || cmd === CMD.SETUP2_RSP) {
        const p = r.subarray(24); const off = cmd === CMD.SETUP_RSP ? 4 : 36;
        const n = p.length >= off ? p.readUInt32LE(off - 4) : 0;
        const txt = p.subarray(off, off + n).toString('utf8');
        log(`settings answer cmd=${cmd} result=${result} (${n} bytes)`);
        process.stdout.write(txt.replace(/("(?:password|passwd|pwd)"\s*:\s*")[^"]*/gi, '$1***') + '\n');
        setupAck && setupAck();
      } else if (cmd === CMD.PTZ_RSP) { log(`move answer: ${result === 0 ? 'OK' : 'refused code=' + result}`); ptzAck && ptzAck(result); }
      else if (cmd === CMD.LIVE_RSP && result !== 0) {
        // Refusal (-40 = no free slot, e.g. too many HD streams): the NVR then sends a placeholder picture
        // (H.264 704x480) that must not be forwarded. Wait a little for the slot to be released, then quit
        // so that the relay starts a clean connection.
        log(`API answer cmd=${cmd} result=${result}: NVR busy, retry in ${BUSY_WAIT_S} s`);
        refused = true; setTimeout(() => finish(7, 'stopped after refusal'), BUSY_WAIT_S * 1000);
      } else log(`API answer cmd=${cmd} result=${result}`);
      return;
    }
    if (magic === MARF || magic === NARF) {
      if (magic === NARF) r = r.subarray(40);
      if (r.length < 56) return;
      const headtype = r.readUInt32LE(8), size = r.readUInt32LE(12);
      if (headtype !== 0) return;
      r = r.subarray(24);
      const ftype = r.readUInt32LE(0), chan = r.readUInt32LE(4);
      r = r.subarray(8);
      const codec = r.subarray(0, 8).toString('latin1').replace(/\0+$/, '');
      if (frames === 0 && !frag && ftype !== 0 && !refused) {
        const fps = r.readUInt32LE(8);
        log(`stream: codec=${codec} ${r.readUInt32LE(12)}x${r.readUInt32LE(16)} ${fps} fps, channel=${chan}`);
        // "Busy" placeholder picture sent WITHOUT an explicit refusal (LIVE answer = 0): 0 fps video
        // (H.264 704x480 while the cameras are H.265 15 fps). Handled like a refusal.
        if (fps === 0) {
          log(`NVR placeholder picture (0 fps): NVR busy, retry in ${BUSY_WAIT_S} s`);
          refused = true; setTimeout(() => finish(7, 'stopped after placeholder picture'), BUSY_WAIT_S * 1000);
          return;
        }
      }
      if (chan !== CH) return;
      if (ftype !== 0 && codec !== 'H264' && codec !== 'H265') return finish(3, `unsupported codec: ${codec}`);
      const data = r.subarray(32);
      if (data.length < size) { frag = { size, got: data.length, chunks: [data], ftype }; return; }
      emitVideo(data.subarray(0, size), ftype);
    }
  };

  ws.onopen = () => { const b = Buffer.alloc(20); ARQ_OPEN.copy(b); b.writeUInt32LE(sid, 16); ws.send(b); };
  ws.onerror = (e) => finish(1, 'WebSocket error: ' + (e.message || e.type));
  ws.onclose = () => finish(started ? 0 : 1, 'connection closed');
  ws.onmessage = (ev) => {
    const d = Buffer.from(ev.data);
    if (d.length >= 4 && d.subarray(0, 4).equals(ARQ_PREFIX)) return;
    if (first) {
      first = false;
      if (!d.subarray(0, 16).equals(ARQ_OPEN_RES)) return finish(1, 'unexpected answer: ' + d.subarray(0, 16).toString('hex'));
      log('handshake OK'); iot(IOT.OPEN_REQ, Buffer.from([sid & 255, (sid >> 8) & 255, 0, 0, 0, 0, 0, 0]));
      return;
    }
    if (d.length < 32 || !d.subarray(0, 4).equals(IOT_MAGIC)) return;
    const cmd = d.readUInt32LE(4), ecode = d.readInt32LE(24), body = d.subarray(32);
    if (cmd === IOT.OPEN_RES) {
      if (ecode !== 0) return finish(1, 'session refused, code=' + ecode);
      log('session open');
      if (args.hello) return finish(0, 'TEST OK: the NVR speaks the kp2p protocol');
      pingTimer = setInterval(() => iot(IOT.PING, Buffer.alloc(96)), 10000);
      api(CMD.AUTH_REQ, Buffer.concat([aesField(USER), aesField(password)]));
    } else if (cmd === IOT.DATA || cmd === IOT.DATA_PRIOR) onData(body);
  };
  setTimeout(() => { if (!started) finish(1, args.ptz ? 'timeout' : 'timeout, no video'); }, 20000);
}
main();
