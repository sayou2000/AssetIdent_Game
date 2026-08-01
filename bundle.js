/* ============================================================================
   AssetTrace: The Handover Quest — v2.0
   80s retro platformer that gamifies the FM "Handover Gap".

   v2.0 changes (P0 + P1):
     P0-a  Countdown timer ("Übergabe in ...") — time is the only currency.
           Every hazard costs seconds, every perfect scan buys seconds back.
           Timeout ends the run with a HANDOVER REPORT listing the missing data.
     P0-b  Gates became skills:
             focus       — distance-tracking OCR minigame (drifting sweet spot)
             darkness    — flashlight with a draining battery + battery pickups
             obstructed  — real line-of-sight raycast against pipes/ducts
             steam       — timing window + contact damage
             defect      — sweeping crosshair, lock onto the anomaly
     P0-c  Manual-mode prologue: type a nameplate serial by hand, get measured,
           then the scanner unlocks. The player *feels* the handover gap.
     P1    Diegetic status line + badges, per-category grades and a D..S rank,
           BAD DATA tracking, 3 levels + boss ("Der Übergabetermin"),
           mission briefings, and 5 knowledge tasks (DIN 276, Zähler,
           Prüffrist, VDI/VDMA-Intervall, Kältemittel/GWP).

   Sections
     1. Config & palette          11. Focus minigame
     2. Utils                     12. Defect minigame
     3. Tracking                  13. Capture + knowledge tasks
     4. Audio                     14. Boss round
     5. Input                     15. Scoring / rank / report
     6. Content (question bank)   16. Rendering
     7. Levels                    17. HUD
     8. Game state                18. DOM overlays
     9. Physics                   19. Game loop
    10. Targeting + line of sight 20. Boot
============================================================================ */
(function () {
  "use strict";

  /* ---------------------------------------------------------------------------
     1. CONFIG & PALETTE
  --------------------------------------------------------------------------- */
  const CFG = {
    W: 480, H: 270,
    GROUND_Y: 246,

    // physics
    GRAVITY: 0.42, MOVE_SPEED: 2.1, FRICTION: 0.78, JUMP_V: -8.2, MAX_FALL: 9,
    COYOTE: 6, JUMP_BUFFER: 6,

    // scanning
    SCAN_RANGE: 62,
    FOCUS_TOL: 8,             // px tolerance around the drifting sweet spot
    FOCUS_FILL: 1.45,         // focus gained per frame inside the band
    FOCUS_DRAIN: 1.0,         // focus lost per frame outside the band
    FOCUS_SHAKE_MULT: 0.45,   // fill multiplier while moving fast ("verwackelt")
    DEFECT_SWEEP: 0.028,      // crosshair sweep speed
    DEFECT_COOLDOWN: 26,

    // scoring
    BASE_POINTS: 300,
    FOCUS_BONUS: 200,
    TASK_BONUS: 250,
    DEFECT_BONUS: 150,
    COMBO_MAX: 5,             // multiplier caps at 1 + 5*0.2 = 2.0x

    // time economy (seconds)
    PENALTY_WRONG: 6,
    PENALTY_STEAM: 4,
    PENALTY_PIT: 3,
    PENALTY_MISS: 2,
    BONUS_PERFECT: 3,

    // flashlight — budget is tuned so one full charge (~31 s) is not enough for a
    // whole level: the lamp must be switched off between dark zones.
    BATTERY_MAX: 100,
    BATTERY_DRAIN: 3.2,       // % per second while the lamp is on
    BATTERY_PICKUP: 50,
    LIGHT_RANGE: 62,

    // knowledge tasks (seconds to answer)
    TASK_TIME: { classify: 8, meter: 9, sticker: 6, gwp: 9, interval: 8 },
    EXPLAIN_TIME: 2.2,

    // boss
    BOSS_RECORDS: 8, BOSS_T_START: 5.4, BOSS_T_END: 2.6,

    // Marketing math. The prologue measures typing ONE field (the serial). A CAFM
    // record needs roughly this many fields, so the manual side is scaled by it and
    // the assumption is printed in the report instead of being hidden in the ratio.
    BUILDING_ASSETS: 400,
    FIELDS_PER_RECORD: 8,

    VERSION: "2.0.0",
    HS_KEY: "at_handover_hs_v2",
  };

  const PAL = {
    bg0: "#0B192C", bg1: "#13294b", bg2: "#1E3A8A",
    pipe: "#2b3a55", pipeHi: "#4c6b9c", pipeLo: "#15212f",
    metal: "#3a4a66", metalHi: "#6b82a8", metalLo: "#1c2638",
    rust: "#7a3b12",
    orange: "#FF6B00", orangeD: "#C24E00", orangeL: "#FFA45E",
    cyan: "#22D3EE", cyanD: "#0e7490",
    magenta: "#D946A6",
    green: "#34D399", red: "#EF4444", yellow: "#FACC15",
    white: "#E2E8F0", dim: "#64748B",
    floor: "#243049", floorTop: "#3b4a6b",
    skin: "#E8B27A", vest: "#0e7490", vestHi: "#22D3EE",
    dark: "rgba(2,4,10,0.90)",
  };

  /* ---------------------------------------------------------------------------
     2. UTILS
  --------------------------------------------------------------------------- */
  const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
  const lerp = (a, b, t) => a + (b - a) * t;
  const aabb = (a, b) =>
    a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
  const dist = (ax, ay, bx, by) => Math.hypot(ax - bx, ay - by);
  const rand = (a, b) => a + Math.random() * (b - a);
  const choice = arr => arr[(Math.random() * arr.length) | 0];
  const fmtTime = s => {
    s = Math.max(0, s);
    const m = Math.floor(s / 60), r = Math.floor(s % 60);
    return m + ":" + (r < 10 ? "0" : "") + r;
  };
  const pad = (n, l) => (n + "").padStart(l, "0");
  const esc = s => String(s).replace(/[&<>"]/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

  // Liang–Barsky: does the segment (x1,y1)->(x2,y2) intersect rect r?
  function segRect(x1, y1, x2, y2, r) {
    let t0 = 0, t1 = 1;
    const dx = x2 - x1, dy = y2 - y1;
    const p = [-dx, dx, -dy, dy];
    const q = [x1 - r.x, r.x + r.w - x1, y1 - r.y, r.y + r.h - y1];
    for (let i = 0; i < 4; i++) {
      if (p[i] === 0) { if (q[i] < 0) return false; continue; }
      const t = q[i] / p[i];
      if (p[i] < 0) { if (t > t1) return false; if (t > t0) t0 = t; }
      else { if (t < t0) return false; if (t < t1) t1 = t; }
    }
    return true;
  }

  /* ---------------------------------------------------------------------------
     3. TRACKING (utm + optional analytics endpoint)
  --------------------------------------------------------------------------- */
  const Tracking = (function () {
    const params = new URLSearchParams(location.search);
    const utm = {};
    ["source", "medium", "campaign", "content", "term"].forEach(k => {
      const v = params.get("utm_" + k);
      if (v) utm[k] = v;
    });
    const apiBase = params.get("api") || (window.ASSETTRACE_API || "");
    const debug = params.get("debug") === "1";
    const sessionId = "at-" + Math.random().toString(36).slice(2, 10);

    function send(event, payload) {
      const body = JSON.stringify(Object.assign({
        event, session: sessionId, ts: Date.now(), utm, ver: CFG.VERSION,
        href: location.href,
      }, payload || {}));
      if (apiBase && navigator.sendBeacon) {
        try { navigator.sendBeacon(apiBase, body); } catch (e) { /* ignore */ }
      } else if (apiBase) {
        try {
          fetch(apiBase, {
            method: "POST", body, headers: { "Content-Type": "application/json" },
            keepalive: true, mode: "no-cors",
          }).catch(() => {});
        } catch (e) { /* ignore */ }
      }
      window.assetTraceEvents = window.assetTraceEvents || [];
      window.assetTraceEvents.push({ event, payload });
      if (debug) console.log("[AssetTrace]", event, payload);
      const cb = window._atCb && window._atCb[event];
      if (cb) { try { cb(payload); } catch (e) { /* ignore */ } }
    }
    return { utm, apiBase, debug, sessionId, send, params };
  })();

  /* ---------------------------------------------------------------------------
     4. AUDIO — chiptune SFX + looping synthwave bgm (pure Web Audio synth)
  --------------------------------------------------------------------------- */
  const Audio = (function () {
    let ctx = null, master = null, musicGain = null, sfxGain = null;
    let started = false, muted = false, musicTimer = null, step = 0;

    function init() {
      if (ctx) return;
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      ctx = new AC();
      master = ctx.createGain(); master.gain.value = 0.9; master.connect(ctx.destination);
      musicGain = ctx.createGain(); musicGain.gain.value = 0.28; musicGain.connect(master);
      sfxGain = ctx.createGain(); sfxGain.gain.value = 0.55; sfxGain.connect(master);
    }
    function resume() { if (ctx && ctx.state === "suspended") ctx.resume(); }
    const now = () => ctx ? ctx.currentTime : 0;

    function tone(freq, dur, type, when, vol, glideTo) {
      if (!ctx || muted) return;
      const t0 = when || ctx.currentTime;
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = type || "square";
      o.frequency.setValueAtTime(freq, t0);
      if (glideTo) o.frequency.exponentialRampToValueAtTime(glideTo, t0 + dur);
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(vol || 0.3, t0 + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      o.connect(g); g.connect(sfxGain);
      o.start(t0); o.stop(t0 + dur + 0.02);
    }
    function noise(dur, vol, filterFreq, when) {
      if (!ctx || muted) return;
      const t0 = when || ctx.currentTime;
      const len = Math.max(1, Math.floor(ctx.sampleRate * dur));
      const buf = ctx.createBuffer(1, len, ctx.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
      const src = ctx.createBufferSource(); src.buffer = buf;
      const f = ctx.createBiquadFilter(); f.type = "bandpass"; f.frequency.value = filterFreq || 1200;
      const g = ctx.createGain(); g.gain.value = vol || 0.25;
      src.connect(f); f.connect(g); g.connect(sfxGain);
      src.start(t0);
    }

    const SFX = {
      jump()    { tone(420, 0.16, "square", null, 0.26, 760); },
      land()    { tone(160, 0.07, "triangle", null, 0.20, 90); },
      step()    { tone(120, 0.04, "square", null, 0.09); },
      shutter() { tone(1200, 0.04, "square"); noise(0.12, 0.18, 2400); tone(700, 0.09, "square", now() + 0.04, 0.18, 1500); },
      pickbeep(){ tone(1046, 0.05, "square"); },
      focus(v)  { tone(500 + v * 900, 0.045, "square", null, 0.13); },   // rising pitch = sharper focus
      locked()  { tone(1568, 0.06, "square"); tone(2093, 0.08, "square", now() + 0.05, 0.2); },
      success() { [523, 659, 784, 1046].forEach((f, i) => tone(f, 0.12, "square", now() + i * 0.08, 0.26)); },
      error()   { tone(180, 0.22, "sawtooth", null, 0.28, 90); noise(0.1, 0.12, 400); },
      blocked() { tone(220, 0.10, "square", null, 0.20, 150); },
      steam()   { noise(0.35, 0.20, 900); },
      type()    { tone(1400, 0.02, "square", null, 0.16); },
      typo()    { tone(240, 0.10, "sawtooth", null, 0.22, 160); },
      classify(){ tone(660, 0.05, "square"); tone(990, 0.06, "square", now() + 0.05, 0.18); },
      correct() { [784, 1046, 1318].forEach((f, i) => tone(f, 0.10, "square", now() + i * 0.07, 0.24)); },
      wrong()   { tone(300, 0.20, "sawtooth", null, 0.28, 140); noise(0.14, 0.10, 500); },
      tick()    { tone(1760, 0.03, "square", null, 0.14); },
      lowtime() { tone(330, 0.09, "square", null, 0.22); },
      battery() { [523, 784, 1046].forEach((f, i) => tone(f, 0.07, "square", now() + i * 0.05, 0.22)); },
      lamp()    { tone(880, 0.04, "triangle", null, 0.16); },
      levelup() { [523, 659, 784, 1046, 1318].forEach((f, i) => tone(f, 0.14, "square", now() + i * 0.10, 0.28)); },
      win()     { [523, 659, 784, 1046, 1318, 1568].forEach((f, i) => tone(f, 0.18, "square", now() + i * 0.13, 0.30)); },
      fail()    { [392, 330, 262, 196].forEach((f, i) => tone(f, 0.24, "sawtooth", now() + i * 0.18, 0.26)); },
      combo(n)  { tone(660 + n * 110, 0.07, "square", null, 0.22); },
    };

    // --- looping synthwave: Am - F - C - G ---
    const BASS = [
      45,0,45,0, 53,0,45,0,  41,0,41,0, 53,0,41,0,
      41,0,41,0, 53,0,41,0,  48,0,48,0, 55,0,48,0,
      48,0,48,0, 55,0,48,0,  43,0,43,0, 55,0,43,0,
      43,0,43,0, 55,0,43,0,  47,0,47,0, 55,0,47,0,
    ];
    const ARP = [
      69,72,76,72, 65,69,72,69, 72,76,79,76, 67,71,74,71,
      65,69,72,69, 60,65,69,65, 72,76,79,76, 72,74,76,74,
      72,76,79,76, 69,72,76,72, 79,84,88,84, 71,74,77,74,
      67,71,74,71, 62,67,71,67, 74,79,83,79, 74,76,79,76,
    ];
    const midi = n => 440 * Math.pow(2, (n - 69) / 12);

    function mtone(freq, dur, type, vol) {
      if (!ctx || muted) return;
      const t0 = ctx.currentTime;
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = type || "square";
      o.frequency.setValueAtTime(freq, t0);
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(vol || 0.2, t0 + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      o.connect(g); g.connect(musicGain);
      o.start(t0); o.stop(t0 + dur + 0.02);
    }
    function mNoise(dur, vol) {
      if (!ctx || muted) return;
      const len = Math.max(1, Math.floor(ctx.sampleRate * dur));
      const buf = ctx.createBuffer(1, len, ctx.sampleRate), d = buf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
      const s = ctx.createBufferSource(); s.buffer = buf;
      const f = ctx.createBiquadFilter(); f.type = "highpass"; f.frequency.value = 5200;
      const g = ctx.createGain(); g.gain.value = vol;
      s.connect(f); f.connect(g); g.connect(musicGain); s.start();
    }
    function musicStep() {
      if (!ctx || muted) return;
      const b = BASS[step % BASS.length], a = ARP[step % ARP.length];
      if (b) mtone(midi(b), 0.20, "triangle", 0.30);
      if (a) mtone(midi(a), 0.10, "square", 0.085);
      if (step % 2 === 0) mNoise(0.025, 0.05);
      step++;
    }
    function startMusic() {
      if (!ctx || musicTimer) return;
      step = 0;
      musicTimer = setInterval(musicStep, 134);   // 16ths @ ~112 BPM
    }
    function start() {
      init(); resume();
      if (!started) { started = true; startMusic(); }
    }
    function setIntensity(hot) {
      // subtle tension shift: the music gets louder as the deadline closes in
      if (musicGain) musicGain.gain.value = hot ? 0.36 : 0.28;
    }
    function toggleMute() {
      muted = !muted;
      if (master) master.gain.value = muted ? 0 : 0.9;
      return muted;
    }
    return { start, resume, SFX, toggleMute, setIntensity, isMuted: () => muted };
  })();

  /* ---------------------------------------------------------------------------
     5. INPUT
  --------------------------------------------------------------------------- */
  const Input = (function () {
    const pressed = {}, held = {};
    let touchDevice = false;
    let digitCb = null;               // prologue: raw digit stream

    const map = {
      ArrowLeft: "left", KeyA: "left",
      ArrowRight: "right", KeyD: "right",
      ArrowUp: "jump", KeyW: "jump", ArrowDown: "down", KeyS: "down",
      Space: "scan", KeyZ: "scan", KeyJ: "scan", Enter: "scan",
      KeyF: "lamp", ShiftLeft: "lamp", ShiftRight: "lamp",
      KeyP: "pause", Escape: "pause",
      Digit1: "cA", Numpad1: "cA",
      Digit2: "cB", Numpad2: "cB",
      Digit3: "cC", Numpad3: "cC",
      Digit4: "cD", Numpad4: "cD",
    };

    function down(k) { if (!held[k]) pressed[k] = true; held[k] = true; }

    window.addEventListener("keydown", e => {
      if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Space"].includes(e.code)) e.preventDefault();
      if (digitCb && /^[0-9]$/.test(e.key)) { digitCb(e.key); return; }
      const k = map[e.code];
      if (k) down(k);
      if (e.code === "KeyM") { const m = Audio.toggleMute(); setStatus(m ? "MUTED" : "AUDIO ON"); }
    });
    window.addEventListener("keyup", e => { const k = map[e.code]; if (k) held[k] = false; });
    window.addEventListener("blur", () => { for (const k in held) held[k] = false; });

    function bindTouch() {
      document.querySelectorAll(".at-tbtn").forEach(btn => {
        const k = btn.getAttribute("data-key");
        const on = e => { e.preventDefault(); touchDevice = true; down(k); };
        const off = e => { e.preventDefault(); held[k] = false; };
        btn.addEventListener("touchstart", on, { passive: false });
        btn.addEventListener("touchend", off, { passive: false });
        btn.addEventListener("touchcancel", off, { passive: false });
        btn.addEventListener("mousedown", on);
        btn.addEventListener("mouseup", off);
        btn.addEventListener("mouseleave", off);
      });
    }
    const isTouch = () => touchDevice || ("ontouchstart" in window) || (navigator.maxTouchPoints > 0);
    function clearEdges() { for (const k in pressed) pressed[k] = false; }
    function anyPressed() {
      for (const k in pressed) if (pressed[k]) return true;
      return false;
    }
    return {
      held: k => !!held[k],
      pressed: k => !!pressed[k],
      clearEdges, bindTouch, isTouch, anyPressed,
      onDigit: cb => { digitCb = cb; },
    };
  })();

  /* ---------------------------------------------------------------------------
     6. CONTENT — the knowledge layer.
        Every question carries a `why` line: that is the educational payload and
        the reason the game works as marketing. Norm references are real.
  --------------------------------------------------------------------------- */
  const Q = {
    // --- DIN 276 cost groups ---
    kgHeat: {
      ask: "Kostengruppe nach DIN 276?",
      opts: ["KG 410 Abwasser/Wasser/Gas", "KG 420 Wärmeversorgung", "KG 430 Raumlufttechnik", "KG 440 Elektrische Anlagen"],
      correct: 1,
      why: "Wärmeerzeuger und Heizungsverteilung = KG 420 Wärmeversorgungsanlagen.",
    },
    kgElec: {
      ask: "Kostengruppe nach DIN 276?",
      opts: ["KG 430 Raumlufttechnik", "KG 440 Elektrische Anlagen", "KG 450 Kommunikationstechnik", "KG 480 Automation"],
      correct: 1,
      why: "Niederspannungsverteilung und Trafos = KG 440 Elektrische Anlagen.",
    },
    kgAuto: {
      ask: "Kostengruppe nach DIN 276?",
      opts: ["KG 440 Elektrische Anlagen", "KG 450 Kommunikationstechnik", "KG 480 Gebäudeautomation", "KG 470 Nutzungsspezifisch"],
      correct: 2,
      why: "GLT/DDC-Automationsstationen = KG 480 Gebäude- und Anlagenautomation — nicht 440.",
    },
    kgWater: {
      ask: "Kostengruppe nach DIN 276?",
      opts: ["KG 410 Abwasser/Wasser/Gas", "KG 420 Wärmeversorgung", "KG 430 Raumlufttechnik", "KG 460 Förderanlagen"],
      correct: 0,
      why: "Trinkwasser-Druckerhöhung = KG 410. Nur Heizungspumpen gehören zu KG 420.",
    },
    kgAir: {
      ask: "Kostengruppe nach DIN 276?",
      opts: ["KG 420 Wärmeversorgung", "KG 430 Raumlufttechnik", "KG 440 Elektrische Anlagen", "KG 480 Automation"],
      correct: 1,
      why: "RLT-Zentralgeräte = KG 430 Raumlufttechnische Anlagen.",
    },

    // --- inspection / maintenance intervals ---
    intEmergency: {
      ask: "Funktionsprüfung der Sicherheitsbeleuchtung?",
      opts: ["monatlich", "halbjährlich", "jährlich", "alle 3 Jahre"],
      correct: 0,
      why: "DIN EN 50172: monatliche Funktionsprüfung, jährlich zusätzlich die Bemessungsbetriebsdauer.",
    },
    intVdi6022: {
      ask: "RLT-Anlage MIT Befeuchter — Hygieneinspektion nach VDI 6022?",
      opts: ["jährlich", "alle 2 Jahre", "alle 3 Jahre", "alle 5 Jahre"],
      correct: 1,
      why: "VDI 6022-1: alle 2 Jahre mit Befeuchtung, alle 3 Jahre ohne.",
    },
    intLift: {
      ask: "Aufzug — wiederkehrende Hauptprüfung durch ZÜS?",
      opts: ["jährlich", "alle 2 Jahre", "alle 4 Jahre", "alle 6 Jahre"],
      correct: 1,
      why: "BetrSichV: Hauptprüfung alle 2 Jahre, dazwischen eine Zwischenprüfung.",
    },
    intLegionella: {
      ask: "Legionellenprüfung Großanlage (gewerbliche Vermietung)?",
      opts: ["jährlich", "alle 3 Jahre", "alle 5 Jahre", "monatlich"],
      correct: 0,
      why: "TrinkwV: jährlich bei gewerblicher Abgabe, alle 3 Jahre im nicht-gewerblichen Fall.",
    },

    // --- refrigerants / ESG ---
    gwp410a: {
      ask: "Kältemittel R-410A, Füllmenge 3,2 kg — GWP?",
      opts: ["4", "675", "1430", "2088"],
      correct: 3,
      why: "R-410A: GWP 2088 → 3,2 kg ≈ 6,7 t CO₂e, berichtspflichtig in Scope 1.",
      co2e: 6.7,
    },
    gwp404a: {
      ask: "Kältemittel R-404A, Füllmenge 2,5 kg — GWP?",
      opts: ["675", "1774", "2088", "3922"],
      correct: 3,
      why: "R-404A: GWP 3922 → 2,5 kg ≈ 9,8 t CO₂e. Seit 2020 im Service verboten.",
      co2e: 9.8,
    },
    gwp32: {
      ask: "Kältemittel R-32, Füllmenge 4,0 kg — GWP?",
      opts: ["4", "675", "1430", "2088"],
      correct: 1,
      why: "R-32: GWP 675 → 4,0 kg ≈ 2,7 t CO₂e. Rund 1/3 von R-410A.",
      co2e: 2.7,
    },
  };

  // Meter readings: the distractors are digit transpositions — the real-world error.
  const Q_METER = [
    { ask: "Zählerstand korrekt übernehmen:", meter: "024851", unit: "kWh",
      opts: ["024 851", "024 815", "024 581", "024 8511"], correct: 0,
      why: "Zahlendreher sind der häufigste Ablesefehler — und im Verbrauchsreport nicht mehr auffindbar." },
    { ask: "Zählerstand korrekt übernehmen:", meter: "108406", unit: "m³",
      opts: ["108 460", "108 406", "180 406", "108 006"], correct: 1,
      why: "Die letzte rote Rolle ist die Nachkommastelle — sie gehört nicht in den Hauptzählerstand." },
    { ask: "Zählerstand korrekt übernehmen:", meter: "917230", unit: "kWh",
      opts: ["917 320", "971 230", "917 230", "917 203"], correct: 2,
      why: "Zeitstempel + Zählernummer + Stand: erst alle drei zusammen ergeben eine auditfähige Ablesung." },
  ];

  // Inspection stickers: current in-game date is fixed so the math is checkable.
  const TODAY = { m: 7, y: 2026, label: "07/2026" };
  const Q_STICKER = [
    { ask: "Prüfplakette gelesen: nächste Prüfung 03/2026.", plate: "03/2026",
      opts: ["GÜLTIG", "ABGELAUFEN"], correct: 1,
      why: "4 Monate über der Frist — Betreiberpflicht verletzt (BetrSichV §14). Genau das findet kein Excel." },
    { ask: "Prüfplakette gelesen: nächste Prüfung 11/2026.", plate: "11/2026",
      opts: ["GÜLTIG", "ABGELAUFEN"], correct: 0,
      why: "Noch 4 Monate Restlaufzeit → als Termin ins CAFM, Warnung 8 Wochen vorher." },
    { ask: "Prüfplakette gelesen: nächste Prüfung 07/2026.", plate: "07/2026",
      opts: ["GÜLTIG", "ABGELAUFEN"], correct: 0,
      why: "Läuft in diesem Monat ab: formal noch gültig, aber sofort terminieren." },
  ];

  /* ---------------------------------------------------------------------------
     7. LEVELS
        challenge : how you get a clean scan   (plain|focus|obstructed|steam|defect)
        task      : what the data means        (null|classify|meter|sticker|gwp|interval)
        Darkness is positional (dark zones), so it combines freely with any challenge.
  --------------------------------------------------------------------------- */
  const G = CFG.GROUND_Y;

  const LEVELS = [
    /* ---------------- 01 BAUPHASE — bright, teaches the basics -------------- */
    {
      name: "01 BAUPHASE",
      brief: [
        "Rohbau, kurz vor Abnahme. Die Anlagen stehen, die Daten nicht.",
        "Erfasse alle Anlagen, bevor die Bauleitung abzieht.",
      ],
      time: 105, w: 2100, hasFlash: false, theme: "site",
      plats: [
        { x: 0, y: G, w: 560, h: 24 }, { x: 620, y: G, w: 420, h: 24 },
        { x: 1100, y: G, w: 480, h: 24 }, { x: 1620, y: G, w: 480, h: 24 },
        { x: 560, y: G - 40, w: 60, h: 40 }, { x: 1040, y: G - 40, w: 60, h: 40 },
        { x: 1580, y: G - 44, w: 40, h: 44 },
        // Ladders overlap horizontally by ~30 px so the climb is comfortable rather
        // than pixel-perfect (max jump height is 80 px, ~55 px of it usable sideways).
        { x: 240, y: 190, w: 90, h: 8, oneway: true }, { x: 300, y: 146, w: 100, h: 8, oneway: true },
        { x: 700, y: 192, w: 110, h: 8, oneway: true }, { x: 770, y: 148, w: 100, h: 8, oneway: true },
        { x: 1180, y: 188, w: 100, h: 8, oneway: true }, { x: 1250, y: 144, w: 100, h: 8, oneway: true },
        { x: 1700, y: 190, w: 100, h: 8, oneway: true }, { x: 1770, y: 148, w: 110, h: 8, oneway: true },
      ],
      darkzones: [], blockers: [], vents: [], pickups: [],
      assets: [
        { type: "boiler", x: 140, y: G - 30, w: 30, h: 30, label: "BR-01 GASKESSEL",
          challenge: "plain", task: "classify", q: Q.kgHeat,
          data: { HERSTELLER: "VIESSMANN", TYP: "VITOCROSSAL 300", LEISTUNG: "120 kW", BAUJAHR: "2019" } },
        { type: "pump", x: 470, y: G - 30, w: 30, h: 30, label: "PU-02 UMWÄLZPUMPE",
          challenge: "focus", task: null,
          data: { HERSTELLER: "WILO", TYP: "STRATOS 40/1-8", LEISTUNG: "0,55 kW", BAUJAHR: "2018" } },
        { type: "meterbox", x: 770, y: G - 36, w: 26, h: 36, label: "ZL-03 STROMZÄHLER",
          challenge: "plain", task: "meter",
          data: { ZÄHLER_NR: "1ESY1161234567", TARIF: "HT/NT", MESSART: "Wirkarbeit" } },
        { type: "cabinet", x: 1210, y: 158, w: 28, h: 30, label: "EV-04 UNTERVERTEILUNG",
          challenge: "focus", task: "classify", q: Q.kgElec,
          data: { HERSTELLER: "HAGER", TYP: "UNIVERS N", NENNSTROM: "250 A", BAUJAHR: "2019" } },
        { type: "valve", x: 1760, y: G - 30, w: 30, h: 30, label: "AV-05 ABSPERRARMATUR",
          challenge: "plain", task: "sticker", q: Q_STICKER[0],
          data: { HERSTELLER: "GESTRA", DN: "DN 80", PN: "PN 16", PRÜFUNG: "Plakette erkannt" } },
      ],
    },

    /* ------------- 02 TECHNIKZENTRALE — dark, battery, pipes, steam -------- */
    {
      name: "02 TECHNIKZENTRALE",
      brief: [
        "Keller. Notbeleuchtung. Der Bauleiter hat die Lampe dagelassen.",
        "AKKU IST ENDLICH — Licht kostet Laufzeit. Batterien liegen im Gang.",
      ],
      time: 120, w: 2500, hasFlash: true, theme: "plant",
      plats: [
        { x: 0, y: G, w: 640, h: 24 }, { x: 700, y: G, w: 560, h: 24 },
        { x: 1320, y: G, w: 480, h: 24 }, { x: 1860, y: G, w: 640, h: 24 },
        { x: 640, y: G - 40, w: 60, h: 40 }, { x: 1260, y: G - 40, w: 60, h: 40 },
        { x: 1800, y: G - 44, w: 60, h: 44 },
        { x: 200, y: 196, w: 90, h: 8, oneway: true }, { x: 260, y: 150, w: 100, h: 8, oneway: true },
        { x: 760, y: 190, w: 110, h: 8, oneway: true }, { x: 840, y: 146, w: 110, h: 8, oneway: true },
        { x: 1080, y: 190, w: 100, h: 8, oneway: true },
        // ladder up to the riser: ground -> 192 -> 140, then hop over the pipe
        { x: 1380, y: 192, w: 100, h: 8, oneway: true }, { x: 1450, y: 140, w: 120, h: 8, oneway: true },
        { x: 1900, y: 190, w: 110, h: 8, oneway: true }, { x: 1960, y: 146, w: 110, h: 8, oneway: true },
        { x: 2200, y: 196, w: 110, h: 8, oneway: true },
      ],
      darkzones: [{ x: 720, w: 380 }, { x: 1880, w: 400 }],
      // Solid steel riser: blocks the player AND the scan line. Get around it.
      blockers: [{ x: 1576, y: 150, w: 12, h: 96, solid: true }],
      vents: [{ x: 1700, y: 176, period: 150, duration: 60 }],
      pickups: [
        { id: "batt1", type: "battery", x: 1120, y: 166, w: 14, h: 14 },
        { id: "batt2", type: "battery", x: 2050, y: 128, w: 14, h: 14 },
      ],
      assets: [
        { type: "cabinet", x: 800, y: G - 30, w: 28, h: 30, label: "EV-06 HAUPTVERTEILUNG",
          challenge: "plain", task: "classify", q: Q.kgElec,
          data: { HERSTELLER: "SIEMENS", TYP: "SIVACON S4", NENNSTROM: "630 A", BAUJAHR: "2017" } },
        { type: "chiller", x: 880, y: 114, w: 34, h: 32, label: "KM-07 KALTWASSERSATZ",
          challenge: "focus", task: "gwp", q: Q.gwp410a,
          data: { HERSTELLER: "DAIKIN", TYP: "EWAD170", KÄLTEMITTEL: "R-410A", FÜLLMENGE: "3,2 kg" } },
        { type: "ahu", x: 1606, y: G - 30, w: 30, h: 30, label: "RL-08 RLT-ZENTRALGERÄT",
          challenge: "obstructed", task: "interval", q: Q.intVdi6022,
          data: { HERSTELLER: "TROX", TYP: "X-CUBE X2", VOLUMENSTROM: "8.500 m³/h", BEFEUCHTER: "ja" } },
        { type: "valve", x: 1728, y: G - 30, w: 30, h: 30, label: "DV-09 DAMPFVENTIL",
          challenge: "steam", task: "sticker", q: Q_STICKER[1],
          data: { HERSTELLER: "SPIRAX", DN: "DN 50", PN: "PN 25", PRÜFUNG: "Plakette erkannt" } },
        { type: "pump", x: 1940, y: G - 30, w: 30, h: 30, label: "PU-10 DRUCKERHÖHUNG",
          challenge: "defect", task: "classify", q: Q.kgWater,
          data: { HERSTELLER: "GRUNDFOS", TYP: "HYDRO MPC", LEISTUNG: "4,0 kW", ZUSTAND: "Auffälligkeit erkannt" } },
        { type: "cabinet", x: 2230, y: 166, w: 28, h: 30, label: "GA-11 AUTOMATIONSSTATION",
          challenge: "focus", task: "classify", q: Q.kgAuto,
          data: { HERSTELLER: "SAUTER", TYP: "modulo 6", BUS: "BACnet/IP", BAUJAHR: "2019" } },
      ],
    },

    /* ------------------ 03 ÜBERGABETAG — everything at once ---------------- */
    {
      name: "03 ÜBERGABETAG",
      brief: [
        "Heute wird übergeben. 11:00 Uhr Abnahmetermin, danach ist der Keller zu.",
        "Alles gleichzeitig: dunkel, verbaut, unter Dampf. Und ein Loch im Boden.",
      ],
      time: 115, w: 2620, hasFlash: true, theme: "handover",
      plats: [
        { x: 0, y: G, w: 520, h: 24 }, { x: 600, y: G, w: 380, h: 24 },
        { x: 1060, y: G, w: 300, h: 24 }, { x: 1420, y: G, w: 480, h: 24 },
        { x: 1980, y: G, w: 640, h: 24 },
        { x: 520, y: G - 40, w: 80, h: 40 }, { x: 980, y: G - 48, w: 80, h: 48 },
        { x: 1360, y: G - 44, w: 60, h: 44 },
        // 1900..1980 stays open: a real pit. Crossing costs a precise jump.
        { x: 180, y: 192, w: 100, h: 8, oneway: true }, { x: 250, y: 146, w: 100, h: 8, oneway: true },
        { x: 660, y: 190, w: 110, h: 8, oneway: true }, { x: 740, y: 146, w: 110, h: 8, oneway: true },
        { x: 1100, y: 192, w: 110, h: 8, oneway: true }, { x: 1180, y: 146, w: 110, h: 8, oneway: true },
        { x: 1470, y: 190, w: 110, h: 8, oneway: true }, { x: 1550, y: 146, w: 110, h: 8, oneway: true },
        { x: 1780, y: 192, w: 100, h: 8, oneway: true }, { x: 1908, y: 200, w: 64, h: 8, oneway: true },
        { x: 2050, y: 190, w: 100, h: 8, oneway: true },
        { x: 2150, y: 192, w: 100, h: 8, oneway: true }, { x: 2200, y: 140, w: 92, h: 8, oneway: true },
      ],
      darkzones: [{ x: 1070, w: 300 }, { x: 2030, w: 440 }],
      blockers: [{ x: 2296, y: 150, w: 12, h: 96, solid: true }],
      vents: [
        { x: 700, y: 176, period: 130, duration: 55 },
        { x: 1524, y: 176, period: 112, duration: 48 },
      ],
      pickups: [
        { id: "batt3", type: "battery", x: 1150, y: 174, w: 14, h: 14 },
        { id: "batt4", type: "battery", x: 2090, y: 172, w: 14, h: 14 },
      ],
      assets: [
        { type: "valve", x: 730, y: G - 30, w: 30, h: 30, label: "SV-12 SICHERHEITSVENTIL",
          challenge: "steam", task: "interval", q: Q.intEmergency,
          data: { HERSTELLER: "ARI", DN: "DN 40", PN: "PN 16", NOTLICHT: "Kreis 3 betroffen" } },
        { type: "ahu", x: 790, y: 116, w: 30, h: 30, label: "RL-13 ZULUFTGERÄT",
          challenge: "focus", task: "gwp", q: Q.gwp32,
          data: { HERSTELLER: "SWEGON", TYP: "GOLD RX", KÄLTEMITTEL: "R-32", FÜLLMENGE: "4,0 kg" } },
        { type: "pump", x: 1130, y: G - 30, w: 30, h: 30, label: "PU-14 TRINKWASSERPUMPE",
          challenge: "defect", task: "classify", q: Q.kgWater,
          data: { HERSTELLER: "KSB", TYP: "MOVITEC", LEISTUNG: "2,2 kW", ZUSTAND: "Auffälligkeit erkannt" } },
        { type: "transformer", x: 1220, y: 114, w: 32, h: 32, label: "TR-15 TRAFO 630 KVA",
          challenge: "focus", task: "classify", q: Q.kgElec,
          data: { HERSTELLER: "SGB", TYP: "GEAFOL", LEISTUNG: "630 kVA", BAUJAHR: "2016" } },
        { type: "meterbox", x: 1566, y: G - 36, w: 26, h: 36, label: "ZL-16 WÄRMEZÄHLER",
          challenge: "steam", task: "meter", q: Q_METER[1],
          data: { ZÄHLER_NR: "68127744", MEDIUM: "Heizwasser", MESSART: "Wärmemenge" } },
        { type: "cabinet", x: 2326, y: G - 30, w: 28, h: 30, label: "GA-17 UNTERSTATION GLT",
          challenge: "obstructed", task: "sticker", q: Q_STICKER[2],
          data: { HERSTELLER: "KIEBACK&PETER", TYP: "DDC4200", BUS: "BACnet MS/TP", PRÜFUNG: "Plakette erkannt" } },
      ],
    },
  ];

  const TOTAL_ASSETS = LEVELS.reduce((n, l) => n + l.assets.length, 0);

  // Boss round: the deadline itself. Records fly past, you classify or lose them.
  const BOSS_QS = [
    Q.kgHeat, Q.kgAuto, Q.intLift, Q.gwp404a, Q.kgAir,
    Q_STICKER[0], Q.intLegionella, Q.kgWater,
  ];
  const BOSS_LABELS = [
    "BR-21 KESSEL 2", "GA-22 DDC WEST", "AZ-23 AUFZUG 1", "KM-24 KÄLTE 2",
    "RL-25 RLT OST", "AV-26 ARMATUR KG", "TW-27 TRINKWASSER", "PU-28 PUMPE 3",
  ];

  /* ---------------------------------------------------------------------------
     8. GAME STATE
  --------------------------------------------------------------------------- */
  const Game = {
    // title | prologue | briefing | playing | task | explain | paused
    // | levelDone | bossIntro | boss | report
    state: "title",
    lvlIndex: 0,
    lvl: null,                // runtime clone of the current level
    frame: 0,
    timeLeft: 0,
    elapsed: 0,               // total seconds spent capturing (all levels)
    cam: { x: 0, y: 0 },
    player: null,
    particles: [], floaters: [],
    target: null, tstatus: null,
    task: null, explain: null,
    hasFlash: false, lampOn: false, battery: 0,
    score: 0, scoreAtLevelStart: 0,
    combo: 0, bestCombo: 0,
    shake: 0, hitstop: 0, flashWhite: 0,
    lowTimeBeep: 0,
    prologue: null,
    boss: null,
    stats: null,
    checkpoint: null,
    report: null,
  };

  function newStats() {
    return {
      captured: 0, total: TOTAL_ASSETS,
      good: 0, bad: 0,                 // correctly / incorrectly structured records
      badList: [], missing: [],
      co2e: 0,
      // seconds spent on the DATA ACT only (aiming, scanning, structuring) — excludes
      // walking, so it is comparable to the prologue, where the player only typed.
      captureSeconds: 0,
      timeLost: 0, timeGained: 0,
      cat: {},                          // category -> {ok, fail}
      manualSecPerAsset: 0, typos: 0,
      levelTimes: [],
    };
  }
  function cat(key, ok) {
    const c = Game.stats.cat[key] || (Game.stats.cat[key] = { ok: 0, fail: 0 });
    if (ok) c.ok++; else c.fail++;
  }

  const CAT_LABELS = {
    focus: "TYPENSCHILD-OCR",
    dark: "BELEUCHTUNG",
    obstructed: "ZUGÄNGLICHKEIT",
    steam: "TIMING / DAMPF",
    defect: "MÄNGELERKENNUNG",
    classify: "DIN 276",
    meter: "ZÄHLERABLESUNG",
    sticker: "PRÜFFRISTEN",
    interval: "WARTUNGSINTERVALLE",
    gwp: "ESG / KÄLTEMITTEL",
  };

  function loadLevel(i) {
    const src = LEVELS[i];
    Game.lvlIndex = i;
    Game.lvl = {
      name: src.name, w: src.w, time: src.time, theme: src.theme || "plant",
      // solid blockers (steel risers) collide like walls AND cut the scan line
      plats: src.plats.concat(src.blockers.filter(b => b.solid)),
      darkzones: src.darkzones,
      blockers: src.blockers,
      vents: src.vents.map(v => Object.assign({}, v, { t: 0, active: false })),
      pickups: src.pickups.map(p => Object.assign({}, p, { taken: false })),
      assets: src.assets.map((a, idx) => Object.assign({}, a, {
        id: src.name + "#" + idx,
        captured: false, focus: 0, focusDrops: 0, beamT: 0, errorT: 0,
        sweep: Math.random(), sweepDir: 1, cooldown: 0, defectFound: false,
        defectX: rand(0.25, 0.75), defectY: rand(0.3, 0.7),
      })),
    };
    Game.timeLeft = src.time;
    Game.hasFlash = src.hasFlash;
    Game.lampOn = false;
    Game.battery = src.hasFlash ? CFG.BATTERY_MAX : 0;
    Game.player = makePlayer();
    Game.cam.x = 0;
    Game.particles = []; Game.floaters = [];
    Game.target = null; Game.tstatus = null; Game.task = null; Game.explain = null;
    Game.scoreAtLevelStart = Game.score;
    Game.lowTimeBeep = 0;
    // snapshot for "retry level": without this, a failed attempt's captures and
    // answers would be counted a second time on the retry.
    Game.checkpoint = {
      score: Game.score, elapsed: Game.elapsed,
      stats: JSON.parse(JSON.stringify(Game.stats)),
    };
    // clear leftover juice timers — a hitstop from the previous level's last capture
    // would otherwise freeze the first frames here and eat the first input
    Game.hitstop = 0; Game.shake = 0; Game.flashWhite = 0;
  }

  function makePlayer() {
    return {
      x: 40, y: CFG.GROUND_Y - 22, w: 12, h: 20,
      vx: 0, vy: 0, facing: 1, onGround: false,
      coyote: 0, jumpBuf: 0, animT: 0, stepSnd: 0,
      flash: 0, safeX: 40, hurt: 0,
    };
  }

  function resetRun() {
    Game.score = 0; Game.combo = 0; Game.bestCombo = 0;
    Game.elapsed = 0; Game.stats = newStats();
    Game.boss = null; Game.report = null;
    Game.shake = 0; Game.hitstop = 0; Game.flashWhite = 0;
  }

  /* ---------------------------------------------------------------------------
     9. PHYSICS
  --------------------------------------------------------------------------- */
  function physics(p) {
    const plats = Game.lvl.plats;
    const want = (Input.held("left") ? -1 : 0) + (Input.held("right") ? 1 : 0);
    if (want !== 0) {
      p.vx = lerp(p.vx, want * CFG.MOVE_SPEED, 0.35);
      p.facing = want;
    } else {
      p.vx *= CFG.FRICTION;
      if (Math.abs(p.vx) < 0.05) p.vx = 0;
    }
    if (Input.pressed("jump")) p.jumpBuf = CFG.JUMP_BUFFER;
    if (p.jumpBuf > 0 && (p.onGround || p.coyote > 0)) {
      p.vy = CFG.JUMP_V; p.onGround = false; p.coyote = 0; p.jumpBuf = 0;
      Audio.SFX.jump(); spawnDust(p.x + p.w / 2, p.y + p.h, 6);
    }
    if (p.jumpBuf > 0) p.jumpBuf--;
    if (p.coyote > 0) p.coyote--;
    if (!Input.held("jump") && p.vy < -3) p.vy *= 0.86;      // variable jump height
    p.vy = clamp(p.vy + CFG.GRAVITY, -99, CFG.MAX_FALL);

    const wasOnGround = p.onGround;
    p.onGround = false;

    p.x += p.vx;
    for (const pl of plats) {
      if (pl.oneway) continue;
      if (aabb(p, pl)) {
        if (p.vx > 0) p.x = pl.x - p.w;
        else if (p.vx < 0) p.x = pl.x + pl.w;
        p.vx = 0;
      }
    }
    p.y += p.vy;
    for (const pl of plats) {
      if (!aabb(p, pl)) continue;
      if (pl.oneway) {
        // land only when falling onto it, and allow dropping through with DOWN
        if (p.vy > 0 && (p.y + p.h - p.vy) <= pl.y + 2 && !Input.held("down")) {
          p.y = pl.y - p.h; p.vy = 0; p.onGround = true;
        }
      } else if (p.vy > 0) { p.y = pl.y - p.h; p.vy = 0; p.onGround = true; }
      else if (p.vy < 0) { p.y = pl.y + pl.h; p.vy = 0; }
    }

    if (wasOnGround && !p.onGround) p.coyote = CFG.COYOTE;
    if (!wasOnGround && p.onGround) { Audio.SFX.land(); spawnDust(p.x + p.w / 2, p.y + p.h, 8); }
    if (p.onGround) p.safeX = p.x;

    if (p.onGround && Math.abs(p.vx) > 0.6) {
      p.stepSnd -= Math.abs(p.vx);
      if (p.stepSnd <= 0) { Audio.SFX.step(); p.stepSnd = 22; }
      p.animT += Math.abs(p.vx) * 0.12;
    } else p.animT = 0;

    p.x = clamp(p.x, 0, Game.lvl.w - p.w);

    // fell into a pit → time penalty, respawn on the last safe ground
    if (p.y > CFG.H + 30) {
      loseTime(CFG.PENALTY_PIT, "STURZ");
      p.x = p.safeX; p.y = CFG.GROUND_Y - 60; p.vx = 0; p.vy = 0;
      Game.shake = 10;
    }
  }

  function spawnDust(x, y, n) {
    for (let i = 0; i < n; i++)
      Game.particles.push({ x, y, vx: rand(-1, 1), vy: rand(-1.5, -0.2),
        life: rand(14, 26), max: 26, c: choice([PAL.dim, PAL.metalHi]), size: rand(1, 2) });
  }
  function spawnSparks(x, y, n, c) {
    for (let i = 0; i < n; i++)
      Game.particles.push({ x, y, vx: rand(-2, 2), vy: rand(-2.4, 0.4),
        life: rand(16, 30), max: 30, c: c || PAL.orange, size: rand(1, 2.4) });
  }
  // "data stream": the captured record visibly flies up into the HUD counter
  function spawnDataStream(x, y) {
    for (let i = 0; i < 14; i++)
      Game.particles.push({ x: x + rand(-6, 6), y: y + rand(-4, 4), vx: rand(-0.3, 0.3),
        vy: rand(-3.2, -1.8), life: rand(24, 40), max: 40,
        c: choice([PAL.cyan, PAL.green, PAL.white]), size: 1, grav: -0.02 });
  }
  function floater(x, y, text, c) {
    Game.floaters.push({ x, y, text, c: c || PAL.orange, life: 62, max: 62 });
  }

  function loseTime(sec, why) {
    Game.timeLeft -= sec;
    Game.stats.timeLost += sec;
    breakCombo();
    const p = Game.player;
    if (p) floater(p.x + p.w / 2, p.y - 10, "-" + sec + "s " + why, PAL.red);
  }
  function gainTime(sec, why) {
    Game.timeLeft += sec;
    Game.stats.timeGained += sec;
    const p = Game.player;
    if (p) floater(p.x + p.w / 2, p.y - 10, "+" + sec + "s " + why, PAL.green);
  }
  function breakCombo() {
    if (Game.combo > 0) { Game.combo = 0; }
  }
  function addCombo() {
    Game.combo++;
    Game.bestCombo = Math.max(Game.bestCombo, Game.combo);
    if (Game.combo > 1) Audio.SFX.combo(Math.min(Game.combo, 6));
  }
  const comboMult = () => 1 + Math.min(Game.combo, CFG.COMBO_MAX) * 0.2;
  function addScore(pts) {
    const total = Math.round(pts * comboMult());
    Game.score += total;
    return total;
  }

  /* ---------------------------------------------------------------------------
     10. TARGETING + LINE OF SIGHT + STATUS
  --------------------------------------------------------------------------- */
  function eye(p) { return { x: p.x + p.w / 2 + p.facing * 4, y: p.y + 6 }; }

  function nearestTarget() {
    const p = Game.player;
    let best = null, bestD = CFG.SCAN_RANGE;
    const px = p.x + p.w / 2, py = p.y + p.h / 2;
    for (const a of Game.lvl.assets) {
      if (a.captured) continue;
      const ax = a.x + a.w / 2, ay = a.y + a.h / 2;
      if ((ax - px) * p.facing < -10) continue;               // must be roughly in front
      const d = dist(px, py, ax, ay);
      if (d < bestD) { best = a; bestD = d; }
    }
    return best;
  }

  // Forgiving LOS: three sample points on the asset, one clear ray is enough.
  function losBlocked(a) {
    const blockers = Game.lvl.blockers;
    if (!blockers.length) return false;
    const p = Game.player;
    const e = eye(p);
    const feet = p.y + p.h;
    const pts = [
      [a.x + a.w / 2, a.y + a.h / 2],
      [a.x + a.w / 2, a.y + 3],
      [a.x + a.w / 2, a.y + a.h - 3],
    ];
    for (const pt of pts) {
      let clear = true;
      for (const b of blockers) {
        // standing on top of the riser → you are above it and can see past it
        if (feet <= b.y + 4 && p.x + p.w > b.x - 2 && p.x < b.x + b.w + 2) continue;
        if (segRect(e.x, e.y, pt[0], pt[1], b)) { clear = false; break; }
      }
      if (clear) return false;
    }
    return true;
  }

  function inDarkZone(x, w) {
    for (const z of Game.lvl.darkzones)
      if (x + (w || 0) > z.x && x < z.x + z.w) return true;
    return false;
  }
  function lampActive() { return Game.hasFlash && Game.lampOn && Game.battery > 0; }
  function litByLamp(a) {
    if (!lampActive()) return false;
    const p = Game.player;
    // must match the cone drawn in drawDarkness(), or "lit" and "looks lit" diverge
    const lx = p.x + p.w / 2 + p.facing * 22, ly = p.y + 6;
    return dist(lx, ly, a.x + a.w / 2, a.y + a.h / 2) < CFG.LIGHT_RANGE;
  }
  function steamBlocks(a) {
    for (const v of Game.lvl.vents)
      if (v.active && Math.abs(v.x - (a.x + a.w / 2)) < 62) return true;
    return false;
  }

  // short verdicts for the error floater (the status line carries the long form)
  const STATUS_SHORT = { dark: "ZU DUNKEL", obstructed: "VERDECKT", steam: "DAMPF" };

  /**
   * The diegetic status line — this is what makes every challenge legible.
   * Returns {ok, msg, color, code}.
   */
  function targetStatus(a) {
    if (inDarkZone(a.x, a.w) && !litByLamp(a)) {
      return { ok: false, code: "dark", color: PAL.red,
        msg: Game.hasFlash ? (Game.battery <= 0 ? "AKKU LEER — BATTERIE SUCHEN" : "ZU DUNKEL — LAMPE AN [F]")
                           : "ZU DUNKEL — KEINE LEUCHTE" };
    }
    if (a.challenge === "obstructed" && losBlocked(a)) {
      return { ok: false, code: "obstructed", color: PAL.red, msg: "STEIGLEITUNG DAVOR — POSITION WECHSELN" };
    }
    if (a.challenge === "steam" && steamBlocks(a)) {
      return { ok: false, code: "steam", color: PAL.red, msg: "DAMPF — TIMING ABWARTEN" };
    }
    if (a.challenge === "focus") {
      return { ok: true, code: "focus", color: PAL.cyan, msg: "TYPENSCHILD UNSCHARF — SCAN HALTEN" };
    }
    if (a.challenge === "defect") {
      return { ok: true, code: "defect", color: PAL.yellow, msg: "MANGEL ORTEN — SCAN AUF DER MARKE" };
    }
    return { ok: true, code: "ready", color: PAL.green, msg: "SCAN BEREIT [SPACE]" };
  }

  /* ---------------------------------------------------------------------------
     11. FOCUS MINIGAME  (illegible nameplates)
     The player must hold a specific distance to the plate while the sweet spot
     drifts. Standing still helps; running blurs the shot. Lesson: a bad photo
     is a bad record.
  --------------------------------------------------------------------------- */
  function sweetDistance() {
    return 30 + Math.sin(Game.frame * 0.021) * 12;   // 18..42 px, slow drift
  }
  function focusBandX(a) {
    const p = Game.player;
    const ax = a.x + a.w / 2;
    const side = (p.x + p.w / 2) < ax ? -1 : 1;
    return ax + side * sweetDistance();
  }

  function updateFocus(a) {
    const p = Game.player;
    if (!Input.held("scan")) {
      if (a.focus > 0) a.focus = Math.max(0, a.focus - 2.5);
      return;
    }
    const d = Math.abs((p.x + p.w / 2) - (a.x + a.w / 2));
    const off = Math.abs(d - sweetDistance());
    const moving = Math.abs(p.vx) > 1.4;
    if (off <= CFG.FOCUS_TOL) {
      const gain = CFG.FOCUS_FILL * (moving ? CFG.FOCUS_SHAKE_MULT : 1);
      a.focus = Math.min(100, a.focus + gain);
      if (Game.frame % 7 === 0) Audio.SFX.focus(a.focus / 100);
    } else {
      if (a.focus > 4 && Game.frame % 12 === 0) a.focusDrops++;
      a.focus = Math.max(0, a.focus - CFG.FOCUS_DRAIN);
    }
    if (a.focus >= 100) {
      const perfect = a.focusDrops === 0;
      cat("focus", true);
      Audio.SFX.locked();
      if (perfect) {
        gainTime(CFG.BONUS_PERFECT, "PERFEKT");
        floater(a.x + a.w / 2, a.y - 20, "PERFECT SCAN", PAL.cyan);
      }
      captureStage1(a, CFG.FOCUS_BONUS - Math.min(a.focusDrops, 8) * 20, perfect);
    }
  }

  /* ---------------------------------------------------------------------------
     12. DEFECT MINIGAME  (visual anomaly detection)
     A crosshair sweeps across the unit; lock it on the anomaly.
  --------------------------------------------------------------------------- */
  function updateDefect(a) {
    if (a.cooldown > 0) { a.cooldown--; return; }
    a.sweep += CFG.DEFECT_SWEEP * a.sweepDir;
    if (a.sweep > 1) { a.sweep = 1; a.sweepDir = -1; }
    if (a.sweep < 0) { a.sweep = 0; a.sweepDir = 1; }
    if (!Input.pressed("scan")) return;

    const hit = Math.abs(a.sweep - a.defectX) < 0.09;
    if (hit) {
      a.defectFound = true;
      cat("defect", true);
      Audio.SFX.locked();
      floater(a.x + a.w / 2, a.y - 20, "MANGEL: KORROSION", PAL.yellow);
      captureStage1(a, CFG.DEFECT_BONUS, true);
    } else {
      cat("defect", false);
      a.cooldown = CFG.DEFECT_COOLDOWN;
      a.errorT = 24;
      Audio.SFX.error();
      loseTime(CFG.PENALTY_MISS, "DANEBEN");
    }
  }

  /* ---------------------------------------------------------------------------
     13. SCAN → CAPTURE → KNOWLEDGE TASK
  --------------------------------------------------------------------------- */
  function updateScan() {
    // vents + steam contact damage
    for (const v of Game.lvl.vents) {
      v.t = (v.t + 1) % v.period;
      const wasActive = v.active;
      v.active = v.t < v.duration;
      if (v.active && !wasActive) Audio.SFX.steam();
      if (v.active) {
        const col = { x: v.x - 7, y: v.y - 40, w: 14, h: 44 };
        if (Game.player.hurt <= 0 && aabb(Game.player, col)) {
          Game.player.hurt = 45;
          Game.shake = 12;
          cat("steam", false);
          loseTime(CFG.PENALTY_STEAM, "VERBRANNT");
          Audio.SFX.error();
        }
      }
    }
    if (Game.player.hurt > 0) Game.player.hurt--;

    // battery drain
    if (Game.lampOn && Game.battery > 0) {
      Game.battery = Math.max(0, Game.battery - CFG.BATTERY_DRAIN / 60);
      if (Game.battery === 0) { Game.lampOn = false; Audio.SFX.error(); floater(Game.player.x, Game.player.y - 12, "AKKU LEER", PAL.red); }
    }
    if (Input.pressed("lamp") && Game.hasFlash && Game.battery > 0) {
      Game.lampOn = !Game.lampOn;
      Audio.SFX.lamp();
    }

    const t = nearestTarget();
    // reset focus progress on the assets we are no longer aiming at
    for (const a of Game.lvl.assets) {
      if (a !== t && a.focus > 0) a.focus = Math.max(0, a.focus - 3);
      if (a.beamT > 0) a.beamT--;
      if (a.errorT > 0) a.errorT--;
    }
    Game.target = t;
    if (!t) { Game.tstatus = null; return; }

    const st = targetStatus(t);
    Game.tstatus = st;

    if (!st.ok) {
      if (Input.pressed("scan")) {
        t.errorT = 28;
        Audio.SFX.blocked();
        cat(st.code, false);
        // short verdict only — the status line above already spells out the fix,
        // repeating it word for word was just noise
        floater(t.x + t.w / 2, t.y - 12, STATUS_SHORT[st.code] || "BLOCKIERT", PAL.red);
      }
      return;
    }
    // the access challenge succeeded → count it once we actually capture
    if (t.challenge === "focus") { updateFocus(t); return; }
    if (t.challenge === "defect") { updateDefect(t); return; }
    if (Input.pressed("scan")) captureStage1(t, 0, true);
  }

  /** Stage 1: the shot is in the can. Stage 2 is structuring the data. */
  function captureStage1(a, bonus, clean) {
    // credit the access challenge exactly once, here
    if (inDarkZone(a.x, a.w)) cat("dark", true);
    if (a.challenge === "obstructed") cat("obstructed", true);
    if (a.challenge === "steam") cat("steam", true);
    Audio.SFX.shutter();
    Game.player.flash = 14;
    Game.hitstop = 4;
    Game.flashWhite = 10;
    spawnSparks(a.x + a.w / 2, a.y + a.h / 2, 16, PAL.orange);
    a.pendingBonus = bonus || 0;
    a.cleanShot = !!clean;
    if (a.task) openTask(a);
    else completeAsset(a, CFG.BASE_POINTS + (bonus || 0), true);
  }

  function completeAsset(a, points, good) {
    a.captured = true;
    a.beamT = 26;
    Game.stats.captured++;
    if (good) { addCombo(); } else { breakCombo(); }
    const gained = addScore(points);
    Audio.SFX.success();
    spawnDataStream(a.x + a.w / 2, a.y + a.h / 2);
    floater(a.x + a.w / 2, a.y - 8,
      "CAFM +" + gained + (comboMult() > 1 ? " x" + comboMult().toFixed(1) : ""),
      good ? PAL.green : PAL.orange);
    Tracking.send("asset_captured", {
      id: a.id, label: a.label, level: Game.lvl.name,
      challenge: a.challenge, task: a.task || "none", points: gained, good: !!good,
    });
    if (Game.lvl.assets.every(x => x.captured)) finishLevel();
  }

  /* --- knowledge task (DOM overlay, world frozen) --- */
  function openTask(a) {
    const q = a.q || Q.kgHeat;
    Game.task = {
      asset: a, q, kind: a.task,
      time: CFG.TASK_TIME[a.task] || 8,
      max: CFG.TASK_TIME[a.task] || 8,
      boss: false,
    };
    Game.state = "task";
    Audio.SFX.classify();
    renderTaskPanel();
  }

  function answerTask(idx) {
    const t = Game.task;
    if (!t || t.answered) return;
    t.answered = true;
    const ok = idx === t.q.correct;
    const isBoss = t.boss;

    if (ok) {
      Game.stats.good++;
      cat(t.kind, true);
      if (t.q.co2e) Game.stats.co2e += t.q.co2e;
      Audio.SFX.correct();
    } else {
      Game.stats.bad++;
      cat(t.kind, false);
      Audio.SFX.wrong();
      Game.shake = 12;
      Game.stats.badList.push({
        label: t.label || (t.asset && t.asset.label) || "?",
        ask: t.q.ask,
        given: t.q.opts[idx] || "KEINE ANTWORT",
        right: t.q.opts[t.q.correct],
      });
    }

    Tracking.send("task_answer", {
      kind: t.kind, boss: isBoss, correct: ok, chosen: idx,
      label: t.label || (t.asset && t.asset.label),
    });

    // Show the "why" — that line is the whole educational payload.
    Game.explain = { ok, q: t.q, time: CFG.EXPLAIN_TIME, boss: isBoss, kind: t.kind };
    Game.state = "explain";
    renderExplainPanel();
  }

  /** Called when the explain toast is dismissed. */
  function afterExplain() {
    const ex = Game.explain;
    Game.explain = null;
    const t = Game.task;
    Game.task = null;

    if (!t) { Game.state = "playing"; hideOverlay(); return; }

    if (t.boss) { bossNext(ex.ok); return; }

    if (!ex.ok) loseTime(CFG.PENALTY_WRONG, "BAD DATA");
    const a = t.asset;
    const pts = CFG.BASE_POINTS + (a.pendingBonus || 0) + (ex.ok ? CFG.TASK_BONUS : 0);
    Game.state = "playing";
    hideOverlay();
    completeAsset(a, pts, ex.ok);
    if (!ex.ok) floater(a.x + a.w / 2, a.y - 22, "BAD DATA", PAL.red);
  }

  /* ---------------------------------------------------------------------------
     14. BOSS — "DER ÜBERGABETERMIN"
     No platforming: records stream past on the CAFM export terminal and every
     one you get wrong ships broken data.
  --------------------------------------------------------------------------- */
  function startBoss() {
    Game.boss = { i: 0, hits: 0, misses: 0 };
    Game.state = "bossIntro";
    renderBossIntro();
  }
  function bossNext(prevOk) {
    const b = Game.boss;
    if (prevOk === true) b.hits++;
    else if (prevOk === false) b.misses++;
    if (b.i >= CFG.BOSS_RECORDS) { endRun("complete"); return; }
    const q = BOSS_QS[b.i % BOSS_QS.length];
    const label = BOSS_LABELS[b.i % BOSS_LABELS.length];
    const t = lerp(CFG.BOSS_T_START, CFG.BOSS_T_END, b.i / (CFG.BOSS_RECORDS - 1));
    b.i++;
    Game.task = {
      asset: null, q, kind: kindOfQuestion(q), label,
      time: t, max: t, boss: true, record: b.i,
    };
    Game.state = "task";
    Audio.SFX.classify();
    renderTaskPanel();
  }
  function kindOfQuestion(q) {
    if (q.meter) return "meter";
    if (q.plate) return "sticker";
    if (q.co2e) return "gwp";
    if (/Prüfung|Inspektion|Funktionsprüfung|Legionellen/.test(q.ask)) return "interval";
    return "classify";
  }

  /* ---------------------------------------------------------------------------
     15. SCORING / RANK / REPORT
  --------------------------------------------------------------------------- */
  function finishLevel() {
    const left = Math.max(0, Game.timeLeft);
    const bonus = Math.round(left * 10);
    Game.score += bonus;
    Game.stats.levelTimes.push({ name: Game.lvl.name, left, used: Game.lvl.time - left });
    // NOTE: Game.elapsed is accumulated per tick in the loop — do not add it again here,
    // and lvl.time - left is not the real duration anyway (time bonuses/penalties move it).
    Audio.SFX.levelup();
    Game.state = "levelDone";
    Tracking.send("level_complete", { level: Game.lvl.name, time_left: left, bonus, score: Game.score });
    renderLevelDonePanel(bonus, left);
  }

  function nextLevel() {
    if (Game.lvlIndex + 1 < LEVELS.length) {
      Game.state = "briefing";
      renderBriefing(Game.lvlIndex + 1);
    } else {
      startBoss();
    }
  }

  function grade(c) {
    if (!c || (c.ok + c.fail) === 0) return { g: "–", cls: "at-dim" };
    const r = c.ok / (c.ok + c.fail);
    if (r >= 1)    return { g: "A+", cls: "at-green" };
    if (r >= 0.85) return { g: "A", cls: "at-green" };
    if (r >= 0.7)  return { g: "B", cls: "at-cyan" };
    if (r >= 0.55) return { g: "C", cls: "at-orange" };
    if (r >= 0.35) return { g: "D", cls: "at-orange" };
    return { g: "F", cls: "at-red" };
  }

  function buildReport(reason) {
    const s = Game.stats;
    // every asset never captured is a hole in the CAFM handover
    s.missing = [];
    for (let i = 0; i < LEVELS.length; i++) {
      const isCurrent = i === Game.lvlIndex && Game.lvl;
      const list = isCurrent ? Game.lvl.assets : LEVELS[i].assets;
      const done = i < Game.lvlIndex;
      list.forEach(a => {
        if (done) return;
        if (isCurrent ? !a.captured : true) s.missing.push({ label: a.label, level: LEVELS[i].name });
      });
    }
    const answered = s.good + s.bad;
    const completeness = s.captured / s.total;
    // no records at all is not "100% quality" — it is no handover
    const quality = answered ? s.good / answered : (s.captured > 0 ? 1 : 0);
    const budget = LEVELS.reduce((n, l) => n + l.time, 0);
    const speed = s.captured > 0 ? clamp(1 - (Game.elapsed / budget), 0, 1) : 0;

    const handover = Math.round(45 * completeness + 40 * quality + 15 * speed);
    let rank = "D";
    if (handover >= 92 && s.bad === 0) rank = "S";
    else if (handover >= 84) rank = "A";
    else if (handover >= 70) rank = "B";
    else if (handover >= 55) rank = "C";

    // Personalised marketing math, measured in the prologue.
    // Both sides exclude walking: the prologue measured pure typing, perAsset measures
    // pure capture + structuring. Comparing total run time would be dishonest.
    const manualField = s.manualSecPerAsset || 22;             // measured: one field
    const manualRecord = manualField * CFG.FIELDS_PER_RECORD;  // extrapolated: full record
    const perAsset = s.captured > 0 ? Math.max(0.1, s.captureSeconds / s.captured) : 0;
    const manualDays = (manualRecord * CFG.BUILDING_ASSETS) / 3600 / 8;
    const scanDays = (perAsset * CFG.BUILDING_ASSETS) / 3600 / 8;

    Game.report = {
      reason, rank, handover, completeness, quality, speed,
      manualField, manualRecord, perAsset, manualDays, scanDays,
      factor: perAsset > 0 ? manualRecord / perAsset : 0,
      // no capture, no saving — never claim a benefit the player did not earn
      savedHours: s.captured > 0
        ? Math.max(0, Math.round((manualRecord - perAsset) * CFG.BUILDING_ASSETS / 3600)) : 0,
    };
    return Game.report;
  }

  function endRun(reason) {
    const r = buildReport(reason);
    Game.state = "report";
    if (reason === "complete") Audio.SFX.win(); else Audio.SFX.fail();
    Tracking.send("run_complete", {
      reason, rank: r.rank, handover: r.handover, score: Game.score,
      captured: Game.stats.captured, total: Game.stats.total,
      good: Game.stats.good, bad: Game.stats.bad,
      elapsed_s: Math.round(Game.elapsed), best_combo: Game.bestCombo,
      co2e: Game.stats.co2e, saved_hours: r.savedHours,
    });
    renderReportPanel();
  }

  const HighScore = (function () {
    function load() {
      try {
        if (Tracking.params.get("hs") === "0") { localStorage.removeItem(CFG.HS_KEY); return []; }
        return JSON.parse(localStorage.getItem(CFG.HS_KEY) || "[]");
      } catch (e) { return []; }
    }
    function add(entry) {
      let list = load();
      list.push(entry);
      list.sort((a, b) => b.score - a.score);
      list = list.slice(0, 5);
      try { localStorage.setItem(CFG.HS_KEY, JSON.stringify(list)); } catch (e) { /* ignore */ }
      Tracking.send("highscore", { entry, board: list });
      return list;
    }
    return { load, add };
  })();

  /* ---------------------------------------------------------------------------
     16. RENDERING
  --------------------------------------------------------------------------- */
  const cv = document.getElementById("at-canvas");
  const ctx = cv.getContext("2d");
  ctx.imageSmoothingEnabled = false;

  function render() {
    const p = Game.player;
    const targetCam = clamp(p.x + p.w / 2 - CFG.W / 2, 0, Game.lvl.w - CFG.W);
    Game.cam.x = lerp(Game.cam.x, targetCam, 0.18);

    let sx = 0, sy = 0;
    if (Game.shake > 0) {
      sx = rand(-Game.shake, Game.shake) * 0.4;
      sy = rand(-Game.shake, Game.shake) * 0.4;
      Game.shake *= 0.85;
      if (Game.shake < 0.3) Game.shake = 0;
    }

    ctx.save();
    ctx.translate((-Game.cam.x + sx) | 0, sy | 0);

    drawBackground();
    drawPlats();
    drawFloorMarks();      // painted markings belong ON the slab, not behind it
    drawPickups();
    drawAssets();
    drawBlockers();
    drawVents();
    drawParticles();
    drawPlayer();
    // Darkness dims the WORLD (assets, player) — but never the scanner readout:
    // "ZU DUNKEL" has to be legible precisely when everything else is not.
    drawDarkness();
    drawScanUI();
    drawFloaters();

    ctx.restore();

    drawScreenUI();
  }

  /* =========================================================================
     SCENERY — the building itself.

     Five parallax layers built entirely from FM/TGA elements: concrete shell with
     tie-rod holes, cable trays with cable bundles, insulated pipe runs with
     hangers and medium labels, rectangular ventilation ducts, distribution
     manifolds, pump sets, cabinet rows, buffer tanks, escape signage, hydrant
     boxes and painted walkway markings.

     Everything is procedural AND deterministic: placement comes from an integer
     hash, never Math.random, so the scenery is stable frame to frame and free of
     per-level data. Each theme ("site" / "plant" / "handover") re-mixes the same
     prop kit into a different room.
  ========================================================================= */
  function hash01(n) {
    n = (n ^ 61) ^ (n >>> 16);
    n = n + (n << 3);
    n = n ^ (n >>> 4);
    n = Math.imul(n, 0x27d4eb2d);
    n = n ^ (n >>> 15);
    return ((n >>> 0) % 100000) / 100000;
  }

  const SCN = {
    site: {                                   // 01 Bauphase: raw shell, daylight
      sky0: "#152541", sky1: "#20395f",
      far: "#1a2b47", farHi: "#233a5c", seam: "#111e34",
      mid: "#172640", midHi: "#21365a",
      near: "#111d33", nearHi: "#1a2b47",
      ceil: "#131f36", ceilHi: "#1c2d4a",
      lamp: "rgba(255,236,190,",
      haze: "rgba(255,205,140,0.05)",
      wallProps: ["scaffold", "cableDrum", "pallets", "doorSteel", "signPlate", "extinguisher"],
      midProps: ["ductBox", "pipeColumn", "scaffold", "conduits", "pallets"],
      nearProps: ["ahuBox", "cabinetRow", "stairFlight", "tank"],
      openings: true, trays: 1, ducts: false, sprinkler: false, floor: "raw",
    },
    plant: {                                  // 02 Technikzentrale: dense services
      sky0: "#0a1526", sky1: "#13284a",
      far: "#101e35", farHi: "#182842", seam: "#0b1727",
      mid: "#0e1b31", midHi: "#182a45",
      near: "#0a1425", nearHi: "#132234",
      ceil: "#0c1728", ceilHi: "#16253c",
      lamp: "rgba(214,240,255,",
      haze: "rgba(120,200,255,0.04)",
      wallProps: ["hydrant", "extinguisher", "exitSign", "doorSteel", "signPlate", "radiator"],
      midProps: ["manifold", "pipeColumn", "ductBox", "pumpSet", "conduits", "vessel"],
      nearProps: ["cabinetRow", "tank", "ahuBox", "pumpSet", "stairFlight"],
      openings: false, trays: 2, ducts: true, sprinkler: true, floor: "marked",
    },
    handover: {                               // 03 Übergabetag: in service, ageing
      sky0: "#0d1626", sky1: "#1b2d4a",
      far: "#152338", farHi: "#1e2f48", seam: "#0e1927",
      mid: "#111d31", midHi: "#1b2b45",
      near: "#0c1527", nearHi: "#152334",
      lamp: "rgba(255,225,180,",
      ceil: "#0e1a2d", ceilHi: "#18273e",
      haze: "rgba(255,150,70,0.05)",
      wallProps: ["exitSign", "hydrant", "fileBoxes", "signPlate", "doorSteel", "extinguisher"],
      midProps: ["manifold", "ductBox", "pipeColumn", "fileBoxes", "vessel", "pumpSet"],
      nearProps: ["cabinetRow", "ahuBox", "tank", "cabinetRow"],
      openings: false, trays: 2, ducts: true, sprinkler: true, floor: "marked",
    },
  };

  /* --- individual props. (x,y) is the bottom-left anchor, S the theme colors. --- */
  const PROPS = {
    // vertical riser bundle with pipe clamps
    pipeColumn(x, y, S, i) {
      const n = 2 + ((hash01(i) * 3) | 0), top = 18 + hash01(i * 3) * 30;
      for (let k = 0; k < n; k++) {
        const px = x + k * 7;
        ctx.fillStyle = S.mid; ctx.fillRect(px, top, 5, y - top);
        ctx.fillStyle = S.midHi; ctx.fillRect(px, top, 2, y - top);
      }
      ctx.fillStyle = S.midHi;                       // clamps
      for (let cy = top + 20; cy < y; cy += 34) ctx.fillRect(x - 2, cy, n * 7 + 2, 2);
    },
    // rectangular duct with flange plates, sometimes turning down
    ductBox(x, y, S, i) {
      const h = 16 + ((hash01(i * 5) * 10) | 0), w = 54 + ((hash01(i * 7) * 40) | 0);
      const ty = y - 74 - hash01(i * 11) * 40;
      ctx.fillStyle = S.mid; ctx.fillRect(x, ty, w, h);
      ctx.fillStyle = S.midHi; ctx.fillRect(x, ty, w, 2);
      for (let fx = x + 12; fx < x + w; fx += 26) { ctx.fillStyle = S.midHi; ctx.fillRect(fx, ty - 1, 3, h + 2); }
      if (hash01(i * 13) > 0.55) {                   // vertical drop with a damper
        ctx.fillStyle = S.mid; ctx.fillRect(x + w - 22, ty + h, 18, y - ty - h);
        ctx.fillStyle = S.midHi; ctx.fillRect(x + w - 22, ty + h + 14, 18, 2);
      }
    },
    // heating/cooling distributor: header pipe with branch valves
    manifold(x, y, S, i) {
      const h = 40 + ((hash01(i) * 22) | 0), top = y - h;
      ctx.fillStyle = S.mid; ctx.fillRect(x, top, 9, h);
      ctx.fillStyle = S.midHi; ctx.fillRect(x, top, 3, h);
      for (let k = 0; k < 4; k++) {
        const by = top + 8 + k * 11;
        if (by > y - 4) break;
        ctx.fillStyle = S.mid; ctx.fillRect(x + 9, by, 16, 3);
        ctx.fillStyle = S.midHi; ctx.fillRect(x + 24, by - 3, 4, 8);   // valve body
      }
      ctx.fillStyle = S.midHi; ctx.fillRect(x - 2, y - 3, 13, 3);      // base
    },
    // pump set on a foundation frame
    pumpSet(x, y, S, i) {
      ctx.fillStyle = S.near; ctx.fillRect(x, y - 8, 34, 8);
      ctx.fillStyle = S.nearHi; ctx.fillRect(x, y - 8, 34, 2);
      for (let k = 0; k < 2; k++) {
        const px = x + 4 + k * 16;
        ctx.fillStyle = S.mid; ctx.fillRect(px, y - 22, 11, 14);
        ctx.fillStyle = S.midHi; ctx.fillRect(px, y - 22, 11, 3);
        ctx.fillStyle = S.mid; ctx.fillRect(px + 3, y - 30, 5, 8);     // motor
      }
      if (hash01(i) > 0.6) { ctx.fillStyle = "rgba(239,68,68,0.35)"; ctx.fillRect(x + 30, y - 26, 3, 3); }
    },
    // insulated buffer / storage tank
    tank(x, y, S, i) {
      const h = 54 + ((hash01(i) * 34) | 0), w = 24;
      ctx.fillStyle = S.near; ctx.fillRect(x, y - h, w, h);
      ctx.fillStyle = S.nearHi; ctx.fillRect(x, y - h, 4, h);
      ctx.fillStyle = S.nearHi;                                        // jacket bands
      for (let by = y - h + 8; by < y - 6; by += 16) ctx.fillRect(x, by, w, 2);
      ctx.fillStyle = S.near; ctx.fillRect(x + 3, y - h - 5, w - 6, 5); // domed top
      ctx.fillStyle = S.nearHi; ctx.fillRect(x + w / 2 - 1, y - h - 12, 3, 8);
    },
    // small red expansion vessel — one of the few colour accents back here
    vessel(x, y, S) {
      ctx.fillStyle = "#5a1a1a"; ctx.fillRect(x, y - 26, 13, 26);
      ctx.fillStyle = "#7a2626"; ctx.fillRect(x, y - 26, 4, 26);
      ctx.fillStyle = "#3d1212"; ctx.fillRect(x + 2, y - 30, 9, 4);
      ctx.fillStyle = S.midHi; ctx.fillRect(x + 5, y - 3, 3, 3);
    },
    // row of switchgear cabinets
    cabinetRow(x, y, S, i) {
      const n = 3 + ((hash01(i) * 3) | 0), h = 46 + ((hash01(i * 3) * 10) | 0);
      for (let k = 0; k < n; k++) {
        const cx = x + k * 19;
        ctx.fillStyle = S.near; ctx.fillRect(cx, y - h, 18, h);
        ctx.fillStyle = S.nearHi; ctx.fillRect(cx, y - h, 18, 2);
        ctx.fillStyle = S.near; ctx.fillRect(cx + 17, y - h, 1, h);     // door seam
        ctx.fillStyle = S.nearHi; ctx.fillRect(cx + 13, y - h + 14, 2, 5); // handle
        ctx.fillStyle = S.nearHi; ctx.fillRect(cx + 3, y - h + 5, 8, 3);   // label plate
      }
    },
    // air handling unit shell with access doors and a filter grille
    ahuBox(x, y, S, i) {
      const w = 72 + ((hash01(i) * 40) | 0), h = 54 + ((hash01(i * 5) * 16) | 0);
      ctx.fillStyle = S.near; ctx.fillRect(x, y - h, w, h);
      ctx.fillStyle = S.nearHi; ctx.fillRect(x, y - h, w, 2);
      for (let dx = x + 6; dx < x + w - 8; dx += 26) {
        ctx.fillStyle = S.nearHi; ctx.fillRect(dx, y - h + 6, 1, h - 14);   // door seams
        ctx.fillStyle = S.nearHi; ctx.fillRect(dx + 10, y - h + 20, 3, 2);  // handle
      }
      ctx.fillStyle = S.near;                                              // grille
      for (let gy = y - h + 8; gy < y - h + 26; gy += 4) ctx.fillRect(x + w - 22, gy, 16, 2);
      ctx.fillStyle = S.nearHi; ctx.fillRect(x + 4, y - h - 6, w - 8, 6);  // duct connection
    },
    // stair flight with railing
    stairFlight(x, y, S) {
      for (let k = 0; k < 7; k++) {
        ctx.fillStyle = S.near; ctx.fillRect(x + k * 8, y - 6 - k * 7, 9, 6 + k * 7);
        ctx.fillStyle = S.nearHi; ctx.fillRect(x + k * 8, y - 6 - k * 7, 9, 2);
      }
      ctx.fillStyle = S.nearHi;
      for (let k = 0; k < 7; k += 2) ctx.fillRect(x + k * 8 + 7, y - 30 - k * 7, 1, 24);
    },
    conduits(x, y, S, i) {
      const top = 20 + hash01(i) * 40;
      for (let k = 0; k < 3; k++) {
        ctx.fillStyle = S.mid; ctx.fillRect(x + k * 4, top, 2, y - top);
      }
      ctx.fillStyle = S.midHi; ctx.fillRect(x - 1, y - 40, 13, 8);      // junction box
    },
    radiator(x, y, S) {
      ctx.fillStyle = S.mid; ctx.fillRect(x, y - 22, 30, 16);
      ctx.fillStyle = S.midHi;
      for (let fx = x + 2; fx < x + 29; fx += 3) ctx.fillRect(fx, y - 21, 1, 14);
      ctx.fillStyle = S.mid; ctx.fillRect(x + 26, y - 6, 3, 6);
    },
    doorSteel(x, y, S, i) {
      ctx.fillStyle = S.near; ctx.fillRect(x, y - 46, 26, 46);
      ctx.fillStyle = S.nearHi; ctx.fillRect(x, y - 46, 26, 2);
      ctx.fillStyle = S.nearHi; ctx.fillRect(x + 21, y - 26, 3, 5);      // handle
      ctx.fillStyle = hash01(i) > 0.5 ? "rgba(52,211,153,0.35)" : S.nearHi;
      ctx.fillRect(x + 6, y - 40, 14, 6);                                // door sign
    },
    // escape sign — the strongest "this is a building" cue, and a colour accent
    exitSign(x, y, S, i) {
      const sy = y - 62 - ((hash01(i) * 10) | 0);
      ctx.fillStyle = "rgba(52,211,153,0.10)"; ctx.fillRect(x - 5, sy - 4, 26, 14);
      ctx.fillStyle = "#12503c"; ctx.fillRect(x, sy, 16, 7);
      ctx.fillStyle = "#34D399"; ctx.fillRect(x + 1, sy + 1, 14, 5);
      ctx.fillStyle = "#0b2b20";                                        // arrow + figure
      ctx.fillRect(x + 3, sy + 2, 4, 3); ctx.fillRect(x + 9, sy + 3, 4, 1);
      ctx.fillRect(x + 11, sy + 2, 1, 3);
      ctx.fillStyle = S.midHi; ctx.fillRect(x + 7, sy - 4, 2, 4);        // stem
    },
    hydrant(x, y, S) {
      ctx.fillStyle = "#5f1717"; ctx.fillRect(x, y - 50, 20, 26);
      ctx.fillStyle = "#7d2020"; ctx.fillRect(x, y - 50, 20, 2);
      ctx.fillStyle = "#c8ccd4"; ctx.fillRect(x + 8, y - 42, 4, 10); ctx.fillRect(x + 5, y - 39, 10, 4);
      ctx.fillStyle = S.nearHi; ctx.fillRect(x + 17, y - 40, 2, 5);
    },
    // wall-mounted at chest height (as required), not standing on the walkway —
    // on the floor it read as a foreground object
    extinguisher(x, y, S) {
      const ey = y - 52;
      ctx.fillStyle = "#5c1818"; ctx.fillRect(x, ey, 7, 16);
      ctx.fillStyle = "#7a2222"; ctx.fillRect(x, ey, 2, 16);
      ctx.fillStyle = S.nearHi; ctx.fillRect(x + 2, ey - 4, 3, 4);
      ctx.fillStyle = S.mid; ctx.fillRect(x - 2, ey + 5, 11, 2);      // bracket
      ctx.fillStyle = "rgba(226,232,240,0.10)"; ctx.fillRect(x - 1, ey - 9, 9, 6); // sign above
    },
    signPlate(x, y, S, i) {
      const sy = y - 44 - ((hash01(i) * 22) | 0);
      ctx.fillStyle = S.nearHi; ctx.fillRect(x, sy, 20, 11);
      ctx.fillStyle = S.near; ctx.fillRect(x + 1, sy + 1, 18, 9);
      ctx.fillStyle = S.nearHi;                                          // suggested text
      ctx.fillRect(x + 3, sy + 3, 10, 2); ctx.fillRect(x + 3, sy + 6, 14, 2);
    },
    // --- construction-site props (01 Bauphase) ---
    scaffold(x, y, S, i) {
      const h = 90 + ((hash01(i) * 60) | 0);
      ctx.fillStyle = S.mid;
      ctx.fillRect(x, y - h, 2, h); ctx.fillRect(x + 30, y - h, 2, h);
      for (let by = y - h + 10; by < y; by += 26) {
        ctx.fillRect(x, by, 32, 2);
        ctx.fillStyle = S.midHi; ctx.fillRect(x + 2, by - 1, 28, 1); ctx.fillStyle = S.mid;
      }
      for (let by = y - h + 10; by < y - 20; by += 26) ctx.fillRect(x + 4, by, 24, 1);
    },
    cableDrum(x, y, S) {
      ctx.fillStyle = S.mid;
      ctx.beginPath(); ctx.arc(x + 13, y - 13, 13, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = S.midHi;
      ctx.beginPath(); ctx.arc(x + 13, y - 13, 8, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = S.mid;
      ctx.beginPath(); ctx.arc(x + 13, y - 13, 4, 0, Math.PI * 2); ctx.fill();
    },
    pallets(x, y, S, i) {
      const n = 2 + ((hash01(i) * 3) | 0);
      for (let k = 0; k < n; k++) {
        ctx.fillStyle = S.mid; ctx.fillRect(x, y - 7 - k * 7, 34, 6);
        ctx.fillStyle = S.midHi; ctx.fillRect(x, y - 7 - k * 7, 34, 1);
        ctx.fillStyle = S.near; ctx.fillRect(x + 4, y - 3 - k * 7, 3, 2);
        ctx.fillRect(x + 26, y - 3 - k * 7, 3, 2);
      }
    },
    // --- handover props (03): the paper the game is trying to replace ---
    fileBoxes(x, y, S, i) {
      const n = 3 + ((hash01(i) * 4) | 0);
      for (let k = 0; k < n; k++) {
        const by = y - 9 - k * 9, off = (hash01(i * 7 + k) - 0.5) * 5;
        ctx.fillStyle = S.near; ctx.fillRect(x + off, by, 26, 8);
        ctx.fillStyle = S.nearHi; ctx.fillRect(x + off, by, 26, 1);
        ctx.fillStyle = "rgba(226,232,240,0.16)"; ctx.fillRect(x + off + 3, by + 3, 12, 3);
      }
    },
  };

  /** Scatter props of a layer along the level, deterministically. */
  function propLayer(cam, par, spacing, groundY, kinds, seed, S) {
    const off = cam * par;
    const first = Math.floor((off - 130) / spacing);
    const last = Math.ceil((off + CFG.W + 130) / spacing);
    for (let i = first; i <= last; i++) {
      const jitter = (hash01(i * 31 + seed) - 0.5) * spacing * 0.6;
      const sx = i * spacing - off + jitter;
      if (sx < -130 || sx > CFG.W + 130) continue;
      if (hash01(i * 17 + seed) < 0.12) continue;                 // leave gaps
      const kind = kinds[(hash01(i * 13 + seed * 3) * kinds.length) | 0];
      const fn = PROPS[kind];
      if (fn) fn(cam + sx, groundY, S, i * 7 + seed);
    }
  }

  /** Horizontal cable tray with a cable bundle — reads as "Technik" instantly. */
  function drawTray(cam, par, y, S) {
    const off = cam * par;
    ctx.fillStyle = S.midHi; ctx.fillRect(cam, y, CFG.W, 1);
    ctx.fillStyle = S.mid; ctx.fillRect(cam, y + 5, CFG.W, 1);
    const step = 6, start = Math.floor(off / step);
    ctx.fillStyle = S.midHi;
    for (let i = start; i <= start + CFG.W / step + 2; i++) {
      const sx = i * step - off;
      if (sx < 0 || sx > CFG.W) continue;
      ctx.fillRect(cam + sx, y + 1, 1, 4);
    }
    ctx.fillStyle = S.mid; ctx.fillRect(cam, y + 2, CFG.W, 2);      // cable bundle
    // hangers up to the slab
    const hstep = 78, hstart = Math.floor(off / hstep);
    for (let i = hstart; i <= hstart + CFG.W / hstep + 2; i++) {
      const sx = i * hstep - off;
      if (sx < 0 || sx > CFG.W) continue;
      ctx.fillStyle = S.mid; ctx.fillRect(cam + sx, 16, 2, y - 16);
    }
  }

  /** Insulated pipe run with hangers and medium-code bands. */
  function drawPipeRun(cam, par, y, S, seed) {
    const off = cam * par;
    ctx.fillStyle = S.mid; ctx.fillRect(cam, y, CFG.W, 7);
    ctx.fillStyle = S.midHi; ctx.fillRect(cam, y, CFG.W, 2);
    const step = 64, start = Math.floor(off / step);
    for (let i = start; i <= start + CFG.W / step + 2; i++) {
      const sx = i * step - off;
      if (sx < -20 || sx > CFG.W + 20) continue;
      ctx.fillStyle = S.midHi; ctx.fillRect(cam + sx, y - 1, 4, 9);          // flange
      ctx.fillStyle = S.mid; ctx.fillRect(cam + sx + 14, 16, 2, y - 16);     // hanger
      // medium marker band (DIN 2403 style) — a single accent pixel row
      if (hash01(i + seed) > 0.6) {
        ctx.fillStyle = hash01(i * 3 + seed) > 0.5
          ? "rgba(250,204,21,0.30)" : "rgba(34,211,238,0.30)";
        ctx.fillRect(cam + sx + 24, y + 1, 8, 5);
      }
    }
  }

  function drawSprinkler(cam, par, y, S) {
    const off = cam * par;
    ctx.fillStyle = S.mid; ctx.fillRect(cam, y, CFG.W, 2);
    const step = 34, start = Math.floor(off / step);
    for (let i = start; i <= start + CFG.W / step + 2; i++) {
      const sx = i * step - off;
      if (sx < 0 || sx > CFG.W) continue;
      ctx.fillStyle = S.midHi;
      ctx.fillRect(cam + sx, y + 2, 3, 2); ctx.fillRect(cam + sx + 1, y + 4, 1, 2);
    }
  }

  /** Concrete shell: pour joints, formwork tie holes, block courses. */
  function drawShell(cam, S) {
    const par = 0.16, off = cam * par;
    ctx.fillStyle = S.far;
    ctx.fillRect(cam, 0, CFG.W, CFG.H);
    // formwork panel grid (2.5 m panels ≈ 60 px)
    const pw = 60, start = Math.floor(off / pw);
    for (let i = start; i <= start + CFG.W / pw + 2; i++) {
      const sx = i * pw - off;
      if (sx < -pw || sx > CFG.W) continue;
      ctx.fillStyle = S.seam; ctx.fillRect(cam + sx, 0, 1, CFG.H);
      // tie-rod holes, two per panel row
      ctx.fillStyle = S.seam;
      for (let hy = 54; hy < CFG.H - 30; hy += 54) {
        ctx.fillRect(cam + sx + 18, hy, 3, 3);
        ctx.fillRect(cam + sx + 42, hy, 3, 3);
      }
      if (hash01(i) > 0.72) {                       // patch of exposed blockwork
        ctx.fillStyle = S.farHi;
        for (let by = 96; by < 200; by += 9) {
          const shift = ((by / 9) | 0) % 2 ? 0 : 12;
          for (let bx = 0; bx < pw - 4; bx += 24)
            ctx.fillRect(cam + sx + bx + shift, by, 22, 7);
        }
      }
    }
    ctx.fillStyle = S.seam;                          // horizontal pour joints
    for (let hy = 54; hy < CFG.H; hy += 54) ctx.fillRect(cam, hy, CFG.W, 1);
  }

  /** Daylight openings — only the construction phase still has them. */
  function drawOpenings(cam, S) {
    const par = 0.3, off = cam * par, step = 320;
    const start = Math.floor(off / step);
    for (let i = start; i <= start + 2; i++) {
      const sx = i * step - off + 40;
      if (sx < -140 || sx > CFG.W + 20) continue;
      const wx = cam + sx, wy = 46, w = 96, h = 74;
      ctx.fillStyle = "#2c4f7d"; ctx.fillRect(wx, wy, w, h);
      ctx.fillStyle = "#3f6da5"; ctx.fillRect(wx + 2, wy + 2, w - 4, h - 4);
      // scaffolding outside the opening
      ctx.fillStyle = "#24405f";
      ctx.fillRect(wx + 20, wy, 2, h); ctx.fillRect(wx + 66, wy, 2, h);
      for (let by = wy + 16; by < wy + h; by += 24) ctx.fillRect(wx + 2, by, w - 4, 2);
      ctx.fillStyle = S.far; ctx.fillRect(wx - 3, wy - 3, w + 6, 3);       // lintel
      // light spill into the room
      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      const g = ctx.createLinearGradient(wx, wy, wx + 30, wy + h + 90);
      g.addColorStop(0, "rgba(160,200,255,0.16)");
      g.addColorStop(1, "rgba(160,200,255,0)");
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.moveTo(wx, wy); ctx.lineTo(wx + w, wy);
      ctx.lineTo(wx + w + 60, CFG.H); ctx.lineTo(wx - 30, CFG.H);
      ctx.closePath(); ctx.fill();
      ctx.restore();
    }
  }

  /** Slab, downstand beams and the luminaires that make a basement a basement. */
  function drawCeilingLayer(cam, S) {
    ctx.fillStyle = S.ceil; ctx.fillRect(cam, 0, CFG.W, 16);
    ctx.fillStyle = S.ceilHi; ctx.fillRect(cam, 14, CFG.W, 2);

    const par = 0.62, off = cam * par;
    const bstep = 152, bstart = Math.floor(off / bstep);
    for (let i = bstart; i <= bstart + CFG.W / bstep + 2; i++) {
      const sx = i * bstep - off;
      if (sx < -30 || sx > CFG.W) continue;
      ctx.fillStyle = S.ceil; ctx.fillRect(cam + sx, 0, 16, 34);
      ctx.fillStyle = S.ceilHi; ctx.fillRect(cam + sx, 32, 16, 2);
      ctx.fillStyle = S.ceil; ctx.fillRect(cam + sx - 2, 30, 20, 2);
    }

    // fluorescent battens, a few of them with a failing ballast
    const lstep = 118, lstart = Math.floor(off / lstep);
    for (let i = lstart; i <= lstart + CFG.W / lstep + 2; i++) {
      const sx = i * lstep - off + 40;
      if (sx < -40 || sx > CFG.W + 20) continue;
      const wx = cam + sx;
      const flickers = hash01(i * 91) < 0.22;
      const bad = flickers && ((Game.frame + i * 37) % 96) < 7;
      ctx.fillStyle = S.ceilHi; ctx.fillRect(wx, 18, 34, 3);
      ctx.fillStyle = bad ? S.ceilHi : "#d8e6f2";
      ctx.fillRect(wx + 2, 21, 30, 2);
      if (!bad) {
        ctx.save();
        ctx.globalCompositeOperation = "lighter";
        const g = ctx.createLinearGradient(0, 22, 0, 130);
        g.addColorStop(0, S.lamp + "0.13)");
        g.addColorStop(1, S.lamp + "0)");
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.moveTo(wx + 1, 23); ctx.lineTo(wx + 33, 23);
        ctx.lineTo(wx + 58, 130); ctx.lineTo(wx - 24, 130);
        ctx.closePath(); ctx.fill();
        ctx.restore();
      }
    }
  }

  /** Painted walkway edges, drains and screed texture — drawn ON the floor. */
  function drawFloorMarks() {
    const cam = Game.cam.x, S = SCN[Game.lvl.theme] || SCN.plant;
    const top = CFG.GROUND_Y;
    for (const pl of Game.lvl.plats) {
      if (pl.oneway || pl.y !== top) continue;
      const x0 = Math.max(cam - 4, pl.x), x1 = Math.min(cam + CFG.W + 4, pl.x + pl.w);
      if (x1 <= x0) continue;
      if (S.floor === "marked") {
        // hatched safety marking along the walkway edge
        ctx.fillStyle = "rgba(161,98,7,0.55)";
        ctx.fillRect(x0, top + 4, x1 - x0, 2);
        ctx.fillStyle = "rgba(250,204,21,0.16)";
        for (let x = Math.floor(x0 / 8) * 8; x < x1; x += 8) {
          if (x + 4 < x0) continue;
          ctx.fillRect(x, top + 6, 4, 2);
        }
      } else {
        ctx.fillStyle = "rgba(120,140,170,0.10)";     // raw screed, no markings yet
        for (let x = Math.floor(x0 / 5) * 5; x < x1; x += 5) ctx.fillRect(x, top + 5, 2, 1);
      }
      // floor drains
      const dstep = 190, dstart = Math.floor(x0 / dstep);
      for (let i = dstart; i <= dstart + (x1 - x0) / dstep + 1; i++) {
        const dx = i * dstep + 60;
        if (dx < x0 + 6 || dx + 14 > x1 - 6) continue;
        ctx.fillStyle = "rgba(5,8,16,0.55)"; ctx.fillRect(dx, top + 2, 14, 6);
        ctx.fillStyle = S.nearHi;
        for (let k = 0; k < 4; k++) ctx.fillRect(dx + 2 + k * 3, top + 3, 2, 4);
      }
    }
  }

  function drawBackground() {
    const cam = Game.cam.x;
    const S = SCN[Game.lvl.theme] || SCN.plant;

    // sky / room volume
    const g = ctx.createLinearGradient(0, 0, 0, CFG.H);
    g.addColorStop(0, S.sky0); g.addColorStop(0.65, S.sky1); g.addColorStop(1, S.sky0);
    ctx.fillStyle = g; ctx.fillRect(cam, 0, CFG.W, CFG.H);

    // L1: structural shell, L2/L3: same shell but darker and further away
    drawShell(cam, S);
    if (S.openings) drawOpenings(cam, S);

    // depth haze pushes the shell behind the services
    ctx.fillStyle = S.haze; ctx.fillRect(cam, 0, CFG.W, CFG.H);

    // --- services layer (0.42) ---
    propLayer(cam, 0.42, 138, CFG.GROUND_Y, S.midProps, 11, S);
    if (S.trays > 0) drawTray(cam, 0.42, 40, S);
    if (S.ducts) drawPipeRun(cam, 0.42, 60, S, 3);
    ctx.fillStyle = S.haze; ctx.fillRect(cam, 0, CFG.W, CFG.H);

    // --- plant layer (0.7), the big silhouettes ---
    propLayer(cam, 0.7, 186, CFG.GROUND_Y, S.nearProps, 29, S);
    if (S.trays > 1) drawTray(cam, 0.7, 78, S);
    if (S.sprinkler) drawSprinkler(cam, 0.7, 96, S);

    // --- ceiling (0.62) ---
    drawCeilingLayer(cam, S);

    // --- wall furniture (0.88): signage, extinguishers, hydrants, boxes ---
    propLayer(cam, 0.88, 152, CFG.GROUND_Y, S.wallProps, 47, S);

    // floor shadow line so the play layer sits clearly in front
    ctx.fillStyle = "rgba(5,8,16,0.35)";
    ctx.fillRect(cam, CFG.GROUND_Y - 10, CFG.W, 10);

    // One global scrim over the finished scenery. It keeps every detail but pushes
    // the whole background a step back, so no prop — not a cabinet row, not a red
    // vessel at floor level — can be mistaken for a scannable asset.
    ctx.fillStyle = "rgba(8,14,26,0.28)";
    ctx.fillRect(cam, 0, CFG.W, CFG.H);
  }

  function drawPlats() {
    for (const pl of Game.lvl.plats) {
      if (pl.oneway) {
        ctx.fillStyle = PAL.metal; ctx.fillRect(pl.x, pl.y, pl.w, pl.h);
        ctx.fillStyle = PAL.orange; ctx.fillRect(pl.x, pl.y, pl.w, 2);
        ctx.fillStyle = PAL.metalLo; ctx.fillRect(pl.x, pl.y + pl.h - 2, pl.w, 2);
        for (let x = pl.x; x < pl.x + pl.w; x += 16) {
          ctx.fillStyle = PAL.metalLo; ctx.fillRect(x + 6, pl.y + pl.h, 2, 6);
        }
      } else {
        ctx.fillStyle = PAL.floor; ctx.fillRect(pl.x, pl.y, pl.w, pl.h);
        ctx.fillStyle = PAL.floorTop; ctx.fillRect(pl.x, pl.y, pl.w, 3);
        ctx.fillStyle = PAL.metalHi;
        for (let x = pl.x + 4; x < pl.x + pl.w - 2; x += 10) ctx.fillRect(x, pl.y + 6, 1, 1);
        ctx.fillStyle = "rgba(0,0,0,0.4)"; ctx.fillRect(pl.x, pl.y + pl.h - 3, pl.w, 3);
      }
    }
  }

  // Pipe runs / risers: they hide nameplates. Drawn in front of the assets.
  function drawBlockers() {
    for (const b of Game.lvl.blockers) {
      const vertical = b.h > b.w;
      ctx.fillStyle = PAL.pipe; ctx.fillRect(b.x, b.y, b.w, b.h);
      if (vertical) {
        // Round-pipe shading, NOT evenly spaced rungs: with a flange every 24 px this
        // read as a ladder and invited the player to climb what is actually a blocker.
        ctx.fillStyle = PAL.pipeHi; ctx.fillRect(b.x + 1, b.y, 3, b.h);
        ctx.fillStyle = PAL.pipeLo; ctx.fillRect(b.x + b.w - 4, b.y, 4, b.h);
        ctx.fillStyle = "rgba(226,232,240,0.10)"; ctx.fillRect(b.x + 2, b.y, 1, b.h);
        // continues up through the slab
        ctx.fillStyle = PAL.pipeLo; ctx.fillRect(b.x + 2, 0, b.w - 4, b.y);
        // two insulation collars only
        ctx.fillStyle = PAL.orangeD;
        ctx.fillRect(b.x - 2, b.y + 4, b.w + 4, 5);
        ctx.fillRect(b.x - 2, b.y + b.h - 26, b.w + 4, 5);
        ctx.fillStyle = PAL.metalLo;
        ctx.fillRect(b.x - 3, b.y + b.h - 8, b.w + 6, 3);          // floor penetration
        ctx.fillStyle = PAL.metalHi; ctx.fillRect(b.x - 2, b.y, b.w + 4, 2);
      } else {
        ctx.fillStyle = PAL.pipeHi; ctx.fillRect(b.x, b.y, b.w, 2);
        ctx.fillStyle = PAL.pipeLo; ctx.fillRect(b.x, b.y + b.h - 2, b.w, 2);
        ctx.fillStyle = PAL.orangeD;
        for (let x = b.x + 8; x < b.x + b.w - 4; x += 26) ctx.fillRect(x, b.y - 1, 4, b.h + 2);
        ctx.fillStyle = PAL.metalLo;
        for (let x = b.x + 14; x < b.x + b.w; x += 60) ctx.fillRect(x, 0, 2, b.y);
      }
    }
  }

  const BADGE = {
    focus:      { t: "TYP", c: PAL.cyan },
    obstructed: { t: "ROHR", c: PAL.magenta },
    steam:      { t: "DAMPF", c: PAL.white },
    defect:     { t: "MANGEL", c: PAL.yellow },
    plain:      { t: "SCAN", c: PAL.orange },
  };
  const TASK_BADGE = {
    classify: "DIN276", meter: "ZÄHLER", sticker: "FRIST", interval: "WARTUNG", gwp: "ESG",
  };

  function drawAssets() {
    for (const a of Game.lvl.assets) {
      const isTarget = Game.target === a;
      ctx.save();
      if (isTarget) {
        ctx.fillStyle = "rgba(255,107,0,0.14)";
        ctx.fillRect(a.x - 4, a.y - 4, a.w + 8, a.h + 8);
      }
      drawAssetByType(a);

      if (a.captured) {
        ctx.fillStyle = "rgba(52,211,153,0.22)";
        ctx.fillRect(a.x - 2, a.y - 2, a.w + 4, a.h + 4);
        ctx.fillStyle = PAL.green;
        ctx.fillRect(a.x + a.w - 6, a.y + 2, 4, 4);
        tinyText("OK", a.x + a.w / 2 - 4, a.y - 6, PAL.green);
      } else if (!isTarget) {
        // P1: always-on badges so the player can plan from a distance.
        // Suppressed on the current target — the status line says more, and they
        // would collide with the focus meter.
        const b = BADGE[a.challenge] || BADGE.plain;
        const bx = a.x + a.w / 2;
        const tb = a.task ? TASK_BADGE[a.task] : "";
        // dark backing plate — the scenery behind is detailed enough to swallow 8px text
        const bw = Math.max(b.t.length, tb.length) * 4.9 + 6;
        ctx.fillStyle = "rgba(5,8,16,0.62)";
        ctx.fillRect(bx - bw / 2, a.y - 20, bw, tb ? 17 : 9);
        tinyTextC(b.t, bx, a.y - 13, b.c);
        if (tb) tinyTextC(tb, bx, a.y - 5, PAL.dim);
        if ((Game.frame >> 4) % 2 === 0) {
          ctx.fillStyle = b.c;
          ctx.fillRect(bx - 1, a.y - 24, 2, 2);
        }
      }
      if (a.beamT > 0) {
        ctx.fillStyle = "rgba(255,255,255," + (a.beamT / 26) + ")";
        ctx.fillRect(a.x - 3, a.y - 3, a.w + 6, a.h + 6);
      }
      if (a.errorT > 0) {
        // capped: at full strength this painted the unit solid red and hid it
        ctx.fillStyle = "rgba(239,68,68," + (a.errorT / 30) * 0.45 + ")";
        ctx.fillRect(a.x - 3, a.y - 3, a.w + 6, a.h + 6);
      }
      ctx.restore();
    }
  }

  function drawAssetByType(a) {
    const { x, y, w, h, type } = a;
    switch (type) {
      case "boiler":
        roundRect(x, y, w, h, PAL.metal, PAL.metalHi);
        ctx.fillStyle = PAL.orange; ctx.fillRect(x + 4, y + 6, w - 8, 6);
        ctx.fillStyle = PAL.bg0; ctx.fillRect(x + 5, y + 7, w - 10, 4);
        ctx.fillStyle = PAL.cyan; ctx.fillRect(x + 6, y + 9, 4, 1);
        ctx.fillStyle = PAL.metalLo; ctx.fillRect(x + w / 2 - 2, y + h - 6, 4, 6);
        nameplate(a);
        break;
      case "pump":
        roundRect(x, y, w, h, PAL.metal, PAL.metalHi);
        ctx.fillStyle = PAL.rust; ctx.fillRect(x + 3, y + 3, w - 6, h - 6);
        ctx.fillStyle = "rgba(120,90,60,0.6)"; ctx.fillRect(x + 3, y + 3, w - 6, 3);
        ctx.fillStyle = PAL.orange; ctx.fillRect(x + 6, y + h - 4, 2, 2);
        nameplate(a);
        break;
      case "cabinet":
        ctx.fillStyle = PAL.metalLo; ctx.fillRect(x, y, w, h);
        ctx.fillStyle = PAL.metal; ctx.fillRect(x + 2, y + 2, w - 4, h - 4);
        ctx.fillStyle = (Game.frame >> 4) % 2 ? PAL.green : PAL.orange; ctx.fillRect(x + 5, y + 5, 2, 2);
        ctx.fillStyle = PAL.red; ctx.fillRect(x + 9, y + 5, 2, 2);
        ctx.fillStyle = PAL.metalHi; ctx.fillRect(x + 5, y + 11, w - 10, h - 15);
        nameplate(a);
        break;
      case "ahu":
        roundRect(x, y, w, h, PAL.metal, PAL.metalHi);
        ctx.fillStyle = PAL.bg0; ctx.fillRect(x + 3, y + 3, w - 6, h - 6);
        ctx.fillStyle = PAL.metalLo;
        for (let i = 0; i < 4; i++) ctx.fillRect(x + 4, y + 5 + i * 4, w - 8, 1);
        ctx.fillStyle = PAL.orange; ctx.fillRect(x + w - 4, y + 4, 2, 2);
        nameplate(a);
        break;
      case "valve":
        ctx.fillStyle = PAL.pipe; ctx.fillRect(x + w / 2 - 3, y + h - 8, 6, 8);
        ctx.fillStyle = PAL.metalHi;
        ctx.beginPath(); ctx.arc(x + w / 2, y + 8, 7, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = PAL.metalLo;
        for (let i = 0; i < 6; i++) {
          const ang = i * Math.PI / 3 + Game.frame * 0.01;
          ctx.fillRect(x + w / 2 + Math.cos(ang) * 5 - 1, y + 8 + Math.sin(ang) * 5 - 1, 2, 2);
        }
        nameplate(a);
        break;
      case "transformer":
        roundRect(x, y, w, h, PAL.metalLo, PAL.metal);
        ctx.fillStyle = PAL.metal; ctx.fillRect(x + 2, y + 2, w - 4, h - 4);
        ctx.fillStyle = PAL.metalLo;
        for (let i = 0; i < 4; i++) ctx.fillRect(x + 4 + i * 4, y + 4, 1, h - 8);
        ctx.fillStyle = PAL.yellow; ctx.fillRect(x + 4, y + h - 8, w - 8, 3);
        ctx.fillStyle = PAL.bg0;
        for (let i = 0; i < w - 8; i += 4) ctx.fillRect(x + 5 + i, y + h - 8, 2, 3);
        nameplate(a);
        break;
      case "chiller":
        roundRect(x, y, w, h, PAL.metal, PAL.metalHi);
        ctx.fillStyle = PAL.bg0; ctx.fillRect(x + 2, y + 2, w - 4, h - 10);
        // condenser fan
        ctx.strokeStyle = PAL.cyan; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.arc(x + w / 2, y + 11, 7, 0, Math.PI * 2); ctx.stroke();
        for (let i = 0; i < 3; i++) {
          const ang = i * 2.09 + Game.frame * 0.22;
          ctx.beginPath(); ctx.moveTo(x + w / 2, y + 11);
          ctx.lineTo(x + w / 2 + Math.cos(ang) * 6, y + 11 + Math.sin(ang) * 6); ctx.stroke();
        }
        ctx.fillStyle = PAL.cyanD; ctx.fillRect(x + 3, y + h - 7, w - 6, 4);
        nameplate(a);
        break;
      case "meterbox":
        ctx.fillStyle = PAL.metalLo; ctx.fillRect(x, y, w, h);
        ctx.fillStyle = PAL.metal; ctx.fillRect(x + 2, y + 2, w - 4, h - 4);
        // digit rolls
        ctx.fillStyle = PAL.bg0; ctx.fillRect(x + 4, y + 8, w - 8, 8);
        ctx.fillStyle = PAL.white;
        for (let i = 0; i < 5; i++) ctx.fillRect(x + 5 + i * 3, y + 10, 2, 4);
        ctx.fillStyle = PAL.red; ctx.fillRect(x + w - 7, y + 10, 2, 4);
        ctx.fillStyle = PAL.cyan; ctx.fillRect(x + 4, y + h - 8, w - 8, 2);
        nameplate(a);
        break;
    }
  }

  // The nameplate itself: unreadable blocks until the focus scan resolves it.
  function nameplate(a) {
    const px = a.x + 4, py = a.y + a.h - 12, pw = a.w - 8;
    ctx.fillStyle = a.captured ? PAL.cyanD : "#8a8f99";
    ctx.fillRect(px, py, pw, 7);
    const sharp = a.captured ? 1 : (a.challenge === "focus" ? a.focus / 100 : 0.55);
    ctx.fillStyle = sharp > 0.7 ? PAL.bg0 : "rgba(20,25,35,0.55)";
    for (let i = 0; i < 4; i++) {
      const wob = sharp > 0.7 ? 0 : (Math.random() < 0.5 ? 1 : 0);
      ctx.fillRect(px + 1 + i * 3 + wob, py + 2, 2, 3);
    }
  }

  function drawPickups() {
    for (const pk of Game.lvl.pickups) {
      if (pk.taken) continue;
      const bob = Math.sin(Game.frame * 0.1) * 1.5;
      ctx.fillStyle = "rgba(250,204,21,0.16)";
      ctx.fillRect(pk.x - 4, pk.y + bob - 4, pk.w + 8, pk.h + 8);
      // battery cell
      ctx.fillStyle = PAL.metalLo; ctx.fillRect(pk.x, pk.y + bob, pk.w, pk.h);
      ctx.fillStyle = PAL.yellow; ctx.fillRect(pk.x + 2, pk.y + bob + 2, pk.w - 4, pk.h - 4);
      ctx.fillStyle = PAL.bg0; ctx.fillRect(pk.x + 5, pk.y + bob + 4, 4, 6);
      ctx.fillStyle = PAL.metalHi; ctx.fillRect(pk.x + pk.w / 2 - 2, pk.y + bob - 2, 4, 2);
      tinyText("AKKU", pk.x - 5, pk.y + bob - 6, PAL.yellow);
    }
  }

  function drawVents() {
    for (const v of Game.lvl.vents) {
      ctx.fillStyle = PAL.pipe; ctx.fillRect(v.x - 6, v.y, 12, 16);
      ctx.fillStyle = PAL.pipeHi; ctx.fillRect(v.x - 6, v.y, 12, 2);
      ctx.fillStyle = PAL.orange; ctx.fillRect(v.x - 6, v.y + 14, 12, 2);
      // warning tell: the vent glows just before it blows
      const soon = !v.active && v.t > v.period - 30;
      if (soon && (Game.frame >> 2) % 2 === 0) {
        ctx.fillStyle = PAL.red; ctx.fillRect(v.x - 6, v.y - 2, 12, 2);
      }
      if (v.active) {
        for (let i = 0; i < 5; i++) {
          const off = (Game.frame * 0.7 + i * 8) % 40;
          const alpha = clamp(1 - off / 40, 0, 1);
          ctx.fillStyle = "rgba(226,232,240," + (alpha * 0.5) + ")";
          const r = 3 + off * 0.22;
          ctx.beginPath();
          ctx.arc(v.x + Math.sin(off * 0.3) * 3, v.y - off, r, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }
  }

  function drawParticles() {
    for (const p of Game.particles) {
      ctx.globalAlpha = clamp(p.life / p.max, 0, 1);
      ctx.fillStyle = p.c;
      ctx.fillRect(p.x | 0, p.y | 0, p.size, p.size);
    }
    ctx.globalAlpha = 1;
  }

  function drawFloaters() {
    for (const f of Game.floaters) {
      ctx.globalAlpha = clamp(f.life / f.max, 0, 1);
      // outlined: score popups fly across arbitrary scenery
      pxText(f.text, f.x, f.y, f.c, { center: true, outline: true });
    }
    ctx.globalAlpha = 1;
  }

  function drawPlayer() {
    const p = Game.player;
    const cx = p.x | 0, cy = p.y | 0;
    const walking = p.onGround && Math.abs(p.vx) > 0.4;
    const legPhase = walking ? Math.sin(p.animT) : 0;

    // steam burn flicker
    if (p.hurt > 0 && (p.hurt >> 2) % 2 === 0) return;

    ctx.save();
    ctx.translate(cx + p.w / 2, cy);
    ctx.scale(p.facing, 1);
    ctx.translate(-p.w / 2, 0);

    ctx.fillStyle = "rgba(0,0,0,0.35)"; ctx.fillRect(0, p.h - 1, p.w, 2);
    ctx.fillStyle = PAL.bg2;
    if (walking) {
      ctx.fillRect(1, p.h - 6 + legPhase, 4, 6 - Math.abs(legPhase));
      ctx.fillRect(7, p.h - 6 - legPhase, 4, 6 - Math.abs(legPhase));
    } else {
      ctx.fillRect(1, p.h - 6, 4, 6); ctx.fillRect(7, p.h - 6, 4, 6);
    }
    ctx.fillStyle = PAL.orangeD;
    ctx.fillRect(0, p.h - 2, 5, 2); ctx.fillRect(7, p.h - 2, 5, 2);
    ctx.fillStyle = PAL.vest; ctx.fillRect(1, 8, 10, 8);
    ctx.fillStyle = PAL.vestHi; ctx.fillRect(1, 8, 10, 2); ctx.fillRect(1, 13, 10, 1);
    ctx.fillStyle = PAL.skin; ctx.fillRect(0, 9, 2, 5); ctx.fillRect(10, 9, 2, 5);
    // scanner in hand
    ctx.fillStyle = PAL.bg0; ctx.fillRect(10, 8, 4, 6);
    ctx.fillStyle = Input.held("scan") ? PAL.orange : PAL.cyan; ctx.fillRect(11, 9, 2, 3);
    ctx.fillStyle = PAL.skin; ctx.fillRect(3, 2, 6, 6);
    ctx.fillStyle = PAL.orange; ctx.fillRect(2, 0, 8, 3);
    ctx.fillStyle = PAL.orangeD; ctx.fillRect(2, 2, 8, 1);
    ctx.fillStyle = (Game.frame >> 3) % 2 ? PAL.cyan : PAL.cyanD; ctx.fillRect(5, 1, 1, 1);
    ctx.fillStyle = PAL.bg0; ctx.fillRect(6, 4, 2, 2);
    ctx.fillStyle = PAL.cyan; ctx.fillRect(7, 4, 1, 1);
    // helmet lamp housing when the flashlight is carried
    if (Game.hasFlash) {
      ctx.fillStyle = lampActive() ? PAL.yellow : PAL.metalLo;
      ctx.fillRect(9, 0, 3, 2);
    }
    if (p.flash > 0) {
      ctx.fillStyle = "rgba(255,255,255," + (p.flash / 14) * 0.4 + ")";
      ctx.fillRect(-2, -2, p.w + 4, p.h + 4);
      p.flash--;
    }
    ctx.restore();
  }

  /** All in-world scan feedback: beam, status line, focus band, crosshair. */
  function drawScanUI() {
    const a = Game.target, st = Game.tstatus;
    if (!a || !st) return;
    const p = Game.player;
    const e = eye(p);
    const ax = a.x + a.w / 2, ay = a.y + a.h / 2;

    // beam
    const beamCol = st.ok ? "rgba(255,107,0,0.85)" : "rgba(239,68,68,0.7)";
    ctx.strokeStyle = beamCol; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(e.x, e.y); ctx.lineTo(ax, ay); ctx.stroke();

    // target frame
    const pulse = 2 + Math.sin(Game.frame * 0.4);
    ctx.strokeStyle = st.color;
    ctx.strokeRect(a.x - pulse, a.y - pulse, a.w + pulse * 2, a.h + pulse * 2);
    ctx.fillStyle = st.color;
    [[a.x, a.y], [a.x + a.w, a.y], [a.x, a.y + a.h], [a.x + a.w, a.y + a.h]]
      .forEach(pt => ctx.fillRect(pt[0] - 1, pt[1] - 1, 2, 2));

    // P1: the diegetic status line — always says what is wrong and what to do.
    // Clamped to the viewport so it stays readable at the screen edges.
    const tw = pxWidth(st.msg) + 9;
    const tx = clamp(ax, Game.cam.x + tw / 2 + 3, Game.cam.x + CFG.W - tw / 2 - 3);
    const ty = Math.max(24, a.y - 26);
    ctx.fillStyle = "rgba(5,7,13,0.94)";
    ctx.fillRect(Math.round(tx - tw / 2), ty - FH - 3, tw, FH + 6);
    ctx.strokeStyle = st.color; ctx.lineWidth = 1;
    ctx.strokeRect(Math.round(tx - tw / 2) + 0.5, ty - FH - 2.5, tw - 1, FH + 5);
    pxText(st.msg, tx, ty, st.color, { center: true, plain: true });
    pxText(a.label, tx, ty - FH - 6, PAL.white, { center: true, outline: true });

    if (a.challenge === "focus" && st.ok) drawFocusUI(a);
    if (a.challenge === "defect" && st.ok) drawDefectUI(a);
  }

  function drawFocusUI(a) {
    const p = Game.player;
    const bandX = focusBandX(a);
    const gy = CFG.GROUND_Y - 2;
    // the floor bracket marks where to stand — it drifts, so you must track it
    const okDist = Math.abs(Math.abs((p.x + p.w / 2) - (a.x + a.w / 2)) - sweetDistance()) <= CFG.FOCUS_TOL;
    const c = okDist ? PAL.green : PAL.orange;
    const y0 = Math.min(gy, a.y + a.h + 16);
    ctx.strokeStyle = c; ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(bandX - CFG.FOCUS_TOL, y0 - 5); ctx.lineTo(bandX - CFG.FOCUS_TOL, y0);
    ctx.lineTo(bandX + CFG.FOCUS_TOL, y0); ctx.lineTo(bandX + CFG.FOCUS_TOL, y0 - 5);
    ctx.stroke();
    // guidance only while the player is off the mark — once green, the bracket says it
    if (!okDist) tinyTextC("HIER STEHEN", bandX, y0 - 8, c);

    // focus meter over the plate
    const bw = a.w + 8;
    ctx.fillStyle = PAL.bg0; ctx.fillRect(a.x - 4, a.y - 11, bw, 5);
    ctx.fillStyle = okDist ? PAL.cyan : PAL.orangeD;
    ctx.fillRect(a.x - 4, a.y - 11, bw * (a.focus / 100), 5);
    ctx.strokeStyle = PAL.metalHi; ctx.strokeRect(a.x - 4, a.y - 11, bw, 5);
    if (Math.abs(p.vx) > 1.4 && a.focus > 0) tinyTextC("VERWACKELT", a.x + a.w / 2, a.y - 14, PAL.red);
    else if (a.focus > 4) tinyTextC("OCR " + Math.round(a.focus) + "%", a.x + a.w / 2, a.y - 14, PAL.cyan);
  }

  function drawDefectUI(a) {
    if (a.cooldown > 0) {
      tinyTextC("SENSOR RESET...", a.x + a.w / 2, a.y - 15, PAL.red);
      return;
    }
    // the anomaly: a rust bloom that is only visible in the scanner overlay
    const dx = a.x + a.defectX * a.w, dy = a.y + a.defectY * a.h;
    ctx.fillStyle = "rgba(122,59,18,0.85)";
    ctx.fillRect(dx - 3, dy - 2, 6, 4);
    ctx.fillStyle = PAL.rust;
    ctx.fillRect(dx - 2, dy - 1, 2, 2);
    // sweeping crosshair
    const sx = a.x + a.sweep * a.w;
    ctx.strokeStyle = PAL.yellow; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(sx, a.y - 6); ctx.lineTo(sx, a.y + a.h + 6); ctx.stroke();
    ctx.fillStyle = PAL.yellow;
    ctx.fillRect(sx - 3, a.y + a.h + 4, 6, 2);
    tinyTextC("SCAN!", sx, a.y - 8, PAL.yellow);
  }

  function drawDarkness() {
    let anyDark = false;
    for (const z of Game.lvl.darkzones) {
      const x0 = Math.max(Game.cam.x - 8, z.x);
      const x1 = Math.min(Game.cam.x + CFG.W + 8, z.x + z.w);
      if (x1 <= x0) continue;
      anyDark = true;
      const g = ctx.createLinearGradient(z.x, 0, z.x + z.w, 0);
      g.addColorStop(0, "rgba(2,4,10,0)");
      g.addColorStop(0.12, PAL.dark);
      g.addColorStop(0.88, PAL.dark);
      g.addColorStop(1, "rgba(2,4,10,0)");
      ctx.fillStyle = g;
      ctx.fillRect(x0, 0, x1 - x0, CFG.H);
    }
    if (!anyDark) return;
    const p = Game.player;

    // Helmet LED: always on, tiny. You must never lose sight of your own character,
    // even with a dead battery.
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    const hx = p.x + p.w / 2, hy = p.y + 8;
    const hg = ctx.createRadialGradient(hx, hy, 1, hx, hy, 24);
    hg.addColorStop(0, "rgba(185,232,255,0.52)");
    hg.addColorStop(0.55, "rgba(150,205,255,0.22)");
    hg.addColorStop(1, "rgba(120,190,255,0)");
    ctx.fillStyle = hg;
    ctx.beginPath(); ctx.arc(hx, hy, 24, 0, Math.PI * 2); ctx.fill();
    ctx.restore();

    if (!lampActive()) return;
    const lx = p.x + p.w / 2 + p.facing * 22, ly = p.y + 6;
    const rg = ctx.createRadialGradient(lx, ly, 2, lx, ly, CFG.LIGHT_RANGE);
    rg.addColorStop(0, "rgba(255,232,180,0.60)");
    rg.addColorStop(0.5, "rgba(255,205,125,0.22)");
    rg.addColorStop(1, "rgba(255,205,125,0)");
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    ctx.fillStyle = rg;
    ctx.beginPath(); ctx.arc(lx, ly, CFG.LIGHT_RANGE, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }

  /** Screen-space overlays: battery, combo, deadline flash. */
  function drawScreenUI() {
    // battery gauge (only when a lamp is carried)
    if (Game.hasFlash) {
      const bx = 8, by = CFG.H - 16, bw = 46, bh = 7;
      ctx.fillStyle = "rgba(5,7,13,0.8)"; ctx.fillRect(bx - 2, by - 8, bw + 8, bh + 10);
      ctx.strokeStyle = PAL.metalHi; ctx.lineWidth = 1; ctx.strokeRect(bx, by, bw, bh);
      const pct = Game.battery / CFG.BATTERY_MAX;
      ctx.fillStyle = pct > 0.4 ? PAL.green : pct > 0.15 ? PAL.yellow : PAL.red;
      ctx.fillRect(bx + 1, by + 1, (bw - 2) * pct, bh - 2);
      ctx.fillStyle = PAL.metalHi; ctx.fillRect(bx + bw, by + 2, 2, 3);
      tinyText("AKKU " + (lampConst()), bx, by - 2, lampActive() ? PAL.yellow : PAL.dim);
    }
    // combo
    if (Game.combo > 1) {
      const t = "x" + comboMult().toFixed(1) + " COMBO";
      pxText(t, CFG.W - 8 - pxWidth(t), CFG.H - 9,
        Game.combo >= CFG.COMBO_MAX ? PAL.magenta : PAL.orange, { outline: true });
    }
    // deadline pressure vignette
    if (Game.timeLeft <= 20 && Game.state === "playing") {
      const a = 0.10 + 0.10 * Math.sin(Game.frame * 0.25);
      ctx.fillStyle = "rgba(239,68,68," + a + ")";
      ctx.fillRect(0, 0, CFG.W, CFG.H);
    }
    if (Game.flashWhite > 0) {
      ctx.fillStyle = "rgba(255,255,255," + (Game.flashWhite / 10) * 0.5 + ")";
      ctx.fillRect(0, 0, CFG.W, CFG.H);
      Game.flashWhite--;
    }
  }
  const lampConst = () => (Game.lampOn ? "AN [F]" : "AUS [F]");

  function roundRect(x, y, w, h, fill, hi) {
    ctx.fillStyle = fill; ctx.fillRect(x, y, w, h);
    ctx.fillStyle = hi; ctx.fillRect(x, y, w, 2); ctx.fillRect(x, y, 2, h);
    ctx.fillStyle = "rgba(0,0,0,0.35)";
    ctx.fillRect(x, y + h - 2, w, 2); ctx.fillRect(x + w - 2, y, 2, h);
  }
  /* =========================================================================
     BITMAP FONT — 5x7, drawn pixel by pixel.

     Why not ctx.fillText: the browser anti-aliases small text into grey
     half-pixels, and `image-rendering: pixelated` then magnifies that blur.
     At 8px that produced unreadable mush — which is exactly what the in-world
     labels suffered from. A hand-set bitmap font has no anti-aliasing at all,
     so it stays razor sharp at every upscale factor. That is also how the
     machines this game imitates actually did it.

     Uppercase only (German ß uppercases to SS natively, umlaut dots are drawn
     on top of the base glyph), which keeps the table small and the look period-correct.
  ========================================================================= */
  const FW = 5, FH = 7, FADV = 6;
  const GLYPHS = (function () {
    const raw = {
      A: "01110 10001 10001 11111 10001 10001 10001",
      B: "11110 10001 10001 11110 10001 10001 11110",
      C: "01110 10001 10000 10000 10000 10001 01110",
      D: "11100 10010 10001 10001 10001 10010 11100",
      E: "11111 10000 10000 11110 10000 10000 11111",
      F: "11111 10000 10000 11110 10000 10000 10000",
      G: "01110 10001 10000 10111 10001 10001 01111",
      H: "10001 10001 10001 11111 10001 10001 10001",
      I: "11111 00100 00100 00100 00100 00100 11111",
      J: "00111 00010 00010 00010 00010 10010 01100",
      K: "10001 10010 10100 11000 10100 10010 10001",
      L: "10000 10000 10000 10000 10000 10000 11111",
      M: "10001 11011 10101 10101 10001 10001 10001",
      N: "10001 11001 10101 10011 10001 10001 10001",
      O: "01110 10001 10001 10001 10001 10001 01110",
      P: "11110 10001 10001 11110 10000 10000 10000",
      Q: "01110 10001 10001 10001 10101 01110 00011",
      R: "11110 10001 10001 11110 10100 10010 10001",
      S: "01111 10000 10000 01110 00001 00001 11110",
      T: "11111 00100 00100 00100 00100 00100 00100",
      U: "10001 10001 10001 10001 10001 10001 01110",
      V: "10001 10001 10001 10001 10001 01010 00100",
      W: "10001 10001 10001 10101 10101 11011 10001",
      X: "10001 10001 01010 00100 01010 10001 10001",
      Y: "10001 10001 01010 00100 00100 00100 00100",
      Z: "11111 00001 00010 00100 01000 10000 11111",
      0: "01110 10001 10011 10101 11001 10001 01110",
      1: "00100 01100 00100 00100 00100 00100 01110",
      2: "01110 10001 00001 00010 00100 01000 11111",
      3: "11111 00010 00100 00010 00001 10001 01110",
      4: "00010 00110 01010 10010 11111 00010 00010",
      5: "11111 10000 11110 00001 00001 10001 01110",
      6: "00110 01000 10000 11110 10001 10001 01110",
      7: "11111 00001 00010 00100 01000 01000 01000",
      8: "01110 10001 10001 01110 10001 10001 01110",
      9: "01110 10001 10001 01111 00001 00010 01100",
      " ": "00000 00000 00000 00000 00000 00000 00000",
      ".": "00000 00000 00000 00000 00000 01100 01100",
      ",": "00000 00000 00000 00000 01100 00100 01000",
      ":": "00000 01100 01100 00000 01100 01100 00000",
      ";": "00000 01100 01100 00000 01100 00100 01000",
      "-": "00000 00000 00000 11111 00000 00000 00000",
      "+": "00000 00100 00100 11111 00100 00100 00000",
      "=": "00000 00000 11111 00000 11111 00000 00000",
      "_": "00000 00000 00000 00000 00000 00000 11111",
      "/": "00001 00010 00010 00100 01000 01000 10000",
      "\\": "10000 01000 01000 00100 00010 00010 00001",
      "%": "11000 11001 00010 00100 01000 10011 00011",
      "!": "00100 00100 00100 00100 00100 00000 00100",
      "?": "01110 10001 00001 00010 00100 00000 00100",
      "'": "00100 00100 00000 00000 00000 00000 00000",
      "*": "00000 10101 01110 11111 01110 10101 00000",
      "#": "01010 01010 11111 01010 11111 01010 01010",
      "(": "00010 00100 01000 01000 01000 00100 00010",
      ")": "01000 00100 00010 00010 00010 00100 01000",
      "[": "01110 01000 01000 01000 01000 01000 01110",
      "]": "01110 00010 00010 00010 00010 00010 01110",
      "<": "00010 00100 01000 10000 01000 00100 00010",
      ">": "01000 00100 00010 00001 00010 00100 01000",
      "°": "01100 10010 01100 00000 00000 00000 00000",
      "·": "00000 00000 00000 01100 01100 00000 00000",
      "|": "00100 00100 00100 00100 00100 00100 00100",
    };
    const out = {};
    for (const c in raw) out[c] = raw[c].split(" ").map(r => parseInt(r, 2));
    // aliases: em dash / ellipsis pieces / multiplication sign
    out["—"] = out["-"]; out["–"] = out["-"]; out["×"] = out["X"];
    return out;
  })();
  const UML = { "Ä": "A", "Ö": "O", "Ü": "U" };

  const pxWidth = t => String(t).length * FADV - 1;

  function pxGlyph(ch, x, top) {
    const g = GLYPHS[ch];
    if (!g) return;
    for (let r = 0; r < FH; r++) {
      const bits = g[r];
      if (!bits) continue;
      let run = 0;                                     // merge horizontal runs
      for (let c = 0; c <= FW; c++) {
        const on = c < FW && (bits & (1 << (FW - 1 - c)));
        if (on) run++;
        else if (run) { ctx.fillRect(x + c - run, top + r, run, 1); run = 0; }
      }
    }
  }

  function pxRun(s, x, top) {
    let cx = x;
    for (let i = 0; i < s.length; i++) {
      const ch = s[i], base = UML[ch];
      pxGlyph(base || ch, cx, top);
      if (base) { ctx.fillRect(cx + 1, top - 2, 1, 1); ctx.fillRect(cx + 3, top - 2, 1, 1); }
      cx += FADV;
    }
  }

  /**
   * Draw pixel text. `y` is the BASELINE (the glyph box sits at y-FH … y-1), so
   * call sites written against the old fillText API keep their vertical offsets.
   * opts: {center, outline, plain}
   */
  function pxText(text, x, y, color, opts) {
    const o = opts || {};
    const s = String(text).toUpperCase();
    const sx = Math.round(o.center ? x - pxWidth(s) / 2 : x);
    const top = Math.round(y) - FH;
    if (o.outline) {
      // 4-way outline: needed for floaters and readouts that fly over any scenery
      ctx.fillStyle = "#05070d";
      pxRun(s, sx - 1, top); pxRun(s, sx + 1, top);
      pxRun(s, sx, top - 1); pxRun(s, sx, top + 1);
    } else if (!o.plain) {
      ctx.fillStyle = "rgba(5,7,13,0.85)";
      pxRun(s, sx + 1, top + 1);
    }
    ctx.fillStyle = color || PAL.white;
    pxRun(s, sx, top);
  }

  const tinyText = (t, x, y, c) => pxText(t, x, y, c);
  const tinyTextC = (t, x, y, c) => pxText(t, x, y, c, { center: true });

  /* --- animated backdrops for the non-playing states --- */
  function renderTitleBackdrop() {
    Game.frame++;
    const g = ctx.createLinearGradient(0, 0, 0, CFG.H);
    g.addColorStop(0, PAL.bg0); g.addColorStop(1, PAL.bg2);
    ctx.fillStyle = g; ctx.fillRect(0, 0, CFG.W, CFG.H);
    ctx.strokeStyle = "rgba(255,107,0,0.5)"; ctx.lineWidth = 1;
    const horizon = CFG.H * 0.55;
    for (let i = 0; i < 12; i++) {
      const y = horizon + Math.pow(i / 12, 2) * (CFG.H - horizon);
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(CFG.W, y); ctx.stroke();
    }
    const scroll = (Game.frame * 0.6) % 80;
    for (let i = -7; i <= 7; i++) {
      ctx.beginPath(); ctx.moveTo(CFG.W / 2, horizon);
      ctx.lineTo(CFG.W / 2 + i * 80 + scroll, CFG.H); ctx.stroke();
    }
    ctx.fillStyle = PAL.orange;
    ctx.beginPath(); ctx.arc(CFG.W / 2, horizon - 6, 30, Math.PI, 0); ctx.fill();
    ctx.fillStyle = PAL.bg0;
    for (let i = 0; i < 5; i++) ctx.fillRect(CFG.W / 2 - 30, horizon - 6 + i * 5, 60, 1 + i);
  }

  function renderBossBackdrop() {
    Game.frame++;
    ctx.fillStyle = "#05070D"; ctx.fillRect(0, 0, CFG.W, CFG.H);
    // falling data columns: the export stream you are racing
    for (let i = 0; i < 26; i++) {
      const x = i * 19 + 4;
      const speed = 1 + (i % 5) * 0.5;
      const y = ((Game.frame * speed + i * 47) % (CFG.H + 60)) - 30;
      ctx.fillStyle = i % 4 === 0 ? "rgba(52,211,153,0.55)" : "rgba(34,211,238,0.28)";
      for (let j = 0; j < 5; j++) {
        pxGlyph(String((i * 7 + j * 3 + (Game.frame >> 3)) % 10), x, (y - j * 10) | 0);
      }
    }
    ctx.fillStyle = "rgba(255,107,0,0.10)";
    ctx.fillRect(0, CFG.H / 2 - 40, CFG.W, 80);
  }

  function renderPrologueBackdrop() {
    Game.frame++;
    ctx.fillStyle = PAL.bg0; ctx.fillRect(0, 0, CFG.W, CFG.H);
    // The pump with its plate sits in the lower left; the readable close-up is the
    // DOM plate in the panel. Centring both put one on top of the other.
    const w = 150, h = 66, x = 22, y = CFG.H - h - 26;
    const rg = ctx.createRadialGradient(CFG.W / 2, y + h / 2, 20, CFG.W / 2, y + h / 2, 190);
    rg.addColorStop(0, "rgba(255,232,180,0.20)");
    rg.addColorStop(1, "rgba(255,232,180,0)");
    ctx.fillStyle = rg; ctx.fillRect(0, 0, CFG.W, CFG.H);
    ctx.fillStyle = "#9aa1ad"; ctx.fillRect(x, y, w, h);
    ctx.fillStyle = "#6f7682"; ctx.fillRect(x, y, w, 3);
    ctx.fillStyle = "#464c57"; ctx.fillRect(x + 4, y + 4, w - 8, h - 8);
    ctx.fillStyle = PAL.metalHi;
    [[x + 6, y + 6], [x + w - 10, y + 6], [x + 6, y + h - 10], [x + w - 10, y + h - 10]]
      .forEach(p => ctx.fillRect(p[0], p[1], 4, 4));
    const pr = Game.prologue;
    pxText("WILO SE DORTMUND", x + 10, y + 18, "#dfe5ee", { plain: true });
    pxText("STRATOS 40/1-8", x + 10, y + 30, "#c3cbd8", { plain: true });
    pxText("0,55 KW  2018", x + 10, y + 42, "#c3cbd8", { plain: true });
    pxText("SN " + (pr ? pr.code : ""), x + 10, y + 58, PAL.yellow, { outline: true });
    // pump body under the plate, so it reads as an installed unit
    ctx.fillStyle = "#2b3346"; ctx.fillRect(x + 18, y + h, w - 36, 22);
    ctx.fillStyle = "#3b4459"; ctx.fillRect(x + 18, y + h, w - 36, 3);
    ctx.fillStyle = "#1b2130"; ctx.fillRect(x + 40, y + h + 22, w - 80, 4);
    if (pr && pr.shake > 0) pr.shake--;
  }

  /* ---------------------------------------------------------------------------
     17. HUD
  --------------------------------------------------------------------------- */
  const overlay = document.getElementById("at-overlay");
  const panel = document.getElementById("at-panel-content");
  const el = id => document.getElementById(id);
  const elLevel = el("at-level"), elScore = el("at-score"), elData = el("at-data"),
        elQual = el("at-qual"), elTime = el("at-time"), elStatus = el("at-status");

  function setStatus(t) { if (elStatus) elStatus.textContent = t; }

  function showOverlay(html, cls) {
    panel.className = "at-panel" + (cls ? " " + cls : "");
    panel.innerHTML = html;
    overlay.classList.add("at-overlay--visible");
  }
  function hideOverlay() {
    overlay.classList.remove("at-overlay--visible");
    panel.innerHTML = "";
  }

  const hudEl = document.getElementById("at-hud");
  const HUD_STATES = { playing: 1, task: 1, explain: 1, paused: 1, levelDone: 1, boss: 1 };

  function updateHUD() {
    // the HUD only means something while a level is running — hide it behind
    // full-screen panels (title, prologue, briefing, report) instead of dimming it
    const show = !!HUD_STATES[Game.state];
    if (hudEl) hudEl.style.opacity = show ? "1" : "0";
    if (!show) return;
    const s = Game.stats;
    if (!s) return;
    if (elLevel) elLevel.textContent = Game.state === "boss" || Game.state === "bossIntro"
      ? "BOSS" : (Game.lvl ? Game.lvl.name.slice(0, 2) : "--") + "/03";
    if (elScore) elScore.textContent = pad(Game.score, 6);
    if (elData) elData.textContent = s.captured + "/" + s.total;
    const answered = s.good + s.bad;
    if (elQual) {
      const q = answered ? Math.round(s.good / answered * 100) : 100;
      elQual.textContent = q + "%";
      elQual.style.color = q >= 90 ? PAL.green : q >= 70 ? PAL.yellow : PAL.red;
    }
    if (elTime) {
      const showBoss = Game.state === "boss" || Game.state === "bossIntro" ||
        (Game.task && Game.task.boss) || (Game.explain && Game.explain.boss);
      elTime.textContent = showBoss ? "REC " + (Game.boss ? Game.boss.i : 0) + "/" + CFG.BOSS_RECORDS
                                    : fmtTime(Game.timeLeft);
      elTime.style.color = (!showBoss && Game.timeLeft <= 20) ? PAL.red : PAL.orange;
    }
  }

  /* ---------------------------------------------------------------------------
     18. DOM OVERLAYS
  --------------------------------------------------------------------------- */
  function renderTitlePanel() {
    // Drop any leftover juice from the previous run so frozen particles/floaters
    // don't sit in memory (or get drawn on top of the title backdrop) until the
    // next loadLevel. loadLevel clears them too; this covers the report→title path.
    Game.particles = []; Game.floaters = [];
    const hs = HighScore.load();
    const hsHTML = hs.length
      ? hs.map((h, i) => `<div><span class="at-rank">${i + 1}.</span>${esc(h.initials)}<span class="at-badge at-badge--${h.rank || "D"}">${esc(h.rank || "-")}</span><span class="at-sc">${h.score}</span></div>`).join("")
      : `<div class="at-dim">--- keine einträge ---</div>`;
    showOverlay(`
      <h1>ASSETTRACE</h1>
      <h2>THE HANDOVER QUEST</h2>
      <p class="at-dim">// FM DATA CAPTURE PROTOCOL v${CFG.VERSION} //</p>
      <p>3 Ebenen, ${TOTAL_ASSETS} Anlagen, ein Übergabetermin.</p>
      <p class="at-dim">Die Uhr läuft rückwärts. Jeder Fehler kostet Sekunden,
      jeder saubere Scan bringt welche zurück.</p>
      <p style="margin-top:8px">
        <span class="at-keys">A/D</span> laufen &nbsp;
        <span class="at-keys">W</span> springen &nbsp;
        <span class="at-keys">SPACE</span> scannen &nbsp;
        <span class="at-keys">F</span> lampe &nbsp;
        <span class="at-keys">1-4</span> antworten
      </p>
      <button class="at-btn" id="at-start">INSERT COIN / START</button>
      <button class="at-btn at-btn--ghost" id="at-skip">PROLOG ÜBERSPRINGEN</button>
      <p class="at-dim" style="margin-top:8px">BESTENLISTE</p>
      <div class="at-hs-list">${hsHTML}</div>
    `);
    el("at-start").onclick = () => startRun(true);
    el("at-skip").onclick = () => startRun(false);
  }

  /* --- P0-c: manual mode. Type the serial by hand and get measured. --- */
  function startPrologue() {
    const code = "4471 8093 26";
    Game.prologue = {
      code, digits: code.replace(/\D/g, ""),
      typed: "", t: 0, typos: 0, done: false, shake: 0,
    };
    Game.state = "prologue";
    Input.onDigit(d => onPrologueDigit(d));
    renderProloguePanel();
  }

  function onPrologueDigit(d) {
    const pr = Game.prologue;
    if (!pr || pr.done) return;
    const expect = pr.digits[pr.typed.length];
    if (d === expect) {
      pr.typed += d;
      Audio.SFX.type();
      if (pr.typed.length >= pr.digits.length) finishPrologue();
      else updateProlgueLine();
    } else {
      pr.typos++;
      pr.shake = 8;
      Audio.SFX.typo();
      updateProlgueLine();
    }
  }

  function renderProloguePanel() {
    const keypad = Input.isTouch()
      ? `<div class="at-keypad">${[1,2,3,4,5,6,7,8,9,0].map(n =>
          `<button class="at-key" data-d="${n}">${n}</button>`).join("")}</div>`
      : `<p class="at-dim">Tippe die Ziffern auf der Tastatur.</p>`;
    // The plate is rendered in the DOM, not only on the canvas: the player has to be
    // able to READ the serial they are copying, at any screen size.
    showOverlay(`
      <p class="at-cyan">// SCHRITT 0 — SO LÄUFT ES HEUTE //</p>
      <h2>MANUELLE ERFASSUNG</h2>
      <p>Kein Scanner. Kein CAFM-Import. Nur du, das Typenschild und Excel.</p>
      <div class="at-np">
        <div class="at-np-brand">WILO SE &middot; DORTMUND</div>
        <div class="at-np-row"><span>TYP</span><span>STRATOS 40/1-8</span></div>
        <div class="at-np-row"><span>P2</span><span>0,55 kW &middot; 2018</span></div>
        <div class="at-np-sn">SN ${Game.prologue.code}</div>
      </div>
      <p><span class="at-orange">Übertrage die Seriennummer:</span></p>
      <div class="at-serial" id="at-serial"></div>
      <p class="at-dim" id="at-prostat">0,0 s · 0 Tippfehler</p>
      ${keypad}
      <button class="at-btn at-btn--ghost" id="at-proskip">ÜBERSPRINGEN</button>
    `, "at-panel--prologue");
    document.querySelectorAll(".at-key").forEach(b =>
      b.addEventListener("click", () => onPrologueDigit(b.getAttribute("data-d"))));
    el("at-proskip").onclick = () => { Game.prologue.typos = 2; Game.prologue.t = 22; finishPrologue(); };
    updateProlgueLine();
  }

  function updateProlgueLine() {
    const pr = Game.prologue;
    const box = el("at-serial");
    if (!box || !pr) return;
    const total = pr.digits.length;
    let html = "";
    for (let i = 0; i < total; i++) {
      const ch = i < pr.typed.length ? pr.typed[i] : "_";
      const cls = i < pr.typed.length ? "at-s-ok" : (i === pr.typed.length ? "at-s-cur" : "at-s-todo");
      html += `<span class="${cls}">${ch}</span>`;
      if (i === 3 || i === 7) html += `<span class="at-s-sep"> </span>`;
    }
    box.innerHTML = html;
    box.className = "at-serial" + (pr.shake > 0 ? " at-shake" : "");
    const st = el("at-prostat");
    if (st) st.innerHTML = pr.t.toFixed(1).replace(".", ",") + " s · " +
      `<span class="${pr.typos ? "at-red" : "at-dim"}">${pr.typos} Tippfehler</span>`;
  }

  function finishPrologue() {
    const pr = Game.prologue;
    pr.done = true;
    Input.onDigit(null);
    const secs = Math.max(4, pr.t);
    Game.stats.manualSecPerAsset = secs;
    Game.stats.typos = pr.typos;
    const days = (secs * CFG.BUILDING_ASSETS) / 3600 / 8;
    Audio.SFX.levelup();
    Tracking.send("prologue_done", { seconds: +secs.toFixed(1), typos: pr.typos });
    showOverlay(`
      <p class="at-cyan">// MESSUNG //</p>
      <h2>${secs.toFixed(1).replace(".", ",")} s FÜR <span class="at-orange">EINE</span> ANLAGE</h2>
      <p>${pr.typos} Tippfehler. Bei einem Gebäude mit
         <span class="at-orange">${CFG.BUILDING_ASSETS} Anlagen</span> sind das</p>
      <h1>${days.toFixed(1).replace(".", ",")} ARBEITSTAGE</h1>
      <p class="at-dim">Nur Abtippen. Ohne Prüfung, ohne Klassifizierung, ohne Fotos sortieren.</p>
      <p class="at-green" style="margin-top:10px">&gt;&gt; SCANNER FREIGESCHALTET &lt;&lt;</p>
      <button class="at-btn" id="at-go">WEITER</button>
    `);
    el("at-go").onclick = () => { Game.state = "briefing"; renderBriefing(0); };
    Game.state = "prologueDone";
  }

  function renderBriefing(i) {
    const L = LEVELS[i];
    showOverlay(`
      <p class="at-cyan">// EINSATZBESPRECHUNG //</p>
      <h2>${esc(L.name)}</h2>
      ${L.brief.map(b => `<p>${esc(b)}</p>`).join("")}
      <div class="at-brief-grid">
        <div><span class="at-dim">ANLAGEN</span><br><span class="at-orange">${L.assets.length}</span></div>
        <div><span class="at-dim">ZEIT BIS ÜBERGABE</span><br><span class="at-orange">${fmtTime(L.time)}</span></div>
        <div><span class="at-dim">LICHT</span><br><span class="at-orange">${L.darkzones.length ? "DUNKELZONEN" : "OK"}</span></div>
      </div>
      <p class="at-dim" style="margin-top:8px">${briefHints(L)}</p>
      <button class="at-btn" id="at-brief-go">LOS</button>
    `);
    el("at-brief-go").onclick = () => beginLevel(i);
  }

  function briefHints(L) {
    const kinds = new Set(L.assets.map(a => a.challenge));
    const hints = [];
    if (kinds.has("focus")) hints.push("TYP = Typenschild unscharf: SCAN halten und im Boden-Marker stehen bleiben.");
    if (L.darkzones.length) hints.push("Dunkelzonen: Lampe mit [F] — der Akku läuft dabei leer.");
    if (kinds.has("obstructed")) hints.push("ROHR = Sichtlinie verdeckt: auf Anlagenhöhe klettern.");
    if (kinds.has("steam")) hints.push("DAMPF = zwischen zwei Stößen scannen, Kontakt verbrennt.");
    if (kinds.has("defect")) hints.push("MANGEL = Fadenkreuz auf der Korrosionsstelle stoppen.");
    return hints.join(" · ");
  }

  function beginLevel(i) {
    loadLevel(i);
    Game.state = "playing";
    hideOverlay();
    setStatus("ERFASSUNG LÄUFT — " + Game.lvl.name);
    Tracking.send("level_start", { level: Game.lvl.name, time: Game.lvl.time });
  }

  function renderPausePanel() {
    showOverlay(`
      <h2>-- PAUSE --</h2>
      <p class="at-dim">Die Uhr steht. In der Realität nicht.</p>
      <button class="at-btn" id="at-resume">WEITER</button>
      <button class="at-btn at-btn--ghost" id="at-quit">ABBRECHEN</button>
    `);
    el("at-resume").onclick = resumeRun;
    el("at-quit").onclick = () => { Game.state = "title"; renderTitlePanel(); setStatus("SYSTEM READY"); };
  }

  /* --- the knowledge task terminal (also used by the boss round) --- */
  function renderTaskPanel() {
    const t = Game.task;
    if (!t) return;
    const q = t.q;
    const a = t.asset;
    const label = t.label || (a && a.label) || "";
    const fields = a && a.data
      ? Object.keys(a.data).map(k =>
          `<div><span class="at-dim">${esc(k.replace(/_/g, " "))}</span><span class="at-cyan">${esc(a.data[k])}</span></div>`).join("")
      : "";

    let visual = "";
    if (q.meter) {
      visual = `<div class="at-meter">${q.meter.split("").map((d, i) =>
        `<span class="at-roll ${i === q.meter.length - 1 ? "at-roll--red" : ""}">${d}</span>`).join("")}
        <span class="at-unit">${esc(q.unit || "")}</span></div>`;
    } else if (q.plate) {
      visual = `<div class="at-plate"><span class="at-plate-top">NÄCHSTE PRÜFUNG</span>
        <span class="at-plate-date">${esc(q.plate)}</span>
        <span class="at-plate-bot">HEUTE ${TODAY.label}</span></div>`;
    }

    const optClass = q.opts.length === 2 ? "at-opts at-opts--2" : "at-opts";
    showOverlay(`
      <div class="at-terminal">
        <div class="at-term-head">
          <span class="at-cyan">${t.boss ? "// CAFM-EXPORT — DATENSATZ " + t.record + "/" + CFG.BOSS_RECORDS + " //" : "// AI-AUSWERTUNG // KI-KONFIDENZ 0.97 //"}</span>
        </div>
        <h2>${esc(label)}</h2>
        ${fields ? `<div class="at-fields">${fields}</div>` : ""}
        ${visual}
        <p class="at-ask">${esc(q.ask)}</p>
        <div class="${optClass}" id="at-opts">
          ${q.opts.map((o, i) => `<button class="at-opt" data-i="${i}"><b>${i + 1}</b> ${esc(o)}</button>`).join("")}
        </div>
        <div class="at-timer-bar"><div class="at-timer-fill" id="at-tfill"></div></div>
        <p class="at-dim">Richtig = +${CFG.TASK_BONUS} &amp; sauberer Datensatz ·
           Falsch = <span class="at-red">BAD DATA</span>${t.boss ? "" : " &amp; -" + CFG.PENALTY_WRONG + "s"}</p>
      </div>
    `, "at-panel--task");
    document.querySelectorAll(".at-opt").forEach(b =>
      b.addEventListener("click", () => answerTask(+b.getAttribute("data-i"))));
    updateTaskTimer();
  }

  function updateTaskTimer() {
    const t = Game.task, f = el("at-tfill");
    if (!t || !f) return;
    const pct = clamp(t.time / t.max, 0, 1);
    f.style.width = (pct * 100) + "%";
    f.style.background = pct > 0.4 ? "linear-gradient(90deg,#FF6B00,#22D3EE)" : "#EF4444";
  }

  function renderExplainPanel() {
    const ex = Game.explain;
    if (!ex) return;
    showOverlay(`
      <div class="at-explain ${ex.ok ? "at-explain--ok" : "at-explain--bad"}">
        <h2>${ex.ok ? "DATENSATZ SAUBER" : "BAD DATA"}</h2>
        <p class="at-dim">${esc(CAT_LABELS[ex.kind] || "")}</p>
        <p>${esc(ex.q.why)}</p>
        ${ex.ok ? "" : `<p class="at-red">Richtig wäre: ${esc(ex.q.opts[ex.q.correct])}</p>`}
        <p class="at-dim at-tiny">[ SPACE ] weiter</p>
      </div>
    `, "at-panel--explain");
  }

  function renderLevelDonePanel(bonus, left) {
    const s = Game.stats;
    showOverlay(`
      <p class="at-green">// EBENE ABGESCHLOSSEN //</p>
      <h2>${esc(Game.lvl.name)}</h2>
      <p>Alle ${Game.lvl.assets.length} Anlagen erfasst.</p>
      <p>ZEIT ÜBRIG <span class="at-cyan">${fmtTime(left)}</span>
         → BONUS <span class="at-orange">+${bonus}</span></p>
      <p>DATENQUALITÄT <span class="${s.bad ? "at-orange" : "at-green"}">${s.good}/${s.good + s.bad}</span>
         ${s.bad ? `<span class="at-red">(${s.bad} BAD DATA)</span>` : ""}</p>
      <p>SCORE <span class="at-orange">${pad(Game.score, 6)}</span></p>
      <button class="at-btn" id="at-next">${Game.lvlIndex + 1 < LEVELS.length ? "NÄCHSTE EBENE" : "ÜBERGABETERMIN"}</button>
    `);
    el("at-next").onclick = nextLevel;
  }

  function renderBossIntro() {
    showOverlay(`
      <h1>DER ÜBERGABETERMIN</h1>
      <p class="at-cyan">// 11:00 UHR — CAFM-EXPORT LÄUFT //</p>
      <p>${CFG.BOSS_RECORDS} Datensätze gehen jetzt raus. Jeder falsche Datensatz
         bleibt <span class="at-red">für 20 Jahre</span> im System.</p>
      <p class="at-dim">Die Zeit pro Datensatz wird kürzer. Antworten mit
         <span class="at-keys">1-4</span> oder Klick.</p>
      <button class="at-btn" id="at-boss-go">EXPORT STARTEN</button>
    `);
    el("at-boss-go").onclick = () => { Game.state = "boss"; bossNext(null); };
  }

  /* The report is deliberately two pages: page 1 is the verdict, page 2 is the
     business case and the CTA. One long scrolling panel pushed the CTA below the
     fold of a 16:9 stage, where nobody saw it. */
  function renderReportPanel() { renderReportPage1(); }

  function renderReportPage1() {
    const r = Game.report, s = Game.stats;
    const cats = Object.keys(CAT_LABELS)
      .filter(k => s.cat[k] && (s.cat[k].ok + s.cat[k].fail) > 0)
      .map(k => {
        const g = grade(s.cat[k]);
        return `<div class="at-cat"><span>${CAT_LABELS[k]}</span>
          <span class="at-dim">${s.cat[k].ok}/${s.cat[k].ok + s.cat[k].fail}</span>
          <span class="${g.cls} at-cat-g">${g.g}</span></div>`;
      }).join("");

    const missing = s.missing.length
      ? `<div class="at-report-block at-report-block--bad">
           <p class="at-red">NICHT ERFASST — ${s.missing.length} ANLAGEN OHNE DATENSATZ</p>
           <div class="at-list">${s.missing.slice(0, 8).map(m =>
             `<div>${esc(m.label)} <span class="at-dim">${esc(m.level)}</span></div>`).join("")}
             ${s.missing.length > 8 ? `<div class="at-dim">… +${s.missing.length - 8} weitere</div>` : ""}</div>
           <p class="at-dim at-tiny">Diese Anlagen tauchen im CAFM nie auf. Niemand wartet sie.</p>
         </div>` : "";

    const bad = s.badList.length
      ? `<div class="at-report-block at-report-block--bad">
           <p class="at-red">FALSCH STRUKTURIERT — ${s.badList.length} DATENSÄTZE</p>
           <div class="at-list">${s.badList.slice(0, 6).map(b =>
             `<div>${esc(b.label)}: <span class="at-red">${esc(b.given)}</span>
              <span class="at-dim">statt</span> <span class="at-green">${esc(b.right)}</span></div>`).join("")}
             ${s.badList.length > 6 ? `<div class="at-dim">… +${s.badList.length - 6} weitere</div>` : ""}</div>
         </div>` : `<div class="at-report-block"><p class="at-green">KEIN EINZIGER FEHLERHAFTER DATENSATZ — AUDIT-SAFE</p></div>`;

    const failed = r.reason === "timeout";
    showOverlay(`
      <div class="at-rep-body">
      <h1 class="${failed ? "at-h1-fail" : ""}">${failed ? "ÜBERGABE ERZWUNGEN" : "HANDOVER COMPLETE"}</h1>
      <p class="at-dim">${failed
        ? "Der Termin war der Termin. Was jetzt nicht im CAFM steht, ist weg."
        : "Vollständig, strukturiert, im Zeitrahmen."}</p>

      <div class="at-rankrow">
        <div class="at-badge at-badge--${r.rank} at-badge--big">${r.rank}</div>
        <div class="at-rankmeta">
          <div><span class="at-dim">HANDOVER-SCORE</span> <span class="at-orange">${r.handover}/100</span></div>
          <div><span class="at-dim">VOLLSTÄNDIGKEIT</span> <span class="at-cyan">${Math.round(r.completeness * 100)}%</span></div>
          <div><span class="at-dim">DATENQUALITÄT</span> <span class="${s.bad ? "at-orange" : "at-green"}">${Math.round(r.quality * 100)}%</span></div>
          <div><span class="at-dim">SCORE</span> <span class="at-orange">${pad(Game.score, 6)}</span>
               <span class="at-dim">· COMBO x${(1 + Math.min(Game.bestCombo, CFG.COMBO_MAX) * 0.2).toFixed(1)}</span></div>
        </div>
      </div>
      ${r.rank === "S" ? `<p class="at-green">RANG S — AUDIT-SAFE: vollständig, fehlerfrei, fristgerecht.</p>` : ""}

      <p class="at-cyan" style="margin-top:8px">KATEGORIEN</p>
      <div class="at-cats">${cats || `<div class="at-dim">keine daten</div>`}</div>

      ${missing}
      ${bad}
      </div>
      <div class="at-rep-foot">
        <button class="at-btn" id="at-page2">BILANZ &amp; HOCHRECHNUNG &raquo;</button>
        ${failed ? `<button class="at-btn at-btn--ghost" id="at-retry">EBENE WIEDERHOLEN</button>` : ""}
      </div>
    `, "at-panel--report");
    el("at-page2").onclick = renderReportPage2;
    // a failed run's most likely next action belongs here, not one page deeper
    if (failed && el("at-retry")) el("at-retry").onclick = retryLevel;
  }

  function renderReportPage2() {
    const r = Game.report, s = Game.stats;
    const failed = r.reason === "timeout";
    showOverlay(`
      <div class="at-rep-body">
      <p class="at-cyan">// BILANZ // RANG
         <span class="at-badge at-badge--${r.rank}">${r.rank}</span>
         SCORE <span class="at-orange">${pad(Game.score, 6)}</span></p>

      <div class="at-report-block at-report-block--sell">
        <p class="at-cyan">// HOCHRECHNUNG AUF ${CFG.BUILDING_ASSETS} ANLAGEN //</p>
        ${s.captured === 0 ? `
        <p class="at-red">Kein einziger Datensatz — nichts hochzurechnen.</p>
        <p class="at-dim">Manuell wären es ${r.manualDays.toFixed(1).replace(".", ",")} Arbeitstage.
           Genau deshalb bleibt die Erfassung liegen.</p>
        ` : `
        <div class="at-compare">
          <div><span class="at-dim">MANUELL — ABTIPPEN</span><br>
            <span class="at-red">${(r.manualRecord / 60).toFixed(1).replace(".", ",")} min/Anlage</span><br>
            <span class="at-red">${r.manualDays.toFixed(1).replace(".", ",")} Arbeitstage</span></div>
          <div class="at-arrow">&rarr;</div>
          <div><span class="at-dim">SCAN + STRUKTURIEREN</span><br>
            <span class="at-green">${r.perAsset.toFixed(1).replace(".", ",")} s/Anlage</span><br>
            <span class="at-green">${r.scanDays.toFixed(1).replace(".", ",")} Arbeitstage</span></div>
        </div>
        <p class="at-green">FAKTOR ${Math.round(r.factor)}× · ≈ ${r.savedHours} Stunden gespart${s.co2e ? ` · ${s.co2e.toFixed(1).replace(".", ",")} t CO₂e für Scope 1 erfasst` : ""}</p>
        <p class="at-dim at-tiny">Rechenweg: du hast <span class="at-orange">${r.manualField.toFixed(1).replace(".", ",")} s</span>
           für <span class="at-orange">ein Feld</span> gebraucht (Seriennummer, gemessen im Prolog).
           Ein CAFM-Datensatz hat ca. ${CFG.FIELDS_PER_RECORD} Felder →
           ${(r.manualRecord / 60).toFixed(1).replace(".", ",")} min je Anlage.
           Rechts dein im Spiel gemessenes Scan-Tempo. Beide Seiten ohne Laufweg.
           Gesamtlaufzeit: ${fmtTime(Game.elapsed)}${s.typos ? ` · ${s.typos} Tippfehler` : ""}.</p>
        `}
      </div>

      <p class="at-cyan">INITIALEN FÜR DIE BESTENLISTE</p>
      <input id="at-initials" class="at-initials" maxlength="3" value="INS" inputmode="text" />
      <button class="at-btn" id="at-submit">SPEICHERN</button>
      <div id="at-hs-area"></div>
      </div>
      <div class="at-rep-foot">
        <a class="at-btn" href="${landingURL()}" target="_blank" rel="noopener">ASSETTRACE LIVE ANSEHEN &raquo;</a>
        <button class="at-btn at-btn--ghost" id="at-replay">NOCHMAL</button>
        ${failed ? `<button class="at-btn at-btn--ghost" id="at-retry">EBENE WIEDERHOLEN</button>` : ""}
        <button class="at-btn at-btn--ghost at-btn--sm" id="at-page1">&laquo; BEFUND</button>
      </div>
    `, "at-panel--report");

    const inp = el("at-initials");
    inp.addEventListener("input", () => {
      inp.value = inp.value.replace(/[^A-Za-z0-9]/g, "").toUpperCase().slice(0, 3);
    });
    el("at-submit").onclick = () => {
      const initials = (inp.value || "INS").toUpperCase().slice(0, 3) || "INS";
      const board = HighScore.add({
        initials, score: Game.score, rank: r.rank, handover: r.handover,
        acc: Math.round(r.quality * 100), at: Date.now(),
      });
      el("at-hs-area").innerHTML =
        `<p class="at-cyan" style="margin-top:6px">BESTENLISTE</p>` +
        `<div class="at-hs-list">${board.map((h, i) =>
          `<div><span class="at-rank">${i + 1}.</span>${esc(h.initials)}<span class="at-badge at-badge--${h.rank || "D"}">${esc(h.rank || "-")}</span><span class="at-sc">${h.score}</span></div>`).join("")}</div>`;
      el("at-submit").disabled = true;
    };
    el("at-replay").onclick = () => startRun(false);
    el("at-page1").onclick = renderReportPage1;
    if (failed && el("at-retry")) el("at-retry").onclick = retryLevel;
  }

  function retryLevel() {
    const cp = Game.checkpoint;
    if (cp) {
      Game.score = cp.score;
      Game.elapsed = cp.elapsed;
      Game.stats = JSON.parse(JSON.stringify(cp.stats));
    }
    Game.report = null;
    // clear effects from the failed attempt; beginLevel→loadLevel clears them
    // again, but this keeps the briefing screen clean if the player lingers here.
    Game.particles = []; Game.floaters = [];
    Game.state = "briefing";
    renderBriefing(Game.lvlIndex);
  }

  function landingURL() {
    const base = window.ASSETTRACE_LANDING || "https://assettrace.example.com";
    const q = [];
    if (Tracking.utm.source) q.push("utm_source=" + encodeURIComponent(Tracking.utm.source));
    if (Tracking.utm.campaign) q.push("utm_campaign=" + encodeURIComponent(Tracking.utm.campaign));
    q.push("at_rank=" + (Game.report ? Game.report.rank : "-"));
    return base + (base.indexOf("?") >= 0 ? "&" : "?") + q.join("&");
  }

  /* ---------------------------------------------------------------------------
     19. GAME LOOP
  --------------------------------------------------------------------------- */
  let last = performance.now(), accTime = 0;
  const STEP = 1000 / 60;

  function frame(now) {
    let dt = now - last; last = now;
    if (dt > 250) dt = 250;
    accTime += dt;
    let guard = 0;
    while (accTime >= STEP && guard++ < 8) { tick(); accTime -= STEP; }
    draw();
    updateHUD();
    Input.clearEdges();
    requestAnimationFrame(frame);
  }

  function draw() {
    switch (Game.state) {
      case "title": renderTitleBackdrop(); break;
      case "prologue":
      case "prologueDone": renderPrologueBackdrop(); break;
      case "bossIntro":
      case "boss": renderBossBackdrop(); break;
      case "briefing":
        if (Game.lvl) render(); else renderTitleBackdrop();
        break;
      default:
        if (Game.lvl) render(); else renderTitleBackdrop();
    }
    // the boss terminal keeps streaming behind its own quiz panel
    if ((Game.state === "task" || Game.state === "explain") &&
        ((Game.task && Game.task.boss) || (Game.explain && Game.explain.boss))) {
      renderBossBackdrop();
    }
  }

  function tick() {
    // prologue: the clock the player is being measured against
    if (Game.state === "prologue") {
      Game.prologue.t += STEP / 1000;
      if (Game.frame % 6 === 0) updateProlgueLine();
      Game.frame++;
      return;
    }
    if (Game.state === "title" || Game.state === "briefing" || Game.state === "paused" ||
        Game.state === "levelDone" || Game.state === "report" || Game.state === "bossIntro" ||
        Game.state === "prologueDone") return;

    Game.frame++;

    if (Game.state === "explain") {
      const ex = Game.explain;
      ex.time -= STEP / 1000;
      if (ex.time <= 0 || Input.pressed("scan") || Input.pressed("jump")) afterExplain();
      stepEffects();
      return;
    }

    if (Game.state === "task") {
      const t = Game.task;
      if (t && !t.answered) {
        if (!t.boss) Game.stats.captureSeconds += STEP / 1000;   // structuring counts too
        t.time -= STEP / 1000;
        updateTaskTimer();
        if (t.time <= 1.5 && Game.frame % 20 === 0) Audio.SFX.tick();
        const keys = ["cA", "cB", "cC", "cD"];
        for (let i = 0; i < Math.min(4, t.q.opts.length); i++)
          if (Input.pressed(keys[i])) { answerTask(i); break; }
        if (t.time <= 0) answerTask(-1);      // no answer = wrong = bad data
      }
      stepEffects();
      return;
    }

    if (Game.state === "playing") {
      if (Input.pressed("pause")) { pauseRun(); return; }
      if (Game.hitstop > 0) { Game.hitstop--; stepEffects(); return; }

      Game.timeLeft -= STEP / 1000;
      Game.elapsed += STEP / 1000;
      if (Game.timeLeft <= 20) {
        Audio.setIntensity(true);
        Game.lowTimeBeep -= STEP / 1000;
        if (Game.lowTimeBeep <= 0) { Audio.SFX.lowtime(); Game.lowTimeBeep = Game.timeLeft <= 8 ? 0.5 : 1; }
      } else Audio.setIntensity(false);
      if (Game.timeLeft <= 0) { Game.timeLeft = 0; endRun("timeout"); return; }

      physics(Game.player);
      updateScan();
      // only count time while an asset is actually being worked on
      if (Game.target) Game.stats.captureSeconds += STEP / 1000;
      handlePickups();
      stepEffects();
    }
  }

  function stepEffects() {
    for (let i = Game.particles.length - 1; i >= 0; i--) {
      const p = Game.particles[i];
      p.x += p.vx; p.y += p.vy; p.vy += (p.grav === undefined ? 0.06 : p.grav);
      if (--p.life <= 0) Game.particles.splice(i, 1);
    }
    for (let i = Game.floaters.length - 1; i >= 0; i--) {
      const f = Game.floaters[i];
      f.y -= 0.4;
      if (--f.life <= 0) Game.floaters.splice(i, 1);
    }
  }

  function handlePickups() {
    for (const pk of Game.lvl.pickups) {
      if (pk.taken) continue;
      if (!aabb(Game.player, pk)) continue;
      pk.taken = true;
      if (pk.type === "battery") {
        Game.battery = Math.min(CFG.BATTERY_MAX, Game.battery + CFG.BATTERY_PICKUP);
        Audio.SFX.battery();
        floater(pk.x, pk.y, "+" + CFG.BATTERY_PICKUP + "% AKKU", PAL.yellow);
      }
      Tracking.send("pickup", { id: pk.id, type: pk.type });
    }
  }

  function pauseRun() { Game.state = "paused"; renderPausePanel(); setStatus("PAUSE"); }
  function resumeRun() { Game.state = "playing"; hideOverlay(); setStatus("ERFASSUNG LÄUFT"); }

  /* ---------------------------------------------------------------------------
     20. BOOT
  --------------------------------------------------------------------------- */
  function startRun(withPrologue) {
    Audio.start();
    resetRun();
    Tracking.send("game_start", { prologue: !!withPrologue });
    if (withPrologue) startPrologue();
    else { Game.stats.manualSecPerAsset = 22; Game.state = "briefing"; renderBriefing(0); }
  }

  function boot() {
    Input.bindTouch();
    if (Input.isTouch()) document.body.classList.add("at-touch-device");
    const unlock = () => {
      Audio.start();
      window.removeEventListener("pointerdown", unlock);
      window.removeEventListener("keydown", unlock);
    };
    window.addEventListener("pointerdown", unlock);
    window.addEventListener("keydown", unlock);

    Game.stats = newStats();
    Game.state = "title";
    renderTitlePanel();
    setStatus("SYSTEM READY");
    requestAnimationFrame(frame);

    window.AssetTrace = {
      version: CFG.VERSION,
      start: () => startRun(true),
      startNoPrologue: () => startRun(false),
      reset: () => { Game.state = "title"; renderTitlePanel(); },
      on: (ev, cb) => { (window._atCb = window._atCb || {})[ev] = cb; },
      state: () => Game.state,
      utm: Tracking.utm,
      // ?debug=1 only: handles for automated testing / screenshots
      _dev: Tracking.debug ? { Game, CFG, LEVELS, beginLevel, startPrologue, endRun } : undefined,
    };
    Tracking.send("game_loaded", { touch: Input.isTouch(), levels: LEVELS.length, assets: TOTAL_ASSETS });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
