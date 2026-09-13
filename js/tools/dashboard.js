/* Dashboard — device & environment overview (the "home" of 4uTools). */
(function () {
  "use strict";

  function detectOS(ua) {
    if (/Windows NT 10/.test(ua)) return "Windows 10/11";
    if (/Windows/.test(ua)) return "Windows";
    if (/Mac OS X/.test(ua)) return "macOS";
    if (/Android/.test(ua)) return "Android";
    if (/(iPhone|iPad|iPod)/.test(ua)) return "iOS / iPadOS";
    if (/Linux/.test(ua)) return "Linux";
    return "Unknown";
  }
  function detectBrowser(ua) {
    if (/Edg\//.test(ua)) return "Edge";
    if (/OPR\//.test(ua)) return "Opera";
    if (/Chrome\//.test(ua) && !/Chromium/.test(ua)) return "Chrome";
    if (/Firefox\//.test(ua)) return "Firefox";
    if (/Safari\//.test(ua)) return "Safari";
    return "Unknown";
  }

  function statCard(label, value, mono) {
    return U.el("div", { class: "stat" }, [
      U.el("span", { class: "label", text: label }),
      U.el("span", { class: "value" + (mono ? " mono" : ""), text: value }),
    ]);
  }

  FourU.register({
    id: "dashboard",
    title: "Dashboard",
    icon: "🏠",
    desc: "Overview of your device and environment.",
    render(root) {
      const ua = navigator.userAgent;
      const nav = navigator;

      const stats = U.el("div", { class: "grid cols-4" });
      stats.append(
        statCard("Operating System", detectOS(ua)),
        statCard("Browser", detectBrowser(ua)),
        statCard("CPU Threads", nav.hardwareConcurrency ? String(nav.hardwareConcurrency) : "—"),
        statCard("Device Memory", nav.deviceMemory ? nav.deviceMemory + " GB" : "n/a"),
      );
      root.append(stats);

      // Detail panels
      const grid = U.el("div", { class: "grid cols-2", style: "margin-top:16px" });

      const sysCard = U.el("div", { class: "card" });
      sysCard.append(U.el("h3", { text: "System" }));
      const sysKv = U.el("div", { class: "kv" });
      const conn = nav.connection || {};
      const rows = [
        ["Platform", nav.platform || "—"],
        ["Language", nav.language || "—"],
        ["Languages", (nav.languages || []).join(", ") || "—"],
        ["Screen", `${screen.width}×${screen.height} @ ${window.devicePixelRatio}x`],
        ["Viewport", `${window.innerWidth}×${window.innerHeight}`],
        ["Color depth", `${screen.colorDepth}-bit`],
        ["Timezone", Intl.DateTimeFormat().resolvedOptions().timeZone || "—"],
        ["Cookies", nav.cookieEnabled ? "Enabled" : "Disabled"],
        ["Online", nav.onLine ? "Yes" : "No"],
        ["Touch points", String(nav.maxTouchPoints ?? 0)],
      ];
      rows.forEach(([k, v]) => {
        sysKv.append(U.el("span", { class: "k", text: k }), U.el("span", { class: "v", text: v }));
      });
      sysCard.append(sysKv);
      grid.append(sysCard);

      // Live status card (battery / network / memory)
      const liveCard = U.el("div", { class: "card" });
      liveCard.append(U.el("h3", { text: "Live status" }));
      const liveKv = U.el("div", { class: "kv" });
      const battRow = U.el("span", { class: "v", text: "reading…" });
      const netRow = U.el("span", { class: "v", text: conn.effectiveType || "unknown" });
      const dlRow = U.el("span", { class: "v", text: conn.downlink ? conn.downlink + " Mbps" : "—" });
      const rttRow = U.el("span", { class: "v", text: conn.rtt != null ? conn.rtt + " ms" : "—" });
      const memRow = U.el("span", { class: "v", text: "n/a" });
      if (performance.memory) {
        memRow.textContent = `${U.bytes(performance.memory.usedJSHeapSize)} / ${U.bytes(performance.memory.jsHeapSizeLimit)}`;
      }
      [
        ["Battery", battRow],
        ["Network type", netRow],
        ["Downlink", dlRow],
        ["Latency (RTT)", rttRow],
        ["JS heap", memRow],
      ].forEach(([k, node]) => {
        liveKv.append(U.el("span", { class: "k", text: k }), node);
      });
      liveCard.append(liveKv);
      grid.append(liveCard);
      root.append(grid);

      if (nav.getBattery) {
        nav.getBattery().then((b) => {
          const upd = () => {
            battRow.textContent = `${Math.round(b.level * 100)}% ${b.charging ? "⚡ charging" : "on battery"}`;
          };
          upd();
          b.addEventListener("levelchange", upd);
          b.addEventListener("chargingchange", upd);
        }).catch(() => (battRow.textContent = "unavailable"));
      } else {
        battRow.textContent = "unavailable (API not supported)";
      }

      // UA string
      const uaCard = U.el("div", { class: "card", style: "margin-top:16px" });
      uaCard.append(U.el("h3", { text: "User agent" }), U.el("div", { class: "code-out", text: ua }));
      root.append(uaCard);
    },
  });
})();
