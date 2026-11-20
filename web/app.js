"use strict";
// app.js - automm-ui's user interface: renders the page, talks to Moonraker, handles clicks.
//
// automm-ui is only a UI. The calibration itself (heating, extruding, reading the
// load cell, working out max flow and pressure advance) is Automm3AdaptivePA's work,
// by Buddman69: https://github.com/Buddman69/Automm3AdaptivePA
//
// Pure logic (no DOM, no network) lives in lib.js so it can be unit tested.
// See docs/DEVELOPMENT.md for how the pieces fit together.

const {
  VERSION, NOZZLE_GEOM, MATERIALS, MAT_TEMP, TEMP_MIN, TEMP_MAX, STAGES, DB_NS,
  esc, shade, normHex, guessColor, guessMaterial, runKey: key, parseRunsFile, groupLibrary, assignPending,
  geoText, nozzleFor, pointsOf, readSlots, boxEnabled, parseFilamentDb, matchSlot, slotTemp,
  buildCommand, classifyLine, stageFromLine, buildExport, mergeImport, isSlowFps,
} = window.AutommUI;
const $ = id => document.getElementById(id);
const EMBED = new URLSearchParams(location.search).has("embed");
if (EMBED) document.body.classList.add("embed");

// Lite mode: forced with ?lite=1, remembered when chosen with the button, otherwise decided by measuring the frame rate.
const LITE_KEY = "automm-ui.lite";
function litePref() { try { return localStorage.getItem(LITE_KEY); } catch (e) { return null; } }
let LITE = new URLSearchParams(location.search).get("lite") === "1" || litePref() === "1";
document.body.classList.toggle("lite", LITE);

// ---------------------------------------------------------------- spool artwork
// A cylinder along the Z axis built from flat strips, each shaded for a light at the upper left.
function cylinder(r, depth, n, colorAt) {
  const w = 2 * Math.PI * r / n + 0.8;
  let h = "";
  for (let i = 0; i < n; i++) {
    const a = i * 360 / n;
    h += `<i style="width:${w.toFixed(2)}px;height:${depth}px;left:${(-w / 2).toFixed(2)}px;top:${-depth / 2}px;background:${colorAt(a)};transform:rotateZ(${a}deg) translateY(${-r}px) rotateX(90deg)"></i>`;
  }
  return h;
}
const lit = a => (Math.cos((a + 45) * Math.PI / 180) + 1) / 2;   // 1 facing the light, 0 facing away
function disc(size, z, bg, extra) {
  return `<i class="fl ${extra || ""}" style="width:${size}px;height:${size}px;left:${-size / 2}px;top:${-size / 2}px;background:${bg};transform:translateZ(${z}px)"></i>`;
}
function spool3D(color, mode) {
  const R = 50, RF = 39, D = 44, ghost = mode === "empty" || mode === "plus";
  let h = `<div class="sp3">${ghost ? "" : `<i class="shd"></i>`}<div class="rig">`;
  h += cylinder(4, 96, LITE ? 6 : 8, a => `rgb(${Math.round(90 + 90 * lit(a))},${Math.round(95 + 90 * lit(a))},${Math.round(104 + 90 * lit(a))})`);   // the peg
  if (!ghost) {
    h += cylinder(RF, D, LITE ? 14 : 22, a => `repeating-linear-gradient(0deg, rgba(0,0,0,.16) 0 1px, transparent 1px 3px), ${shade(color, -.62 + .9 * lit(a))}`);
    h += cylinder(14, D, LITE ? 6 : 10, a => shade("#2a2e35", -.3 + .5 * lit(a)));   // hub tube
    const face = `repeating-radial-gradient(circle, rgba(0,0,0,.12) 0 1px, transparent 1px 3px), radial-gradient(circle, transparent 0 14px, ${shade(color, -.45)} 14px 16px, ${shade(color, .08)} 16px ${RF - 2}px, ${shade(color, -.3)} ${RF - 2}px ${RF}px, transparent ${RF}px)`;
    h += disc(RF * 2, D / 2, face) + disc(RF * 2, -D / 2, face);
  }
  const fl = `radial-gradient(circle, #0b0c0f 0 9px, #454b55 9px 14px, transparent 14px), radial-gradient(circle, transparent 0 ${R - 6}px, #2a2e35 ${R - 6}px ${R - 1.5}px, #59606c ${R - 1.5}px), repeating-conic-gradient(rgba(32,35,41,.96) 0 11deg, rgba(32,35,41,.2) 11deg 90deg)`;
  const edge = `radial-gradient(circle, #0b0c0f 0 9px, #1b1d22 9px)`;
  h += `<div class="spin">`;
  if (ghost) h += disc(R * 2, -D / 2 - 2, "transparent", "ghost") + `<i class="fl ghost ${mode === "plus" ? "plus" : ""}" style="width:${R * 2}px;height:${R * 2}px;left:${-R}px;top:${-R}px;transform:translateZ(${D / 2 + 2}px)">${mode === "plus" ? "+" : ""}</i>`;
  else h += disc(R * 2, -D / 2 - 5, edge) + disc(R * 2, -D / 2 - 2, fl) + disc(R * 2, D / 2 + 2, fl) + disc(R * 2, D / 2 + 5, edge.replace("#1b1d22", "rgba(40,44,51,.55)"));
  h += `</div></div></div>`;
  return h;
}

// ---------------------------------------------------------------- moonraker
let ws = null, rpcId = 1;
const pending = new Map();
const st = { klippy: "disconnected", ext: null, extT: 0, bed: null, bedT: 0, idle: "", vars: {}, loaded: "" };

