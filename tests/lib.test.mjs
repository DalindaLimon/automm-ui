// Unit tests for web/lib.js - run with:  node --test tests/
// No dependencies: Node's built-in test runner and assert only.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

const require = createRequire(import.meta.url);
const L = require("../web/lib.js");

// A finished calibration as Automm3AdaptivePA writes it to auto_cal.json
const run = (time, extra = {}) => ({
  kind: "auto_cal", time,
  payload: {
    qmax_mm3_s: 18.5, centre_k: 0.0328, temp_c: 260, minutes: 11.3,
    rows: ["0.0493,2.77,500", "0.0334,4.46,500", "0.0328,7.17,500", "0.0493,2.77,10000", "0.0334,4.46,10000", "0.0328,7.17,10000"],
    geometry: { layer_h: 0.24, line_w: 0.62 }, block: "printable text", ...extra,
  },
});

test("VERSION matches the VERSION file", () => {
  assert.equal(L.VERSION, readFileSync(new URL("../VERSION", import.meta.url), "utf8").trim());
});

test("esc escapes everything HTML cares about", () => {
  assert.equal(L.esc(`<a href="x">'&'</a>`), "&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;");
  assert.equal(L.esc(42), "42");
});

test("normHex accepts QIDI's bare hex and rejects junk", () => {
  assert.equal(L.normHex("5CF30E"), "#5cf30e");
  assert.equal(L.normHex("#FAFAFA"), "#fafafa");
  for (const bad of [null, undefined, "", 1, "12345", "zzzzzz", "#1234567"]) assert.equal(L.normHex(bad), null);
});

test("shade darkens and lightens within 0-255", () => {
  assert.equal(L.shade("#808080", 0), "rgb(128,128,128)");
  assert.equal(L.shade("#808080", -1), "rgb(0,0,0)");
  assert.equal(L.shade("#808080", 1), "rgb(255,255,255)");
  assert.equal(L.shade("#fff", -0.5), "rgb(128,128,128)");
});

test("guessColor reads colour words, then falls back to the material", () => {
  assert.equal(L.guessColor("Elegoo PLA+ White", "PLA"), "#f2f2ee");
  assert.equal(L.guessColor("Galaxy Grey", "PETG"), "#8d9199");
  assert.equal(L.guessColor("Mystery", "PETG"), L.MAT_COLOR.PETG);
  assert.equal(L.guessColor("", "Other"), "#9aa0a8");
});

test("guessMaterial from temperature", () => {
  assert.equal(L.guessMaterial(210), "PLA");
  assert.equal(L.guessMaterial(245), "PETG");
  assert.equal(L.guessMaterial(260), "PETG");
  assert.equal(L.guessMaterial(265), "ABS");
  assert.equal(L.guessMaterial(285), "PA");
});

test("runKey is the timestamp to the second", () => {
  assert.equal(L.runKey({ time: 1793596952.229 }), "1793596952");
  assert.equal(L.runKey({ time: 1793596952.6 }), "1793596953");
});

test("parseRunsFile keeps finished runs and tags where they ran", () => {
  const text = JSON.stringify([run(100), { kind: "auto_cal", time: 101, payload: {} }, null, run(102)]);
  const out = L.parseRunsFile(text, "Chute");
  assert.deepEqual(out.map(r => r.time), [100, 102]);
  assert.ok(out.every(r => r.where === "Chute"));
});

test("parseRunsFile survives nginx serving Fluidd's index.html for a missing file", () => {
  assert.deepEqual(L.parseRunsFile("<!doctype html><html>", "Bed"), []);
  assert.deepEqual(L.parseRunsFile('{"not":"a list"}', "Bed"), []);
});

