// Quick refund estimate in the browser.
//
// This file repeats engine/estimate.py and the parts of the Python engine it uses (tariff, wage tax, social
// contributions, assessment). Keep every arithmetic operation in the same order as the Python code:
// tests/web/test_parity.py compares both implementations over a grid of inputs, field by field.

const EPS = 1e-9;
export const YEARS = [2022, 2023, 2024, 2025];
export const STATES = ["BW", "BY", "BE", "BB", "HB", "HH", "HE", "MV", "NI", "NW", "RP", "SL", "SN", "ST", "SH", "TH"];
const EAST = ["BB", "MV", "SN", "ST", "TH"];
const MUST_FILE_ABOVE = 410;
const MAX_SALARY = 1000000;

// ---- rounding (engine/rounding.py) ---------------------------------------------------------------------
function cents(x) {
  const sign = x < 0 ? -1 : 1;
  return sign * Math.floor(Math.abs(x) * 100 + 0.5 + EPS) / 100;
}
function euros(x) { return Math.floor(x + 0.5 + EPS); }
function floorEuros(x) { return Math.floor(x + EPS); }

// ---- tariff (engine/tarif.py) --------------------------------------------------------------------------
function basic(zve, p) {
  const t = p.tariff;
  const x = Math.floor(zve);
  let tax;
  if (x <= p.basic_allowance) return 0;
  if (x <= t.z_from) {
    const y = (x - p.basic_allowance) / 10000;
    tax = (t.y_a * y + t.y_b) * y;
  } else if (x <= t.p42_from) {
    const z = (x - t.z_from) / 10000;
    tax = (t.z_a * z + t.z_b) * z + t.z_c;
  } else if (x <= t.p45_from) {
    tax = 0.42 * x - t.p42_sub;
  } else {
    tax = 0.45 * x - t.p45_sub;
  }
  return floorEuros(tax);
}
function splitting(zve, p) { return 2 * basic(Math.floor(zve) / 2, p); }
function incomeTax(zve, p, joint) { return joint ? splitting(zve, p) : basic(zve, p); }
function rate(zve, rateIncome, p, joint) {
  const base = Math.max(zve, 0) + Math.max(rateIncome, 0);
  if (base <= 0) return 0.0;
  return incomeTax(base, p, joint) / base;
}
function withProgression(zve, rateIncome, p, joint) {
  zve = Math.floor(zve);
  if (rateIncome <= 0) return incomeTax(zve, p, joint);
  return floorEuros(Math.max(zve, 0) * rate(zve, rateIncome, p, joint));
}
function solz(tax, p, joint) {
  const s = p.solz;
  const exempt = joint ? s.exempt_joint : s.exempt_joint / 2;
  if (tax <= exempt) return 0.0;
  return cents(Math.min(s.rate * tax, s.phase_in * (tax - exempt)));
}

// ---- deductions (engine/deductions.py) -----------------------------------------------------------------
function commute(km, days, p) {
  const c = p.commute;
  const nearKm = Math.min(km, c.far_from_km - 1);
  const farKm = Math.max(km - (c.far_from_km - 1), 0);
  return cents(days * (nearKm * c.near + farKm * c.far));
}
function homeOffice(days, p) { return cents(Math.min(days * p.home_office.per_day, p.home_office.max)); }
function workingDays(months, daysPerWeek) { return euros(220 * months / 12 * daysPerWeek / 5); }

// ---- social contributions (engine/social.py) -----------------------------------------------------------
function contributions(gross, p, months, childless, east) {
  const s = p.social;
  const share = months / 12;
  const basePension = Math.min(gross, (east ? s.bbg_pension_east : s.bbg_pension_west) * share);
  const baseHealth = Math.min(gross, s.bbg_health * share);
  const extra = s.health_extra_avg;
  const careRate = s.care_employee + (childless ? s.care_childless_extra : 0.0);
  return {
    pension: cents(basePension * s.pension_employee),
    unemployment: cents(basePension * s.unemployment_employee),
    health: cents(baseHealth * (s.health_employee_general + extra / 2)),
    care: cents(baseHealth * careRate),
  };
}