function connect() {
  ws = new WebSocket((location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/websocket");
  ws.onopen = async () => { setKlippy("connected"); try { await refreshKlippy(); } catch (e) {} loadAll(); };
  ws.onmessage = ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(m.error.message || "error")) : p.resolve(m.result); return; }
    switch (m.method) {
      case "notify_status_update": applyStatus(m.params[0]); break;
      case "notify_gcode_response": logLine(m.params[0]); break;
      case "notify_klippy_ready": refreshKlippy(); break;
      case "notify_klippy_shutdown": setKlippy("shutdown"); break;
      case "notify_klippy_disconnected": setKlippy("disconnected"); break;
    }
  };
  ws.onclose = () => { setKlippy("offline"); for (const p of pending.values()) p.reject(new Error("connection lost")); pending.clear(); setTimeout(connect, 3000); };
}
function rpc(method, params) {
  return new Promise((resolve, reject) => {
    if (!ws || ws.readyState !== 1) return reject(new Error("not connected"));
    const id = rpcId++; pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ jsonrpc: "2.0", method, params: params || {}, id }));
  });
}
async function refreshKlippy() {
  const info = await rpc("printer.info"); setKlippy(info.state);
  if (info.state !== "ready") return;
  const r = await rpc("printer.objects.subscribe", { objects: {
    webhooks: ["state"], extruder: ["temperature", "target"], heater_bed: ["temperature", "target"], idle_timeout: ["state"],
    save_variables: ["variables"], box_extras: ["loaded_slot"] } });
  applyStatus(r.status);
}
function applyStatus(s) {
  if (s.webhooks && s.webhooks.state) setKlippy(s.webhooks.state);
  if (s.extruder) { if ("temperature" in s.extruder) st.ext = s.extruder.temperature; if ("target" in s.extruder) st.extT = s.extruder.target; }
  if (s.heater_bed) { if ("temperature" in s.heater_bed) st.bed = s.heater_bed.temperature; if ("target" in s.heater_bed) st.bedT = s.heater_bed.target; }
  if (s.idle_timeout && s.idle_timeout.state) st.idle = s.idle_timeout.state;
  let wallDirty = false;
  if (s.save_variables && s.save_variables.variables) { st.vars = s.save_variables.variables; wallDirty = true; }
  if (s.box_extras && "loaded_slot" in s.box_extras) { st.loaded = s.box_extras.loaded_slot; wallDirty = true; }
  renderStatus();
  if (wallDirty) renderWall();
}
function setKlippy(state) { st.klippy = state; renderStatus(); }
function renderStatus() {
  const k = st.klippy;
  $("tKlippy").textContent = k === "ready" ? "Klipper ready" : k === "shutdown" ? "Klipper shut down" : "Klipper " + k;
  $("dKlippy").className = "dot " + (k === "ready" ? "ok" : (k === "shutdown" || k === "error") ? "err" : "");
  const fmt = (t, tg) => t == null ? "–" : Math.round(t) + "°" + (tg > 0 ? " → " + Math.round(tg) + "°" : "");
  $("tExt").textContent = fmt(st.ext, st.extT); $("tBed").textContent = fmt(st.bed, st.bedT);
  const busy = st.idle === "Printing" || running;
  $("tBusy").textContent = k !== "ready" ? "–" : busy ? "Busy" : "Idle";
  $("dBusy").className = "dot " + (k !== "ready" ? "" : busy ? "busy" : "ok");
  $("btnRestart").classList.toggle("hidden", !(k === "shutdown" || k === "error"));
  const can = k === "ready" && !busy;
  for (const id of ["btnCal", "btnDry", "calDry"]) $(id).disabled = !can;
  updateGo();
  $("embedStatus").textContent = `${$("tKlippy").textContent} · ${$("tExt").textContent} · ${$("tBusy").textContent}`;
  const heat = st.ext == null ? 0 : Math.max(0, Math.min(1, (st.ext - 45) / 210));
  $("printer").style.setProperty("--heat", heat.toFixed(2));
}

// ---------------------------------------------------------------- data
let runs = [], labels = {}, meta = {}, filDb = {};
let sel = null;          // {kind:"fil", name} | {kind:"slot", i} | {kind:"run", key}
let selRunKey = null;    // which run of the selection is shown

// Automm3AdaptivePA's result files, served from data/ (a link to ~/printer_data/qidi_pa made by install.sh)
async function fetchRuns(file, where) {
  try {
    const r = await fetch("data/" + file, { cache: "no-store" });
    return r.ok ? parseRunsFile(await r.text(), where) : [];
  } catch (e) { return []; }
}
async function dbGet(k) { try { return (await rpc("server.database.get_item", { namespace: DB_NS, key: k })).value || {}; } catch (e) { return {}; } }
async function dbPut(k, v) { try { await rpc("server.database.post_item", { namespace: DB_NS, key: k, value: v }); } catch (e) {} }
async function loadFilDb() {
  // QIDI's own filament list, to name the Box's filament ids; missing on non-QIDI printers, which is fine
  try { const r = await fetch("/server/files/config/.qidi_filaments/filament-0.4.json", { cache: "no-store" }); filDb = parseFilamentDb(await r.json()); } catch (e) {}
}
async function loadAll(afterRun) {
  const [a, b] = await Promise.all([fetchRuns("auto_cal.json", "Chute"), fetchRuns("auto_cal_bed.json", "Bed"), Object.keys(filDb).length ? null : loadFilDb()]);
  runs = a.concat(b).sort((x, y) => y.time - x.time);
  [labels, meta] = await Promise.all([dbGet("labels"), dbGet("meta")]);
  const named = assignPending(runs, labels);
  if (named.hitKey) {
    labels = named.labels; await dbPut("labels", labels);
    if (afterRun) { sel = { kind: "fil", name: labels[named.hitKey] }; selRunKey = named.hitKey; }
  }
  if (!sel) { const lib = library(); sel = lib.length ? { kind: "fil", name: lib[0].name } : runs.length ? { kind: "run", key: key(runs[0]) } : null; }
  renderWall(); renderSelection();
}
const library = () => groupLibrary(runs, labels, meta);
const slots = () => readSlots(st.vars, st.loaded, filDb);
const slotMatch = s => matchSlot(s, library());
const fcolor = f => f.m.color || guessColor(f.name, f.m.material);

