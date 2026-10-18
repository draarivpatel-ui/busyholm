// Tiny DOM helpers. Data is only ever set as text or attributes, never parsed as HTML.

const SVG_NS = "http://www.w3.org/2000/svg";

/**
 * h("div.row.alert", { attrs }, ...children). Class names come after dots in the tag. Attribute
 * values: strings are set with setAttribute; on* keys add listeners; `text` sets textContent.
 */
export function h(tag, attrs, ...children) {
  const [name, ...classes] = tag.split(".");
  const el = document.createElement(name || "div");
  if (classes.length) el.className = classes.join(" ");
  applyAttrs(el, attrs);
  append(el, children);
  return el;
}

function applyAttrs(el, attrs) {
  if (!attrs) return;
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "text") el.textContent = String(v);
    else if (k === "class") el.className = el.className ? el.className + " " + v : v;
    else if (k === "style" && typeof v === "object") {
      for (const [sk, sv] of Object.entries(v)) {
        if (sk.startsWith("--")) el.style.setProperty(sk, String(sv));
        else el.style[sk] = sv;
      }
    }
    else if (k === "dataset") Object.assign(el.dataset, v);
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
    else if (v === true) el.setAttribute(k, "");
    else el.setAttribute(k, String(v));
  }
}

export function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

/** Replace an element's children. */
export function fill(el, ...children) {
  el.replaceChildren();
  return append(el, children);
}

export function svg(viewBox, className) {
  const s = document.createElementNS(SVG_NS, "svg");
  s.setAttribute("viewBox", viewBox);
  if (className) s.setAttribute("class", className);
  s.setAttribute("aria-hidden", "true");
  s.setAttribute("focusable", "false");
  return s;
}

export function svgEl(name, attrs) {
  const e = document.createElementNS(SVG_NS, name);
  for (const [k, v] of Object.entries(attrs || {})) e.setAttribute(k, String(v));
  return e;
}

/** Announce text to screen readers through a shared polite live region. */
export function announce(text, assertive) {
  const id = assertive ? "bh-live-assertive" : "bh-live-polite";
  let r = document.getElementById(id);
  if (!r) {
    r = h("div.sr-only", { id, role: assertive ? "alert" : "status", "aria-live": assertive ? "assertive" : "polite" });
    document.body.append(r);
  }
  r.textContent = "";
  setTimeout(() => (r.textContent = text), 30);
}

/** Apply theme and motion classes from boot data, settings and query overrides. */
export function applyAppearance(settings, os) {
  const root = document.documentElement;
  const q = new URLSearchParams(location.search);
  const theme = q.get("theme");
  if (theme === "light" || theme === "dark") root.dataset.theme = theme;
  root.dataset.os = os || "macos";
  const rm = settings && settings.other ? settings.other.reduced_motion : "follow_os";
  root.classList.toggle("reduce-motion", rm === "always" || q.get("motion") === "reduce");
}