test("groupLibrary groups named runs, newest first", () => {
  const runs = [run(100), run(300), run(200), run(400)];
  const labels = { "100": "PLA white", "300": "PLA white", "200": "PETG black" };
  const meta = { "PLA white": { material: "PLA", color: "#ffffff" } };
  const lib = L.groupLibrary(runs, labels, meta);
  assert.deepEqual(lib.map(f => f.name), ["PLA white", "PETG black"]);
  assert.deepEqual(lib[0].runs.map(r => r.time), [300, 100]);
  assert.equal(lib[0].latest.time, 300);
  assert.deepEqual(lib[0].m, { material: "PLA", color: "#ffffff" });
  assert.deepEqual(lib[1].m, {});
});

test("assignPending names the first new run after a calibration started", () => {
  const runs = [run(100), run(200), run(300)];
  const r = L.assignPending(runs, { "100": "old", pending: { name: "new PETG", t: 150 } });
  assert.equal(r.hitKey, "200");
  assert.equal(r.labels["200"], "new PETG");
  assert.equal(r.labels.pending, undefined);
});

test("assignPending leaves labels alone when nothing new has arrived", () => {
  const labels = { pending: { name: "x", t: 999 } };
  const r = L.assignPending([run(100)], labels);
  assert.equal(r.hitKey, null);
  assert.deepEqual(r.labels.pending, { name: "x", t: 999 });
  assert.equal(L.assignPending([run(1)], {}).hitKey, null);
});

test("nozzleFor maps a line width back to its nozzle", () => {
  assert.equal(L.nozzleFor(0.42), "0.4");
  assert.equal(L.nozzleFor(0.62), "0.6");
  assert.equal(L.nozzleFor(0.44), "0.4", "within 0.03 mm");
  assert.equal(L.nozzleFor(0.52), null);
});

test("geoText", () => {
  assert.equal(L.geoText(run(1).payload), "0.24 × 0.62");
  assert.equal(L.geoText({}), "–");
  assert.equal(L.geoText(null), "–");
});

test("pointsOf gives one point per flow, sorted", () => {
  assert.deepEqual(L.pointsOf(run(1).payload), [{ q: 2.77, k: 0.0493 }, { q: 4.46, k: 0.0334 }, { q: 7.17, k: 0.0328 }]);
  assert.deepEqual(L.pointsOf({ rows: ["garbage", "0.03,abc,500"] }), []);
  assert.deepEqual(L.pointsOf({}), []);
});

// What the QIDI Q2 actually reports (save_variables + box_extras), trimmed
const vars = {
  enable_box: 1, box_count: 1,
  color_slot0: ["060606"], color_slot1: ["5CF30E"], color_slot2: ["FF7174"], color_slot3: 1,
  filament_slot0: "QFG90", filament_slot1: "QFG90", filament_slot2: "QFZZZ", filament_slot3: 1,
  slot0: 2, slot1: 1, slot2: 1, slot3: 0,
};
const filDb = L.parseFilamentDb({
  "Generic PETG": { type: "PETG", filament_id: "QFG90", nozzle_temperature: [220, 270] },
  "No id": { type: "PLA" },
});

test("parseFilamentDb indexes QIDI's list by filament id", () => {
  assert.deepEqual(filDb, { QFG90: { name: "Generic PETG", type: "PETG", temps: [220, 270] } });
});

test("readSlots reads colours, filaments, presence and the loaded slot", () => {
  const s = L.readSlots(vars, "slot0", filDb);
  assert.equal(s.length, 4);
  assert.deepEqual([s[0].name, s[0].color, s[0].present, s[0].loaded, s[0].fil.name], ["1A", "#060606", true, true, "Generic PETG"]);
  assert.equal(s[1].loaded, false);
  assert.equal(s[2].fil, null, "unknown filament id");
  assert.equal(s[3].present, false, "empty slot (QIDI stores 1 for 'no colour')");
  assert.ok(L.readSlots(undefined, null, undefined).every(x => !x.present));
});