// ---------------------------------------------------------------- wall
function spoolBtn({ id, title, sub, color, empty, selected, badge, badgeCls }) {
  return `<button class="spool ${selected ? "sel" : ""}" data-sel='${esc(JSON.stringify(id))}' title="${esc(title)}">
    <div class="tag"><b>${esc(title)}</b><i>${esc(sub)}</i></div><div class="string"></div>${spool3D(color, empty || "full")}
    ${badge ? `<span class="badge ${badgeCls || ""}">${esc(badge)}</span>` : ""}</button>`;
}
function renderWall() {
  if (!$("wall")) return;
  const isSel = (k, v) => sel && sel.kind === k && (sel.name === v || sel.i === v || sel.key === v);
  let h = "";
  if (boxEnabled(st.vars)) {
    h += `<div class="shelfname">In the Box</div><div class="row">`;
    for (const s of slots()) {
      const m = slotMatch(s);
      h += spoolBtn({ id: { kind: "slot", i: s.i }, title: s.present ? (s.fil ? s.fil.name : "Unknown filament") : "Empty",
        sub: s.name + (m ? " · K " + m.latest.payload.centre_k.toFixed(3) : s.present ? " · not calibrated" : ""),
        color: s.color || "#888", empty: s.present ? "" : "empty", selected: isSel("slot", s.i),
        badge: s.loaded ? "in toolhead" : s.present ? "in the Box" : "", badgeCls: s.loaded ? "" : "box" });
    }
    h += `</div>`;
  }
  const lib = library();
  h += `<div class="shelfname">Calibrated</div><div class="row">`;
  const where = slots().filter(x => x.present).map(x => [x, slotMatch(x)]);
  for (const f of lib) {
    const p = f.latest.payload, at = where.find(([, m]) => m && m.name === f.name);
    h += spoolBtn({ id: { kind: "fil", name: f.name }, title: f.name, sub: `${f.m.material ? f.m.material + " · " : ""}K ${p.centre_k.toFixed(3)}`,
      color: fcolor(f), selected: isSel("fil", f.name),
      badge: at ? (at[0].loaded ? "in toolhead" : "in the Box · " + at[0].name) : "", badgeCls: at && !at[0].loaded ? "box" : "" });
  }
  h += spoolBtn({ id: { kind: "new" }, title: "New filament", sub: "calibrate", color: "#888", empty: "plus" });
  h += `</div>`;
  $("wall").innerHTML = h;

  const loose = runs.filter(r => !labels[key(r)]);
  $("unsorted").innerHTML = loose.length ? `<h3>Unsorted runs (${loose.length}) · click to view, name them to hang them on the wall</h3><div class="ulist">` +
    loose.map(r => { const p = r.payload; return `<div class="urow ${isSel("run", key(r)) ? "sel" : ""}" data-sel='${esc(JSON.stringify({ kind: "run", key: key(r) }))}'>
      <span>${esc(fmtDate(r.time))} · ${Math.round(p.temp_c)}° · <b>${p.qmax_mm3_s.toFixed(1)}</b> mm³/s · K <b>${p.centre_k.toFixed(4)}</b> · ${geoText(p)}</span>
      <button class="small" data-name="${key(r)}">Name it</button></div>`; }).join("") + `</div>` : "";
}
function onWallClick(e) {
  const nb = e.target.closest("[data-name]");
  if (nb) { e.stopPropagation(); openName(nb.dataset.name); return; }
  const b = e.target.closest("[data-sel]"); if (!b) return;
  const id = JSON.parse(b.dataset.sel);
  if (id.kind === "new") { openCal({ name: "", material: "PLA", color: "#e8e4da", temp: 220 }); return; }
  sel = id; selRunKey = null; renderWall(); renderSelection();
  if (window.matchMedia("(max-width: 980px)").matches) scrollToEl($("printerPanel"));
}
$("wall").addEventListener("click", onWallClick);
$("unsorted").addEventListener("click", onWallClick);

// Scrolls only this page. scrollIntoView would also scroll Fluidd when we are inside its iframe,
// and when embedded the frame is small enough that jumping around is more annoying than useful.
function scrollToEl(el) {
  if (EMBED) return;
  window.scrollTo({ top: el.getBoundingClientRect().top + window.scrollY - 70, behavior: "smooth" });
}

// ---------------------------------------------------------------- selection -> printer
const fmtDate = t => new Date(t * 1000).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

