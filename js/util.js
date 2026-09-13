/* 4uTools — shared utilities and global namespace.
 * Everything here runs locally in the browser. No data leaves the device
 * except where a tool explicitly calls out to a public API (Network tab).
 */
(function () {
  "use strict";

  const FourU = {
    tools: [], // populated by js/tools/*.js
    register(tool) {
      // tool: { id, title, icon, desc, render(container) }
      this.tools.push(tool);
    },
  };
  window.FourU = FourU;

  const U = {
    /* DOM helpers -------------------------------------------------------- */
    el(tag, attrs = {}, children = []) {
      const node = document.createElement(tag);
      for (const [k, v] of Object.entries(attrs)) {
        if (k === "class") node.className = v;
        else if (k === "html") node.innerHTML = v;
        else if (k === "text") node.textContent = v;
        else if (k.startsWith("on") && typeof v === "function") {
          node.addEventListener(k.slice(2).toLowerCase(), v);
        } else if (v !== null && v !== undefined && v !== false) {
          node.setAttribute(k, v === true ? "" : v);
        }
      }
      (Array.isArray(children) ? children : [children]).forEach((c) => {
        if (c == null) return;
        node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
      });
      return node;
    },
    qs(sel, root = document) { return root.querySelector(sel); },
    qsa(sel, root = document) { return Array.from(root.querySelectorAll(sel)); },
    clear(node) { while (node.firstChild) node.removeChild(node.firstChild); },

    /* Formatting --------------------------------------------------------- */
    bytes(n) {
      if (n == null || isNaN(n)) return "—";
      const units = ["B", "KB", "MB", "GB", "TB"];
      let i = 0;
      while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
      return `${n.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
    },
    // Human-readable duration from seconds; handles astronomically large values.
    duration(seconds) {
      if (!isFinite(seconds)) return "∞";
      if (seconds < 1e-3) return "< 1 ms";
      if (seconds < 1) return `${(seconds * 1000).toFixed(0)} ms`;
      const units = [
        ["year", 31557600],
        ["day", 86400],
        ["hour", 3600],
        ["min", 60],
        ["sec", 1],
      ];
      if (seconds > 31557600 * 1000) {
        const years = seconds / 31557600;
        if (years > 1e9) return `${(years / 1e9).toExponential(2)} billion yr`;
        if (years > 1e6) return `${(years / 1e6).toFixed(1)} million yr`;
        return `${Math.round(years).toLocaleString()} yr`;
      }
      const parts = [];
      let rem = seconds;
      for (const [name, size] of units) {
        if (rem >= size) {
          const v = Math.floor(rem / size);
          rem -= v * size;
          parts.push(`${v} ${name}${v !== 1 ? "s" : ""}`);
          if (parts.length === 2) break;
        }
      }
      return parts.join(" ") || "< 1 sec";
    },
    num(n) { return Number(n).toLocaleString(); },

    /* Clipboard ---------------------------------------------------------- */
    async copy(text, btn) {
      try {
        await navigator.clipboard.writeText(text);
        if (btn) {
          const old = btn.textContent;
          btn.textContent = "✓ Copied";
          setTimeout(() => (btn.textContent = old), 1200);
        }
      } catch (e) { console.warn("clipboard failed", e); }
    },

    /* Crypto ------------------------------------------------------------- */
    // SHA family via SubtleCrypto. algo: "SHA-1" | "SHA-256" | "SHA-384" | "SHA-512"
    async sha(algo, data) {
      const buf = typeof data === "string" ? new TextEncoder().encode(data) : data;
      const digest = await crypto.subtle.digest(algo, buf);
      return U.hex(new Uint8Array(digest));
    },
    hex(uint8) {
      return Array.from(uint8).map((b) => b.toString(16).padStart(2, "0")).join("");
    },

    // log2 of number of combinations -> entropy bits
    entropyBits(charsetSize, length) {
      if (charsetSize <= 1 || length <= 0) return 0;
      return length * Math.log2(charsetSize);
    },
  };
  window.U = U;
})();