test("boxEnabled", () => {
  assert.equal(L.boxEnabled(vars), true);
  assert.equal(L.boxEnabled({ enable_box: 0, box_count: 0 }), false);
  assert.equal(L.boxEnabled(null), false);
});

test("matchSlot pairs a Box spool with the wall filament of the same colour and material", () => {
  const slots = L.readSlots(vars, "slot0", filDb);
  const lib = L.groupLibrary([run(1), run(2)], { "1": "Green PETG", "2": "Green PLA" },
    { "Green PETG": { material: "PETG", color: "#5CF30E" }, "Green PLA": { material: "PLA", color: "#5cf30e" } });
  assert.equal(L.matchSlot(slots[1], lib).name, "Green PETG");
  assert.equal(L.matchSlot(slots[0], lib), null, "no black filament on the wall");
  assert.equal(L.matchSlot(slots[3], lib), null, "empty slot");
});

test("slotTemp uses the middle of QIDI's range, else the material default", () => {
  assert.equal(L.slotTemp({ type: "PETG", temps: [220, 270] }), 245);
  assert.equal(L.slotTemp({ type: "PLA", temps: [190, 241] }), 215);
  assert.equal(L.slotTemp({ type: "ABS" }), L.MAT_TEMP.ABS);
  assert.equal(L.slotTemp(null), L.MAT_TEMP.PLA);
});

test("buildCommand builds Automm3AdaptivePA's command", () => {
  const ok = L.buildCommand({ temp: 245.4, layer: 0.2, width: 0.42, loc: "chute", blocks: 12, points: 5 });
  assert.equal(ok.err, "");
  assert.equal(ok.cmd, "QIDI_AUTO_CALIBRATE TEMP=245 LAYER=0.20 WIDTH=0.42 BLOCKS=12 POINTS=5");
  const bed = L.buildCommand({ temp: 220, layer: 0.24, width: 0.62, loc: "bed", blocks: 30, points: 7, dry: true });
  assert.equal(bed.cmd, "QIDI_AUTO_CALIBRATE_BED TEMP=220 LAYER=0.24 WIDTH=0.62 BLOCKS=30 POINTS=7 DRY=1");
});

test("buildCommand refuses values Automm3AdaptivePA would reject", () => {
  const base = { temp: 220, layer: 0.2, width: 0.42, loc: "chute", blocks: 12, points: 5 };
  assert.match(L.buildCommand({ ...base, temp: 320 }).err, /Temperature/);
  assert.match(L.buildCommand({ ...base, temp: 150 }).err, /Temperature/);
  assert.match(L.buildCommand({ ...base, temp: NaN }).err, /Temperature/);
  assert.match(L.buildCommand({ ...base, layer: 0 }).err, /Layer/);
  assert.match(L.buildCommand({ ...base, width: 2 }).err, /Line width/);
  assert.match(L.buildCommand({ ...base, blocks: 13 }).err, /Precision/);
  assert.match(L.buildCommand({ ...base, points: 4 }).err, /rows/);
  assert.equal(L.buildCommand({ ...base, temp: 300 }).err, "");
});

test("classifyLine", () => {
  assert.equal(L.classifyLine("!! auto_cal: no working_max"), "e");
  assert.equal(L.classifyLine("// auto_cal: ---- Stage 1: max flow ----"), "s");
  assert.equal(L.classifyLine("// flow_ramp: WORKING MAX = 18.5 mm3/s"), "r");
  assert.equal(L.classifyLine("// flow_ramp: retracted 2.00 mm"), "");
  assert.equal(L.classifyLine("// probe at 10,10 is z=0.04"), "c");
});