function resolveSel() {
  // -> {title, material, color, runs[], slot}
  if (!sel) return null;
  if (sel.kind === "fil") { const f = library().find(x => x.name === sel.name); if (!f) return null; return { title: f.name, material: f.m.material, color: fcolor(f), runs: f.runs, labelName: f.name }; }
  if (sel.kind === "run") { const r = runs.find(x => key(x) === sel.key); if (!r) return null; return { title: "Unsorted run", material: "", color: "#9aa0a8", runs: [r], unsorted: true }; }
  if (sel.kind === "slot") {
    const s = slots()[sel.i]; const m = slotMatch(s);
    return { title: s.present ? `${s.fil ? s.fil.name : "Unknown"} · ${s.name}` : `Slot ${s.name} · empty`, material: s.fil ? s.fil.type : "", color: s.color || "#888",
      runs: m ? m.runs : [], slot: s, labelName: m ? m.name : null };
  }
  return null;
}
function renderSelection() {
  const v = resolveSel();
  const r = v && v.runs.length ? (v.runs.find(x => key(x) === selRunKey) || v.runs[0]) : null;
  $("selName").textContent = v ? v.title : "Pick a spool";
  $("selSwatch").style.background = v ? v.color : "transparent";
  $("selMat").textContent = v && v.material ? v.material : ""; $("selMat").classList.toggle("hidden", !(v && v.material));
  $("selWhen").textContent = r ? "measured " + fmtDate(r.time) + (r.payload.minutes ? ` · ${r.payload.minutes.toFixed(0)} min` : "") : "";
  $("printer").style.setProperty("--fcol", v ? v.color : "#999");
  $("btnRename").classList.toggle("hidden", !r);
  const set = (id, val, unit) => {
    const el = $(id), c = el.querySelector(".cp");
    el.querySelector("b").innerHTML = val == null ? "–" : `${val}${unit ? ` <small>${unit}</small>` : ""}`;
    el.classList.toggle("dim", val == null); c.dataset.copy = val == null ? "" : String(val); c.disabled = val == null;
  };
  if (r) {
    const p = r.payload;
    set("coFlow", p.qmax_mm3_s.toFixed(1), "mm³/s"); set("coPA", p.centre_k.toFixed(4)); set("coTemp", Math.round(p.temp_c), "°C");
    const g = p.geometry || {};
    const gn = g.line_w ? nozzleFor(g.line_w) : null;
    $("geoArt").innerHTML = geoSVG(g.layer_h, g.line_w, gn, v.color) + geoRows(g.layer_h, g.line_w, gn);
    $("screen").innerHTML = `<b>${esc(v.title)}</b>${p.qmax_mm3_s.toFixed(1)}mm³/s K${p.centre_k.toFixed(3)}`;
  } else {
    for (const id of ["coFlow", "coPA", "coTemp"]) set(id, null);
    $("geoArt").innerHTML = geoSVG(null, null, null, v ? v.color : "#888") + geoRows(null, null, null);
    $("screen").innerHTML = `<b>${esc(v ? v.title : "Q2")}</b>${v ? "not calibrated" : "ready"}`;
  }
  // run chips
  $("runs").innerHTML = v && v.runs.length > 1 ? `<span class="sub" style="align-self:center">Runs:</span>` + v.runs.map(x =>
    `<button data-run="${key(x)}" class="${x === r ? "on" : ""}">${esc(fmtDate(x.time))} · ${x.payload.centre_k.toFixed(3)}</button>`).join("") : "";
  // warnings
  let w = "";
  if (r) { const noz = r.payload.geometry && r.payload.geometry.line_w ? nozzleFor(r.payload.geometry.line_w) : null;
    if (noz && noz !== "0.4") w += `<div class="note warn">Measured with ${noz} mm nozzle geometry (${geoText(r.payload)}). Only use these numbers with that nozzle and matching Orca layer height / line width.</div>`; }
  if (v && v.slot && v.slot.present && !r) w += `<div class="note warn">No calibration on the wall matches this spool's colour and material yet. Load slot ${v.slot.name} into the toolhead, then press <b>Calibrate this filament</b>.</div>`;
  $("warnBox").innerHTML = w;
  // chart + orca
  if (r) {
    const pts = pointsOf(r.payload);
    $("chartBox").innerHTML = `<div class="sub">PA at each measured flow rate (dashed = centre value)</div>` + (pts.length > 1 ? chart(pts, r.payload.centre_k) : "");
    $("orcaFields").innerHTML = `<div class="sub" style="margin-bottom:6px">Filament preset → <b>Filament</b> tab, Advanced mode on</div>` +
      fld("Max volumetric speed", r.payload.qmax_mm3_s.toFixed(1)) + fld("Pressure advance", r.payload.centre_k.toFixed(4)) +
      fld("Adaptive pressure advance measurements", (r.payload.rows || []).join("\n")) +
      `<div class="sub">Also tick <b>Enable pressure advance</b> and <b>Enable adaptive pressure advance</b>.</div>`;
    $("orcaBox").classList.remove("hidden");
  } else $("orcaBox").classList.add("hidden");
  requestAnimationFrame(drawLeaders);
}
$("runs").addEventListener("click", e => { const b = e.target.closest("[data-run]"); if (!b) return; selRunKey = b.dataset.run; renderSelection(); });

