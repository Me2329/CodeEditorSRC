# 4uTools — Device & Security Toolbox

A lightweight, **3uTools-style** utility app built with plain HTML/CSS/JS.
Where 3uTools focuses on iOS device management, **4uTools** is a general
device & security toolbox with a clean, VS Code–style dark UI.

Everything runs **locally in your browser** — no build step, no backend,
no accounts. Open `index.html` and go.

## Modules

| Module | What it does |
| --- | --- |
| 🏠 **Dashboard** | Live overview of your device: OS, browser, CPU threads, memory, screen, battery, network type & latency, user agent. |
| 📶 **Bluetooth Control** | Scan for and connect to Bluetooth Low Energy devices via the Web Bluetooth API, then enumerate GATT services/characteristics and read values (battery level, device name, etc.). The browser always shows a chooser — 4uTools never connects silently. |
| 🔐 **Bruteforce Lab** | An **educational** brute-force demonstration. Set a short secret *yourself*, pick a character set, and watch the search find it locally — with live attempts/sec, entropy, and real-world crack-time estimates. Built to teach why length + variety matter. |
| #️⃣ **Hash Tools** | MD5 / SHA-1 / SHA-256 / SHA-384 / SHA-512 for text, plus SHA-256 file checksums (great for verifying downloads). |
| 🔤 **Encoding Tools** | Base64, URL, Hex, ROT13 and JSON pretty/minify — encode & decode both ways. |
| 🔑 **Password Toolkit** | Cryptographically-random password generator + a strength analyzer with entropy and crack-time estimates. |
| 🌐 **Network Info** | Connection type/downlink/RTT, an online/offline monitor, a latency probe, and an opt-in public-IP lookup. |

## Running it

```bash
# Any static server works. For example:
python3 -m http.server 8000
# then open http://localhost:8000
```

Some browser APIs (Web Bluetooth, clipboard, battery) require a **secure
context** — serve over `https://` or `http://localhost`, and use a
Chromium-based browser for Bluetooth. Opening `index.html` directly from
disk works for most tools but blocks a few of those APIs.

## Responsible use

4uTools is for inspecting and securing **your own** devices and for learning
how these mechanisms work:

- The **Bruteforce Lab** only ever searches for a value you type into the
  page. It has no network capability and cannot target external devices,
  accounts, or services.
- **Bluetooth** actions only affect devices you explicitly select in the
  browser's picker.
- The only feature that contacts an external service is the opt-in public-IP
  lookup on the Network tab.

Don't use these techniques against systems you don't own or aren't
authorized to test.

## Structure

```
index.html          # app shell
css/style.css       # dark UI theme
js/util.js          # shared helpers + global namespace (window.FourU / window.U)
js/app.js           # sidebar router / view host
js/tools/*.js       # one self-registering module per tool
```

Adding a tool is just a new file in `js/tools/` that calls
`FourU.register({ id, title, icon, desc, render })` and a `<script>` tag
in `index.html`.

## License

MIT — see [LICENSE](LICENSE).
