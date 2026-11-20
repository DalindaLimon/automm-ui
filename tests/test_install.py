"""Tests for install.sh, run against a fake printer in a temporary folder.

    python3 -m unittest discover -s tests

Each test builds a pretend home directory (printer_data, a Fluidd or Mainsail
folder and an nginx site), copies the installer into it and runs it there, so
nothing on this machine or any printer is touched.
"""

import os
import shutil
import stat
import subprocess
import tempfile
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
NAV_TAG = '<script src="./automm/fluidd-nav.js" defer></script>'
FLUIDD_INDEX = (
    '<!doctype html><html><head><meta charset="utf-8">'
    '<link rel="manifest" href="./manifest.webmanifest"></head>'
    '<body><div id="app"></div></body></html>\n'
)


class FakePrinter:
    """A temporary home with printer_data, a web UI and an nginx site pointing at it."""

    def __init__(self, ui="fluidd", results=True):
        self.tmp = Path(tempfile.mkdtemp(prefix="automm-ui-test-"))
        self.home = self.tmp / "home"
        self.app = self.home / "automm-ui"
        self.results = self.home / "printer_data" / "qidi_pa"
        self.web_root = self.home / ui
        self.sites = self.tmp / "nginx-sites"

        (self.home / "printer_data").mkdir(parents=True)
        if results:
            self.results.mkdir()
            (self.results / "auto_cal.json").write_text("[]")
        self.web_root.mkdir()
        (self.web_root / "index.html").write_text(FLUIDD_INDEX)
        (self.web_root / "release_info.json").write_text(f'{{"project_name":"{ui}","version":"v1"}}')
        self.sites.mkdir()
        (self.sites / ui).write_text(
            "server {\n    listen 80;\n"
            f"    root {self.web_root};\n"
            "    location /websocket {\n        proxy_pass http://apiserver/websocket;\n    }\n}\n"
        )
        # the installer as it would be unpacked on the printer
        self.app.mkdir()
        for name in ("install.sh", "VERSION"):
            shutil.copy2(REPO / name, self.app / name)
        shutil.copytree(REPO / "web", self.app / "web", ignore=shutil.ignore_patterns("data", ".claude"))

    def run(self, *args, expect=0):
        env = dict(os.environ, HOME=str(self.home), NGINX_SITES=str(self.sites),
                   MOONRAKER_URL="http://127.0.0.1:9")  # nothing listens there: camera calls must fail politely
        env.pop("WEB_ROOT", None)
        p = subprocess.run(["bash", str(self.app / "install.sh"), *args], env=env,
                           capture_output=True, text=True, timeout=60)
        out = p.stdout + p.stderr
        if p.returncode != expect:
            raise AssertionError(f"install.sh {' '.join(args)} exited {p.returncode}, expected {expect}:\n{out}")
        return out

    @property
    def index(self):
        return (self.web_root / "index.html").read_text()

    def cleanup(self):
        shutil.rmtree(self.tmp, ignore_errors=True)


