// Reads an amount the way people type it: "58000", "58.000", "58,000", "58 000 €", "4.500,50".
// Returns a number, or null when the text is not an amount.
export function parseAmount(text) {
  if (text === null || text === undefined) return null;
  let s = String(text).trim().replace(/€|eur/gi, "").replace(/[\s  ']/g, "");
  if (s === "") return null;
  let sign = 1;
  if (s[0] === "-") { sign = -1; s = s.slice(1); } else if (s[0] === "+") { s = s.slice(1); }
  if (!/^[0-9.,]+$/.test(s) || !/[0-9]/.test(s)) return null;

  const lastDot = s.lastIndexOf(".");
  const lastComma = s.lastIndexOf(",");
  let decimalSep = null;
  if (lastDot >= 0 && lastComma >= 0) {
    decimalSep = lastDot > lastComma ? "." : ",";
  } else {
    const sep = lastDot >= 0 ? "." : (lastComma >= 0 ? "," : null);
    if (sep) {
      const count = s.split(sep).length - 1;
      const digitsAfter = s.length - s.lastIndexOf(sep) - 1;
      // One separator that is not followed by exactly three digits is a decimal mark ("1,5", "58.00").
      // "58.000" and "58,000" are thousands, which is what a salary field almost always means.
      if (count === 1 && digitsAfter !== 3) decimalSep = sep;
    }
  }

  let whole = s;
  let fraction = "";
  if (decimalSep) {
    const i = s.lastIndexOf(decimalSep);
    whole = s.slice(0, i);
    fraction = s.slice(i + 1);
  }
  if (!/^[0-9]*$/.test(fraction)) return null;
  const groups = whole.split(/[.,]/);
  if (groups.length > 1) {
    if (new Set(whole.replace(/[0-9]/g, "")).size > 1) return null;
    if (!/^[0-9]{1,3}$/.test(groups[0]) || groups.slice(1).some((g) => !/^[0-9]{3}$/.test(g))) return null;
  }
  const digits = groups.join("");
  if (digits === "" && fraction === "") return null;
  const value = Number((digits || "0") + (fraction ? "." + fraction : ""));
  return Number.isFinite(value) ? sign * value : null;
}