// Flat-icon nozzle (threaded shank, hex, brass cone) laying a line onto the previous layer.
// The nozzle is illustrative; the line's width and height share one scale so they compare honestly.
function geoSVG(layer, width, nozzle, color) {
  const known = layer != null && width != null;
  const n = nozzle ? Number(nozzle) : (known ? width / 1.05 : 0.4);
  const S = 80, cx = 88, O = "#3a3229", col = color || "#888";
  const bw = Math.min(120, Math.max(26, (known ? width : n * 1.05) * S)), bh = Math.max(12, Math.min(40, (known ? layer : n / 2) * S));
  const tip = Math.max(20, Math.min(54, n * S)), ori = Math.max(6, tip * .4);
  const sh = 32, hx = 42, f = 22;                                   // shank, hex and centre-face half widths
  const yT = 6, yH = 58, yC = 100, yTip = 146, y0 = yTip + 2, yb = y0 + bh, yd = yb + bh + 18, H = yd + 30;
  let s = `<svg viewBox="0 0 230 ${H}" role="img" aria-label="Nozzle, layer height and line width">
  <defs><marker id="ar" viewBox="0 0 8 8" refX="4" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L8 4L0 8z" fill="currentColor"/></marker></defs>
  <g stroke="${O}" stroke-width="4" stroke-linejoin="round" stroke-linecap="round">
    <rect x="${cx - sh}" y="${yT}" width="${sh * 2}" height="${yH - yT}" fill="#d6c39c"/>
    <rect x="${cx - sh + 2}" y="${yH - 14}" width="${sh * 2 - 4}" height="12" fill="#ad9668" stroke="none"/>
    ${[16, 29, 42].map(y => `<path d="M${cx - sh - 5} ${y} C${cx - sh + 6} ${y + 7} ${cx + 2} ${y + 9} ${cx + sh + 5} ${y + 9}" fill="none"/>`).join("")}
    <path d="M${cx - hx} ${yC} L${cx - tip / 2} ${yTip - 8} Q${cx - tip / 2 + 3} ${yTip} ${cx - tip / 2 + 9} ${yTip} L${cx + tip / 2 - 9} ${yTip} Q${cx + tip / 2 - 3} ${yTip} ${cx + tip / 2} ${yTip - 8} L${cx + hx} ${yC} Z" fill="#f0b84a"/>
    <rect x="${cx - hx}" y="${yH}" width="${hx * 2}" height="${yC - yH}" rx="3" fill="#d6c39c"/>
    <path d="M${cx - hx} ${yH} Q${cx - f - 7} ${yH} ${cx - f} ${yH + 8} L${cx - f} ${yC - 8} Q${cx - f - 7} ${yC} ${cx - hx} ${yC} Z" fill="#ad9668"/>
    <path d="M${cx + hx} ${yH} Q${cx + f + 7} ${yH} ${cx + f} ${yH + 8} M${cx + f} ${yC - 8} Q${cx + f + 7} ${yC} ${cx + hx} ${yC}" fill="none"/>
    <path d="M${cx - f} ${yH + 8} Q${cx} ${yH - 4} ${cx + f} ${yH + 8} L${cx + f} ${yC - 8} Q${cx} ${yC + 4} ${cx - f} ${yC - 8} Z" fill="#d6c39c"/>
    <rect x="${cx - bw / 2}" y="${yb + 2}" width="${bw}" height="${bh}" rx="${bh / 2}" fill="${col}" opacity=".45"/>
    <rect x="${cx - bw / 2}" y="${y0}" width="${bw}" height="${bh}" rx="${bh / 2}" fill="${col}"/>
  </g>
  <rect x="${cx - ori / 2}" y="${yTip - 3}" width="${ori}" height="3" fill="${O}"/>
  <ellipse cx="${cx - bw * .16}" cy="${y0 + bh * .34}" rx="${bw * .22}" ry="${bh * .13}" fill="rgba(255,255,255,.4)"/>`;
  // nozzle size, pointing at the tip
  s += `<path class="ext" d="M${cx + tip / 2 + 2} ${yTip - 4} L${cx + hx + 8} ${yTip - 24} H${cx + hx + 14}"/>
  <text class="gt" x="${cx + hx + 16}" y="${yTip - 36}">nozzle</text><text class="gv" x="${cx + hx + 16}" y="${yTip - 20}">⌀ ${nozzle || "–"}</text>`;
  // layer height, to the right of the line
  const xr = cx + Math.max(bw / 2, tip / 2) + 14;
  s += `<path class="ext" d="M${cx + bw / 2 - bh / 2} ${y0}H${xr + 4}M${cx + bw / 2 - bh / 2} ${yb}H${xr + 4}"/>
  <path class="dim" style="color:var(--text)" d="M${xr} ${y0 + 1}V${yb - 1}" marker-start="url(#ar)" marker-end="url(#ar)"/>
  <text class="gt" x="${xr + 8}" y="${y0 + bh / 2 - 2}">layer</text><text class="gv" x="${xr + 8}" y="${y0 + bh / 2 + 13}">${known ? layer.toFixed(2) : "–"}</text>`;
  // line width, under both layers
  s += `<path class="ext" d="M${cx - bw / 2} ${yb + 2}V${yd + 4}M${cx + bw / 2} ${yb + 2}V${yd + 4}"/>
  <path class="dim" style="color:var(--text)" d="M${cx - bw / 2 + 1} ${yd}H${cx + bw / 2 - 1}" marker-start="url(#ar)" marker-end="url(#ar)"/>
  <text class="gt" x="${cx}" y="${yd + 20}" text-anchor="middle">line width <tspan class="gv" dx="3">${known ? width.toFixed(2) : "–"}</tspan></text>`;
  return s + "</svg>";
}
function geoRows(layer, width, nozzle) {
  const row = (label, value, copy, tip) => `<div class="grow" tabindex="0"><b>${label}</b><span>${value}</span>
    <button class="cp" data-copy="${copy}" title="Copy" aria-label="Copy ${label.toLowerCase()}" ${copy ? "" : "disabled"}>${ICON_COPY}</button>
    <div class="gtip" role="tooltip">${tip}</div></div>`;
  return `<div class="grows">
  ${row("Nozzle", nozzle ? nozzle + " mm" : "–", nozzle || "", "The nozzle size this run was measured with. Only use these results with the same nozzle installed.")}
  ${row("Layer height", layer != null ? layer.toFixed(2) + " mm" : "–", layer != null ? layer.toFixed(2) : "", "The layer height this run was measured at. Use the same value in OrcaSlicer: Process → Quality → Layer height.")}
  ${row("Line width", width != null ? width.toFixed(2) + " mm" : "–", width != null ? width.toFixed(2) : "", "The line width this run was measured at. Use the same value in OrcaSlicer: Process → Quality → Line width → Default.")}
  </div>`;
}
function chart(pts, centre) {
  const W = 520, H = 220, L = 46, R = 12, T = 12, B = 32;
  const qmax = Math.max(...pts.map(p => p.q)) * 1.08, kmax = Math.max(...pts.map(p => p.k), centre) * 1.15;
  const x = q => L + (q / qmax) * (W - L - R), y = k => T + (1 - k / kmax) * (H - T - B);
  let s = `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Pressure advance versus flow">`;
  for (let i = 0; i <= 4; i++) { const kv = kmax * i / 4; s += `<line class="grid" x1="${L}" x2="${W - R}" y1="${y(kv)}" y2="${y(kv)}"/><text x="${L - 6}" y="${y(kv) + 4}" text-anchor="end">${kv.toFixed(3)}</text>`; }
  const step = qmax > 20 ? 5 : qmax > 8 ? 2 : 1;
  for (let q = 0; q <= qmax; q += step) s += `<text x="${x(q)}" y="${H - B + 16}" text-anchor="middle">${q}</text>`;
  s += `<text x="${(L + W - R) / 2}" y="${H - 3}" text-anchor="middle">flow (mm³/s)</text>`;
  s += `<line class="ctr" x1="${L}" x2="${W - R}" y1="${y(centre)}" y2="${y(centre)}"/>`;
  s += `<polyline class="ln" points="${pts.map(p => x(p.q) + "," + y(p.k)).join(" ")}"/>`;
  for (const p of pts) s += `<circle class="pt" cx="${x(p.q)}" cy="${y(p.k)}" r="5"><title>${p.q.toFixed(2)} mm³/s → PA ${p.k.toFixed(4)}</title></circle>`;
  return s + "</svg>";
}
function fld(name, val) { return `<div class="fld"><div class="fh"><span>${esc(name)}</span><button class="cp" data-copy="${esc(val)}" title="Copy" aria-label="Copy ${esc(name.toLowerCase())}">${ICON_COPY}</button></div><pre>${esc(val)}</pre></div>`; }
const ICON_COPY = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"/></svg>`;
const ICON_OK = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12l5 5L20 7"/></svg>`;
document.querySelectorAll(".cp").forEach(b => { if (!b.innerHTML.trim()) b.innerHTML = ICON_COPY; });
document.addEventListener("click", e => {
  const b = e.target.closest("[data-copy]"); if (!b || b.disabled || !b.dataset.copy) return;
  e.stopPropagation(); copyText(b.dataset.copy);
  b.classList.add("ok"); b.innerHTML = ICON_OK; setTimeout(() => { b.classList.remove("ok"); b.innerHTML = ICON_COPY; }, 1200);
});
function copyText(s) {
  // http:// pages have no navigator.clipboard, so fall back to a hidden textarea
  if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(s);
  const ta = document.createElement("textarea"); ta.value = s; ta.style.cssText = "position:fixed;opacity:0"; document.body.appendChild(ta); ta.select(); document.execCommand("copy"); ta.remove();
}