class InstallTests(unittest.TestCase):
    def setUp(self):
        self.p = FakePrinter()
        self.addCleanup(self.p.cleanup)

    def test_install_creates_links_and_sidebar_entry(self):
        out = self.p.run()
        page = self.p.web_root / "automm"
        self.assertTrue(page.is_symlink())
        self.assertEqual(page.resolve(), (self.p.app / "web").resolve())
        data = self.p.app / "web" / "data"
        self.assertTrue(data.is_symlink())
        self.assertEqual(data.resolve(), self.p.results.resolve())
        self.assertEqual(self.p.index.count(NAV_TAG), 1)
        self.assertIn(NAV_TAG + "</head>", self.p.index)
        self.assertIn("/automm/", out)

    def test_original_fluidd_index_is_backed_up(self):
        self.p.run()
        backup = self.p.app / "backup" / "fluidd-index.html.orig"
        self.assertEqual(backup.read_text(), FLUIDD_INDEX)

    def test_running_twice_changes_nothing_more(self):
        self.p.run()
        first = self.p.index
        out = self.p.run()
        self.assertEqual(self.p.index, first)
        self.assertEqual(self.p.index.count(NAV_TAG), 1)
        self.assertIn("already", out)

    def test_uninstall_restores_fluidd_exactly(self):
        self.p.run()
        self.p.run("--uninstall")
        self.assertEqual(self.p.index, FLUIDD_INDEX)
        self.assertFalse((self.p.web_root / "automm").exists())
        self.assertFalse((self.p.app / "web" / "data").is_symlink())
        self.assertTrue(self.p.results.is_dir(), "Automm3AdaptivePA's results are never touched")

    def test_uninstall_when_never_installed_is_harmless(self):
        self.p.run("--uninstall")
        self.assertEqual(self.p.index, FLUIDD_INDEX)

    def test_dry_run_changes_nothing(self):
        out = self.p.run("--dry-run")
        self.assertIn("dry run", out)
        self.assertEqual(self.p.index, FLUIDD_INDEX)
        self.assertFalse((self.p.web_root / "automm").exists())
        self.assertFalse((self.p.app / "web" / "data").exists())
        self.assertFalse((self.p.app / "backup").exists())

    def test_no_sidebar_leaves_fluidd_alone(self):
        self.p.run("--no-sidebar")
        self.assertEqual(self.p.index, FLUIDD_INDEX)
        self.assertTrue((self.p.web_root / "automm").is_symlink())

    def test_refuses_to_replace_a_real_folder(self):
        real = self.p.web_root / "automm"
        real.mkdir()
        (real / "keep.txt").write_text("mine")
        out = self.p.run(expect=1)
        self.assertIn("not a link", out)
        self.assertEqual((real / "keep.txt").read_text(), "mine")

    def test_missing_results_folder_only_warns(self):
        shutil.rmtree(self.p.results)
        out = self.p.run()
        self.assertIn("doesn't exist yet", out)
        self.assertTrue((self.p.web_root / "automm").is_symlink())

    def test_read_only_web_root_is_explained(self):
        if os.geteuid() == 0:
            self.skipTest("root ignores permissions")
        self.p.web_root.chmod(stat.S_IRUSR | stat.S_IXUSR)
        self.addCleanup(self.p.web_root.chmod, stat.S_IRWXU)
        out = self.p.run(expect=1)
        self.assertIn("isn't writable", out)

    def test_unknown_option(self):
        out = self.p.run("--frobnicate", expect=2)
        self.assertIn("unknown option", out)

    def test_help(self):
        out = self.p.run("--help")
        self.assertIn("--uninstall", out)

    def test_camera_without_moonraker_warns_but_installs(self):
        out = self.p.run("--camera")
        self.assertIn("couldn't reach Moonraker", out)
        self.assertTrue((self.p.web_root / "automm").is_symlink())


class OtherSetups(unittest.TestCase):
    def test_mainsail_gets_the_page_but_no_sidebar_edit(self):
        p = FakePrinter(ui="mainsail")
        self.addCleanup(p.cleanup)
        out = p.run()
        self.assertTrue((p.web_root / "automm").is_symlink())
        self.assertEqual(p.index, FLUIDD_INDEX)
        self.assertIn("only available in Fluidd", out)

    def test_web_root_found_without_nginx(self):
        p = FakePrinter()
        self.addCleanup(p.cleanup)
        shutil.rmtree(p.sites)
        p.sites.mkdir()
        p.run()
        self.assertTrue((p.web_root / "automm").is_symlink())


class PcHelperTests(unittest.TestCase):
    def test_install_from_pc_needs_a_host(self):
        p = subprocess.run(["bash", str(REPO / "install-from-pc.sh")], capture_output=True, text=True)
        self.assertEqual(p.returncode, 2)
        self.assertIn("printer-ip", p.stdout)

    def test_scripts_parse(self):
        for name in ("install.sh", "install-from-pc.sh"):
            subprocess.run(["bash", "-n", str(REPO / name)], check=True)


if __name__ == "__main__":
    unittest.main()
