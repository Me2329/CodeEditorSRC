/* Password Toolkit — generate strong passwords and analyze strength.
 * The analyzer estimates entropy from the character classes actually used
 * and gives crack-time estimates against a fast offline attacker.
 */
(function () {
  "use strict";

  const SETS = {
    lower: "abcdefghijklmnopqrstuvwxyz",
    upper: "ABCDEFGHIJKLMNOPQRSTUVWXYZ",
    digits: "0123456789",
    symbols: "!@#$%^&*()-_=+[]{};:,.<>?/",
  };

  function randInt(max) {
    const buf = new Uint32Array(1);
    crypto.getRandomValues(buf);
    return buf[0] % max;
  }

  function generate(opts) {
    let pool = "";
    if (opts.lower) pool += SETS.lower;
    if (opts.upper) pool += SETS.upper;
    if (opts.digits) pool += SETS.digits;
    if (opts.symbols) pool += SETS.symbols;
    if (opts.ambiguous) pool = pool.replace(/[Il1O0o]/g, "");
    if (!pool) return "";
    let out = "";
    for (let i = 0; i < opts.length; i++) out += pool[randInt(pool.length)];
    return out;
  }

  // Entropy from the classes actually present in the string.
  function analyze(pw) {
    let size = 0;
    if (/[a-z]/.test(pw)) size += 26;
    if (/[A-Z]/.test(pw)) size += 26;
    if (/[0-9]/.test(pw)) size += 10;
    if (/[^a-zA-Z0-9]/.test(pw)) size += 33;
    const bits = pw.length ? U.entropyBits(size, pw.length) : 0;
    const combos = Math.pow(size, pw.length);
    return { size, bits, combos };
  }

  function verdict(bits) {
    if (bits < 28) return { label: "Very weak", cls: "bad", pct: 15 };
    if (bits < 40) return { label: "Weak", cls: "bad", pct: 35 };
    if (bits < 60) return { label: "Reasonable", cls: "warn", pct: 60 };
    if (bits < 80) return { label: "Strong", cls: "good", pct: 82 };
    return { label: "Very strong", cls: "good", pct: 100 };
  }

  FourU.register({
    id: "password",
    title: "Password Toolkit",
    icon: "🔑",
    desc: "Generate strong passwords and measure their strength.",
    render(root) {
      // Generator
      const gen = U.el("div", { class: "card" });
      gen.append(U.el("h3", { text: "Generator" }));

      const lenInput = U.el("input", { type: "number", min: "4", max: "128", value: "20", style: "max-width:120px" });
      gen.append(U.el("label", { class: "field" }, [U.el("span", { class: "lbl", text: "Length" }), lenInput]));

      const optWrap = U.el("div", { style: "margin-bottom:14px" });
      const checks = {};
      [["lower", "a-z", true], ["upper", "A-Z", true], ["digits", "0-9", true], ["symbols", "Symbols", true], ["ambiguous", "Exclude look-alikes (Il1O0o)", false]].forEach(([k, lbl, on]) => {
        const cb = U.el("input", { type: "checkbox" });
        cb.checked = on;
        checks[k] = cb;
        optWrap.append(U.el("label", { class: "checkbox" }, [cb, document.createTextNode(lbl)]));
      });
      gen.append(optWrap);

      const genOut = U.el("div", { class: "code-out" });
      const genRow = U.el("div", { class: "btn-row" });
      const genBtn = U.el("button", { class: "btn btn-primary" }, "🎲 Generate");
      const copyBtn = U.el("button", { class: "btn btn-ghost" }, "Copy");
      const useBtn = U.el("button", { class: "btn btn-ghost" }, "Analyze it ↓");
      genRow.append(genBtn, copyBtn, useBtn);
      gen.append(genOut, genRow);
      root.append(gen);

      // Analyzer
      const an = U.el("div", { class: "card", style: "margin-top:16px" });
      an.append(U.el("h3", { text: "Strength analyzer" }));
      const anInput = U.el("input", { type: "text", placeholder: "Type a password to score it…" });
      an.append(anInput);

      const meter = U.el("div", { class: "meter", style: "margin:14px 0 6px" }, [U.el("span")]);
      const verdictRow = U.el("div", { style: "display:flex;gap:10px;align-items:center;margin-bottom:14px" }, [
        U.el("span", { class: "pill", text: "—" }),
        U.el("span", { class: "muted", text: "" }),
      ]);
      an.append(meter, verdictRow);

      const anKv = U.el("div", { class: "kv" });
      an.append(anKv);
      root.append(an);

      function refreshAnalysis(pw) {
        const { size, bits, combos } = analyze(pw);
        const v = verdict(bits);
        const bar = U.qs("span", meter);
        bar.style.width = v.pct + "%";
        bar.style.background = v.cls === "good" ? "var(--good)" : v.cls === "warn" ? "var(--warn)" : "var(--bad)";
        const pill = verdictRow.children[0];
        pill.textContent = pw ? v.label : "—";
        pill.className = "pill " + (pw ? v.cls : "");
        verdictRow.children[1].textContent = pw ? `${bits.toFixed(1)} bits of entropy` : "";
        U.clear(anKv);
        const rows = [
          ["Length", pw.length + " chars"],
          ["Charset size", size + " symbols"],
          ["Combinations", pw ? combos.toExponential(2) : "—"],
          ["Crack @ 10B guess/s", pw ? U.duration(combos / 1e10) : "—"],
          ["Crack @ 1k guess/s", pw ? U.duration(combos / 1e3) : "—"],
        ];
        rows.forEach(([k, val]) => anKv.append(U.el("span", { class: "k", text: k }), U.el("span", { class: "v", text: val })));
      }

      function doGenerate() {
        const opts = {
          length: Math.max(4, Math.min(128, parseInt(lenInput.value, 10) || 20)),
          lower: checks.lower.checked, upper: checks.upper.checked,
          digits: checks.digits.checked, symbols: checks.symbols.checked,
          ambiguous: checks.ambiguous.checked,
        };
        const pw = generate(opts);
        genOut.textContent = pw || "Select at least one character set.";
        return pw;
      }

      genBtn.addEventListener("click", doGenerate);
      copyBtn.addEventListener("click", () => U.copy(genOut.textContent, copyBtn));
      useBtn.addEventListener("click", () => { anInput.value = genOut.textContent; refreshAnalysis(anInput.value); anInput.focus(); });
      anInput.addEventListener("input", () => refreshAnalysis(anInput.value));

      doGenerate();
      refreshAnalysis("");
    },
  });
})();
