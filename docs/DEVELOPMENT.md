# Developing automm-ui

This guide explains how automm-ui works and how to change it safely. Start here if you want to fix a
bug, add a feature or port it to another printer.

A reminder of scope: automm-ui is **only an interface**. It never measures anything. It sends
[Automm3AdaptivePA](https://github.com/Buddman69/Automm3AdaptivePA)'s G-code commands and reads the
result files that project writes. If a change would need new measurements or different
calibration logic, it belongs in Automm3AdaptivePA, not here.

---

## Contents

1. [The big picture](#1-the-big-picture)
2. [Files](#2-files)
3. [What the page reads and writes](#3-what-the-page-reads-and-writes)
4. [How the page works](#4-how-the-page-works)
5. [The Fluidd sidebar entry](#5-the-fluidd-sidebar-entry)
6. [The installer](#6-the-installer)
7. [Working on it](#7-working-on-it)
8. [Tests](#8-tests)
9. [Conventions](#9-conventions)
10. [Releasing](#10-releasing)
11. [Known limits and ideas](#11-known-limits-and-ideas)

---

## 1. The big picture

```
   Browser / Fluidd / OrcaSlicer Device tab
                 │  http://printer/automm/
                 ▼
   nginx (already there, serves Fluidd)
     ├── /automm/        → symlink → ~/automm-ui/web/            the page (static files)
     │     └── data/     → symlink → ~/printer_data/qidi_pa/     Automm3AdaptivePA's result files (read-only)
     ├── /server/files/… → Moonraker file API                    QIDI's filament list (read-only)
     └── /websocket      → Moonraker JSON-RPC
                              ├── printer status, Box state       (subscribe)
                              ├── QIDI_AUTO_CALIBRATE …           (runs Automm3AdaptivePA)
                              └── database "automm_ui"            (filament names and colours)
```

- **No server code.** Everything is static files served by the nginx that already serves Fluidd.
  The page talks to Moonraker over the same websocket Fluidd uses.
- **No build step, no dependencies.** Plain HTML, CSS and JavaScript that browsers run as-is.
- **Nothing is installed into Klipper.** The installer only creates two symlinks and, for the
  sidebar, adds one `<script>` tag to Fluidd's `index.html`.

## 2. Files

```
automm-ui/
├── web/                     the page; this folder is what nginx serves at /automm/
│   ├── index.html           markup: header, wall, printer, dialogs
│   ├── style.css            all styles (Fluidd's dark palette as CSS variables at the top)
│   ├── lib.js               pure logic: no DOM, no network. Unit-tested.
│   ├── app.js               the UI: rendering, Moonraker calls, event handlers
│   └── fluidd-nav.js        loaded by Fluidd (not by the page) to add the sidebar entry
├── install.sh               installer, runs on the printer
├── install-from-pc.sh       copies the folder to the printer over SSH and runs install.sh
├── tools/take-screenshots.py   retakes the README screenshots from a printer (Playwright)
├── tests/
│   ├── lib.test.mjs         Node tests for web/lib.js
│   ├── test_install.py      install.sh against a fake printer in a temp folder
│   └── test_repo.py         repository checks (no private IPs, assets exist, versions agree, credits)
├── docs/DEVELOPMENT.md      this file
├── docs/images/             README screenshots
├── .github/workflows/tests.yml   CI: runs all tests and shellcheck on every push
├── VERSION, CHANGELOG.md, LICENSE (GPL-3.0), package.json (only for `npm test`)
```

On the printer the installer also creates `web/data` (symlink) and `backup/` (Fluidd's original
`index.html`). Both are in `.gitignore`.

**Rule of thumb:** if a function can be written without `document`, `window` or `fetch`, it goes in
`lib.js` with a test. `app.js` should mostly be wiring.

## 3. What the page reads and writes

### Automm3AdaptivePA's results (read-only)

Served from `web/data/` (a link to `~/printer_data/qidi_pa/`):

| File | Written by | Used for |
|---|---|---|
| `auto_cal.json` | `QIDI_AUTO_CALIBRATE` (purge chute) | runs on the wall |
| `auto_cal_bed.json` | `QIDI_AUTO_CALIBRATE_BED` (over the bed) | runs on the wall |

Each file is a JSON list. The entries automm-ui uses look like this (trimmed):

```json
{
  "kind": "auto_cal",
  "time": 1793597048.34,
  "payload": {
    "qmax_mm3_s": 18.5,
    "centre_k": 0.0328,
    "temp_c": 260.0,
    "minutes": 11.3,
    "rows": ["0.0493,2.77,500", "0.0334,4.46,500", "…", "0.0493,2.77,10000", "…"],
    "geometry": { "layer_h": 0.24, "line_w": 0.62, "filament_d": 1.75 },
    "blocks": 12, "points": 5
  }
}
```

- `rows` is OrcaSlicer's adaptive PA format, `PA,flow,acceleration`. Automm3AdaptivePA lists
  each flow twice (low and high acceleration, same PA) because it found no acceleration
  dependence. `lib.pointsOf()` reduces that to one point per flow for the chart.
- A run is identified by `runKey(run)`: its `time` rounded to the second, as a string.
- `lib.parseRunsFile()` skips anything without `qmax_mm3_s` and `centre_k` (aborted runs). It also
  copes with nginx answering a *missing* file with Fluidd's `index.html` (HTTP 200, not JSON).

If Automm3AdaptivePA changes this format, `parseRunsFile` and its tests are the place to adapt.

### Printer state (Moonraker subscription)

`printer.objects.subscribe` with:

| Object | Fields | Used for |
|---|---|---|
| `webhooks` | `state` | Klipper ready / shut down |
| `extruder`, `heater_bed` | `temperature`, `target` | header pills, nozzle glow |
| `idle_timeout` | `state` | "Printing" means a G-code command is running, so Start is disabled |
| `save_variables` | `variables` | **QIDI Box**: `color_slotN` (`["5CF30E"]`, or `1` when empty), `filament_slotN` (a QIDI filament id like `QFG90`), `slotN` (`0` = empty), `enable_box`, `box_count` |
| `box_extras` | `loaded_slot` | which slot is in the toolhead (`"slot0"`…) |

QIDI filament ids are turned into names with QIDI's own list at
`/server/files/config/.qidi_filaments/filament-0.4.json` (see `lib.parseFilamentDb`). The Box
variables are QIDI-specific. On other printers the Box shelf simply doesn't show.

### Commands sent (Moonraker `printer.gcode.script`)

| Command | When |
|---|---|
| `QIDI_AUTO_CALIBRATE TEMP= LAYER= WIDTH= BLOCKS= POINTS=` | Start (purge chute) |
| `QIDI_AUTO_CALIBRATE_BED …` | Start (over the bed) |
| the same with ` DRY=1` | Dry run: prints the plan, heats and moves nothing |

They're built by `lib.buildCommand()`, which also refuses values Automm3AdaptivePA would reject
(temperature 170–300 °C, precision 12/20/30, rows 3/5/7). The calibration call only returns when
the whole calibration has finished (10–15 minutes). Progress comes from the console lines in
between (`notify_gcode_response`), which `lib.stageFromLine()` maps to stages.

Other calls: `printer.info`, `printer.emergency_stop` (STOP), `printer.firmware_restart`.

### Filament names (Moonraker database)

Namespace **`automm_ui`**, via `server.database.get_item` / `post_item`:

| Key | Value |
|---|---|
| `labels` | `{ "<runKey>": "Filament name", …, "pending": { "name": "…", "t": <unix seconds> } }` |
| `meta` | `{ "Filament name": { "material": "PETG", "color": "#5cf30e" } }` |

`pending` is written when a calibration starts. The first unnamed run at or after `t` gets that
name when the results arrive (`lib.assignPending`). That's how a new calibration lands on the
wall with the right name.

### Export file

`lib.buildExport()` / `lib.mergeImport()`:

```json
{
  "app": "automm-ui", "version": 1, "exported": "2026-11-20T10:00:00.000Z",
  "labels": { "1793597048": "Elegoo PETG black" },
  "meta":   { "Elegoo PETG black": { "material": "PETG", "color": "#060606" } },
  "runs":   [ { "key": "1793597048", "name": "Elegoo PETG black", "qmax_mm3_s": 18.5, "centre_k": 0.0328, "…": "…" } ]
}
```

`runs` is a convenience copy so the file is readable on its own. Import only uses `labels` and
`meta`, merges them into what's there, drops unknown materials and invalid colours, and cuts names
to 60 characters. Files with `"app": "q2-calibration-ui"` (pre-release builds) are accepted too.

## 4. How the page works

`app.js` is organised in sections (search for the `// ----` comments):

| Section | Does |
|---|---|
| spool artwork | `spool3D()`: a CSS-3D spool. The filament is a cylinder of flat strips (`cylinder()`), each shaded for a light at the upper left; two flanges (`disc()`); a peg. |
| moonraker | websocket connect/reconnect, `rpc()`, the status subscription, `applyStatus()` |
| data | `loadAll()` fetches the result files and names, then renders. `library()`, `slots()` and `slotMatch()` wrap the pure versions in `lib.js`. |
| wall | `renderWall()`: Box shelf, calibrated shelf, unsorted runs |
| selection → printer | `resolveSel()` turns the selection (`{kind:"fil"|"slot"|"run"}`) into what to show. `renderSelection()` fills the callouts, the nozzle diagram (`geoSVG`), the chart and the Orca fields. |
| the 3D printer | `buildPrinter()` builds the Q2 out of CSS-3D boxes (`cub()`). `drawLeaders()` draws the dotted lines from the callouts to the nozzle. |
| console + stages | `logLine()`, `trackStage()`, `runCommand()`, the whole start → finish flow |
| calibrate / name dialogs | forms, validation, pre-filling from the selected spool |
| export / import / delete all | the wall's header buttons |
| lite mode | `setLite()` and `autoLite()` (measures frames per second once, two seconds after load) |

**Embed mode** (`?embed=1`) hides the page header and turns off auto-scrolling. It's used by the
sidebar and the optional dashboard card. In an iframe, `scrollIntoView` would scroll Fluidd too,
so the page only ever scrolls its own window (`scrollToEl`).

**Lite mode** exists because embedded web views (OrcaSlicer's Device tab in particular) can be
slow at CSS 3D. Lite drops animations and hover effects and builds spools with fewer facets. One
lesson learned: don't put a CSS `filter` (e.g. `drop-shadow`) on 3D content. It's re-rendered on
every frame and was the main cause of 15 fps in OrcaSlicer. The spool shadow is a plain gradient
(`.shd`) instead.

**Styling**: all colours are CSS variables at the top of `style.css`, copied from Fluidd's dark
theme (`#1e1e20` background, `#262629` cards, `#333337` card headers, `#5576d1` primary). Container
queries on `.stagewrap` decide whether the value cards sit around the printer or in a grid below it.

## 5. The Fluidd sidebar entry

Fluidd has no setting for custom sidebar links, so the installer adds one line to Fluidd's
`index.html`:

```html
<script src="./automm/fluidd-nav.js" defer></script>
```

`fluidd-nav.js` then:

1. waits for Fluidd's sidebar (`.nav-items`) and **clones one of Fluidd's own links**, so it looks
   native, swaps the icon and title, and inserts it before *Settings*;
2. on click, shows a fixed overlay with an iframe of `/automm/?embed=1`, positioned under the app
   bar and next to the sidebar (`place()`). Fluidd's URL doesn't change, and the iframe stays loaded
   while hidden, so a running calibration keeps its live view;
3. closes the overlay when any other sidebar link is clicked or the route changes;
4. keeps re-adding the entry with a `MutationObserver`, because Fluidd can re-render its sidebar.
   It uses `setTimeout`, not `requestAnimationFrame`, since rAF doesn't fire in background tabs.

Caveats:

- A Fluidd update (or a QIDI firmware update) replaces `index.html`, so the entry disappears until
  the installer runs again.
- It depends on Fluidd's DOM (`.nav-items a[href*="#/"]`, `.v-app-bar`). If a future Fluidd
  changes those, this script is the one place to update.

## 6. The installer

`install.sh` runs **on the printer**, as the user that owns the web interface. It:

1. finds the web root by asking nginx: the site with a `location /websocket` block is the one
   serving Fluidd/Mainsail, and its `root` line is the folder. It falls back to `~/fluidd` /
   `~/mainsail`;
2. links `web/data → ~/printer_data/qidi_pa` and `<web root>/automm → web/`, refusing to replace
   anything that isn't already a symlink;
3. for Fluidd, saves the original `index.html` to `backup/` once and adds the script tag (only if
   it's not there yet, so re-running is safe);
4. with `--camera`, registers the page with Moonraker as an `iframe` camera (`POST /server/webcams/item`).

`--uninstall` reverses each step. It removes exactly the script tag (not the whole line), so Fluidd's
`index.html` ends up byte-for-byte as before. It never deletes the result files or the
database. Every path can be overridden with an environment variable (`PRINTER_DATA`,
`RESULTS_DIR`, `WEB_ROOT`, `NGINX_SITES`, `MOONRAKER_URL`), which is how the tests run it in a
temporary folder.

`install-from-pc.sh` streams `install.sh`, `VERSION`, `LICENSE`, `README.md` and `web/` (without
`web/data`) over one SSH connection into `~/automm-ui` and runs the installer there.

## 7. Working on it

You need a printer running Automm3AdaptivePA to see real data. The page talks to the Moonraker
it's served from.

**Fast loop:** because `/automm/` is a symlink to `~/automm-ui/web`, copying a single file
updates the live page immediately:

```bash
scp web/app.js qidi@PRINTER_IP:~/automm-ui/web/app.js
```

Then hard-reload the page (Ctrl+Shift+R). For bigger changes just run
`./install-from-pc.sh PRINTER_IP`.

**Handy things:**

- `?embed=1` shows exactly what the sidebar and the dashboard card show.
- `?lite=1` forces lite mode. `localStorage["automm-ui.lite"]` stores the manual choice.
- The browser devtools console shows websocket traffic under *Network → WS*.
- **Dry run** exercises the whole start → finish flow without heating anything.
  Prefer it while working on the Live panel.
- Never test a real (heated) calibration without being at the printer.

## 8. Tests

```bash
npm test                                    # everything (needs Node 20+ and Python 3)
node --test tests/                          # lib.js only
python3 -m unittest discover -s tests -v    # installer + repository checks
```

| File | Covers |
|---|---|
| `tests/lib.test.mjs` | every function in `lib.js`: parsing result files (including the nginx-returns-HTML case), grouping and naming runs, Box slot reading and matching, the command builder and its limits, console line classification and stage tracking, export/import round-trips and rejection of bad files, lite-mode detection. The Box data is a trimmed copy of what a real QIDI Q2 reports. |
| `tests/test_install.py` | `install.sh` against a fake printer: links, sidebar tag, backup, running twice, uninstall restoring Fluidd byte-for-byte, dry run, `--no-sidebar`, refusing to overwrite a real folder, missing results, read-only web root, Mainsail, no nginx, `--camera` without Moonraker. |
| `tests/test_repo.py` | no private IP addresses, personal home folders or email addresses in the repo; every asset `index.html` links exists; every `$("id")` in `app.js` exists in `index.html`; `lib.js` loads before `app.js`; installer and sidebar script agree on `/automm/`; `VERSION`, `lib.js`, `package.json` and `CHANGELOG.md` agree; the README credits Automm3AdaptivePA and says this is only a UI; no Automm3AdaptivePA code is bundled. |

CI (`.github/workflows/tests.yml`) runs all of it plus `shellcheck` on every push and pull request.

**Not automated:** the visual result and the Fluidd sidebar inside a real Fluidd. Before a release,
check by hand on a printer:

- [ ] the page loads at `/automm/` with no console errors, and the wall shows your runs and Box spools
- [ ] the sidebar entry appears, opens the page, and closes when you click another entry
- [ ] Dry run completes and the Live panel steps through to *Done*
- [ ] copy buttons put the right number on the clipboard
- [ ] Export → Delete all → Import brings the wall back
- [ ] narrow window / phone layout has no sideways scrolling
- [ ] `--uninstall` leaves Fluidd as it was

## 9. Conventions

- **Plain browser JavaScript**, no frameworks, no build, no dependencies. That keeps the install a
  file copy, and anyone can read the code in the browser.
- **Pure logic in `lib.js`, with a test.** `lib.js` must stay DOM-free so Node can run it.
- **Comments explain *why***, not what. Note anything that was learned the hard way (like the
  `filter` performance trap or the rAF-in-background-tabs bug).
- **Never put user data in the code**: no IP addresses, names or paths (a test checks).
- **Accessibility:** buttons have `aria-label`s; tooltips also open on keyboard focus.
- **Don't bundle Automm3AdaptivePA.** It's PolyForm Strict licensed; users install it from its own
  repository. Refer to it by name and link.
- Keep the installer **sudo-free, idempotent and fully reversible**, and add a test for any new step.

## 10. Releasing

1. Bump the version in **`VERSION`**, **`web/lib.js`** (`VERSION`) and **`package.json`**.
2. Add a section to **`CHANGELOG.md`** (`## x.y.z - date`).
3. `npm test`, then the manual checklist above.
4. If the look changed, retake the screenshots (below).
5. Commit, tag `vX.Y.Z`, push, and create a GitHub release. The source zip is what users download.

### Screenshots

The README's pictures in `docs/images/` come from `tools/take-screenshots.py`, which drives a
headless Chromium (Playwright) against a real printer:

```bash
pip install playwright && python -m playwright install chromium-headless-shell
python tools/take-screenshots.py PRINTER_IP docs/images
```

Only in the browser's memory, it swaps your filament names for example names, so personal names
never end up on GitHub. All the numbers stay real. It needs a few named calibrations on the wall.
`tests/test_repo.py` checks that every image the README shows exists.

`tests/test_repo.py` fails if the version numbers or the changelog don't agree.

## 11. Known limits and ideas

- Tested only on a **QIDI Q2** with Fluidd v1.30.5 and Automm3AdaptivePA Q2 v1.2.3. The X-Max 4
  should work (same commands and files) but is untested. Mainsail gets the page but no sidebar entry.
- Box support reads **one Box with four slots**, and filament names from QIDI's 0.4 mm list.
- Temperatures above 300 °C are refused because Automm3AdaptivePA's flow search refuses them.
- automm-ui can't load filament from the Box. Automm3AdaptivePA doesn't, and doing it from a UI
  without its safety checks would be a bad idea.
- Ideas: export a ready-to-import OrcaSlicer filament preset; compare two runs on one chart;
  support several Boxes; screenshots in the README.
