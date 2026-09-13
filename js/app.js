/* 4uTools — app shell: sidebar navigation, routing and view rendering.
 * Loads last, after all tool modules have registered themselves.
 */
(function () {
  "use strict";

  const nav = U.qs("#nav");
  const content = U.qs("#content");
  const titleEl = U.qs("#view-title");
  const descEl = U.qs("#view-desc");
  const tools = FourU.tools;

  function activate(id) {
    const tool = tools.find((t) => t.id === id) || tools[0];
    if (!tool) return;

    // Nav highlight
    U.qsa(".nav-item", nav).forEach((n) => n.classList.toggle("active", n.dataset.id === tool.id));

    // Header
    titleEl.textContent = tool.title;
    descEl.textContent = tool.desc || "";

    // Render body
    U.clear(content);
    const wrap = U.el("div", { class: "stack" });
    content.append(wrap);
    try {
      tool.render(wrap);
    } catch (e) {
      wrap.append(U.el("div", { class: "callout warn", text: "This tool failed to load: " + e.message }));
      console.error(e);
    }
    content.scrollTop = 0;

    if (location.hash.slice(1) !== tool.id) history.replaceState(null, "", "#" + tool.id);
  }

  // Build sidebar
  tools.forEach((tool) => {
    const item = U.el("div", { class: "nav-item", "data-id": tool.id }, [
      U.el("span", { class: "ico", text: tool.icon || "•" }),
      U.el("span", { text: tool.title }),
    ]);
    item.addEventListener("click", () => activate(tool.id));
    nav.append(item);
  });

  window.addEventListener("hashchange", () => activate(location.hash.slice(1)));

  // Clock
  const clock = U.qs("#clock");
  function tick() {
    const d = new Date();
    clock.textContent = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  }
  tick();
  setInterval(tick, 1000);

  // First-run responsible-use notice (dismiss persists via localStorage).
  const notice = U.qs("#notice");
  let dismissed = false;
  try { dismissed = localStorage.getItem("fouru_notice_ack") === "1"; } catch (e) {}
  if (!dismissed) notice.hidden = false;
  U.qs("#notice-dismiss").addEventListener("click", () => {
    notice.hidden = true;
    try { localStorage.setItem("fouru_notice_ack", "1"); } catch (e) {}
  });

  // Initial view (respect deep link)
  activate(location.hash.slice(1) || (tools[0] && tools[0].id));
})();
