// Loaded by the host's verified page bridge. The existing bridge dispatcher
// moves with it so navigation adds no weight to the host's startup scripts.
export default function installPageNavigation({ pages, post, theme, titled }) {
  const pageNavigation = new Map();
  const pageNavigationIcons = __LUCIDE_NAVIGATION_SHAPES__;

  function menuIsOpen(state) { return typeof protoMenu !== "undefined" && !!protoMenu && protoMenu.anchor === state.top; }
  function openPageMenu(state) {
    if (sideNav() || view !== state.key || !state.top?.isConnected) return;
    openProtoMenu(state.top, state.items.map((item) => ({ v: item.id, name: item.title, literalName: true, note: item.count === undefined ? "" : String(item.count) })), state.active, (id) => {
      [...state.buttons.children].find((button) => button.dataset.seg === id)?.click();
      state.top.focus({ preventScroll: true });
    }, titled(state.page.entry), "egress-navigation-menu");
    const box = protoMenu.box;
    box.id = "nav-menu-" + state.key;
    state.top.setAttribute("aria-controls", box.id);
    [...box.querySelectorAll(".pm-item")].forEach((button, index) => { button.dataset.pageNavigationId = state.items[index].id; });
  }

  // Preserve the host's sidebar renderer, animations and grouping. Decorate
  // its output after each refresh, when it has finished replacing the rows.
  const originalNavSubs = navSubs;
  navSubs = function () {
    const focused = document.activeElement?.dataset.pageNavigationId;
    syncPageNavigation();
    originalNavSubs.quiet = navSubs.quiet;
    originalNavSubs();
    const state = pageNavigation.get(view);
    const box = document.querySelector('.nav-sub:not(.leaving)');
    if (!state || box?.dataset.view !== view) return;
    box.id = "nav-sub-" + view;
    const buttons = [...box.querySelectorAll(".nav-s")];
    const items = navSubItems(view);
    const rows = window.navSections?.(view, items, t) || items.map((button, i) => [button, i]);
    rows.forEach(([source], index) => {
      const button = buttons[index];
      if (!button || button.dataset.pageNavigationId === source.dataset.seg) return;
      button.dataset.pageNavigationId = source.dataset.seg;
      button.querySelector("span").textContent = source.dataset.navigationTitle;
      button.firstElementChild.replaceWith(source.querySelector("svg").cloneNode(true));
      button.querySelector("em")?.remove();
      if (source.dataset.navigationCount !== undefined) {
        const count = document.createElement("em"); count.textContent = source.dataset.navigationCount; button.append(count);
      }
    });
    if (focused) buttons.find((button) => button.dataset.pageNavigationId === focused)?.focus({ preventScroll: true });
  };

  function pageNavigationIcon(name) {
    const mark = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    for (const [key, val] of Object.entries({ viewBox: "0 0 24 24", width: "14", height: "14", fill: "none", stroke: "currentColor", "stroke-width": "1.75", "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true", "data-page-nav-icon": "" })) mark.setAttribute(key, val);
    for (const [tag, attributes] of pageNavigationIcons[name] || pageNavigationIcons.logo) {
      const shape = document.createElementNS(mark.namespaceURI, tag);
      for (const [key, val] of Object.entries(attributes)) shape.setAttribute(key, val);
      mark.append(shape);
    }
    return mark;
  }

  // Runs as part of the host's normal navigation refresh, including when the
  // reader leaves this page. The parent is a real disclosure with a chevron.
  function syncPageNavigation() {
    for (const [key, state] of pageNavigation) {
      const top = [...document.querySelectorAll("#nav > button[data-plugin-page]")].find((button) => button.dataset.view === key);
      if (!top) continue;
      if (state.top !== top) {
        state.restore?.();
        state.top = top;
        const click = top.onclick, keydown = top.onkeydown;
        const arrow = pageNavigationIcon("chevron");
        arrow.dataset.pageNavToggle = "";
        arrow.style.cssText = "margin-left:auto;flex:none";
        top.append(arrow);
        top.onclick = (event) => {
          if (top.dataset.dragged) return;
          if (!sideNav() && state.count > 1) {
            if (menuIsOpen(state)) { closeProtoMenu(); return; }
            if (view === key) openPageMenu(state);
            else Promise.resolve(show(key)).then((went) => { if (went !== false) openPageMenu(state); });
            return;
          }
          if (view !== key || state.count < 2) {
            state.collapsed = false;
            return click?.call(top, event);
          }
          state.collapsed = !state.collapsed;
          navSubsAt = ""; navSubs();
        };
        top.onkeydown = (event) => {
          if (!sideNav() && state.count > 1 && ["ArrowDown", "ArrowUp"].includes(event.key)) {
            event.preventDefault();
            if (view === key) openPageMenu(state);
            else Promise.resolve(show(key)).then((went) => { if (went !== false) openPageMenu(state); });
          } else if (sideNav() && view === key && state.count > 1 && ["ArrowLeft", "ArrowRight"].includes(event.key)) {
            event.preventDefault();
            const expand = event.key === "ArrowRight";
            const wasOpen = !state.collapsed;
            state.collapsed = !expand;
            navSubsAt = ""; navSubs();
            if (expand && wasOpen) {
              const box = document.getElementById("nav-sub-" + key);
              (box?.querySelector(".nav-s.cur") || box?.querySelector(".nav-s"))?.focus();
            }
          } else keydown?.call(top, event);
        };
        state.restore = () => {
          if (menuIsOpen(state)) closeProtoMenu();
          top.onclick = click; top.onkeydown = keydown;
          top.removeAttribute("aria-expanded"); top.removeAttribute("aria-controls"); top.removeAttribute("aria-haspopup");
          arrow.remove();
        };
      }
      const shown = view === key;
      if (shown && !state.shown) state.collapsed = false;
      state.shown = shown;
      const side = sideNav();
      if ((!shown || side) && menuIsOpen(state)) closeProtoMenu();
      const expanded = side ? shown && !state.collapsed && state.count > 1 : menuIsOpen(state);
      top.setAttribute("aria-expanded", String(expanded));
      if (side) top.removeAttribute("aria-haspopup");
      else top.setAttribute("aria-haspopup", "menu");
      if (expanded) top.setAttribute("aria-controls", (side ? "nav-sub-" : "nav-menu-") + key);
      else top.removeAttribute("aria-controls");
      const arrow = top.querySelector("[data-page-nav-toggle]");
      arrow.style.transform = !side || expanded ? "rotate(90deg)" : "";
      arrow.hidden = state.count < 2;
    }
  }

  function removePageNavigation(key) {
    const previous = pageNavigation.get(key);
    if (!previous) return;
    if (NAV_SUBS[key] === previous.read) delete NAV_SUBS[key];
    if (window.NAV_SUB_GROUPS) delete window.NAV_SUB_GROUPS[key];
    previous.restore?.();
    pageNavigation.delete(key);
    navSubsAt = "";
  }

  async function setPageNavigation(p, value) {
    const key = p.entry.key;
    const frame = p.frame;
    if (p.context || pages.get(key) !== p || p.gone || !frame?.isConnected) throw new Error("Navigation belongs to a page, not a panel");
    if (!value || !Array.isArray(value.items) || value.items.length > 256) throw new Error("Navigation needs at most 256 items");
    if (Object.hasOwn(NAV_SUBS, key) && !pageNavigation.has(key)) throw new Error("This navigation belongs to the host");
    const ids = new Set();
    const items = value.items.map((item) => {
      if (!item || typeof item.id !== "string" || !item.id || item.id.length > 200 || /[\x00-\x1f]/.test(item.id) || ids.has(item.id)) throw new Error("Navigation IDs must be unique, nonempty strings");
      if (typeof item.title !== "string" || !item.title.trim() || item.title.length > 160) throw new Error("Navigation needs a short title");
      if (item.group !== undefined && (typeof item.group !== "string" || item.group.length > 80)) throw new Error("Invalid navigation group");
      if (item.count !== undefined && (!Number.isInteger(item.count) || item.count < 0 || item.count > 1e9)) throw new Error("Invalid navigation count");
      ids.add(item.id);
      return { id: item.id, title: item.title.trim(), icon: typeof item.icon === "string" && Object.hasOwn(pageNavigationIcons, item.icon) ? item.icon : "logo", count: item.count, group: item.group || "" };
    });
    if (items.length && !ids.has(value.active)) throw new Error("The selected navigation item is missing");
    // Load the host's own grouping and icon helpers before adding this page.
    await import("./navicons.js");
    if (p.gone || pages.get(key) !== p || p.frame !== frame || !frame.isConnected) throw new Error("The page is no longer open");
    if (!items.length) { removePageNavigation(key); navSubs(); return { supported: true }; }
    const signature = JSON.stringify({ items, active: value.active });
    if (pageNavigation.get(key)?.signature === signature) return { supported: true };
    const state = pageNavigation.get(key) || { key, page: p, collapsed: false };
    const menuOpen = menuIsOpen(state);
    const buttons = document.createElement("div");
    const groups = Object.create(null);
    for (const item of items) {
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.seg = item.id;
      button.dataset.navigationTitle = item.title;
      if (item.count !== undefined) button.dataset.navigationCount = String(item.count);
      button.classList.toggle("on", value.active === item.id);
      button.append(pageNavigationIcon(item.icon), document.createTextNode(item.title + (item.count === undefined ? "" : ` · ${item.count}`)));
      button.onclick = () => {
        if (!p.frame?.isConnected || p.gone) return;
        for (const other of buttons.children) other.classList.toggle("on", other === button);
        state.active = item.id;
        navSubsAt = ""; navSubs();
        post(p.frame.contentWindow, { event: "action", data: { id: "page-navigate", navigation: { id: item.id } } });
      };
      groups[item.id] = item.group;
      buttons.append(button);
    }
    Object.assign(state, { read: () => state.collapsed ? null : buttons, signature, count: items.length, buttons, items, active: value.active });
    pageNavigation.set(key, state);
    NAV_SUBS[key] = state.read;
    window.NAV_SUB_GROUPS[key] = groups;
    navSubsAt = ""; navSubs();
    if (menuOpen) openPageMenu(state);
    return { supported: true };
  }

  __MAGPIE_PAGE_ANSWER__

  return { answer, remove: removePageNavigation };
}
