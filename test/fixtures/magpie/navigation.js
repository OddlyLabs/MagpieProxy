// From magpie v0.1.4174, MIT; see LICENSE. The original sidebar implementation.
var NAV_SUBS = {
  usage: () => $("#usageTab"),
  library: () => $("#view-library .lib-tabs"),
  plugins: () => $("#view-plugins .lib-tabs"),
  settings: () => $("#setTabs"),
};
// each tab's mark, from navicons.js (loaded with the first list)
var NAV_SUB_IC;
function navSubItems(v) { return [...(NAV_SUBS[v]?.()?.querySelectorAll(":scope > button") || [])].filter((b) => !b.hidden); }
var navSubsAt = "";
function navSubs() {
  if (mode !== "window") return;
  const nav = $("#nav");
  // a group none of whose pages shows (gateway mode's) leaves out its name
  for (const gl of nav.querySelectorAll(".nav-gl")) {
    let any = false;
    for (let n = gl.nextElementSibling; n && !n.matches(".nav-gl"); n = n.nextElementSibling) if (n.dataset.view && !n.hidden && !n.dataset.replaced) any = true;
    gl.hidden = !any;
  }
  const side = sideNav();
  const items = side ? navSubItems(view) : [];
  const at = view === "settings" ? $("#prefs") : nav.querySelector(`button[data-view="${view}"]`);
  const sig = [side, view, locale, pluginUpdates, ...items.map((b) => b.textContent.trim() + (b.classList.contains("on") ? "*" : ""))].join("|");
  if (sig === navSubsAt) return;
  navSubsAt = sig;
  let box = document.querySelector(".nav-sub:not(.leaving)");
  const want = side && at && items.length > 1;
  const above = at?.id === "prefs";
  if (box && (!want || box.dataset.view !== view || (above ? box.nextElementSibling : box.previousElementSibling) !== at)) { navSubLeave(box); box = null; }
  if (want && !NAV_SUB_IC) import("./navicons.js").then(() => { navSubsAt = ""; navSubs(); }, () => {});
  if (want) {
    const fresh = !box;
    if (fresh) {
      box = el("div", "nav-sub");
      box.setAttribute("role", "tablist");
      box.dataset.view = view;
      box.append(el("i", "nav-hl"));
      box.onkeydown = (e) => {
        const all = [...box.querySelectorAll(".nav-s")], i = all.indexOf(document.activeElement);
        const to = { ArrowDown: i + 1, ArrowUp: i - 1, Home: 0, End: all.length - 1 }[e.key];
        if (i < 0 || to === undefined) return;
        e.preventDefault();
        all[(to + all.length) % all.length].focus();
      };
      if (above) at.before(box); else at.after(box);
    }
    box.setAttribute("aria-label", (at.querySelector("span[data-t]") || at.querySelector("span"))?.textContent || "");
    for (const s of box.querySelectorAll(".nav-s, .nav-sl")) s.remove();
    (window.navSections?.(view, items, t) || items.map((b, i) => [b, i])).forEach(([b, i, head]) => {
      if (head) box.append(el("span", "nav-sl", head));
      const [name, n] = b.textContent.trim().split(" · ");
      const s = el("button", "nav-s");
      s.type = "button";
      s.setAttribute("role", "tab");
      if (b.id) s.dataset.of = b.id;
      const cur = b.classList.contains("on");
      s.classList.toggle("cur", cur);
      s.setAttribute("aria-selected", String(cur));
      s.tabIndex = cur ? 0 : -1;
      const ic = NAV_SUB_IC?.[view]?.[b.dataset.seg || b.dataset.set];
      s.append(ic ? svg(ic, 14, 1.4) : el("i", "nav-s-ic"), el("span", "", name));
      if (b.dataset.sub === "installed" && pluginUpdates) {
        const up = el("em", "up", t(pluginUpdates === 1 ? "1 update" : "{n} updates", { n: pluginUpdates }));
        s.title = t("Newer versions of your plugins are out: update them under Installed");
        s.append(up);
      } else if (n) s.append(el("em", "", n));
      // the selection goes as the finger comes down, as iOS's does
      s.onpointerdown = (e) => { if (e.button === 0) navSubGlide(box, s); };
      s.onpointercancel = () => navSubGlide(box, box.querySelector(".nav-s.cur"));
      s.onpointerleave = (e) => { if (e.buttons & 1) navSubGlide(box, box.querySelector(".nav-s.cur")); };
      s.onclick = (e) => {
        navSubGlide(box, s);
        for (const o of box.querySelectorAll(".nav-s")) o.classList.toggle("cur", o === s);
        const b = navSubItems(view)[i];
        if (!b) return;
        const other = !b.classList.contains("on");
        b.click();
        if (other && scrollOnPurpose(e)) $("#view-" + view).scrollTop = 0;
      };
      box.append(s);
    });
    navSubMark(box, !fresh);
    if (fresh && !navSubs.quiet) navSubEnter(box);
  }
  renderCrumb(items);
}
// the sidebar's lists open and fold the way iOS's do: a spring that
// starts quick and settles slowly, the rows coming in one after another
var NAV_EASE = "cubic-bezier(.32, .72, 0, 1)";
const navCalm = calm;
// the selection is one shape that slides to the row picked
function navSubMark(box, glide) {
  const hl = box.querySelector(".nav-hl"), cur = box.querySelector(".nav-s.cur");
  hl.classList.toggle("still", !glide);
  hl.hidden = !cur;
  if (!cur) return;
  hl.style.transform = `translateY(${cur.offsetTop}px)`;
  hl.style.height = cur.offsetHeight + "px";
  if (!glide) requestAnimationFrame(() => hl.classList.remove("still"));
}
// the selection set off to a row now, ahead of the page (navSubMark puts
// it on the tab the page then shows)
function navSubGlide(box, row) {
  const hl = box.querySelector(".nav-hl");
  if (!hl || !row || hl.hidden) return;
  hl.style.transform = `translateY(${row.offsetTop}px)`;
  hl.style.height = row.offsetHeight + "px";
}
// the open page's row is marked by one shape too (.nav-top-hl), sent on a
// spring; a press that changes its mind turns it with the speed it has
var NAV_SPRING = { response: 0.42, damping: 0.84 }; // seconds, fraction: SwiftUI's terms
var navTop = { row: null, y: 0, h: 0, vy: 0, vh: 0, at: 0, raf: 0, seen: false };
const navTopOn = () => $("#nav")?.querySelector("button[data-view].on") || null;
function navTopHl() {
  const nav = $("#nav");
  let hl = nav.querySelector(":scope > .nav-top-hl");
  if (!hl) {
    hl = el("i", "nav-top-hl");
    hl.hidden = true;
    nav.append(hl);
    // the rows moved at rest: the shape stays on its row
    new ResizeObserver(() => { if (!navTop.raf && navTop.row && !hl.hidden) navTopPut(hl, navTop.row); }).observe(nav);
  }
  return hl;
}
function navTopDraw(hl) {
  hl.style.transform = `translateY(${navTop.y}px)`;
  hl.style.height = navTop.h + "px";
}
function navTopPut(hl, row) {
  Object.assign(navTop, { y: row.offsetTop, h: row.offsetHeight, vy: 0, vh: 0 });
  navTopDraw(hl);
}
// navTopGo sends the shape to row, still unless glide
function navTopGo(row, glide) {
  if (mode !== "window" || !$("#nav")) return;
  const nav = $("#nav"), hl = navTopHl();
  const to = sideNav() && row && !row.hidden && row.offsetParent ? row : null;
  nav.classList.toggle("hl-on", !!to);
  // the same row at rest, or the window opening: put there, not sent
  if (to && ((to === navTop.row && !navTop.raf) || !navTop.seen)) glide = false;
  navTop.row = to;
  if (!to) { cancelAnimationFrame(navTop.raf); navTop.raf = 0; hl.hidden = true; return; }
  const appearing = hl.hidden;
  hl.hidden = false;
  if (!navTop.seen) requestAnimationFrame(() => requestAnimationFrame(() => { navTop.seen = !hl.hidden; }));
  if (appearing || !glide || navCalm()) {
    cancelAnimationFrame(navTop.raf);
    navTop.raf = 0;
    navTopPut(hl, to);
    // back from Settings, whose row is at the foot: it comes up in place
    if (appearing && glide && !navCalm()) hl.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 240, easing: NAV_EASE });
    return;
  }
  if (!navTop.raf) { navTop.at = performance.now(); navTop.raf = requestAnimationFrame(navTopStep); }
}
// where row comes to rest once a list above it has folded (小李 on Discord)
function navTopLands(row) {
  let y = row.offsetTop;
  for (const b of row.parentElement.querySelectorAll(":scope > .nav-sub.leaving")) {
    if (!(b.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING)) continue;
    const cs = getComputedStyle(b);
    y -= b.offsetHeight + parseFloat(cs.marginTop) + parseFloat(cs.marginBottom);
  }
  return y;
}
function navTopStep(now) {
  const nav = $("#nav"), hl = nav?.querySelector(":scope > .nav-top-hl"), row = navTop.row;
  if (!hl || !row?.isConnected) { navTop.raf = 0; return; }
  const dt = Math.min(1 / 30, Math.max(0, (now - navTop.at) / 1000));
  navTop.at = now;
  const k = (2 * Math.PI / NAV_SPRING.response) ** 2, c = 4 * Math.PI * NAV_SPRING.damping / NAV_SPRING.response;
  const ty = navTopLands(row), th = row.offsetHeight;
  // a few small steps a frame keep the spring true at any frame rate
  for (let i = 0, d = dt / 4; i < 4; i++) {
    navTop.vy += (k * (ty - navTop.y) - c * navTop.vy) * d;
    navTop.y += navTop.vy * d;
    navTop.vh += (k * (th - navTop.h) - c * navTop.vh) * d;
    navTop.h += navTop.vh * d;
  }
  const still = Math.abs(ty - navTop.y) < 0.25 && Math.abs(navTop.vy) < 4 && Math.abs(th - navTop.h) < 0.25 && Math.abs(navTop.vh) < 4;
  // at rest once there, and nothing above it still folding
  if (still && !nav.querySelector(".nav-sub.moving, .nav-sub.leaving")) {
    navTopPut(hl, row);
    navTop.raf = 0;
    return;
  }
  navTopDraw(hl);
  navTop.raf = requestAnimationFrame(navTopStep);
}
function navSubEnter(box) {
  if (navCalm()) return;
  const cs = getComputedStyle(box);
  const to = { height: box.offsetHeight + "px", marginTop: cs.marginTop, marginBottom: cs.marginBottom, opacity: 1 };
  box.classList.add("moving");
  box.animate([{ height: "0px", marginTop: "0px", marginBottom: "0px", opacity: 0 }, to], { duration: 300, easing: NAV_EASE })
    .finished.then(() => box.classList.remove("moving"), () => {});
  // Settings' rises from its button, the nearest row first
  const up = !!box.closest(".side-foot");
  const rows = [...box.querySelectorAll(".nav-s")];
  if (up) rows.reverse();
  rows.forEach((s, i) => s.animate(
    [{ opacity: 0, transform: `translateY(${up ? 6 : -6}px)` }, { opacity: 1, transform: "none" }],
    { duration: 260, delay: 40 + Math.min(i, 12) * 20, easing: NAV_EASE, fill: "backwards" }));
  box.querySelector(".nav-hl").animate([{ opacity: 0 }, { opacity: 1 }], { duration: 200, delay: 80, fill: "backwards" });
}
// a folding list is out of reach at once
function navSubLeave(box) {
  box.classList.add("leaving");
  box.removeAttribute("role");
  box.inert = true;
  for (const s of box.querySelectorAll(".nav-s")) s.classList.replace("nav-s", "nav-s-gone");
  if (navCalm() || navSubs.quiet) { box.remove(); return; }
  const cs = getComputedStyle(box);
  box.classList.add("moving");
  box.animate([{ height: box.offsetHeight + "px", marginTop: cs.marginTop, marginBottom: cs.marginBottom, opacity: 1 },
    { height: "0px", marginTop: "0px", marginBottom: "0px", opacity: 0 }], { duration: 240, easing: NAV_EASE, fill: "forwards" })
    .finished.then(() => box.remove(), () => box.remove());
}
