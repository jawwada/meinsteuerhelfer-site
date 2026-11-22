// The refund estimate on the landing page. Everything runs in the browser; nothing is sent anywhere.
// Each [data-estimator] element is one independent estimator with its own texts (a JSON block inside it),
// so a page may hold more than one.
import { quickEstimate } from "./estimator.js";
import { PARAMS } from "./params.js";
import { formatters, readInputs, resultView } from "./view.js";

const VALUE_FIELDS = ["year", "gross", "months", "tax_class", "commute_km", "office_days_week", "home_days_week",
  "foreign_income", "state", "children", "other_costs"];
// Which controls belong to an error slot (data-error-for) when they are not named like the slot.
const CONTROLS_OF = { days: ["office_days_week", "home_days_week"], form: [] };

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function slip(items) {
  const list = el("dl", "slip");
  for (const item of items) {
    const row = el("div", item.total ? "slip__row slip__row--total" : "slip__row");
    row.append(el("dt", "", item.label), el("dd", "", item.value));
    list.append(row);
  }
  return list;
}

function initEstimator(root) {
  if (root.dataset.ready) return;
  const configNode = root.querySelector("script[data-config]");
  const form = root.querySelector("form");
  const out = root.querySelector("[data-result]");
  const why = root.querySelector("[data-why]");
  if (!configNode || !form || !out) return;
  root.dataset.ready = "true";

  const config = JSON.parse(configNode.textContent);
  const t = config.t;
  const fmt = formatters(config.locale);
  const control = (name) => form.elements.namedItem(name);
  const controlsOf = (field) => (CONTROLS_OF[field] || [field]).map(control).filter(Boolean);
  let example = true; // until the visitor changes a line, the page shows a worked example

  function raw() {
    const values = { church: control("church").checked };
    for (const name of VALUE_FIELDS) values[name] = control(name).value;
    return values;
  }

  function clearErrors() {
    for (const slot of form.querySelectorAll("[data-error-for]")) {
      slot.textContent = "";
      slot.hidden = true;
    }
    for (const node of form.querySelectorAll("[aria-invalid]")) node.removeAttribute("aria-invalid");
  }

  function showError(field, text) {
    const slot = form.querySelector(`[data-error-for="${field}"]`) || form.querySelector('[data-error-for="form"]');
    slot.textContent = text;
    slot.hidden = false;
    const folded = slot.closest("details");
    if (folded) folded.open = true;
    for (const node of controlsOf(field)) node.setAttribute("aria-invalid", "true");
  }

  function render(view, pressed) {
    out.replaceChildren();
    if (!view) return;
    const box = el("div", `result__inner result--${view.kind}`);
    if (example) box.append(el("p", "result__example", t["r.example"]));
    if (view.stamp) {
      const stamp = el("p", pressed ? "stamp stamp--press" : "stamp");
      stamp.append(el("span", "stamp__label", view.stamp.label), " ", el("span", "stamp__amount", view.stamp.amount));
      box.append(stamp);
    } else {
      box.append(el("h3", "result__title", view.title));
    }
    for (const line of view.lines) box.append(el("p", "result__line", line));
    for (const hint of view.hints) box.append(el("p", "result__hint", hint));
    if (view.slip.length) box.append(slip(view.slip));
    for (const notice of view.notices) box.append(el("p", "notice", notice));
    for (const note of view.notes) box.append(el("p", "note", note));
    out.append(box);
  }

  // Tax education: every line that moves the number, with its German form word and a plain explanation.
  function whyItem(entry) {
    const term = el("span", "term", entry.term);
    term.lang = "de";
    const name = el("span", "why__name");
    name.append(term, el("span", "why__label", entry.label));
    const head = el("p", "why__head");
    head.append(name, el("span", "why__amount", entry.amount));
    const item = el("li", "why__item");
    item.append(head, el("p", "why__text", entry.why));
    if (entry.parts && entry.parts.length > 1) item.append(slip(entry.parts));
    return item;
  }

  function renderWhy(view) {
    if (!why) return;
    why.replaceChildren();
    if (!view || !(view.costs || view.drivers.length)) return;
    const box = el("div", "why__inner");
    box.append(el("h2", "why__title", t["r.why"]));
    const list = el("ul", "why__list");
    if (view.costs) list.append(whyItem(view.costs));
    for (const driver of view.drivers) list.append(whyItem(driver));
    box.append(list);
    if (view.drivers.length) box.append(el("p", "note", t["r.why.note"]));
    why.append(box);
  }

  // submitted: the visitor pressed the button, so move to the first problem or bring the result into view.
  function run(submitted) {
    clearErrors();
    const { inp, errors } = readInputs(raw());
    let view = null;
    if (errors.length) {
      for (const error of errors) showError(error.field, t[`err.${error.key}`]);
    } else {
      view = resultView(quickEstimate(inp, PARAMS), t, fmt, PARAMS[inp.year]);
      if (view.error) {
        showError(view.error.field, view.error.text);
        view = null;
      }
    }
    render(view, submitted);
    renderWhy(view);
    if (!submitted) return;
    if (!view) {
      const first = form.querySelector('[aria-invalid="true"]');
      if (first) first.focus();
      return;
    }
    const calm = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    out.scrollIntoView({ block: "nearest", behavior: calm ? "auto" : "smooth" });
  }

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    example = false;
    run(true);
  });
  // After the first look, every changed line recalculates; typing alone does not interrupt with errors.
  form.addEventListener("change", () => {
    example = false;
    run(false);
  });

  run(false);
}

export function initEstimators(root = document) {
  for (const node of root.querySelectorAll("[data-estimator]")) initEstimator(node);
}

if (typeof document !== "undefined") initEstimators(document);
