// fluidd-nav.js - adds a "Calibration" entry to Fluidd's left sidebar.
//
// Fluidd has no setting for custom sidebar links, so this is loaded by one
// <script> line in Fluidd's index.html. It clones one of Fluidd's own sidebar
// links (so it inherits Fluidd's look), and clicking it shows the calibration
// page in Fluidd's main area, under the app bar and next to the sidebar.
// Clicking any other sidebar entry hides it again. Fluidd itself is untouched:
// the URL never changes, and the page stays loaded in the background.
(() => {
  "use strict";
  const PAGE = "/automm/?embed=1";
  const TITLE = "Calibration";
  // nozzle: shank, hex, cone, a drop of plastic
  const ICON = "M8,2H16V6H8V2M5,7H19V11H5V7M6,12H18L14,18H10L6,12M11,19H13V22H11V19Z";

  let link = null, overlay = null, restore = [];

  function isOpen() { return overlay && overlay.style.display !== "none"; }

  function place() {
    if (!overlay) return;
    const bar = document.querySelector("header.v-app-bar, .v-app-bar");
    const aside = link && link.closest("aside");
    const top = bar ? Math.max(0, bar.getBoundingClientRect().bottom) : 0;
    let left = 0;
    if (aside) {
      const r = aside.getBoundingClientRect();
      // a temporary (mobile) drawer slides over the content, so only a visible, docked one counts
      if (r.right > 0 && r.left >= 0 && !aside.classList.contains("v-navigation-drawer--temporary")) left = r.right;
    }
    Object.assign(overlay.style, { top: top + "px", left: left + "px" });
  }

  function open() {
    if (!overlay) {
      overlay = document.createElement("div");
      overlay.id = "automm-overlay";
      Object.assign(overlay.style, { position: "fixed", right: "0", bottom: "0", zIndex: "4", background: "#1e1e20", display: "none" });
      const frame = document.createElement("iframe");
      frame.src = PAGE; frame.title = TITLE;
      Object.assign(frame.style, { border: "0", width: "100%", height: "100%", display: "block" });
      overlay.appendChild(frame);
      document.body.appendChild(overlay);
    }
    overlay.style.display = "block";
    place();
    // show our entry as the active one while the page is open
    restore = [...document.querySelectorAll(".nav-items a.v-list-item--active")].filter(a => a !== link);
    restore.forEach(a => a.classList.remove("v-list-item--active"));
    link.classList.add("v-list-item--active");
  }

  function close() {
    if (!isOpen()) return;
    overlay.style.display = "none";
    if (link) link.classList.remove("v-list-item--active");
    restore.forEach(a => a.classList.add("v-list-item--active"));
    restore = [];
  }

  function ensureLink() {
    const list = document.querySelector(".nav-items");
    if (!list || (link && list.contains(link))) return;
    const tpl = list.querySelector('a[href*="#/"]');
    if (!tpl) return;
    link = tpl.cloneNode(true);
    link.classList.remove("v-list-item--active", "secondary--text");
    link.removeAttribute("aria-current");
    link.setAttribute("href", "#");
    link.setAttribute("title", TITLE);
    link.setAttribute("aria-label", TITLE);
    link.dataset.automm = "1";
    const path = link.querySelector("svg path");
    if (path) path.setAttribute("d", ICON);
    const label = link.querySelector(".v-list-item__title");
    if (label) label.textContent = TITLE;
    link.addEventListener("click", e => { e.preventDefault(); e.stopPropagation(); isOpen() ? close() : open(); });
    const settings = list.querySelector('a[href$="#/settings"]');
    list.insertBefore(link, settings || null);
    if (isOpen()) link.classList.add("v-list-item--active");
  }

  // any other sidebar link, or a route change, hides the page again
  document.addEventListener("click", e => {
    const a = e.target.closest && e.target.closest(".nav-items a");
    if (a && a !== link) close();
  }, true);
  window.addEventListener("hashchange", close);
  window.addEventListener("resize", place);

  // Fluidd builds (and can rebuild) its sidebar after load, so keep re-adding the entry.
  // setTimeout, not requestAnimationFrame: rAF never fires in a background tab, which left the entry missing.
  let queued = false;
  new MutationObserver(() => {
    if (queued) return;
    queued = true;
    setTimeout(() => { queued = false; ensureLink(); if (isOpen()) place(); }, 50);
  }).observe(document.documentElement, { childList: true, subtree: true });
  ensureLink();
})();
