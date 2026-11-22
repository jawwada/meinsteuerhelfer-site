// What the landing page shows for an estimate: reading the typed lines and choosing the words for the result.
// Pure functions without any DOM access, so they run under `node --test` (tests/web/view.test.js).
import { parseAmount } from "./numbers.js";

const AMOUNT_FIELDS = ["gross", "commute_km", "foreign_income", "other_costs"];
const MAX_KM = 500;
const FIELD_OF = {
  unsupported_year: "year", salary_range: "gross", months_range: "months", tax_class: "tax_class", days_range: "days",
};
const MINUS = "−";
// The German form word behind each line that moves the estimate. The same in every language of the page.
const DRIVER_TERMS = {
  part_year: "Lohnsteuerabzug", commute: "Entfernungspauschale", home_office: "Tagespauschale",
  other_costs: "Werbungskosten", church_tax: "Kirchensteuer", foreign_income: "Progressionsvorbehalt",
  children: "Kinderfreibetrag",
};

// The form line an estimator message belongs to; "form" when it belongs to no single line.
export function fieldOf(messageKey) {
  return FIELD_OF[messageKey] || "form";
}

// Whole-euro amounts in the notation of the page's language. Not a number: an empty string, never "NaN".
export function formatters(locale) {
  const whole = new Intl.NumberFormat(locale, { style: "currency", currency: "EUR", maximumFractionDigits: 0 });
  const plain = (n) => whole.format(Math.abs(n));
  return {
    money: (n) => (Number.isFinite(n) ? (n < 0 ? MINUS : "") + plain(n) : ""),
    signed: (n) => (Number.isFinite(n) ? (n > 0 ? "+" : n < 0 ? MINUS : "") + plain(n) : ""),
  };
}

// Turns the raw form values into the estimator's input. Typed amounts may use either notation ("30.000",
// "30,000"); an empty optional line is zero. Returns the lines that could not be read as {field, key}.
export function readInputs(raw) {
  const errors = [];
  const inp = {
    year: Number(raw.year), months: Number(raw.months), tax_class: Number(raw.tax_class),
    office_days_week: Number(raw.office_days_week), home_days_week: Number(raw.home_days_week),
    children: Number(raw.children), church: Boolean(raw.church), state: raw.state || null,
  };
  for (const field of AMOUNT_FIELDS) {
    const text = raw[field] === null || raw[field] === undefined ? "" : String(raw[field]).trim();
    if (text === "") {
      if (field === "gross") errors.push({ field, key: "salary_range" });
      else inp[field] = 0;
      continue;
    }
    const value = parseAmount(text);
    if (value === null) errors.push({ field, key: "amount" });
    else if (value < 0) errors.push({ field, key: "negative" });
    else if (field === "commute_km" && value > MAX_KM) errors.push({ field, key: "km_range" });
    else inp[field] = value;
  }
  return { inp, errors };
}

function fill(text, values) {
  return text.replace(/\{(\w+)\}/g, (match, name) => (name in values ? values[name] : match));
}

// The estimate is a range. Only a range that lies entirely above zero is called a refund, only one entirely
// below zero a payment; anything that includes zero is "about even". A negative result is never called a refund.
function kindOf(result) {
  if (result.low > 0) return "refund";
  if (result.high < 0) return "payment";
  return "even";
}

// What a visitor has to be told next to the number, because the few lines of the estimate cannot know it.
function hintsOf(result, t) {
  const inputs = result.inputs || {};
  const hints = [];
  // Arriving during the year usually means income abroad before that; it changes the result a lot.
  if (inputs.months < 12 && !(inputs.foreign_income > 0)) hints.push(t["r.abroad_hint"]);
  if (inputs.tax_class === 3) hints.push(t["r.class3_note"]);
  if (inputs.tax_class === 4) hints.push(t["r.class4_note"]);
  return hints;
}

