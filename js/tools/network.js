/* Network Info — connection details, a local latency probe, and an optional
 * public-IP lookup. The IP lookup is the ONLY feature that leaves the device,
 * it is opt-in (button click), and it fails gracefully when blocked.
 */
(function () {
  "use strict";

  FourU.register({
    id: "network",
    title: "Network Info",
    icon: "🌐",
    desc: "Connection details, latency probe and public IP (opt-in).",
    render(root) {
      const conn = navigator.connection || {};

      const grid = U.el("div", { class: "grid cols-3" });
      const cType = mkStat("Connection", conn.effectiveType || "unknown");
      const cDown = mkStat("Downlink", conn.downlink ? conn.downlink + " Mbps" : "—");
      const cRtt = mkStat("RTT (browser)", conn.rtt != null ? conn.rtt + " ms" : "—");
      grid.append(cType.card, cDown.card, cRtt.card);
      root.append(grid);

      // Online / offline
      const onlineCard = U.el("div", { class: "card", style: "margin-top:16px" });
      onlineCard.append(U.el("h3", { text: "Status" }));
      const kv = U.el("div", { class: "kv" });
      const onlinePill = U.el("span", { class: "pill " + (navigator.onLine ? "good" : "bad"), text: navigator.onLine ? "Online" : "Offline" });
      kv.append(
        U.el("span", { class: "k", text: "Reachability" }), U.el("span", { class: "v" }, [onlinePill]),
        U.el("span", { class: "k", text: "Save-data mode" }), U.el("span", { class: "v", text: conn.saveData ? "on" : "off" }),
        U.el("span", { class: "k", text: "Protocol" }), U.el("span", { class: "v", text: location.protocol }),
        U.el("span", { class: "k", text: "Host" }), U.el("span", { class: "v", text: location.host || "(file)" }),
      );
      onlineCard.append(kv);
      root.append(onlineCard);
      window.addEventListener("online", () => { onlinePill.textContent = "Online"; onlinePill.className = "pill good"; });
      window.addEventListener("offline", () => { onlinePill.textContent = "Offline"; onlinePill.className = "pill bad"; });

      // Latency probe (loads a tiny same-origin/CDN resource a few times).
      const pingCard = U.el("div", { class: "card", style: "margin-top:16px" });
      pingCard.append(U.el("h3", { text: "Latency probe" }), U.el("p", { class: "sub", text: "Times a few round-trips to a chosen host. Uses your network." }));
      const hostInput = U.el("input", { type: "text", value: "https://cdnjs.cloudflare.com/favicon.ico" });
      pingCard.append(U.el("label", { class: "field" }, [U.el("span", { class: "lbl", text: "Probe URL (a small resource)" }), hostInput]));
      const pingBtn = U.el("button", { class: "btn btn-primary" }, "📡 Probe (5×)");
      const pingOut = U.el("div", { class: "code-out", style: "margin-top:12px", text: "Idle." });
      pingCard.append(pingBtn, pingOut);
      root.append(pingCard);

      pingBtn.addEventListener("click", async () => {
        pingBtn.disabled = true;
        pingOut.textContent = "Probing…";
        const times = [];
        for (let i = 0; i < 5; i++) {
          const t0 = performance.now();
          try {
            await fetch(hostInput.value + "?_=" + Date.now(), { mode: "no-cors", cache: "no-store" });
            times.push(performance.now() - t0);
          } catch (e) {
            pingOut.textContent = "Probe failed (network blocked or CORS/host unreachable): " + e.message;
            pingBtn.disabled = false;
            return;
          }
        }
        const avg = times.reduce((a, b) => a + b, 0) / times.length;
        const min = Math.min(...times), max = Math.max(...times);
        pingOut.textContent = `avg ${avg.toFixed(0)} ms  ·  min ${min.toFixed(0)} ms  ·  max ${max.toFixed(0)} ms\nsamples: ${times.map((t) => t.toFixed(0) + "ms").join(", ")}`;
        pingBtn.disabled = false;
      });

      // Public IP (opt-in, leaves device)
      const ipCard = U.el("div", { class: "card", style: "margin-top:16px" });
      ipCard.append(U.el("h3", { text: "Public IP lookup" }),
        U.el("p", { class: "sub", text: "Opt-in — this is the only feature that contacts an external service (ipify)." }));
      const ipBtn = U.el("button", { class: "btn" }, "Look up my public IP");
      const ipOut = U.el("div", { class: "code-out", style: "margin-top:12px", text: "—" });
      ipCard.append(ipBtn, ipOut);
      root.append(ipCard);

      ipBtn.addEventListener("click", async () => {
        ipOut.textContent = "Looking up…";
        try {
          const r = await fetch("https://api.ipify.org?format=json", { cache: "no-store" });
          const j = await r.json();
          ipOut.textContent = j.ip;
        } catch (e) {
          ipOut.textContent = "Lookup failed (offline or blocked): " + e.message;
        }
      });
    },
  });

  function mkStat(label, value) {
    const val = U.el("span", { class: "value", text: value });
    return { card: U.el("div", { class: "stat" }, [U.el("span", { class: "label", text: label }), val]), val };
  }
})();