// ---- wage tax (engine/wage_tax.py) ---------------------------------------------------------------------
function provisionAllowance(gross, taxClass, p, childless, east) {
  const s = p.social;
  const w = p.wage_tax;
  const pensionBase = Math.min(gross, east ? s.bbg_pension_east : s.bbg_pension_west);
  const pension = pensionBase * s.pension_employee * w.pension_share;
  const healthBase = Math.min(gross, s.bbg_health);
  const extra = s.health_extra_avg;
  const health = healthBase * (s.health_employee_reduced + extra / 2);
  const care = healthBase * (s.care_employee + (childless ? s.care_childless_extra : 0.0));
  const minimum = Math.min(w.min_rate * gross, taxClass === 3 ? w.min_cap_class3 : w.min_cap);
  return Math.ceil(pension + Math.max(health + care, minimum) - 1e-9);
}
function annualWageTax(annualGross, taxClass, p, o) {
  const joint = taxClass === 3;
  let taxable = annualGross - p.employee_allowance - p.special_expenses_allowance
    - provisionAllowance(annualGross, taxClass, p, o.childless, o.east);
  if (taxClass === 2) taxable -= p.single_parent_relief.base;
  const tax = incomeTax(taxable, p, joint);
  const perChild = p.child_allowance * (joint ? 1.0 : 0.5);
  const base = incomeTax(taxable - o.children * perChild, p, joint);
  return { tax, solz: solz(base, p, joint), church: o.churchRate ? cents(o.churchRate * base) : 0.0 };
}
function withheldWageTax(gross, months, taxClass, p, o) {
  const full = annualWageTax(gross / months * 12, taxClass, p, o);
  return {
    tax: cents(full.tax * months / 12),
    solz: cents(full.solz * months / 12),
    church: cents(full.church * months / 12),
  };
}

// ---- assessment (engine/assess.py, only what the estimate needs) ---------------------------------------
function workCostsOf(person, allowance) {
  const wages = person.gross + 0.0;
  let items = 0.0;
  for (const amount of person.workCosts) items += amount;
  if (items > allowance || wages <= 0) return items;
  return Math.min(allowance, wages);
}
function assess(p, joint, persons, children, churchRate, singleParent) {
  let income = 0.0;
  let rateIncome = 0.0;
  for (const person of persons) {
    const costs = workCostsOf(person, p.employee_allowance);
    income += person.gross + 0.0 - costs;
    rateIncome += 0.0 + person.foreignIncome;
  }
  let relief = 0.0;
  if (singleParent && children > 0) {
    relief = p.single_parent_relief.base + p.single_parent_relief.per_further_child * (children - 1);
  }
  const totalIncome = income - relief;

  const share = p.pension_deductible_share;
  const cut = p.sick_pay_reduction;
  let pension = 0.0;
  let basis = 0.0;
  let other = 0.0;
  let churchPaid = 0.0;
  let wTax = 0.0;
  let wSolz = 0.0;
  let wChurch = 0.0;
  for (const person of persons) {
    pension += Math.max((person.pensionEmployee + person.pensionEmployer) * share - person.pensionEmployer, 0.0);
    basis += person.health * (1 - cut) + person.care;
    other += person.unemployment + 0.0 + person.health * cut;
    churchPaid += person.churchTax;
    wTax += person.wageTax;
    wSolz += person.solz;
    wChurch += person.churchTax;
  }
  const cap = p.other_insurance_cap * (joint ? 2 : 1);
  const healthCare = Math.max(basis, Math.min(basis + other, cap));
  const otherSpecial = Math.max(cents(churchPaid + 0.0 + 0.0), p.special_expenses_allowance * (joint ? 2 : 1));
  const net = totalIncome - pension - healthCare - otherSpecial - 0.0 - 0.0;

  const taxAt = (allowances) => withProgression(net - allowances, rateIncome, p, joint);
  let used = 0.0;
  let benefitAdded = 0.0;
  let allAllowances = 0.0;
  for (let index = 0; index < children; index++) {
    const months = 12;
    const part = joint ? 1.0 : 0.5;
    const allowance = p.child_allowance * part * months / 12;
    const monthly = p.child_benefit_monthly[Math.min(index, p.child_benefit_monthly.length - 1)];
    const benefit = (monthly * months + p.child_bonus) * part;
    allAllowances += allowance;
    if (taxAt(used) - taxAt(used + allowance) > benefit) {
      used += allowance;
      benefitAdded += benefit;
    }
  }
  const tax = taxAt(used);
  const credit = 0.0;
  const surchargeBase = Math.max(taxAt(allAllowances) - credit, 0.0);
  const solzDue = solz(surchargeBase, p, joint);
  const churchDue = churchRate ? cents(churchRate * surchargeBase) : 0.0;
  const due = tax - credit + benefitAdded;
  return cents((0.0 + cents(wTax) + cents(wSolz) + cents(wChurch)) - due - solzDue - churchDue);
}

