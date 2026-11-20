"""Repository checks: things that should stay true before every release.

    python3 -m unittest discover -s tests
"""

import json
import re
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
TEXT_SUFFIXES = {".html", ".css", ".js", ".mjs", ".py", ".sh", ".md", ".yml", ".json", ""}
SKIP_DIRS = {".git", "node_modules", "__pycache__", ".claude", "backup"}


def repo_text_files():
    for path in REPO.rglob("*"):
        if any(part in SKIP_DIRS for part in path.relative_to(REPO).parts):
            continue
        if path.is_file() and not path.is_symlink() and path.suffix in TEXT_SUFFIXES and path.name != "LICENSE":
            yield path


class Hygiene(unittest.TestCase):
    def test_no_private_addresses_or_home_folders(self):
        """The page must work on anyone's printer: no hard-coded LAN IPs or personal paths."""
        private_ip = re.compile(r"\b(10\.\d{1,3}|192\.168|172\.(1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3}\b")
        personal = re.compile(r"/home/(?!qidi\b|mks\b|pi\b)[a-z]+/")
        for path in repo_text_files():
            text = path.read_text(errors="replace")
            self.assertIsNone(private_ip.search(text), f"private IP address in {path.relative_to(REPO)}")
            self.assertIsNone(personal.search(text), f"personal home folder in {path.relative_to(REPO)}")

    def test_no_email_addresses(self):
        email = re.compile(r"[\w.+-]+@[\w-]+\.[\w.]+")
        allowed = {"noreply@anthropic.com"}
        for path in repo_text_files():
            for m in email.findall(path.read_text(errors="replace")):
                self.assertIn(m, allowed, f"email address in {path.relative_to(REPO)}")

    def test_page_assets_exist(self):
        html = (REPO / "web" / "index.html").read_text()
        for ref in re.findall(r'(?:src|href)="([^"#:]+)"', html):
            self.assertTrue((REPO / "web" / ref).exists(), f"web/index.html references missing {ref}")

    def test_every_id_app_js_uses_exists_in_the_page(self):
        html = (REPO / "web" / "index.html").read_text()
        app = (REPO / "web" / "app.js").read_text()
        ids = set(re.findall(r'id="([^"]+)"', html))
        for used in sorted(set(re.findall(r'\$\("([A-Za-z0-9_]+)"\)', app))):
            # these are created by app.js itself
            if used in {"nozzle", "mover"}:
                continue
            self.assertIn(used, ids, f'app.js uses $("{used}") but index.html has no such id')

    def test_lib_is_loaded_before_app(self):
        html = (REPO / "web" / "index.html").read_text()
        self.assertLess(html.index('src="lib.js"'), html.index('src="app.js"'))

    def test_sidebar_script_and_installer_agree_on_the_path(self):
        nav = (REPO / "web" / "fluidd-nav.js").read_text()
        installer = (REPO / "install.sh").read_text()
        self.assertIn('const PAGE = "/automm/', nav)
        self.assertIn('LINK_NAME="automm"', installer)
        self.assertIn("./automm/fluidd-nav.js", installer)

    def test_version_is_consistent(self):
        version = (REPO / "VERSION").read_text().strip()
        self.assertRegex(version, r"^\d+\.\d+\.\d+$")
        self.assertIn(f'VERSION = "{version}"', (REPO / "web" / "lib.js").read_text())
        self.assertIn(f"## {version}", (REPO / "CHANGELOG.md").read_text())

    def test_credit_and_ui_only_statement(self):
        readme = (REPO / "README.md").read_text()
        self.assertIn("Buddman69", readme)
        self.assertIn("https://github.com/Buddman69/Automm3AdaptivePA", readme)
        self.assertRegex(readme, r"(?i)only a (user )?interface|just a UI")

    def test_licence_present(self):
        text = (REPO / "LICENSE").read_text()
        self.assertIn("GNU GENERAL PUBLIC LICENSE", text)
        self.assertIn("Version 3", text)

    def test_no_automm_code_is_bundled(self):
        """Automm3AdaptivePA is PolyForm Strict licensed and must not be copied into this repo."""
        for path in REPO.rglob("qidi_*.py"):
            self.fail(f"{path.relative_to(REPO)} looks like Automm3AdaptivePA code")

    def test_package_json_is_valid(self):
        data = json.loads((REPO / "package.json").read_text())
        self.assertEqual(data["name"], "automm-ui")
        self.assertEqual(data["version"], (REPO / "VERSION").read_text().strip())


if __name__ == "__main__":
    unittest.main()
