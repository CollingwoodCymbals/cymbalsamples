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
  let rr = 0, lastRobin = 0, voices = [];

  // ---------- parameters (match the plug-in's faders) ----------
  const P = {
    rLevel: 0, rWidth: 100, rComp: 0, rPunch: 0, rDrive: 0,
    rCut: 20, rLow: 0, rMid: 0, rMidF: 2000, rHigh: 0,
    blend: 50, mDelay: 0, vel: 100, decay: 100, tune: 0,
    mLevel: 0, mPan: 15, mComp: 0, mPunch: 0, mDrive: 0,
    mCut: 20, mLow: 0, mMid: 0, mMidF: 2000, mHigh: 0,
    out: 0,
    rSolo: false, rPol: false, rSwap: false, rSlow: false, rPost: false, rAuto: true,
    mSolo: false, mPol: false, align: true, mSlow: false, mPost: false, mAuto: true,
    rrMode: 'random', chokeOn: false
  };
  let view = 'both';                 // wave view: both / ribbons / mono

  const dB = (x) => Math.pow(10, x / 20);

  // DRIVE: fixed drive gain per fader position (about 12 dB at 80 %), tanh saturation.
  // AUTO GAIN on turns the output down by that same fixed amount, so normal levels
  // come out about as loud as they went in; off lets more DRIVE get louder and hotter.
  function driveCurve(amount, auto) {  // amount 0..100
    const g = dB(amount * 0.15), n = 2048, c = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const x = i * 2 / (n - 1) - 1;
      c[i] = amount === 0 ? x : Math.tanh(x * g) / (auto ? g : 1);
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
    b.head = head;
    // four-band EQ: low cut, low shelf, mid (sweepable), high shelf
    b.cut = ctx.createBiquadFilter(); b.cut.type = 'highpass'; b.cut.Q.value = 0.707;
    b.low = ctx.createBiquadFilter(); b.low.type = 'lowshelf'; b.low.frequency.value = 150;
    b.mid = ctx.createBiquadFilter(); b.mid.type = 'peaking'; b.mid.Q.value = 0.9;
    b.high = ctx.createBiquadFilter(); b.high.type = 'highshelf'; b.high.frequency.value = 7000;
    b.cut.connect(b.low); b.low.connect(b.mid); b.mid.connect(b.high);
    b.shaper = ctx.createWaveShaper(); b.shaper.oversample = '2x';
    b.comp = ctx.createDynamicsCompressor();
    b.comp.knee.value = 6; b.comp.attack.value = 0.003; b.comp.release.value = 0.15;
    b.makeup = ctx.createGain();
    b.level = ctx.createGain();
    b.pol = ctx.createGain();
    b.blend = ctx.createGain();
    b.shaper.connect(b.comp); b.comp.connect(b.makeup);
    b.post = null; routeEQ(b, false);
    b.level.connect(b.pol);
    if (!stereo) { b.pan = ctx.createStereoPanner(); b.pol.connect(b.pan); b.pan.connect(b.blend); }
    else b.pol.connect(b.blend);
    return b;
  }

  // EQ before (PRE) or after (POST) the compressor, like the plug-in
  function routeEQ(b, post) {
    if (b.post === post) return;
    [b.head, b.high, b.makeup].forEach((n) => { try { n.disconnect(); } catch (e) {} });
    if (post) { b.head.connect(b.shaper); b.makeup.connect(b.cut); b.high.connect(b.level); }
    else { b.head.connect(b.cut); b.high.connect(b.shaper); b.makeup.connect(b.level); }
    b.post = post;
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

  function setBusEQ(b, cut, lo, mid, midf, hi) {
    b.cut.frequency.value = cut <= 20.5 ? 10 : cut;   // fully left = off
    b.low.gain.value = lo; b.mid.gain.value = mid; b.mid.frequency.value = midf; b.high.gain.value = hi;
  }
  function setBusComp(b, c, slow) {  // 0..100
    b.comp.release.value = slow ? 0.6 : 0.15;
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
    setBusEQ(r, P.rCut, P.rLow, P.rMid, P.rMidF, P.rHigh); setBusComp(r, P.rComp, P.rSlow); routeEQ(r, P.rPost);
    r.shaper.curve = driveCurve(P.rDrive, P.rAuto);
    r.pol.gain.value = P.rPol ? -1 : 1;
    // mono
    m.level.gain.value = dB(P.mLevel);
    m.pan.pan.value = P.mPan / 100;
    setBusEQ(m, P.mCut, P.mLow, P.mMid, P.mMidF, P.mHigh); setBusComp(m, P.mComp, P.mSlow); routeEQ(m, P.mPost);
    m.shaper.curve = driveCurve(P.mDrive, P.mAuto);
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
        .then((buf) => { buffers[k] = buf; peaks[k] = makePeaks(buf, -1); peaks[k + 'L'] = makePeaks(buf, 0); peaks[k + 'R'] = makePeaks(buf, 1); loadedCount++; status(); return buf; });
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

  function makePeaks(buf, ch) {      // ch -1 = both channels, 0 = left, 1 = right
    const n = 600, last = buf.numberOfChannels - 1;
    const d0 = buf.getChannelData(ch < 0 ? 0 : Math.min(ch, last)), d1 = ch < 0 ? buf.getChannelData(last) : d0;
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
    // ROUND ROBIN: RANDOM (never the same take twice running), CYCLE (1,2,3,4,1...) or OFF
    let robin = 1;
    if (P.rrMode === 'cycle') { robin = (rr % RRS) + 1; rr++; }
    else if (P.rrMode === 'random') { robin = 1 + Math.floor(Math.random() * (RRS - 1)); if (robin >= lastRobin) robin++; }
    lastRobin = robin;
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
    // PUNCH: lift (or soften) the first 40 ms of each mic's hit
    [[env, P.rPunch], [env2, P.mPunch]].forEach(([g, pn]) => {
      if (pn !== 0) { g.gain.setValueAtTime(dB(pn * 0.09), t); g.gain.linearRampToValueAtTime(1, t + 0.04); }
    });
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
    drawWave(peaks[kR], peaks[kM], kR);
  }

  function drawWave(pr, pm, kR) {
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
    const lane = (p, col, top, hh) => {
      if (!p) return;
      g.fillStyle = col;
      const n = p.length, bw = w / n, m2 = top + hh / 2;
      for (let i = 0; i < n; i++) { const a = Math.min(1, Math.pow(p[i], 0.5) * 1.6) * (hh * 0.46); g.fillRect(i * bw, m2 - a, Math.max(1, bw - 0.3), a * 2); }
    };
    if (view === 'ribbons') {
      lane(kR && peaks[kR + 'L'], 'rgba(236,230,220,.85)', 0, h / 2);
      lane(kR && peaks[kR + 'R'], 'rgba(236,230,220,.85)', h / 2, h / 2);
      g.fillStyle = '#2a2a2d'; g.fillRect(0, h / 2, w, 1);
      g.fillStyle = '#8f8a84'; g.font = '10px Oswald, sans-serif'; g.fillText('L', 8, h / 2 - 6); g.fillText('R', 8, h - 6);
    } else if (view === 'mono') {
      draw(pm, 'rgba(240,166,64,.85)', 1.1);
    } else {
      draw(pr, 'rgba(236,230,220,' + (0.25 + 0.6 * Math.cos(x * Math.PI / 2)) + ')', 1.1);
      draw(pm, 'rgba(240,166,64,' + (0.25 + 0.6 * Math.sin(x * Math.PI / 2)) + ')', 1.1);
    }
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
  function eqdb(v) { return (v > 0.05 ? '+' : '') + (Math.abs(v) < 0.05 ? '0.0' : v.toFixed(1)) + ' dB'; }
  function hz(v) { return v >= 1000 ? (v / 1000).toFixed(1) + 'kHz' : Math.round(v) + ' Hz'; }
  const fmt = {
    rLevel: (v) => (v > 0 ? '+' : '') + v.toFixed(1) + ' dB', mLevel: (v) => (v > 0 ? '+' : '') + v.toFixed(1) + ' dB', out: (v) => (v > 0 ? '+' : '') + v.toFixed(1) + ' dB',
    rPunch: (v) => Math.round(v) + ' %', mPunch: (v) => Math.round(v) + ' %',
    rCut: (v) => v <= 20.5 ? 'OFF' : Math.round(v) + ' Hz', mCut: (v) => v <= 20.5 ? 'OFF' : Math.round(v) + ' Hz',
    rLow: eqdb, rMid: eqdb, rHigh: eqdb, mLow: eqdb, mMid: eqdb, mHigh: eqdb,
    rMidF: hz, mMidF: hz,
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
    // knobs: drag up/down (or use the arrow keys), double-click to reset
    document.querySelectorAll('.kn').forEach((k) => {
      const p = k.dataset.k, mn = parseFloat(k.dataset.min), mx = parseFloat(k.dataset.max);
      const log = k.dataset.scale === 'log', def = parseFloat(k.dataset.def);
      const box = k.querySelector('.kv'), dial = k.querySelector('.dial');
      const toN = (v) => log ? Math.log(v / mn) / Math.log(mx / mn) : (v - mn) / (mx - mn);
      const fromN = (n) => log ? mn * Math.pow(mx / mn, n) : mn + n * (mx - mn);
      let n = toN(def);
      const upd = () => { n = Math.max(0, Math.min(1, n)); P[p] = fromN(n); dial.style.setProperty('--a', (n * 270 - 135) + 'deg'); box.textContent = fmt[p](P[p]); dial.setAttribute('aria-valuetext', box.textContent); applyAll(); };
      let y0 = null, n0 = 0;
      dial.addEventListener('pointerdown', (e) => { e.preventDefault(); y0 = e.clientY; n0 = n; dial.setPointerCapture(e.pointerId); });
      dial.addEventListener('pointermove', (e) => { if (y0 === null) return; n = n0 + (y0 - e.clientY) / 160; upd(); });
      dial.addEventListener('pointerup', () => { y0 = null; });
      dial.addEventListener('dblclick', () => { n = toN(def); upd(); });
      dial.addEventListener('keydown', (e) => { if (e.key === 'ArrowUp' || e.key === 'ArrowRight') { n += 0.02; upd(); e.preventDefault(); } if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') { n -= 0.02; upd(); e.preventDefault(); } });
      upd();
    });
    // ROUND ROBIN three-way switch
    document.querySelectorAll('[data-rr]').forEach((b) => {
      const sync = () => document.querySelectorAll('[data-rr]').forEach((x) => x.classList.toggle('on', x.dataset.rr === P.rrMode));
      b.addEventListener('click', () => { P.rrMode = b.dataset.rr; sync(); });
      sync();
    });
    // PRE / POST pairs
    document.querySelectorAll('[data-pp]').forEach((b) => {
      const p = b.dataset.pp, post = b.dataset.pos === 'post';
      const sync = () => document.querySelectorAll('[data-pp="' + p + '"]').forEach((x) => x.classList.toggle('on', (x.dataset.pos === 'post') === P[p]));
      b.addEventListener('click', () => { P[p] = post; sync(); applyAll(); });
      sync();
    });
    // wave view: BOTH / RIBBONS / MONO
    document.querySelectorAll('[data-view]').forEach((b) => b.addEventListener('click', () => {
      view = b.dataset.view;
      document.querySelectorAll('[data-view]').forEach((x) => x.classList.toggle('on', x === b));
      redrawLast();
    }));
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
  function redrawLast() { if (lastK) drawWave(peaks[lastK[0]], peaks[lastK[1]], lastK[0]); }
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
