// lib.js - automm-ui's pure logic: no DOM, no network, no printer.
//
// Everything here takes plain data and returns plain data, so it can be unit
// tested with Node (see tests/lib.test.mjs) and reused by app.js in the
// browser. In the browser it is available as `window.AutommUI`; in Node as the
// module's exports.
//
// automm-ui is only a user interface. All measuring is done by
// Automm3AdaptivePA (https://github.com/Buddman69/Automm3AdaptivePA);
// this file only reads and presents the results it writes.

(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.AutommUI = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const VERSION = "1.0.0";

  // Layer height / line width per nozzle size - the same defaults Automm3AdaptivePA's wizard uses.
  const NOZZLE_GEOM = { "0.2": [0.10, 0.22], "0.4": [0.20, 0.42], "0.6": [0.24, 0.62], "0.8": [0.40, 0.82] };
  const MATERIALS = ["PLA", "PETG", "ABS", "ASA", "TPU", "PA", "PC", "PLA-CF", "PETG-CF", "PA-CF", "Other"];
  // A starting temperature per material; the user always confirms it.
  const MAT_TEMP = { PLA: 220, PETG: 245, ABS: 260, ASA: 260, TPU: 230, PA: 280, PC: 280, "PLA-CF": 230, "PETG-CF": 250, "PA-CF": 290, Other: 230 };
  const MAT_COLOR = { PLA: "#e8e4da", PETG: "#5b8bd6", ABS: "#d65b5b", ASA: "#c98a3c", TPU: "#59b07a", PA: "#bdb39a", PC: "#cfd8e2" };
  // Automm3AdaptivePA's flow search refuses anything outside 170-300 C.
  const TEMP_MIN = 170, TEMP_MAX = 300;
  // The calibration's stages, in order, as shown in the Live panel.
  const STAGES = [["prep", "Home / prepare"], ["1", "Max flow"], ["2", "Flow points"], ["3", "Pressure advance"],
    ["4", "Orca table"], ["cool", "Cool-down wipe"], ["done", "Done"]];
  const SLOT_NAMES = ["1A", "1B", "1C", "1D"];
  // Moonraker database namespace for filament names and colours.
  const DB_NS = "automm_ui";
  // Export files carry this id. "q2-calibration-ui" is what pre-release builds wrote.
  const EXPORT_APP = "automm-ui";
  const EXPORT_APPS_ACCEPTED = ["automm-ui", "q2-calibration-ui"];
  // Below this many frames per second the page switches itself to lite mode.
  const LITE_FPS = 35;
  const NAME_MAX = 60;

  // ------------------------------------------------------------------ text and colour

  const esc = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  function hexToRgb(h) {
    h = String(h).replace("#", "");
    if (h.length === 3) h = h.split("").map(c => c + c).join("");
    const n = parseInt(h, 16);
    return [n >> 16 & 255, n >> 8 & 255, n & 255];
  }
  // f < 0 darkens towards black, f > 0 lightens towards white; -1..1
  function shade(h, f) {
    const [r, g, b] = hexToRgb(h);
    const m = v => Math.max(0, Math.min(255, Math.round(f < 0 ? v * (1 + f) : v + (255 - v) * f)));
    return `rgb(${m(r)},${m(g)},${m(b)})`;
  }
  // "#AbC123" or "abc123" -> "#abc123"; anything else -> null
  function normHex(h) {
    if (!h) return null;
    h = String(h).replace("#", "");
    return /^[0-9a-f]{6}$/i.test(h) ? "#" + h.toLowerCase() : null;
  }
  function guessColor(name, material) {
    const n = (name || "").toLowerCase();
    const words = { black: "#1c1c1e", white: "#f2f2ee", red: "#d33a3a", green: "#3fae5a", blue: "#3a6fd3", yellow: "#f2c933",
      orange: "#f08a2c", pink: "#f28ab0", purple: "#8a4fd3", grey: "#8d9199", gray: "#8d9199", silver: "#c0c4cc",
      gold: "#d4a93a", clear: "#d6e6ee", natural: "#e6dcc6" };
    for (const [w, c] of Object.entries(words)) if (n.includes(w)) return c;
    return MAT_COLOR[material] || "#9aa0a8";
  }
  // A first guess at the material from the calibration temperature; the user can change it.
  const guessMaterial = t => t >= 275 ? "PA" : t >= 265 ? "ABS" : t >= 238 ? "PETG" : "PLA";

  // ------------------------------------------------------------------ calibration runs

  // A run's identity: its timestamp to the second, as a string. Names on the wall are keyed by it.
  const runKey = r => String(Math.round(r.time));

  // Parse auto_cal.json / auto_cal_bed.json (a list of {kind, time, payload}).
  // Anything that isn't a finished calibration is skipped, and a non-JSON reply
  // (nginx answers a missing file with Fluidd's index.html) gives an empty list.
  function parseRunsFile(text, where) {
    let d;
    try { d = JSON.parse(text); } catch (e) { return []; }
    if (!Array.isArray(d)) return [];
    return d.filter(e => e && typeof e.time === "number" && e.payload && typeof e.payload.qmax_mm3_s === "number"
      && typeof e.payload.centre_k === "number").map(e => Object.assign({}, e, { where }));
  }

  // Named runs grouped into filaments, newest run first, filaments sorted by their newest run.
  function groupLibrary(runs, labels, meta) {
    const by = new Map();
    for (const r of [...runs].sort((a, b) => b.time - a.time)) {
      const n = labels[runKey(r)];
      if (!n) continue;
      if (!by.has(n)) by.set(n, []);
      by.get(n).push(r);
    }
    return [...by.entries()].map(([name, rs]) => ({ name, runs: rs, latest: rs[0], m: (meta && meta[name]) || {} }))
      .sort((x, y) => y.latest.time - x.latest.time);
  }

  // After a calibration the page stores {name, t} as labels.pending; the first unnamed run
  // at or after t gets that name. Returns the new labels and which run was named (or null).
  function assignPending(runs, labels) {
    if (!labels || !labels.pending) return { labels, hitKey: null };
    const out = Object.assign({}, labels);
    const hit = [...runs].sort((a, b) => a.time - b.time).find(r => r.time >= out.pending.t && !out[runKey(r)]);
    if (!hit) return { labels: out, hitKey: null };
    out[runKey(hit)] = out.pending.name;
    delete out.pending;
    return { labels: out, hitKey: runKey(hit) };
  }

  const fmtNum = (v, d) => Number(v).toFixed(d);
  const geoText = p => p && p.geometry && p.geometry.layer_h != null && p.geometry.line_w != null
    ? `${fmtNum(p.geometry.layer_h, 2)} × ${fmtNum(p.geometry.line_w, 2)}` : "–";

  // The nozzle size whose default line width is closest (within 0.03 mm), else null.
  function nozzleFor(lineWidth) {
    let best = null, d = 9;
    for (const [n, g] of Object.entries(NOZZLE_GEOM)) {
      const dd = Math.abs(g[1] - lineWidth);
      if (dd < d) { d = dd; best = n; }
    }
    return d < 0.03 ? best : null;
  }

  // Orca rows are "PA,flow,accel" with each flow listed once per acceleration.
  // Returns one {q: flow, k: PA} per flow, sorted by flow.
  function pointsOf(payload) {
    const seen = new Map();
    for (const row of (payload && payload.rows) || []) {
      const [k, q] = String(row).split(",").map(Number);
      if (Number.isFinite(k) && Number.isFinite(q) && !seen.has(q)) seen.set(q, k);
    }
    return [...seen].map(([q, k]) => ({ q, k })).sort((a, b) => a.q - b.q);
  }

  // ------------------------------------------------------------------ QIDI Box

  // The Box's four slots from Klipper's save_variables (color_slotN, filament_slotN, slotN)
  // and box_extras.loaded_slot. filDb maps a QIDI filament id to {name, type, temps}.
  function readSlots(vars, loadedSlot, filDb) {
    vars = vars || {}; filDb = filDb || {};
    const out = [];
    for (let i = 0; i < SLOT_NAMES.length; i++) {
      const raw = vars["color_slot" + i];
      const color = normHex(Array.isArray(raw) ? raw[0] : raw);
      const fid = vars["filament_slot" + i];
      const fil = typeof fid === "string" ? filDb[fid] || null : null;
      const present = Number(vars["slot" + i]) > 0 && !!color;
      out.push({ i, name: SLOT_NAMES[i], color, fil, present, loaded: loadedSlot === "slot" + i });
    }
    return out;
  }
  const boxEnabled = vars => !!vars && (Number(vars.enable_box) === 1 || Number(vars.box_count) > 0);

  // QIDI's filament list (config/.qidi_filaments/filament-0.4.json) -> {id: {name, type, temps}}
  function parseFilamentDb(obj) {
    const out = {};
    for (const [name, p] of Object.entries(obj || {})) {
      if (p && p.filament_id) out[p.filament_id] = { name, type: p.type, temps: p.nozzle_temperature };
    }
    return out;
  }

  // A Box slot shows the calibration of the wall filament with the same colour and
  // (when both are known) the same material.
  function matchSlot(slot, library) {
    if (!slot || !slot.present) return null;
    return library.find(f => f.m.color && f.m.color.toLowerCase() === slot.color
      && (!slot.fil || !f.m.material || f.m.material === slot.fil.type)) || null;
  }

  // Middle of QIDI's recommended range, rounded to 5 C, else the material default.
  function slotTemp(fil) {
    if (fil && Array.isArray(fil.temps) && fil.temps.length === 2) {
      const t = (Number(fil.temps[0]) + Number(fil.temps[1])) / 2;
      if (Number.isFinite(t)) return Math.round(t / 5) * 5;
    }
    return MAT_TEMP[fil ? fil.type : "PLA"] || 220;
  }

  // ------------------------------------------------------------------ the calibration command

  // Builds the Automm3AdaptivePA command from the form values and says what is wrong, if anything.
  function buildCommand({ temp, layer, width, loc, blocks, points, dry }) {
    let err = "";
    if (!(temp >= TEMP_MIN && temp <= TEMP_MAX)) err = `Temperature must be ${TEMP_MIN}–${TEMP_MAX} °C (the flow search refuses anything above 300).`;
    else if (!(layer >= 0.05 && layer <= 1)) err = "Layer height must be 0.05–1 mm.";
    else if (!(width >= 0.1 && width <= 1.5)) err = "Line width must be 0.1–1.5 mm.";
    else if (![12, 20, 30].includes(Number(blocks))) err = "Precision must be 12, 20 or 30 blocks.";
    else if (![3, 5, 7].includes(Number(points))) err = "Table rows must be 3, 5 or 7.";
    const cmd = (loc === "bed" ? "QIDI_AUTO_CALIBRATE_BED" : "QIDI_AUTO_CALIBRATE")
      + ` TEMP=${Math.round(temp)} LAYER=${fmtNum(layer, 2)} WIDTH=${fmtNum(width, 2)} BLOCKS=${blocks} POINTS=${points}`
      + (dry ? " DRY=1" : "");
    return { cmd, err };
  }

  // ------------------------------------------------------------------ console lines

  // How the Live console colours a line: e(rror), s(tage), r(esult), c(other, dimmed) or "".
  function classifyLine(t) {
    t = String(t);
    if (t.startsWith("!!")) return "e";
    if (/----/.test(t) && /auto_cal/.test(t)) return "s";
    if (/max volumetric flow|WORKING MAX|paste into Orca|written to .*orca_pa/.test(t)) return "r";
    if (!/qidi|flow_ramp|flow_bed|auto_cal|pa_|cs_read|envelope/i.test(t)) return "c";
    return "";
  }
  // Which stage a console line starts: a STAGES id, "fail", or null.
  function stageFromLine(t) {
    t = String(t);
    let m;
    if (/auto_cal(_bed)?: ---- preparing/.test(t) || /auto_cal(_bed)?: full calibration/.test(t)) return "prep";
    if ((m = t.match(/auto_cal(?:_bed)?: ---- Stage (\d)/))) return m[1];
    if (/auto_cal(_bed)?: heater off, waiting/.test(t)) return "cool";
    if (/auto_cal(_bed)?: DRY - nothing heated/.test(t)) return "done";
    if (t.startsWith("!!")) return "fail";
    return null;
  }

  // ------------------------------------------------------------------ export / import

  function buildExport(runs, labels, meta, now) {
    const clean = Object.fromEntries(Object.entries(labels || {}).filter(([k]) => k !== "pending"));
    return {
      app: EXPORT_APP, version: 1, exported: (now || new Date()).toISOString(),
      labels: clean, meta: meta || {},
      // a copy of each named run's results, so the file is a readable backup on its own
      runs: runs.filter(r => clean[runKey(r)]).map(r => {
        const p = Object.assign({}, r.payload);
        delete p.block;   // Automm3AdaptivePA's printable text block, which repeats the numbers
        return Object.assign({ key: runKey(r), name: clean[runKey(r)], time: r.time, where: r.where }, p);
      }),
    };
  }

  // Validates an export and merges it into the current names/colours.
  // Throws an Error with a user-readable message when the file is not usable.
  function mergeImport(data, labels, meta, presentKeys) {
    if (!data || typeof data !== "object" || !EXPORT_APPS_ACCEPTED.includes(data.app)
        || !data.labels || typeof data.labels !== "object" || !data.meta || typeof data.meta !== "object") {
      throw new Error("That isn't a filament wall export.");
    }
    const outLabels = Object.assign({}, labels), outMeta = Object.assign({}, meta);
    const keys = Object.keys(data.labels).filter(k => k !== "pending" && /^\d+$/.test(k) && data.labels[k]);
    for (const k of keys) outLabels[k] = String(data.labels[k]).slice(0, NAME_MAX);
    for (const [n, m] of Object.entries(data.meta)) {
      if (!m || typeof m !== "object") continue;
      const entry = {};
      if (MATERIALS.includes(m.material)) entry.material = m.material;
      const c = normHex(m.color); if (c) entry.color = c;
      outMeta[String(n).slice(0, NAME_MAX)] = entry;
    }
    const present = new Set(presentKeys || []);
    return {
      labels: outLabels, meta: outMeta,
      summary: { filaments: new Set(keys.map(k => outLabels[k])).size, runs: keys.length,
        missing: keys.filter(k => !present.has(k)).length },
    };
  }

  // ------------------------------------------------------------------ lite mode

  const isSlowFps = (frames, ms) => frames > 5 && ms > 0 && frames * 1000 / ms < LITE_FPS;

  return {
    VERSION, NOZZLE_GEOM, MATERIALS, MAT_TEMP, MAT_COLOR, TEMP_MIN, TEMP_MAX, STAGES, SLOT_NAMES, DB_NS,
    EXPORT_APP, LITE_FPS, NAME_MAX,
    esc, hexToRgb, shade, normHex, guessColor, guessMaterial,
    runKey, parseRunsFile, groupLibrary, assignPending, geoText, nozzleFor, pointsOf,
    readSlots, boxEnabled, parseFilamentDb, matchSlot, slotTemp,
    buildCommand, classifyLine, stageFromLine, buildExport, mergeImport, isSlowFps,
  };
});
