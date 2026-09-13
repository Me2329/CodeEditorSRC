/* Bruteforce Lab — an EDUCATIONAL demonstration of how brute-force search
 * works and why length + character variety matter.
 *
 * It only ever searches for a secret that YOU type into this page. Nothing is
 * sent anywhere and it cannot target external devices, accounts or networks.
 * The point is to *feel* how the search space explodes as a password grows,
 * and to see realistic crack-time estimates against fast offline attackers.
 */
(function () {
  "use strict";

  const CHARSETS = {
    digits: { label: "Digits (0-9)", chars: "0123456789" },
    lower: { label: "Lowercase (a-z)", chars: "abcdefghijklmnopqrstuvwxyz" },
    upper: { label: "Uppercase (A-Z)", chars: "ABCDEFGHIJKLMNOPQRSTUVWXYZ" },
    symbols: { label: "Symbols (!@#…)", chars: "!@#$%^&*()-_=+[]{}" },
  };

  // Reference guessing rates for real attackers (guesses/sec), for context.
  const ATTACKER_RATES = [
    ["Online throttled (10/s)", 10],
    ["Online fast (1k/s)", 1e3],
    ["Offline bcrypt GPU (~20k/s)", 2e4],
    ["Offline SHA-256 GPU rig (~10B/s)", 1e10],
  ];

  FourU.register({
    id: "bruteforce",
    title: "Bruteforce Lab",
    icon: "🔐",
    desc: "See how brute-force search scales — against a secret you set.",
    render(root) {
      root.append(U.el("div", { class: "callout warn", html:
        "<b>Educational sandbox.</b> Type a short secret below and watch a brute-force search find it locally. " +
        "This exists to build intuition about password strength — it does not and cannot attack anything but the value you enter here." }));

      // --- Configuration form ---
      const form = U.el("div", { class: "card" });
      form.append(U.el("h3", { text: "Target & search space" }));

      const secretInput = U.el("input", { type: "text", placeholder: "e.g. 4821 or ab7", value: "742" });
      const secretField = U.el("label", { class: "field" }, [
        U.el("span", { class: "lbl", text: "Secret to crack (choose something short — the demo tries every combination)" }),
        secretInput,
      ]);
      form.append(secretField);

      const csWrap = U.el("div", { style: "margin-bottom:14px" });
      csWrap.append(U.el("span", { class: "lbl", text: "Character set to search", style: "display:block;font-size:12px;color:var(--text-dim);margin-bottom:6px" }));
      const csChecks = {};
      Object.entries(CHARSETS).forEach(([key, cs], i) => {
        const cb = U.el("input", { type: "checkbox" });
        if (i === 0) cb.checked = true; // digits by default
        csChecks[key] = cb;
        csWrap.append(U.el("label", { class: "checkbox" }, [cb, document.createTextNode(cs.label)]));
      });
      form.append(csWrap);

      const maxLenInput = U.el("input", { type: "number", min: "1", max: "8", value: "5", style: "max-width:120px" });
      form.append(U.el("label", { class: "field" }, [
        U.el("span", { class: "lbl", text: "Max length to try" }),
        maxLenInput,
      ]));

      const btnRow = U.el("div", { class: "btn-row" });
      const startBtn = U.el("button", { class: "btn btn-primary" }, "▶ Start search");
      const stopBtn = U.el("button", { class: "btn btn-danger", disabled: true }, "■ Stop");
      btnRow.append(startBtn, stopBtn);
      form.append(btnRow);
      root.append(form);

      // --- Live stats ---
      const statsGrid = U.el("div", { class: "grid cols-4", style: "margin-top:16px" });
      const sAttempts = stat("Attempts");
      const sRate = stat("Attempts / sec");
      const sSpace = stat("Search space");
      const sElapsed = stat("Elapsed");
      statsGrid.append(sAttempts.card, sRate.card, sSpace.card, sElapsed.card);
      root.append(statsGrid);

      const progWrap = U.el("div", { class: "card", style: "margin-top:16px" });
      progWrap.append(U.el("h3", { text: "Progress" }));
      const progLabel = U.el("div", { class: "progress-label" }, [
        U.el("span", { text: "Current guess" }),
        U.el("span", { class: "cur", text: "—" }),
      ]);
      const meter = U.el("div", { class: "meter" }, [U.el("span", { style: "background:var(--accent)" })]);
      progWrap.append(progLabel, meter);
      const log = U.el("div", { class: "log", style: "margin-top:14px" });
      progWrap.append(log);
      root.append(progWrap);

      // --- Real-world context table ---
      const ctxCard = U.el("div", { class: "card", style: "margin-top:16px" });
      ctxCard.append(U.el("h3", { text: "Real-world crack-time estimate" }),
        U.el("p", { class: "sub", text: "How long the full search space would take different attackers (worst case)." }));
      const ctxBody = U.el("div", { class: "kv" });
      ctxCard.append(ctxBody);
      root.append(ctxCard);

      // --- Search engine ---
      let running = false;
      let raf = null;

      function activeChars() {
        return Object.entries(csChecks)
          .filter(([, cb]) => cb.checked)
          .map(([k]) => CHARSETS[k].chars)
          .join("");
      }

      function updateContext() {
        const chars = activeChars();
        const maxLen = clampLen();
        const size = chars.length;
        let total = 0;
        for (let l = 1; l <= maxLen; l++) total += Math.pow(size, l);
        sSpace.val.textContent = size ? U.num(total) : "0";
        const bits = U.entropyBits(size, maxLen).toFixed(1);
        U.clear(ctxBody);
        ctxBody.append(
          U.el("span", { class: "k", text: "Charset size" }), U.el("span", { class: "v", text: size + " chars" }),
          U.el("span", { class: "k", text: "Entropy @ max len" }), U.el("span", { class: "v", text: bits + " bits" }),
        );
        ATTACKER_RATES.forEach(([label, rate]) => {
          ctxBody.append(
            U.el("span", { class: "k", text: label }),
            U.el("span", { class: "v", text: U.duration(total / rate) }),
          );
        });
      }

      function clampLen() {
        let v = parseInt(maxLenInput.value, 10) || 1;
        v = Math.max(1, Math.min(8, v));
        return v;
      }

      [maxLenInput, ...Object.values(csChecks)].forEach((n) =>
        n.addEventListener("input", updateContext));
      updateContext();

      function logLine(text, cls) {
        const line = U.el("div", { class: "line" + (cls ? " " + cls : ""), text });
        log.append(line);
        log.scrollTop = log.scrollHeight;
      }

      startBtn.addEventListener("click", () => {
        const chars = activeChars();
        const secret = secretInput.value;
        if (!chars) return logLine("Select at least one character set.", "err");
        if (!secret) return logLine("Enter a secret to search for.", "err");
        // Verify the secret is reachable within the chosen space.
        if (![...secret].every((c) => chars.includes(c))) {
          return logLine("The secret contains characters outside the selected sets — it can never be found. Adjust the charset.", "err");
        }
        if (secret.length > clampLen()) {
          return logLine(`Secret is longer than max length (${clampLen()}). Increase max length.`, "err");
        }

        running = true;
        startBtn.disabled = true;
        stopBtn.disabled = false;
        U.clear(log);
        logLine("Search started. Trying combinations shortest-first…");

        const size = chars.length;
        const maxLen = clampLen();
        let total = 0;
        for (let l = 1; l <= maxLen; l++) total += Math.pow(size, l);

        let attempts = 0;
        const start = performance.now();
        // Odometer state: indices per position, growing in length.
        let len = 1;
        let idx = new Array(len).fill(0);

        function guessFromIdx() {
          let s = "";
          for (let i = 0; i < idx.length; i++) s += chars[idx[i]];
          return s;
        }
        function increment() {
          // returns false when the whole space (up to maxLen) is exhausted
          let pos = idx.length - 1;
          while (pos >= 0) {
            idx[pos]++;
            if (idx[pos] < size) return true;
            idx[pos] = 0;
            pos--;
          }
          // rolled over — grow length
          len++;
          if (len > maxLen) return false;
          idx = new Array(len).fill(0);
          return true;
        }

        function step() {
          if (!running) return finish(false);
          const batchStart = performance.now();
          // Work for ~14ms then yield so the UI stays responsive.
          while (performance.now() - batchStart < 14) {
            const guess = guessFromIdx();
            attempts++;
            if (guess === secret) {
              renderStats(attempts, start, total, guess);
              logLine(`✔ FOUND after ${U.num(attempts)} attempts: "${guess}"`, "hit");
              logLine(`Cracked in ${U.duration((performance.now() - start) / 1000)}.`, "ok");
              return finish(true);
            }
            if (!increment()) {
              renderStats(attempts, start, total, guess);
              logLine("Search space exhausted — secret not found in this space.", "err");
              return finish(false);
            }
          }
          renderStats(attempts, start, total, guessFromIdx());
          raf = requestAnimationFrame(step);
        }

        raf = requestAnimationFrame(step);
      });

      stopBtn.addEventListener("click", () => { running = false; });

      function renderStats(attempts, start, total, guess) {
        const secs = (performance.now() - start) / 1000;
        sAttempts.val.textContent = U.num(attempts);
        sRate.val.textContent = secs > 0 ? U.num(Math.round(attempts / secs)) : "—";
        sElapsed.val.textContent = U.duration(secs);
        U.qs(".cur", progLabel).textContent = guess;
        const pct = Math.min(100, (attempts / total) * 100);
        U.qs("span", meter).style.width = pct + "%";
      }

      function finish(found) {
        running = false;
        startBtn.disabled = false;
        stopBtn.disabled = true;
        if (raf) cancelAnimationFrame(raf);
        U.qs("span", meter).style.background = found ? "var(--good)" : "var(--warn)";
      }
    },
  });

  function stat(label) {
    const val = U.el("span", { class: "value mono", text: "—" });
    const card = U.el("div", { class: "stat" }, [
      U.el("span", { class: "label", text: label }),
      val,
    ]);
    return { card, val };
  }
})();