// ---------------------------------------------------------------- the 3D printer
function cub(cls, w, h, d, x, y, z) {
  // a cuboid centred on (x, y, z) inside the printer; faces: t(op) fr(ont) r(ight) l(eft)
  const el = document.createElement("div"); el.className = "cub " + cls;
  el.style.transform = `translate3d(${x - w / 2}px, ${y - h / 2}px, ${z}px)`;
  el.style.width = w + "px"; el.style.height = h + "px";
  const face = (c, fw, fh, t) => { const f = document.createElement("div"); f.className = "s " + c; f.style.width = fw + "px"; f.style.height = fh + "px"; f.style.transform = t; el.appendChild(f); return f; };
  face("fr", w, h, `translateZ(${d / 2}px)`);
  face("bk", w, h, `rotateY(180deg) translateZ(${d / 2}px)`);
  face("r", d, h, `translateX(${(w - d) / 2}px) rotateY(90deg) translateZ(${w / 2}px)`);
  face("l", d, h, `translateX(${(w - d) / 2}px) rotateY(-90deg) translateZ(${w / 2}px)`);
  face("t", w, d, `translateY(${(h - d) / 2}px) rotateX(90deg) translateZ(${h / 2}px)`);
  return el;
}
function buildPrinter() {
  const box = $("printer"), inn = $("interior");
  const W = box.offsetWidth, H = box.offsetHeight, D = parseFloat(getComputedStyle(box).getPropertyValue("--D")) || 220;
  inn.innerHTML = "";
  const k = W / 230;
  inn.appendChild(cub("bedplate", W * .78, 6 * k, D * .74, 0, 52 * k, 0));                       // bed
  inn.appendChild(cub("rail", W * .9, 5 * k, 5 * k, 0, -78 * k, -D * .22));                       // back gantry
  inn.appendChild(cub("rail", W * .9, 5 * k, 5 * k, 0, -78 * k, D * .22));                        // front gantry
  inn.appendChild(cub("rail", 5 * k, 5 * k, D * .5, 0, -82 * k, 0));                              // cross rail
  const mover = document.createElement("div"); mover.className = "mover"; mover.id = "mover";
  mover.style.transform = `translate3d(0px, 0px, 0px)`;
  const head = cub("head", 30 * k, 34 * k, 28 * k, 0, -64 * k, 0); mover.appendChild(head);
  const nz = document.createElement("div"); nz.className = "nozzle"; nz.id = "nozzle";
  nz.style.transform = `translate3d(${-6}px, ${-64 * k + 17 * k}px, ${14 * k + 1}px)`; mover.appendChild(nz);
  const sd = document.createElement("div"); sd.className = "strand";
  sd.style.transform = `translate3d(${-1.5}px, ${-64 * k + 27 * k}px, ${14 * k + 1}px)`; mover.appendChild(sd);
  const tb = document.createElement("div"); tb.className = "tube";
  tb.style.height = (H / 2 - 64 * k - 17 * k + 4) + "px";
  tb.style.transform = `translate3d(${4 * k}px, ${-H / 2 + 2}px, 0px)`; mover.appendChild(tb);
  inn.appendChild(mover);
}
// tilt follows the pointer a little
$("stage").addEventListener("pointermove", e => {
  if (e.pointerType === "touch" || LITE) return;
  const r = $("stage").getBoundingClientRect(), nx = (e.clientX - r.left) / r.width - .5, ny = (e.clientY - r.top) / r.height - .5;
  $("printer").style.setProperty("--ry", (-30 + nx * 22).toFixed(1) + "deg");
  $("printer").style.setProperty("--rx", (-13 - ny * 10).toFixed(1) + "deg");
  requestAnimationFrame(drawLeaders);
});
$("stage").addEventListener("pointerleave", () => { $("printer").style.removeProperty("--ry"); $("printer").style.removeProperty("--rx"); setTimeout(drawLeaders, 300); });
$("printer").addEventListener("transitionend", drawLeaders);

function drawLeaders() {
  const stage = $("stage"), noz = $("nozzle"); if (!noz || getComputedStyle($("leaders")).display === "none") return;
  const sr = stage.getBoundingClientRect(), nr = noz.getBoundingClientRect();
  const nx = nr.left + nr.width / 2 - sr.left, ny = nr.top + nr.height - sr.top;
  const targets = {
    coFlow: [nx - 3, ny - 12],   // the hotend: how much it can melt
    coPA: [nx - 2, ny - 6],      // pressure in the nozzle
    coTemp: [nx - 1, ny - 2],    // heater block
    coGeo: [nx, ny],             // the tip, where the line comes out
  };
  let s = "";
  for (const [id, [tx, ty]] of Object.entries(targets)) {
    const c = $(id).getBoundingClientRect();
    const left = c.left + c.width / 2 < sr.left + sr.width / 2;
    const ax = (left ? c.right : c.left) - sr.left, ay = c.top + c.height / 2 - sr.top;
    const mx = ax + (left ? 24 : -24);
    s += `<path d="M${ax},${ay} L${mx},${ay} L${tx},${ty}"/><circle cx="${tx}" cy="${ty}" r="3"/>`;
  }
  $("leaders").innerHTML = s;
}
let leaderLoop = null;
function setRunningVisual(on) {
  $("printer").classList.toggle("running", on);
  cancelAnimationFrame(leaderLoop);
  if (on) { const tick = () => { drawLeaders(); leaderLoop = requestAnimationFrame(tick); }; tick(); }
  else setTimeout(drawLeaders, 1300);
}

