/* Bluetooth Control — scan, connect and inspect BLE devices you select.
 * Uses the standard Web Bluetooth API. The browser shows a chooser and the
 * user picks which device to connect to; 4uTools never connects silently.
 */
(function () {
  "use strict";

  // A few well-known GATT services worth reading for typical devices.
  const KNOWN_SERVICES = [
    "battery_service",
    "device_information",
    "generic_access",
    "heart_rate",
    "current_time",
  ];

  FourU.register({
    id: "bluetooth",
    title: "Bluetooth Control",
    icon: "📶",
    desc: "Scan for and inspect Bluetooth Low Energy devices you own.",
    render(root) {
      const supported = !!navigator.bluetooth;

      root.append(
        U.el("div", { class: "callout" +(supported? "":" warn") , html:
          supported
            ? "Click <b>Scan for device</b> — your browser opens a picker so you choose exactly which device to connect to. Requires a Bluetooth adapter and a Chromium-based browser over HTTPS or localhost."
            : "Web Bluetooth is <b>not available</b> in this browser/context. Use Chrome, Edge or another Chromium browser served over HTTPS (or localhost)." }),
      );

      const controls = U.el("div", { class: "btn-row" });
      const scanBtn = U.el("button", { class: "btn btn-primary", disabled: !supported }, "🔍 Scan for device");
      const disconnectBtn = U.el("button", { class: "btn btn-danger", disabled: true }, "Disconnect");
      controls.append(scanBtn, disconnectBtn);
      root.append(controls);

      const status = U.el("div", { class: "card", style: "margin-top:16px" });
      status.append(U.el("h3", { text: "Connected device" }));
      const info = U.el("div", { class: "kv" });
      info.innerHTML = '<span class="k">Status</span><span class="v">No device connected</span>';
      status.append(info);
      root.append(status);

      const servicesCard = U.el("div", { class: "card", style: "margin-top:16px" });
      servicesCard.append(U.el("h3", { text: "GATT services & characteristics" }));
      const svcBody = U.el("div", { class: "device-list" });
      svcBody.append(U.el("p", { class: "muted", text: "Connect a device to enumerate its services." }));
      servicesCard.append(svcBody);
      root.append(servicesCard);

      let currentDevice = null;

      function setInfo(rows) {
        U.clear(info);
        rows.forEach(([k, v]) => info.append(
          U.el("span", { class: "k", text: k }),
          U.el("span", { class: "v", text: v }),
        ));
      }

      async function readCharacteristics(server) {
        U.clear(svcBody);
        let services = [];
        try {
          services = await server.getPrimaryServices();
        } catch (e) {
          svcBody.append(U.el("p", { class: "muted", text: "No accessible primary services." }));
          return;
        }
        if (!services.length) {
          svcBody.append(U.el("p", { class: "muted", text: "Device exposed no readable primary services." }));
          return;
        }
        for (const svc of services) {
          const svcRow = U.el("div", { class: "device-row" });
          svcRow.append(
            U.el("div", {}, [
              U.el("div", { class: "name", text: prettyUuid(svc.uuid) }),
              U.el("div", { class: "meta", text: svc.uuid }),
            ]),
            U.el("span", { class: "pill info", text: "service" }),
          );
          svcBody.append(svcRow);
          try {
            const chars = await svc.getCharacteristics();
            for (const ch of chars) {
              const props = Object.entries(ch.properties).filter(([, v]) => v).map(([k]) => k).join(", ");
              const chRow = U.el("div", { class: "device-row", style: "margin-left:18px" });
              const valNode = U.el("div", { class: "meta", text: props || "—" });
              chRow.append(
                U.el("div", {}, [
                  U.el("div", { class: "name", text: prettyUuid(ch.uuid) }),
                  valNode,
                ]),
              );
              if (ch.properties.read) {
                const rb = U.el("button", { class: "btn btn-ghost", style: "padding:6px 12px" }, "Read");
                rb.addEventListener("click", async () => {
                  try {
                    const val = await ch.readValue();
                    valNode.textContent = decodeValue(ch.uuid, val);
                  } catch (e) { valNode.textContent = "read error: " + e.message; }
                });
                chRow.append(rb);
              }
              svcBody.append(chRow);
            }
          } catch (e) { /* some services block characteristic reads */ }
        }
      }

      scanBtn.addEventListener("click", async () => {
        try {
          const device = await navigator.bluetooth.requestDevice({
            acceptAllDevices: true,
            optionalServices: KNOWN_SERVICES,
          });
          currentDevice = device;
          setInfo([
            ["Name", device.name || "(unnamed)"],
            ["Device ID", device.id],
            ["Status", "Connecting…"],
          ]);
          device.addEventListener("gattserverdisconnected", onDisconnected);
          const server = await device.gatt.connect();
          setInfo([
            ["Name", device.name || "(unnamed)"],
            ["Device ID", device.id],
            ["Status", "✅ Connected"],
          ]);
          disconnectBtn.disabled = false;
          await readCharacteristics(server);
        } catch (e) {
          if (e.name !== "NotFoundError") { // user cancelled the picker
            setInfo([["Status", "Error: " + e.message]]);
          }
        }
      });

      disconnectBtn.addEventListener("click", () => {
        if (currentDevice && currentDevice.gatt.connected) currentDevice.gatt.disconnect();
      });

      function onDisconnected() {
        setInfo([["Status", "Disconnected"]]);
        disconnectBtn.disabled = true;
        U.clear(svcBody);
        svcBody.append(U.el("p", { class: "muted", text: "Device disconnected." }));
      }
    },
  });

  // Map common 16-bit GATT UUIDs to friendly names.
  const NAMES = {
    "00001800": "Generic Access",
    "00001801": "Generic Attribute",
    "0000180a": "Device Information",
    "0000180f": "Battery Service",
    "0000180d": "Heart Rate",
    "00002a00": "Device Name",
    "00002a19": "Battery Level",
    "00002a29": "Manufacturer Name",
    "00002a24": "Model Number",
    "00002a25": "Serial Number",
    "00002a26": "Firmware Revision",
  };
  function prettyUuid(uuid) {
    const short = String(uuid).toLowerCase().slice(0, 8);
    return NAMES[short] || uuid;
  }
  function decodeValue(uuid, dataView) {
    const short = String(uuid).toLowerCase().slice(0, 8);
    if (short === "00002a19") return dataView.getUint8(0) + "%"; // battery level
    // Try UTF-8 text, fall back to hex.
    try {
      const txt = new TextDecoder().decode(dataView);
      if (/^[\x20-\x7e]+$/.test(txt)) return txt;
    } catch (e) { /* fall through */ }
    const bytes = new Uint8Array(dataView.buffer);
    return "0x" + U.hex(bytes);
  }
})();
