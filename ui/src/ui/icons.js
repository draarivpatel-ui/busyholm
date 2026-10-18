// Monochrome line icons, 24 x 24, stroke currentColor. Original drawings (the tool marks and
// basic glyphs follow the Relay prototype's set; the island glyphs are new). Constant markup only.

const P = {
  // tools (Relay marks; not provider logos)
  claude: '<path d="M12 2v5m0 10v5M2 12h5m10 0h5M4.9 4.9l3.6 3.6m7 7 3.6 3.6M4.9 19.1l3.6-3.6m7-7 3.6-3.6"/>',
  codex: '<path d="m8 6-6 6 6 6m8-12 6 6-6 6m-3-14-2 16"/>',
  gemini: '<path d="M12 2c1.4 6.1 3.9 8.6 10 10-6.1 1.4-8.6 3.9-10 10-1.4-6.1-3.9-8.6-10-10 6.1-1.4 8.6-3.9 10-10Z"/>',
  opencode: '<rect x="3" y="4" width="18" height="16" rx="3"/><path d="m7 9 3 3-3 3m6 0h4"/>',
  // states
  key: '<circle cx="8" cy="15" r="4"/><path d="m11 12 8-8m-3 3 2 2m-4 0 2 2"/>',
  question: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.6 2.6 0 1 1 3.6 2.4c-.7.3-1.1.9-1.1 1.6v.5M12 17v.1"/>',
  lantern: '<path d="M9 5h6M10 5V3.5h4V5M8 8h8l-1 11H9L8 8Z"/><path d="M12 11.5c1 1 1 2.6 0 3.6-1-1-1-2.6 0-3.6Z"/><path d="M7 19h10"/>',
  work: '<path d="m14.5 5.5 4 4L10 18l-4.5.5L6 14l8.5-8.5Z"/><path d="m12.5 7.5 4 4"/>',
  door: '<path d="M6 21V4h10v17M4 21h16"/><path d="M13 12v.1"/>',
  cloud: '<path d="M7 15a4 4 0 1 1 1.2-7.8A5 5 0 0 1 17.5 9 3 3 0 0 1 17 15H7Z"/><path d="m9 18-1 2m5-2-1 2m5-2-1 2"/>',
  cup: '<path d="M5 9h11v4a5 5 0 0 1-5 5h-1a5 5 0 0 1-5-5V9Z"/><path d="M16 10h1.5a2.5 2.5 0 0 1 0 5H16M8 3.5c-.6.8-.6 1.7 0 2.5m4-2.5c-.6.8-.6 1.7 0 2.5"/>',
  idle: '<circle cx="12" cy="12" r="9"/><path d="M8 12h8"/>',
  unknown: '<circle cx="12" cy="12" r="9" stroke-dasharray="3 3"/><path d="M10 10a2 2 0 1 1 2.8 1.8c-.5.3-.8.7-.8 1.2M12 16v.1"/>',
  flag: '<path d="M6 21V3"/><path d="M6 4h11l-2.5 4L17 12H6"/>',
  bell: '<path d="M6 16V11a6 6 0 1 1 12 0v5l1.5 2h-15L6 16Z"/><path d="M10 20.5a2 2 0 0 0 4 0"/>',
  // ui
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  warning: '<path d="m12 3 10 18H2L12 3Z"/><path d="M12 9v5m0 3v.1"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  chevron: '<path d="m9 5 7 7-7 7"/>',
  back: '<path d="m15 5-7 7 7 7"/>',
  details: '<rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="M7 9h10M7 13h10M7 17h6"/>',
  moon: '<path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5Z"/>',
  strip: '<rect x="3" y="15" width="18" height="5" rx="1.5"/><path d="M6 15c1.5-2 3-2 4.5 0 1.5-2.5 4-2.5 6 0"/>',
  island: '<path d="M2 17c3-1 5-1 7 0s4 1 6 0 4-1 7 0"/><path d="M5 14c1.5-4 4-6 7-6s5.5 2 7 6"/><path d="M12 8V4l3 1.5L12 7"/>',
  plank: '<rect x="3" y="9" width="18" height="6" rx="1"/><path d="M7 9v6m10-6v6"/>',
  shield: '<path d="M12 3 5 6v5c0 5 3 8.5 7 10 4-1.5 7-5 7-10V6l-7-3Z"/><path d="m9 12 2 2 4-4"/>',
  plug: '<path d="M9 3v5m6-5v5M7 8h10v3a5 5 0 0 1-10 0V8Zm5 8v5"/>',
  unplug: '<path d="M9 3v5m6-5v5M7 8h10v3a5 5 0 0 1-10 0V8Zm5 8v5M4 4l16 16"/>',
  external: '<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-9.5v.1"/>',
  terminal: '<rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="m7 9 3 3-3 3m6 0h4"/>',
  history: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5M12 7v5l3 2"/>',
};

const TOOL_ICON = { claude: "claude", codex: "codex", opencode: "opencode", gemini: "gemini", antigravity: "gemini" };

export function iconFor(tool) {
  return TOOL_ICON[tool] || "terminal";
}

/** An SVG icon element (aria-hidden; pair it with visible or sr-only text). */
export function icon(name, className) {
  const tpl = document.createElement("template");
  tpl.innerHTML =
    '<svg class="icon' + (className ? " " + className : "") + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' +
    (P[name] || P.idle) +
    "</svg>";
  return tpl.content.firstChild;
}