// ---------------------------------------------------------------- console + stages
let stage = null, stageFailed = false, running = false, runStart = 0, runTimer = null;
function logLine(raw) {
  const t = String(raw), cls = classifyLine(t);
  const c = $("console"), atBottom = c.scrollHeight - c.scrollTop - c.clientHeight < 40;
  const div = document.createElement("div"); if (cls) div.className = cls; div.textContent = t; c.appendChild(div);
  while (c.childNodes.length > 500) c.removeChild(c.firstChild);
  if (atBottom) c.scrollTop = c.scrollHeight;
  if (running) trackStage(t);
}
function trackStage(t) {
  const s = stageFromLine(t);
  if (s === "fail") { stageFailed = true; renderSteps(); }
  else if (s) setStage(s);
}
function setStage(s) { stage = s; renderSteps(); const n = STAGES.find(x => x[0] === s); if (n && running) $("screen").innerHTML = `<b>Calibrating…</b>${esc(n[1])}`; }
function renderSteps() {
  const idx = STAGES.findIndex(x => x[0] === stage);
  $("steps").innerHTML = STAGES.map(([k, name], i) => { let c = ""; if (stage === "done" || (idx >= 0 && i < idx)) c = "done"; else if (i === idx) c = stageFailed ? "fail" : "now"; return `<li class="${c}">${esc(name)}</li>`; }).join("");
}
function tickRun() { const s = Math.floor((Date.now() - runStart) / 1000); $("runInfo").textContent = `· running ${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; }

async function runCommand(script, isDry, name, metaEntry) {
  running = true; stage = null; stageFailed = false; renderSteps(); renderStatus(); setRunningVisual(!isDry);
  runStart = Date.now(); tickRun(); runTimer = setInterval(tickRun, 1000);
  $("runNote").classList.add("hidden"); $("liveBox").open = true;
  logLine("» " + script);
  scrollToEl($("liveBox"));
  if (!isDry && name) {
    labels = await dbGet("labels"); labels.pending = { name, t: Date.now() / 1000 - 5 }; await dbPut("labels", labels);
    meta = await dbGet("meta"); meta[name] = Object.assign(meta[name] || {}, metaEntry); await dbPut("meta", meta);
  }
  let ok = true, msg = "";
  try { await rpc("printer.gcode.script", { script }); } catch (e) { ok = false; msg = e.message; }
  clearInterval(runTimer); running = false; setRunningVisual(false);
  const mins = ((Date.now() - runStart) / 60000).toFixed(1);
  $("runInfo").textContent = ok ? `· finished in ${mins} min` : `· stopped after ${mins} min`;
  if (ok) setStage("done"); else { stageFailed = true; renderSteps(); }
  const n = $("runNote"); n.className = "note " + (ok ? "good" : "bad");
  n.textContent = ok ? (isDry ? "Dry run complete. Nothing heated or moved." : "Calibration complete. It's on the wall now.") : "Did not finish: " + msg + ". The console above shows why.";
  renderStatus();
  if (!isDry) setTimeout(() => loadAll(true), 1500); else renderSelection();
}

// ---------------------------------------------------------------- calibrate dialog
for (const id of ["fMat", "nMat"]) $(id).innerHTML = MATERIALS.map(m => `<option>${m}</option>`).join("");
$("tempChips").innerHTML = [["PLA", 220], ["PETG", 245], ["ABS/ASA", 260], ["TPU", 230], ["PA/PC", 280]].map(([n, t]) => `<button type="button" data-t="${t}">${n} ${t}°</button>`).join("");
$("tempChips").addEventListener("click", e => { const b = e.target.closest("[data-t]"); if (b) { $("fTemp").value = b.dataset.t; updatePreview(); } });
function readForm() {
  const temp = Number($("fTemp").value), layer = Number($("fLayer").value), width = Number($("fWidth").value);
  const loc = document.querySelector("input[name=loc]:checked").value, blocks = Number($("fBlocks").value), points = Number($("fPoints").value);
  const { cmd: base, err } = buildCommand({ temp, layer, width, loc, blocks, points });
  return { base, err, loc, name: $("fName").value.trim(), material: $("fMat").value, color: $("fColor").value };
}
function updatePreview() {
  const f = readForm(); $("cmdPreview").textContent = f.base;
  $("formErr").textContent = f.err; $("formErr").classList.toggle("hidden", !f.err);
  $("chkClear").textContent = f.loc === "bed" ? "The bed is completely empty (it drops and purges over the centre)." : "The purge chute is empty.";
  updateGo();
}
function updateGo() {
  const all = [...$("checks").querySelectorAll("input")].every(c => c.checked);
  const f = $("fTemp") ? readForm() : { err: "x" };
  $("calGo").disabled = !(all && !f.err && f.name && st.klippy === "ready" && !running && st.idle !== "Printing");
}
function setNozzle(n) { const g = NOZZLE_GEOM[n]; if (g) { $("fLayer").value = g[0].toFixed(2); $("fWidth").value = g[1].toFixed(2); } updatePreview(); }
for (const id of ["fTemp", "fLayer", "fWidth", "fBlocks", "fPoints", "fName", "fMat", "fColor"]) $(id).addEventListener("input", updatePreview);
document.querySelectorAll("input[name=loc]").forEach(r => r.addEventListener("change", updatePreview));
$("fNozzle").addEventListener("change", e => setNozzle(e.target.value));
$("checks").addEventListener("change", updateGo);
$("fMat").addEventListener("change", () => { $("fTemp").value = MAT_TEMP[$("fMat").value] || 230; updatePreview(); });

function openCal(pre) {
  $("fName").value = pre.name || ""; $("fMat").value = MATERIALS.includes(pre.material) ? pre.material : "Other";
  $("fColor").value = pre.color || "#888888"; $("fTemp").value = Math.max(TEMP_MIN, Math.min(TEMP_MAX, Math.round(pre.temp || 220)));
  $("checks").querySelectorAll("input").forEach(c => c.checked = false);
  updatePreview(); $("dlgCal").showModal();
}
function prefillFromSelection() {
  const v = resolveSel();
  if (!v) return { name: "", material: "PLA", color: "#e8e4da", temp: 220 };
  const r = v.runs[0];
  if (v.slot && v.slot.present) {
    const f = v.slot.fil;
    return { name: v.labelName || (f ? f.name : ""), material: f ? f.type : "PLA", color: v.slot.color, temp: r ? r.payload.temp_c : slotTemp(f) };
  }
  return { name: v.unsorted ? "" : v.title, material: v.material || "PLA", color: v.color, temp: r ? r.payload.temp_c : 220 };
}
$("btnCal").addEventListener("click", () => openCal(prefillFromSelection()));
$("btnDry").addEventListener("click", () => { const p = prefillFromSelection(); openCal(p); });
$("calCancel").addEventListener("click", () => $("dlgCal").close());
$("calDry").addEventListener("click", () => { const f = readForm(); if (f.err) return updatePreview(); $("dlgCal").close(); runCommand(f.base + " DRY=1", true); });
$("calGo").addEventListener("click", () => {
  const f = readForm(); if (f.err || !f.name) return updatePreview();
  $("dlgCal").close(); runCommand(f.base, false, f.name, { material: f.material, color: f.color });
});

// ---------------------------------------------------------------- name dialog
let naming = null;   // run key
function openName(runKey) {
  naming = runKey; const r = runs.find(x => key(x) === runKey); if (!r) return;
  const cur = labels[runKey] || "", m = meta[cur] || {};
  $("nameTitle").textContent = cur ? "Rename / recolour" : "Name this run";
  $("nameSub").textContent = `${fmtDate(r.time)} · ${Math.round(r.payload.temp_c)}° · ${r.payload.qmax_mm3_s.toFixed(1)} mm³/s · K ${r.payload.centre_k.toFixed(4)}`;
  $("nName").value = cur; $("nMat").value = m.material || guessMaterial(r.payload.temp_c); $("nColor").value = m.color || guessColor(cur, $("nMat").value);
  $("knownNames").innerHTML = library().map(f => `<option value="${esc(f.name)}">`).join("");
  $("dlgName").showModal();
}
$("nName").addEventListener("change", () => { const m = meta[$("nName").value.trim()]; if (m) { if (m.material) $("nMat").value = m.material; if (m.color) $("nColor").value = m.color; } });
$("nameCancel").addEventListener("click", () => $("dlgName").close());
$("nameSave").addEventListener("click", async () => {
  const name = $("nName").value.trim().slice(0, 60);
  labels = await dbGet("labels"); meta = await dbGet("meta");
  if (name) { labels[naming] = name; meta[name] = { material: $("nMat").value, color: $("nColor").value }; } else delete labels[naming];
  await dbPut("labels", labels); await dbPut("meta", meta);
  $("dlgName").close();
  sel = name ? { kind: "fil", name } : { kind: "run", key: naming }; selRunKey = naming;
  renderWall(); renderSelection();
});
$("btnRename").addEventListener("click", () => {
  const v = resolveSel(); if (!v || !v.runs.length) return;
  const r = v.runs.find(x => key(x) === selRunKey) || v.runs[0]; openName(key(r));
});

// ---------------------------------------------------------------- wall: export / import / delete all
$("btnExport").addEventListener("click", async () => {
  [labels, meta] = await Promise.all([dbGet("labels"), dbGet("meta")]);
  const data = buildExport(runs, labels, meta);
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
  a.download = `automm-ui-wall-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
});
$("btnImport").addEventListener("click", () => { $("importFile").value = ""; $("importFile").click(); });
$("importFile").addEventListener("change", async e => {
  const file = e.target.files[0]; if (!file) return;
  let d;
  try { d = JSON.parse(await file.text()); } catch (err) { alert("That file isn't valid JSON."); return; }
  const [curLabels, curMeta] = await Promise.all([dbGet("labels"), dbGet("meta")]);
  let merged;
  try { merged = mergeImport(d, curLabels, curMeta, runs.map(key)); } catch (err) { alert(err.message); return; }
  const { filaments, runs: n, missing } = merged.summary;
  if (!confirm(`Import ${filaments} filament(s) covering ${n} run(s)?\n\n` +
      `Names already on the wall for the same runs are replaced; everything else stays.` +
      (missing ? `\n\n${missing} of those runs aren't on this printer, so they won't show on the wall.` : ""))) return;
  labels = merged.labels; meta = merged.meta;
  await dbPut("labels", labels); await dbPut("meta", meta);
  sel = null; renderWall(); renderSelection(); loadAll();
});
$("btnClear").addEventListener("click", async () => {
  const lib = library();
  if (!lib.length) { alert("The wall has no named filaments to delete."); return; }
  if (!confirm(`Delete all ${lib.length} filament(s) from the wall?\n\nTheir names and colours are removed and their runs go back to "Unsorted runs". ` +
      `The measurement results themselves are kept.\n\nTip: Export first if you might want them back.`)) return;
  labels = {}; meta = {};
  await dbPut("labels", labels); await dbPut("meta", meta);
  sel = null; loadAll();
});