test("stageFromLine follows Automm3AdaptivePA's console messages", () => {
  assert.equal(L.stageFromLine("// auto_cal: full calibration at 220 C - flow search"), "prep");
  assert.equal(L.stageFromLine("// auto_cal_bed: ---- preparing (home, chute, bed"), "prep");
  assert.equal(L.stageFromLine("// auto_cal: ---- Stage 3: pressure advance ----"), "3");
  assert.equal(L.stageFromLine("// auto_cal_bed: ---- Stage 4: Orca table ----"), "4");
  assert.equal(L.stageFromLine("// auto_cal: heater off, waiting for 170 C"), "cool");
  assert.equal(L.stageFromLine("// auto_cal: DRY - nothing heated, nothing moved."), "done");
  assert.equal(L.stageFromLine("!! something broke"), "fail");
  assert.equal(L.stageFromLine("// flow_ramp: wiped"), null);
});

test("buildExport writes names, colours and a readable copy of the results", () => {
  const runs = [{ ...run(100), where: "Chute" }, { ...run(200), where: "Bed" }];
  const e = L.buildExport(runs, { "100": "PLA", pending: { name: "x", t: 1 } }, { PLA: { material: "PLA", color: "#ffffff" } },
    new Date("2026-11-19T12:00:00Z"));
  assert.equal(e.app, "automm-ui");
  assert.equal(e.exported, "2026-11-19T12:00:00.000Z");
  assert.deepEqual(e.labels, { "100": "PLA" });
  assert.equal(e.runs.length, 1);
  assert.equal(e.runs[0].name, "PLA");
  assert.equal(e.runs[0].qmax_mm3_s, 18.5);
  assert.equal(e.runs[0].where, "Chute");
  assert.equal("block" in e.runs[0], false, "Automm3AdaptivePA's printable text block is left out");
});

test("mergeImport round-trips an export", () => {
  const runs = [run(100), run(200)];
  const e = L.buildExport(runs, { "100": "PLA white" }, { "PLA white": { material: "PLA", color: "#ffffff" } });
  const m = L.mergeImport(JSON.parse(JSON.stringify(e)), { "200": "PETG" }, {}, ["100", "200"]);
  assert.deepEqual(m.labels, { "100": "PLA white", "200": "PETG" });
  assert.deepEqual(m.meta, { "PLA white": { material: "PLA", color: "#ffffff" } });
  assert.deepEqual(m.summary, { filaments: 1, runs: 1, missing: 0 });
});

test("mergeImport counts runs that aren't on this printer and cleans bad values", () => {
  const data = { app: "q2-calibration-ui", labels: { "5": "A", "6": "A", pending: { t: 1 }, nope: "B", "7": "" },
    meta: { A: { material: "Unobtainium", color: "red" }, B: "not an object", ["X".repeat(80)]: { color: "#ABCDEF" } } };
  const m = L.mergeImport(data, {}, {}, ["5"]);
  assert.deepEqual(m.labels, { "5": "A", "6": "A" });
  assert.deepEqual(m.meta.A, {}, "unknown material and invalid colour are dropped");
  assert.equal(m.meta["X".repeat(60)].color, "#abcdef", "names are cut to 60 characters");
  assert.deepEqual(m.summary, { filaments: 1, runs: 2, missing: 1 });
});

test("mergeImport rejects files that aren't exports", () => {
  for (const bad of [null, {}, { app: "other", labels: {}, meta: {} }, { app: "automm-ui", labels: {} }, { app: "automm-ui", labels: "x", meta: {} }]) {
    assert.throws(() => L.mergeImport(bad, {}, {}, []), /isn't a filament wall export/);
  }
});

test("isSlowFps", () => {
  assert.equal(L.isSlowFps(30, 2000), true, "15 fps");
  assert.equal(L.isSlowFps(120, 2000), false, "60 fps");
  assert.equal(L.isSlowFps(2, 2000), false, "too few frames to judge (e.g. a background tab)");
  assert.equal(L.isSlowFps(30, 0), false);
});

test("STAGES ids line up with stageFromLine", () => {
  const ids = L.STAGES.map(s => s[0]);
  for (const id of ["prep", "1", "2", "3", "4", "cool", "done"]) assert.ok(ids.includes(id), id);
});
