// Busyholm placeholder settings window (WP-02). Edits only the fields below and keeps
// every other field of the loaded Settings v1 object exactly as the core sent it.
import * as bridge from "./bridge.js";

const boot = bridge.boot();
const $ = (id) => document.getElementById(id);

const f = {
  enabled: $("strip-enabled"),
  height: $("strip-height"),
  hoverFade: $("strip-hover-fade"),
  fullscreen: $("strip-fullscreen"),
  idle: $("ambient-idle"),
  shortcut: $("ambient-shortcut"),
  login: $("other-login"),
};
const layerRadios = Array.from(document.querySelectorAll('input[name="layer"]'));
const errorEl = $("error");
const statusEl = $("status");

let current = null; // the last Settings v1 object received from the core

// reserve_space does not exist on macOS (the core would fall back to on_top)
for (const r of layerRadios) {
  if (r.value === "reserve_space" && boot.os === "macos") r.disabled = true;
}

function showError(text) {
  errorEl.hidden = !text;
  errorEl.textContent = text || "";
}

function fill(s) {
  current = s;
  const strip = s.strip || {};
  const ambient = s.ambient || {};
  f.enabled.checked = !!strip.enabled;
  for (const r of layerRadios) r.checked = r.value === strip.layer_mode;
  f.height.value = String(strip.height ?? "");
  f.hoverFade.checked = !!strip.hover_fade;
  f.fullscreen.checked = !!strip.show_over_fullscreen;
  f.idle.value = ambient.idle_minutes === null || ambient.idle_minutes === undefined ? "" : String(ambient.idle_minutes);
  f.shortcut.value = ambient.shortcut === null || ambient.shortcut === undefined ? "" : String(ambient.shortcut);
  f.login.checked = !!(s.other && s.other.launch_at_login);
}

function build() {
  const next = JSON.parse(JSON.stringify(current));
  const height = Number(f.height.value);
  if (!Number.isInteger(height) || height < 72 || height > 160) {
    throw new Error("Height must be a whole number from 72 to 160.");
  }
  const picked = layerRadios.find((r) => r.checked);
  const shortcut = f.shortcut.value.trim();
  if (shortcut !== "" && !(shortcut.length <= 64 && /^[A-Za-z0-9]+(\+[A-Za-z0-9]+)*$/.test(shortcut))) {
    throw new Error("The shortcut can only use letters, digits and plus signs, for example CommandOrControl+Shift+B.");
  }
  next.strip.enabled = f.enabled.checked;
  if (picked) next.strip.layer_mode = picked.value;
  next.strip.height = height;
  next.strip.hover_fade = f.hoverFade.checked;
  next.strip.show_over_fullscreen = f.fullscreen.checked;
  next.ambient.idle_minutes = f.idle.value === "" ? null : Number(f.idle.value);
  next.ambient.shortcut = shortcut === "" ? null : shortcut;
  next.other.launch_at_login = f.login.checked;
  return next;
}

$("form").addEventListener("submit", async (e) => {
  e.preventDefault();
  showError("");
  statusEl.textContent = "";
  if (!current) {
    showError("Settings are not loaded yet.");
    return;
  }
  let next;
  try {
    next = build();
  } catch (err) {
    showError(err.message);
    return;
  }
  const r = await bridge.setSettings(next);
  if (!r.ok) {
    showError(r.error || "The settings could not be saved.");
    return;
  }
  fill(r.settings);
  statusEl.textContent = "Saved.";
});

bridge.onSettings((s) => {
  if (s && typeof s === "object" && s.strip) fill(s);
});

bridge.getSettings().then((s) => {
  if (s && s.strip && !current) fill(s);
});

if (!bridge.hasCore()) $("nocore").hidden = false;
