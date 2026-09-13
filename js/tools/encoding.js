/* Encoding Tools — Base64 / URL / Hex / ROT13 / JSON, both directions. */
(function () {
  "use strict";

  const OPS = {
    base64: {
      label: "Base64",
      enc: (s) => btoa(unescape(encodeURIComponent(s))),
      dec: (s) => decodeURIComponent(escape(atob(s.trim()))),
    },
    url: {
      label: "URL component",
      enc: (s) => encodeURIComponent(s),
      dec: (s) => decodeURIComponent(s),
    },
    hex: {
      label: "Hex (UTF-8)",
      enc: (s) => Array.from(new TextEncoder().encode(s)).map((b) => b.toString(16).padStart(2, "0")).join(""),
      dec: (s) => {
        const clean = s.replace(/[^0-9a-fA-F]/g, "");
        const bytes = clean.match(/.{1,2}/g) || [];
        return new TextDecoder().decode(new Uint8Array(bytes.map((h) => parseInt(h, 16))));
      },
    },
    rot13: {
      label: "ROT13",
      enc: (s) => s.replace(/[a-z]/gi, (c) => {
        const base = c <= "Z" ? 65 : 97;
        return String.fromCharCode(((c.charCodeAt(0) - base + 13) % 26) + base);
      }),
      dec: (s) => OPS.rot13.enc(s), // symmetric
    },
    json: {
      label: "JSON pretty / minify",
      enc: (s) => JSON.stringify(JSON.parse(s), null, 2),
      dec: (s) => JSON.stringify(JSON.parse(s)),
    },
  };

  FourU.register({
    id: "encoding",
    title: "Encoding Tools",
    icon: "🔤",
    desc: "Base64, URL, Hex, ROT13 and JSON — encode & decode.",
    render(root) {
      const card = U.el("div", { class: "card" });

      const select = U.el("select");
      Object.entries(OPS).forEach(([k, o]) => select.append(U.el("option", { value: k }, o.label)));
      card.append(U.el("label", { class: "field" }, [
        U.el("span", { class: "lbl", text: "Scheme" }), select,
      ]));

      const input = U.el("textarea", { placeholder: "Input…" });
      input.value = "Hello, 4uTools!";
      card.append(U.el("label", { class: "field" }, [
        U.el("span", { class: "lbl", text: "Input" }), input,
      ]));

      const btnRow = U.el("div", { class: "btn-row" });
      const encBtn = U.el("button", { class: "btn btn-primary" }, "Encode ▾");
      const decBtn = U.el("button", { class: "btn" }, "Decode ▴");
      const swapBtn = U.el("button", { class: "btn btn-ghost" }, "⇅ Use output as input");
      const copyBtn = U.el("button", { class: "btn btn-ghost" }, "Copy output");
      btnRow.append(encBtn, decBtn, swapBtn, copyBtn);
      card.append(btnRow);

      const out = U.el("div", { class: "code-out", style: "margin-top:14px", text: "" });
      card.append(U.el("span", { class: "lbl", text: "Output", style: "display:block;font-size:12px;color:var(--text-dim);margin:14px 0 6px" }), out);
      root.append(card);

      function run(dir) {
        const op = OPS[select.value];
        try {
          out.textContent = dir === "enc" ? op.enc(input.value) : op.dec(input.value);
          out.style.color = "var(--accent-2)";
        } catch (e) {
          out.textContent = "⚠ " + e.message;
          out.style.color = "var(--bad)";
        }
      }
      encBtn.addEventListener("click", () => run("enc"));
      decBtn.addEventListener("click", () => run("dec"));
      swapBtn.addEventListener("click", () => { input.value = out.textContent; });
      copyBtn.addEventListener("click", () => U.copy(out.textContent, copyBtn));
      run("enc");
    },
  });
})();
