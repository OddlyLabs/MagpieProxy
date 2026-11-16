// From magpie v0.1.4174, MIT; see LICENSE. Original menu implementation.
let pointerAt = "";
addEventListener("mousemove", (e) => { pointerAt = e.screenX + "," + e.screenY; }, true);
function hoverFocus(b) {
  b.onmouseenter = (e) => { if (e.screenX + "," + e.screenY !== pointerAt) b.focus(NO_SCROLL); };
}
let protoMenu = null;
// stepFocus: ArrowDown or ArrowUp moves focus round list from i (-1: none)
function stepFocus(e, list, i) {
  e.preventDefault(); e.stopPropagation();
  const n = list.length, down = e.key === "ArrowDown";
  if (n) list[((i < 0 ? (down ? n - 1 : 0) : i) + (down ? 1 : n - 1)) % n].focus();
}
// holdMenu makes box the app menu: Escape, a click outside it, a resize
// or the scroll it is given closes it, and done runs once it is closed
function holdMenu(box, anchor, own, scroll, done) {
  const keys = (e) => { if (e.key !== "Escape") return own(e); e.preventDefault(); e.stopPropagation(); closeProtoMenu(); anchor.focus(); };
  const outside = (e) => { if (!box.contains(e.target) && !anchor.contains(e.target)) closeProtoMenu(); };
  document.addEventListener("mousedown", outside, true);
  document.addEventListener("keydown", keys, true);
  document.addEventListener("scroll", scroll, true);
  addEventListener("resize", closeProtoMenu);
  protoMenu = { box, anchor, outside, keys, scroll, done };
}
function closeProtoMenu() {
  if (!protoMenu) return;
  protoMenu.anchor.classList.remove("open");
  if (protoMenu.anchor.hasAttribute("aria-expanded")) protoMenu.anchor.setAttribute("aria-expanded", "false");
  protoMenu.box.remove();
  document.removeEventListener("mousedown", protoMenu.outside, true);
  document.removeEventListener("keydown", protoMenu.keys, true);
  document.removeEventListener("scroll", protoMenu.scroll, true);
  removeEventListener("resize", closeProtoMenu);
  const done = protoMenu.done;
  protoMenu = null;
  done?.();
}
// scrollCloses: only the reader's scroll outside box closes the menu; any
// other is put back by the click guard (guardUntil)
function scrollCloses(box, e) {
  if (box.contains(e.target)) return false;
  // a box scrolling its own text (a long one goes back to its start as it
  // loses focus to the click that opened the menu) moves nothing
  if (e.target.matches?.("input, textarea")) return false;
  return !e.target.classList?.contains("view") || performance.now() < purposeUntil && purposeUntil !== guardUntil;
}
// openProtoMenu picks one of opts, or several when value is a list (ticked
// in turn, menu kept open; live: choose after each tick).
// placeMenu puts an app menu under its anchor, or over it, or where there
// is more room, scrolling inside itself (#1437)
function placeMenu(box, anchor, align = "left", dx = 0, at) {
  // at: a right-click's pointer, the menu opens there (mmmg_btc on X)
  const r = at ? { left: at.x, right: at.x, top: at.y, bottom: at.y - 3 } : anchor.getBoundingClientRect(), h = box.offsetHeight, pad = 8, top = popTop(pad);
  let y = r.bottom + 5;
  const below = innerHeight - pad - y, above = r.top - 5 - top;
  if (h > below && above >= h) { y = r.top - 5 - h; box.classList.add("up"); }
  else if (h > below && above > below) {
    box.style.maxHeight = above + "px";
    y = top;
    box.classList.add("up");
  } else if (h > below) box.style.maxHeight = Math.max(below, 0) + "px";
  const w = box.offsetWidth;
  const left = (align === "right" ? r.right - w : r.left) + dx;
  box.style.left = Math.max(pad, Math.min(left, innerWidth - w - pad)) + "px";
  box.style.top = Math.max(top, y) + "px";
}
// no tick column with nothing to tick (#4020)
const bareTicks = (box, items) => box.classList.toggle("pm-bare", !items.some((b) => b.matches(".on, [role=menuitemcheckbox]")));
function openProtoMenu(anchor, opts, value, choose, head = "Protocol this key speaks", cls = "", align = "left", live = false, search = "") {
  closeProtoMenu();
  const multi = Array.isArray(value);
  let picked = multi ? [...value] : null;
  // an item with its own ticked (true or false) is a setting beside the pick
  // a group heading (o.group, its values) is ticked when all of them are
  const isOn = (v, o) => o?.group ? o.group.every((g) => picked.includes(g)) : typeof o?.ticked === "boolean" ? o.ticked : !multi ? v === value : v === "" ? !picked.length : picked.includes(v);
  const box = el("div", "pop proto-menu" + (cls ? " " + cls : ""));
  box.setAttribute("role", "menu");
  box.append(el("div", "pm-head", t(head)));
  let filter = null;
  if (search) {
    const top = el("div", "sc-top");
    filter = el("input", "sc-q");
    filter.placeholder = t(search);
    filter.setAttribute("aria-label", t(search));
    top.append(filter);
    box.append(top);
  }
  const tick = (b, o) => {
    b.classList.toggle("on", isOn(o.v, o));
    if (o.group) b.classList.toggle("mixed", !isOn(o.v, o) && o.group.some((g) => picked.includes(g)));
    b.setAttribute("aria-checked", isOn(o.v, o));
    b.firstChild.replaceChildren(...(isOn(o.v, o) ? [svg(CHECK, 12, 1.9)] : []));
  };
  const items = opts.map((o) => {
    const b = el("button", "pm-item" + (o.group ? " pm-group" : ""));
    b.type = "button";
    if (o.title) b.title = o.title;
    b.setAttribute("role", o.group || multi && o.v && o.v !== "\x00" || typeof o.ticked === "boolean" ? "menuitemcheckbox" : "menuitemradio");
    const words = el("span", "pm-words");
    words.append(el("span", "pm-name", o.literalName ? o.name : t(o.name)), el("span", "pm-note", t(o.note)));
    b.append(el("span", "pm-tick"), words);
    tick(b, o);
    b.onclick = (e) => {
      e.stopPropagation();
      if (!multi) { closeProtoMenu(); choose(o.v, e); return; }
      if (o.group) {
        picked = isOn(o.v, o) ? picked.filter((v) => !o.group.includes(v)) : [...new Set([...picked, ...o.group])];
        items.forEach((it, i) => tick(it, opts[i]));
        if (live) choose(opts.map((o) => o.v).filter((v) => picked.includes(v)));
        return;
      }
      if (o.v === "\x00") return;
      if (!o.v) { picked = []; closeProtoMenu(); if (live) choose([]); return; }
      picked = picked.includes(o.v) ? picked.filter((v) => v !== o.v) : [...picked, o.v];
      items.forEach((it, i) => tick(it, opts[i]));
      if (live) {
        choose(opts.map((o) => o.v).filter((v) => picked.includes(v)));
        b.focus(NO_SCROLL);
      }
    };
    hoverFocus(b);
    box.append(b);
    return b;
  });
  bareTicks(box, items);
  if (filter) filter.oninput = () => {
    const q = filter.value.trim().toLocaleLowerCase();
    items.forEach((b, i) => { if (!opts[i].group) b.hidden = !opts[i].always && !(opts[i].name + " " + (opts[i].find || "")).toLocaleLowerCase().includes(q); });
    items.forEach((b, i) => { if (opts[i].group) b.hidden = !opts[i].group.some((v) => items.some((m, j) => opts[j].v === v && !m.hidden)); });
  };
  document.body.append(box);
  placeMenu(box, anchor, align);
  anchor.classList.add("open");
  if (anchor.hasAttribute("aria-expanded")) anchor.setAttribute("aria-expanded", "true");
  // A live pick can shrink the list or wrap its heading and clamp the scroll.
  // Only the reader's scroll dismisses it; the click guard holds its anchor.
  const scroll = (e) => {
    if (box.contains(e.target) || live && performance.now() >= purposeUntil) return;
    if (scrollCloses(box, e)) closeProtoMenu();
  };
  const keys = (e) => {
    const shown = filter ? items.filter((b) => !b.hidden) : items;
    const i = shown.indexOf(document.activeElement);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      stepFocus(e, shown, i);
    } else if (filter && e.key === "Enter" && document.activeElement === filter) {
      const first = shown.find((b) => !opts[items.indexOf(b)].always && !opts[items.indexOf(b)].group);
      if (first) { e.preventDefault(); first.click(); }
    } else if (filter && (e.key === "Home" || e.key === "End") && i >= 0) {
      e.preventDefault();
      shown[e.key === "Home" ? 0 : shown.length - 1]?.focus();
    }
  };
  holdMenu(box, anchor, keys, scroll, multi && !live ? () => {
    if (picked.length === value.length && picked.every((v) => value.includes(v))) return;
    choose(opts.map((o) => o.v).filter((v) => picked.includes(v)));
  } : null);
  (filter || items.find((b) => b.classList.contains("on")) || items[0]).focus(NO_SCROLL);
}