// ---------------------------------------------------------------- header buttons
$("btnStop").addEventListener("click", async () => {
  if (!confirm("EMERGENCY STOP?\n\nThis halts Klipper immediately: heaters off, motors stop. You'll need to restart the firmware afterwards.")) return;
  try { await rpc("printer.emergency_stop"); } catch (e) { alert("Stop failed: " + e.message); }
});
$("btnRestart").addEventListener("click", async () => { try { await rpc("printer.firmware_restart"); } catch (e) { alert("Restart failed: " + e.message); } });

// ---------------------------------------------------------------- lite mode
function setLite(on, remember) {
  LITE = on;
  document.body.classList.toggle("lite", on);
  $("btnLite").textContent = "Effects: " + (on ? "lite" : "full");
  if (remember) { try { localStorage.setItem(LITE_KEY, on ? "1" : "0"); } catch (e) {} }
  if (on) { $("printer").style.removeProperty("--ry"); $("printer").style.removeProperty("--rx"); }
  renderWall(); requestAnimationFrame(drawLeaders);
}
$("btnLite").addEventListener("click", () => setLite(!LITE, true));
// Count frames for a couple of seconds while the selected spool spins; a slow web view drops well below 60.
function autoLite() {
  if (LITE || litePref() !== null || document.visibilityState !== "visible") return;
  let frames = 0; const t0 = performance.now();
  const tick = now => { frames++; if (now - t0 < 2000) requestAnimationFrame(tick); else if (isSlowFps(frames, now - t0)) setLite(true, false); };
  requestAnimationFrame(tick);
}

// ---------------------------------------------------------------- start
setNozzle("0.4"); renderSteps(); buildPrinter(); renderSelection(); connect();
$("btnLite").textContent = "Effects: " + (LITE ? "lite" : "full");
setTimeout(autoLite, 2500);
let rz; window.addEventListener("resize", () => { clearTimeout(rz); rz = setTimeout(() => { buildPrinter(); drawLeaders(); }, 150); });
