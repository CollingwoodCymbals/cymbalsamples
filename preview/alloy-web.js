/* Alloy (web) - a browser version of the Alloy cymbal player.
   Plays the real Alloy Test 1 hits: stereo ribbon pair + mono spot mic,
   5 velocity layers x 4 round robins. Web Audio API, no libraries. */
(function () {
  const OFFSET_MS = 0.68;            // measured: mono mic leads the ribbons
  const LAYERS = 5, RRS = 4;
  const AUDIO = 'audio/';
  const $ = (id) => document.getElementById(id);

  let ctx = null, nodes = null;
  const buffers = {};                // key "V1_RR1_Ribbon" -> AudioBuffer
  const peaks = {};                  // key -> Float32Array for the display
  const loading = {};
  let loadedCount = 0;
  let rr = 0, voices = [];

  // ---------- parameters (match the plug-in's faders) ----------
  const P = {
    rLevel: 0, rWidth: 100, rTone: 0, rComp: 0, rDrive: 0,
    blend: 50, mDelay: 0, vel: 100, decay: 100, tune: 0,
    mLevel: 0, mPan: 15, mTone: 0, mComp: 0, mDrive: 0,
    out: 0,
    rSolo: false, rPol: false, rSwap: false,
    mSolo: false, mPol: false, align: true, roundRobin: true
  };

  const dB = (x) => Math.pow(10, x / 20);

  function driveCurve(amount) {      // amount 0..100
    const k = amount / 100 * 8, n = 1024, c = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const x = i * 2 / (n - 1) - 1;
      c[i] = k === 0 ? x : Math.tanh(x * (1 + k)) / Math.tanh(1 + k);
    }
    return c;
  }

  function makeBus(stereo) {
    const b = {};
    b.input = ctx.createGain();
    // width / swap matrix (stereo only)
    let head = b.input;
    if (stereo) {
      b.split = ctx.createChannelSplitter(2);
      b.merge = ctx.createChannelMerger(2);
      b.ll = ctx.createGain(); b.lr = ctx.createGain(); b.rl = ctx.createGain(); b.rr = ctx.createGain();
      b.input.connect(b.split);
      b.split.connect(b.ll, 0); b.split.connect(b.lr, 0);
      b.split.connect(b.rl, 1); b.split.connect(b.rr, 1);
      b.ll.connect(b.merge, 0, 0); b.rl.connect(b.merge, 0, 0);
      b.lr.connect(b.merge, 0, 1); b.rr.connect(b.merge, 0, 1);
      head = b.merge;
    } else {
      b.delay = ctx.createDelay(0.05);
      b.input.connect(b.delay); head = b.delay;
    }
    b.low = ctx.createBiquadFilter(); b.low.type = 'lowshelf'; b.low.frequency.value = 400;
    b.high = ctx.createBiquadFilter(); b.high.type = 'highshelf'; b.high.frequency.value = 3500;
    b.shaper = ctx.createWaveShaper(); b.shaper.oversample = '2x';
    b.comp = ctx.createDynamicsCompressor();
    b.comp.knee.value = 6; b.comp.attack.value = 0.003; b.comp.release.value = 0.25;
    b.makeup = ctx.createGain();
    b.level = ctx.createGain();
    b.pol = ctx.createGain();
    b.blend = ctx.createGain();
    head.connect(b.low); b.low.connect(b.high); b.high.connect(b.shaper);
    b.shaper.connect(b.comp); b.comp.connect(b.makeup); b.makeup.connect(b.level);
    b.level.connect(b.pol);
    if (!stereo) { b.pan = ctx.createStereoPanner(); b.pol.connect(b.pan); b.pan.connect(b.blend); }
    else b.pol.connect(b.blend);
    return b;
  }

  function build() {
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    const r = makeBus(true), m = makeBus(false);
    const out = ctx.createGain();
    r.blend.connect(out); m.blend.connect(out);
    const split = ctx.createChannelSplitter(2);
    const aL = ctx.createAnalyser(), aR = ctx.createAnalyser();
    aL.fftSize = aR.fftSize = 1024;
    out.connect(ctx.destination); out.connect(split);
    split.connect(aL, 0); split.connect(aR, 1);
    nodes = { r, m, out, aL, aR };
    applyAll();
    requestAnimationFrame(meterLoop);
  }

  function setBusTone(b, t) {        // tilt: +dB brighter, -dB darker
    b.low.gain.value = -t / 2; b.high.gain.value = t;
  }
  function setBusComp(b, c) {        // 0..100
    b.comp.threshold.value = -c * 0.4;            // 0 .. -40 dB
    b.comp.ratio.value = 1 + c / 100 * 7;         // 1 .. 8
    b.makeup.gain.value = dB(c * 0.12);           // gentle make-up
  }

  function applyAll() {
    if (!nodes) return;
    const { r, m, out } = nodes;
    // ribbons
    r.level.gain.value = dB(P.rLevel);
    const w = P.rWidth / 100, a = (1 + w) / 2, bx = (1 - w) / 2;
    const sw = P.rSwap;
    r.ll.gain.value = sw ? bx : a; r.rr.gain.value = sw ? bx : a;
    r.lr.gain.value = sw ? a : bx; r.rl.gain.value = sw ? a : bx;
    setBusTone(r, P.rTone); setBusComp(r, P.rComp);
    r.shaper.curve = driveCurve(P.rDrive);
    r.pol.gain.value = P.rPol ? -1 : 1;
    // mono
    m.level.gain.value = dB(P.mLevel);
    m.pan.pan.value = P.mPan / 100;
    setBusTone(m, P.mTone); setBusComp(m, P.mComp);
    m.shaper.curve = driveCurve(P.mDrive);
    m.pol.gain.value = P.mPol ? -1 : 1;
    m.delay.delayTime.value = ((P.align ? OFFSET_MS : 0) + P.mDelay) / 1000;
    // blend (equal power), solos win
    let x = P.blend / 100;
    let gr = Math.cos(x * Math.PI / 2), gm = Math.sin(x * Math.PI / 2);
    if (P.rSolo && !P.mSolo) { gr = 1; gm = 0; }
    if (P.mSolo && !P.rSolo) { gr = 0; gm = 1; }
    r.blend.gain.value = gr; m.blend.gain.value = gm;
    out.gain.value = dB(P.out);
  }

  // ---------- loading ----------
  function key(layer, robin, mic) { return 'V' + layer + '_RR' + robin + '_' + mic; }

  async function load(k) {
    if (buffers[k]) return buffers[k];
    if (!loading[k]) {
      loading[k] = fetch(AUDIO + k + '.mp3')
        .then((res) => { if (!res.ok) throw new Error(k); return res.arrayBuffer(); })
        .then((ab) => new Promise((ok, bad) => ctx.decodeAudioData(ab, ok, bad)))
        .then((buf) => { buffers[k] = buf; peaks[k] = makePeaks(buf); loadedCount++; status(); return buf; });
    }
    return loading[k];
  }
  function loadAll() {
    const all = [];
    for (let v = 1; v <= LAYERS; v++) for (let r = 1; r <= RRS; r++) {
      all.push(load(key(v, r, 'Ribbon')), load(key(v, r, 'Mono')));
    }
    return Promise.all(all);
  }
  function status() {
    const el = $('awStatus');
    if (!el) return;
    el.textContent = loadedCount < 40 ? 'LOADING ' + loadedCount + ' / 40 HITS' : '1 ARTICULATION · 5 LAYERS · 4 RR · 48 kHz 24 BIT';
  }

  function makePeaks(buf) {
    const n = 600, d0 = buf.getChannelData(0), d1 = buf.numberOfChannels > 1 ? buf.getChannelData(1) : d0;
    const step = Math.floor(buf.length / n), out = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      let mx = 0;
      for (let j = i * step, e = j + step; j < e; j += 8) {
        const v = Math.max(Math.abs(d0[j]), Math.abs(d1[j])); if (v > mx) mx = v;
      }
      out[i] = mx;
    }
    return out;
  }

  // ---------- playing ----------
  function layerFor(vel) { return Math.min(LAYERS, Math.max(1, Math.ceil(vel / 127 * LAYERS))); }

  async function hit(vel) {
    if (!ctx) build();
    if (ctx.state === 'suspended') await ctx.resume();
    if (loadedCount === 0) loadAll().catch(() => {});
    vel = vel == null ? P.vel : vel;
    const layer = layerFor(vel);
    const robin = P.roundRobin ? (rr % RRS) + 1 : 1;
    if (P.roundRobin) rr++;
    const kR = key(layer, robin, 'Ribbon'), kM = key(layer, robin, 'Mono');
    let bR, bM;
    try { [bR, bM] = await Promise.all([load(kR), load(kM)]); }
    catch (e) { flashStatus('COULD NOT LOAD THE HITS'); return; }
    const t = ctx.currentTime + 0.01, rate = Math.pow(2, P.tune / 12);
    const env = ctx.createGain();
    const env2 = ctx.createGain();
    const sR = ctx.createBufferSource(), sM = ctx.createBufferSource();
    sR.buffer = bR; sM.buffer = bM;
    sR.playbackRate.value = sM.playbackRate.value = rate;
    sR.connect(env); env.connect(nodes.r.input);
    sM.connect(env2); env2.connect(nodes.m.input);
    if (P.decay < 100) {             // shorten the ring-out
      const len = 0.25 + (P.decay / 100) * 6;
      [env, env2].forEach((g) => { g.gain.setValueAtTime(1, t + len * 0.3); g.gain.linearRampToValueAtTime(0, t + len); });
    }
    sR.start(t); sM.start(t);
    const v = { sR, sM, env, env2 };
    voices.push(v); if (voices.length > 12) stopVoice(voices.shift(), 0.05);
    sR.onended = () => { voices = voices.filter((x) => x !== v); };
    show(layer, robin, vel, kR, kM);
  }

  function stopVoice(v, fade) {
    const t = ctx.currentTime;
    [v.env, v.env2].forEach((g) => { g.gain.cancelScheduledValues(t); g.gain.setValueAtTime(g.gain.value, t); g.gain.linearRampToValueAtTime(0, t + fade); });
    try { v.sR.stop(t + fade + 0.01); v.sM.stop(t + fade + 0.01); } catch (e) {}
  }
  function choke() { if (!ctx) return; voices.forEach((v) => stopVoice(v, 0.08)); voices = []; }

  // ---------- display ----------
  let trigTimer = null;
  function show(layer, robin, vel, kR, kM) {
    const info = $('awHitInfo'); if (info) info.textContent = 'TIP · VEL ' + layer + ' · RR ' + robin;
    const trig = $('awTrig'); if (trig) { trig.classList.add('on'); clearTimeout(trigTimer); trigTimer = setTimeout(() => trig.classList.remove('on'), 160); }
    const tl = $('awTrigText'); if (tl) tl.textContent = 'C4 TIP · VEL ' + vel;
    document.querySelectorAll('#awVelDots i').forEach((d, i) => d.classList.toggle('on', i < layer));
    document.querySelectorAll('#awRRDots i').forEach((d, i) => d.classList.toggle('on', i === robin - 1));
    const pad = $('awPadTip'); if (pad) { pad.classList.add('hit'); setTimeout(() => pad.classList.remove('hit'), 140); }
    drawWave(peaks[kR], peaks[kM]);
  }

  function drawWave(pr, pm) {
    const c = $('awWave'); if (!c) return;
    const dpr = window.devicePixelRatio || 1, w = c.clientWidth, h = c.clientHeight;
    c.width = w * dpr; c.height = h * dpr;
    const g = c.getContext('2d'); g.scale(dpr, dpr); g.clearRect(0, 0, w, h);
    const mid = h / 2;
    const x = P.blend / 100;
    const draw = (p, col, scale) => {
      if (!p) return;
      g.fillStyle = col;
      const n = p.length, bw = w / n;
      for (let i = 0; i < n; i++) { const a = Math.min(1, Math.pow(p[i], 0.5) * scale) * (h * 0.46); g.fillRect(i * bw, mid - a, Math.max(1, bw - 0.3), a * 2); }
    };
    draw(pr, 'rgba(236,230,220,' + (0.25 + 0.6 * Math.cos(x * Math.PI / 2)) + ')', 1.1);
    draw(pm, 'rgba(240,166,64,' + (0.25 + 0.6 * Math.sin(x * Math.PI / 2)) + ')', 1.1);
  }

  let flashT = null;
  function flashStatus(s) { const el = $('awStatus'); if (!el) return; el.textContent = s; clearTimeout(flashT); flashT = setTimeout(status, 2500); }

  // meters + gain reduction
  const mbuf = new Float32Array(1024);
  function level(an) { an.getFloatTimeDomainData(mbuf); let p = 0; for (let i = 0; i < mbuf.length; i++) { const v = Math.abs(mbuf[i]); if (v > p) p = v; } return p; }
  function setMeter(id, peak) {
    const el = $(id); if (!el) return;
    const db = peak > 0 ? 20 * Math.log10(peak) : -99;
    const segs = el.children, n = segs.length;
    const lit = Math.round((db + 48) / 54 * n);
    for (let i = 0; i < n; i++) segs[i].className = i < lit ? (i >= n - 4 ? 'red' : i >= n - 6 ? 'amb' : 'grn') : '';
  }
  function setGR(id, red) {
    const el = $(id); if (!el) return;
    const n = el.children.length, lit = Math.min(n, Math.round(-red / 2));
    for (let i = 0; i < n; i++) el.children[n - 1 - i].className = i < lit ? 'on' : '';
  }
  function meterLoop() {
    if (nodes) {
      setMeter('awMeterL', level(nodes.aL)); setMeter('awMeterR', level(nodes.aR));
      setGR('awGrR', nodes.r.comp.reduction); setGR('awGrM', nodes.m.comp.reduction);
    }
    requestAnimationFrame(meterLoop);
  }

  // ---------- controls ----------
  const fmt = {
    rLevel: (v) => (v > 0 ? '+' : '') + v.toFixed(1) + ' dB', mLevel: (v) => (v > 0 ? '+' : '') + v.toFixed(1) + ' dB', out: (v) => (v > 0 ? '+' : '') + v.toFixed(1) + ' dB',
    rTone: (v) => (v > 0 ? '+' : '') + v.toFixed(1) + ' dB', mTone: (v) => (v > 0 ? '+' : '') + v.toFixed(1) + ' dB',
    rWidth: (v) => Math.round(v) + ' %', rComp: (v) => Math.round(v) + ' %', mComp: (v) => Math.round(v) + ' %',
    rDrive: (v) => Math.round(v) + ' %', mDrive: (v) => Math.round(v) + ' %',
    blend: (v) => Math.round(100 - v) + '/' + Math.round(v), mDelay: (v) => v.toFixed(2) + ' ms',
    vel: (v) => Math.round(v), decay: (v) => v >= 100 ? 'FULL' : Math.round(v) + ' %',
    tune: (v) => (v > 0 ? '+' : '') + v.toFixed(2) + ' st',
    mPan: (v) => v === 0 ? 'C' : (v < 0 ? 'L' : 'R') + Math.abs(Math.round(v))
  };

  function bind() {
    document.querySelectorAll('[data-p]').forEach((inp) => {
      const p = inp.dataset.p, box = document.querySelector('[data-v="' + p + '"]');
      const def = parseFloat(inp.defaultValue);
      const upd = () => { P[p] = parseFloat(inp.value); if (box) box.textContent = fmt[p](P[p]); applyAll(); if (p === 'blend') redrawLast(); };
      inp.addEventListener('input', upd);
      inp.addEventListener('dblclick', () => { inp.value = def; upd(); });
      inp.value = P[p]; upd();
    });
    document.querySelectorAll('[data-t]').forEach((b) => {
      const p = b.dataset.t;
      const upd = () => { b.classList.toggle('on', !!P[p]); applyAll(); };
      b.addEventListener('click', () => { P[p] = !P[p]; upd(); });
      upd();
    });
    // blend presets: hold to audition, like the plug-in
    document.querySelectorAll('[data-blend]').forEach((b) => {
      let saved = null;
      const down = (e) => { e.preventDefault(); saved = P.blend; setBlend(parseFloat(b.dataset.blend)); b.classList.add('on'); };
      const up = () => { if (saved !== null) { setBlend(saved); saved = null; } b.classList.remove('on'); };
      b.addEventListener('pointerdown', down); b.addEventListener('pointerup', up); b.addEventListener('pointerleave', up);
    });
    const set = $('awSet'); if (set) set.addEventListener('click', () => setBlend(50));
    const pad = $('awPadTip');
    if (pad) pad.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      // where you hit the pad sets the velocity: higher = harder
      const r = pad.getBoundingClientRect();
      const v = Math.max(1, Math.min(127, Math.round((1 - (e.clientY - r.top) / r.height) * 127 * 1.15)));
      hit(v);
    });
    const big = $('awStrike'); if (big) big.addEventListener('pointerdown', (e) => { e.preventDefault(); hit(); });
    const ch = $('awChoke'); if (ch) ch.addEventListener('click', choke);
    // MIDI: note 60 (C4) plays the tip, like the plug-in
    if (navigator.requestMIDIAccess) {
      const midiBtn = $('awMidi');
      if (midiBtn) midiBtn.addEventListener('click', () => {
        navigator.requestMIDIAccess().then((acc) => {
          const hook = () => acc.inputs.forEach((i) => { i.onmidimessage = (m) => { const [s, n, v] = m.data; if ((s & 0xf0) === 0x90 && v > 0) { if (n === 60) hit(v); } if ((s & 0xf0) === 0xb0 && n === 120) choke(); }; });
          hook(); acc.onstatechange = hook;
          midiBtn.classList.add('on'); midiBtn.textContent = 'MIDI ON · C4 = TIP';
        }).catch(() => flashStatus('MIDI NOT ALLOWED IN THIS BROWSER'));
      });
    } else { const mb = $('awMidi'); if (mb) mb.style.display = 'none'; }
    window.addEventListener('resize', redrawLast);
  }
  let lastK = null;
  function redrawLast() { if (lastK) drawWave(peaks[lastK[0]], peaks[lastK[1]]); }
  const _show = show;
  show = function (layer, robin, vel, kR, kM) { lastK = [kR, kM]; _show(layer, robin, vel, kR, kM); };

  function setBlend(v) {
    P.blend = v; const inp = document.querySelector('[data-p="blend"]'); if (inp) inp.value = v;
    const box = document.querySelector('[data-v="blend"]'); if (box) box.textContent = fmt.blend(v);
    applyAll(); redrawLast();
  }

  window.AlloyWeb = { hit, choke };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind); else bind();
})();