// The amounts an explanation quotes, taken from the parameters of the tax year so that text and
// calculation cannot drift apart.
function factsOf(yearParams, fmt) {
  if (!yearParams) return {};
  return {
    allowance: fmt.money(yearParams.employee_allowance),
    near: Math.round(yearParams.commute.near * 100), far: Math.round(yearParams.commute.far * 100),
    far_from: yearParams.commute.far_from_km,
    per_day: fmt.money(yearParams.home_office.per_day), max: fmt.money(yearParams.home_office.max),
  };
}

// The work costs the answers add up to, set beside the flat amount every employee gets anyway. Costs under
// that line change nothing, and the page has to say so instead of silently showing no effect.
function costsOf(result, t, fmt) {
  const c = result.costs;
  if (!c || !(c.total > 0)) return null;
  const parts = [["commute", "driver.commute"], ["home_office", "driver.home_office"], ["other", "driver.other_costs"]]
    .filter(([key]) => c[key] > 0)
    .map(([key, label]) => ({ label: t[label], value: fmt.money(c[key]) }));
  const why = fill(t[c.total > c.allowance ? "r.costs.above" : "r.costs.below"], {
    total: fmt.money(c.total), allowance: fmt.money(c.allowance),
    extra: fmt.money(c.total - c.allowance), missing: fmt.money(c.allowance - c.total),
  });
  return { term: "Werbungskosten", label: t["r.costs.title"], amount: fmt.money(c.total), parts, why };
}

// Everything the page prints for one estimator result, as plain strings in the page's language.
// t: the text table (r.*, msg.*, err.*, driver.*); fmt: formatters(locale); yearParams: PARAMS[year].
export function resultView(result, t, fmt, yearParams = null) {
  const view = { kind: result.status, title: "", stamp: null, lines: [], hints: [], slip: [], costs: null, drivers: [], notices: [], notes: [], error: null };
  const invalid = (messageKey) => {
    const key = `err.${messageKey}`;
    view.kind = "invalid";
    view.error = { field: fieldOf(messageKey), text: key in t ? t[key] : t["err.invalid_value"] };
    return view;
  };

  if (result.status === "invalid") return invalid(result.message_key);
  if (result.status === "needs_documents") {
    view.title = t["msg.needs_documents.title"];
    view.lines = [t["msg.needs_documents.body"]];
    return view;
  }
  if (![result.mid, result.low, result.high, result.withheld].every(Number.isFinite)) return invalid("invalid_value");

  view.kind = kindOf(result);
  if (view.kind === "refund") {
    view.title = t["r.heading"];
    view.stamp = { label: t["r.heading"], amount: fmt.money(result.mid) };
    view.lines = [fill(t["r.range"], { low: fmt.money(result.low), high: fmt.money(result.high) })];
  } else if (view.kind === "payment") {
    view.title = t["msg.payment.title"];
    view.lines = [
      fill(t["msg.payment.amount"], {
        amount: fmt.money(-result.mid), low: fmt.money(-result.high), high: fmt.money(-result.low),
      }),
      t["msg.payment.body"],
    ];
  } else {
    view.title = t["msg.even.title"];
    view.lines = [t["msg.even.body"]];
  }

  // "Due" is derived from the two rounded figures beside it, so the slip always adds up on the page.
  view.slip = [
    { label: t["r.slip.withheld"], value: fmt.money(result.withheld), total: false },
    { label: t["r.slip.due"], value: fmt.money(result.withheld - result.mid), total: false },
    { label: t["r.slip.diff"], value: fmt.money(result.mid), total: true },
  ];
  view.costs = costsOf(result, t, fmt);
  const facts = factsOf(yearParams, fmt);
  view.drivers = (result.drivers || []).map((d) => ({
    label: t[`driver.${d.key}`], amount: fmt.signed(d.amount),
    term: DRIVER_TERMS[d.key] || "", why: fill(t[`driver.${d.key}.why`], facts),
  }));
  view.hints = hintsOf(result, t);
  if (result.must_file) view.notices.push(t["r.must_file"]);
  view.notes = [t["r.estimate_note"], t["r.next"]];
  return view;
}