// ---- estimate (engine/estimate.py) ---------------------------------------------------------------------
function number(value, fallback) {
  if (value === null || value === undefined || value === "") return fallback;
  if (typeof value !== "number" && typeof value !== "string") return null;
  const x = typeof value === "number" ? value : Number(value);
  return Number.isFinite(x) ? x : null;
}
function clean(inp) {
  const year = number(inp.year, null);
  if (year === null || Math.trunc(year) !== year || !YEARS.includes(year)) return [null, "unsupported_year"];
  const gross = number(inp.gross, null);
  if (gross === null || gross <= 0 || gross > MAX_SALARY) return [null, "salary_range"];
  const months = number(inp.months, null);
  if (months === null || months < 1 || months > 12) return [null, "months_range"];
  const taxClass = number(inp.tax_class, null);
  if (taxClass === null || Math.trunc(taxClass) !== taxClass || taxClass < 1 || taxClass > 6) return [null, "tax_class"];

  const rest = {};
  for (const key of ["commute_km", "office_days_week", "home_days_week", "foreign_income", "other_costs", "children"]) {
    const value = number(inp[key], 0.0);
    if (value === null || value < 0) return [null, "invalid_value"];
    rest[key] = value;
  }
  if (rest.children !== Math.trunc(rest.children) || rest.children > 10 || rest.commute_km > 500) return [null, "invalid_value"];
  if (rest.office_days_week + rest.home_days_week > 7) return [null, "days_range"];

  const cleaned = {
    ...rest, year, gross, months, tax_class: taxClass, children: rest.children,
    church: Boolean(inp.church), state: STATES.includes(inp.state) ? inp.state : null,
  };
  if (cleaned.tax_class === 2 && cleaned.children < 1) cleaned.children = 1;
  return [cleaned, null];
}
function options(c, p) {
  const byState = p.church.by_state[c.state];
  return {
    childless: c.children === 0,
    east: EAST.includes(c.state),
    churchRate: c.church ? (byState === undefined ? p.church.default : byState) : null,
    children: c.children,
  };
}
function workCosts(c, p) {
  const officeDays = workingDays(c.months, c.office_days_week);
  const homeDays = workingDays(c.months, c.home_days_week);
  return [["commute", commute(Math.trunc(c.commute_km), officeDays, p)],
    ["home_office", homeOffice(homeDays, p)],
    ["other", c.other_costs]];
}
function refundOf(c, p) {
  const o = options(c, p);
  const joint = c.tax_class === 3;
  const w = withheldWageTax(c.gross, c.months, c.tax_class, p, o);
  const s = contributions(c.gross, p, c.months, o.childless, o.east);
  const person = {
    gross: c.gross, wageTax: w.tax, solz: w.solz, churchTax: w.church,
    pensionEmployee: s.pension, pensionEmployer: s.pension, health: s.health, care: s.care,
    unemployment: s.unemployment, foreignIncome: c.foreign_income,
    workCosts: workCosts(c, p).map((item) => item[1]),
  };
  const partner = {
    gross: 0.0, wageTax: 0.0, solz: 0.0, churchTax: 0.0, pensionEmployee: 0.0, pensionEmployer: 0.0,
    health: 0.0, care: 0.0, unemployment: 0.0, foreignIncome: 0.0, workCosts: [],
  };
  const refund = assess(p, joint, joint ? [person, partner] : [person], c.children, o.churchRate, c.tax_class === 2);
  return [refund, w.tax + w.solz + w.church];
}

const DRIVERS = [
  ["commute", "commute_km", { commute_km: 0 }],
  ["home_office", "home_days_week", { home_days_week: 0 }],
  ["other_costs", "other_costs", { other_costs: 0 }],
  ["church_tax", "church", { church: false }],
  ["foreign_income", "foreign_income", { foreign_income: 0 }],
  ["children", "children", { children: 0 }],
];

export function quickEstimate(inp, PARAMS) {
  const [c, error] = clean(inp || {});
  if (error) return { status: "invalid", message_key: error };
  if (c.tax_class === 5 || c.tax_class === 6) return { status: "needs_documents", message_key: "needs_documents", inputs: c };
  const p = PARAMS[c.year];

  const [refund, withheld] = refundOf(c, p);

  const drivers = [];
  if (c.months < 12) {
    const full = annualWageTax(c.gross, c.tax_class, p, options(c, p));
    const amount = euros(withheld - (full.tax + full.solz + full.church));
    if (amount) drivers.push({ key: "part_year", amount });
  }
  for (const [key, field, change] of DRIVERS) {
    if (!c[field] || (key === "children" && c.tax_class === 2)) continue;
    const amount = euros(refund - refundOf({ ...c, ...change }, p)[0]);
    if (amount) drivers.push({ key, amount });
  }

  const costs = { commute: 0, home_office: 0, other: 0, total: 0, allowance: p.employee_allowance };
  let costTotal = 0.0;
  for (const [name, amount] of workCosts(c, p)) {
    costs[name] = euros(amount);
    costTotal += amount;
  }
  costs.total = euros(costTotal);
  const mid = euros(refund);
  const band = Math.max(60, euros(0.06 * Math.abs(mid)));
  const out = {
    status: mid > 0 ? "refund" : "no_refund",
    mid, low: mid - band, high: mid + band,
    withheld: euros(withheld), due: euros(withheld - refund),
    must_file: c.foreign_income > MUST_FILE_ABOVE,
    costs, drivers, inputs: c,
  };
  if (out.status === "no_refund") out.message_key = "no_refund";
  return out;
}
