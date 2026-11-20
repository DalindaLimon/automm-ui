# Changelog

All notable changes to automm-ui. Versions follow [semantic versioning](https://semver.org).

## 1.0.0 - 2026-11-20

First public release. A web interface for
[Automm3AdaptivePA](https://github.com/Buddman69/Automm3AdaptivePA) by Buddman69. The calibration
itself is entirely his project; this release is only the UI around it.

- Filament wall: QIDI Box spools shown live in their real colours, tagged *in the Box* / *in
  toolhead*; named filaments on a scrollable pegboard; unsorted runs you can name.
- Calibrate from a form with a pre-filled temperature, nozzle and geometry, a safety checklist and a dry run.
- Live progress through Automm3AdaptivePA's stages, with a colour-coded console and an emergency STOP.
- Results: max volumetric speed, pressure advance, temperature and measured geometry, each with a
  copy button; PA-vs-flow chart; the exact OrcaSlicer fields.
- 3D Q2 and spools drawn in CSS, Fluidd's dark colours, phone layout.
- Export / import / delete all for the wall's names and colours.
- Fluidd sidebar entry that opens the page inside Fluidd; optional dashboard card.
- Lite mode for slow viewers such as OrcaSlicer's Device tab, switched on automatically.
- Installer that needs no sudo, can be re-run safely and is fully undone by `--uninstall`, plus a one-command install from a PC.
- Tests for the logic, the installer and the repository, run in CI.
