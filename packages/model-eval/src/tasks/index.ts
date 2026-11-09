import type { Difficulty, EvalTask } from "../types.ts";

const t = (id: string, title: string, difficulty: Difficulty, fn: string, prompt: string, reference: string, test: string, diffLines: number): EvalTask => ({
  id, title, difficulty, reference, test: `import test from "node:test";\nimport assert from "node:assert/strict";\nimport { ${fn} } from "./solution.mjs";\n${test}\n`,
  prompt: `Write an ES module \`solution.mjs\` that exports \`${fn}\`.\n\n${prompt}\n\nReply with the complete file in one code block.`,
  contract: { goal: title, filesAllowed: ["solution.mjs"], testCommand: "node --test", expectedDiffLines: diffLines },
});

/** makeLabel is reconstructed from its name: the original task text is not in this repository (see SYNTH, known gaps). */
export const TASKS: EvalTask[] = [
  t("make-label", "makeLabel: a short display label", "easy", "makeLabel",
    "`makeLabel(text, maxLen)` trims the text, collapses runs of whitespace to one space, and if the result is longer than `maxLen` cuts it to `maxLen - 1` characters and appends \"…\" (one character). Throws a RangeError when `maxLen` is less than 1.",
    `export function makeLabel(text, maxLen) {
  if (maxLen < 1) throw new RangeError("maxLen must be at least 1");
  const s = String(text).trim().replace(/\\s+/g, " ");
  return s.length > maxLen ? s.slice(0, maxLen - 1) + "…" : s;
}`,
    `test("trims and collapses", () => assert.equal(makeLabel("  a   b \\n c ", 20), "a b c"));
test("truncates with an ellipsis", () => assert.equal(makeLabel("abcdefghij", 5), "abcd…"));
test("keeps a label that fits exactly", () => assert.equal(makeLabel("abcde", 5), "abcde"));
test("maxLen 1", () => assert.equal(makeLabel("xyz", 1), "…"));
test("rejects maxLen below 1", () => assert.throws(() => makeLabel("a", 0), RangeError));`, 8),

  t("clamp", "clamp a number into a range", "easy", "clamp",
    "`clamp(n, min, max)` returns `n` limited to the range. Throws a RangeError when `min > max`.",
    `export function clamp(n, min, max) {
  if (min > max) throw new RangeError("min > max");
  return Math.min(max, Math.max(min, n));
}`,
    `test("inside", () => assert.equal(clamp(5, 0, 10), 5));
test("below", () => assert.equal(clamp(-5, 0, 10), 0));
test("above", () => assert.equal(clamp(50, 0, 10), 10));
test("equal bounds", () => assert.equal(clamp(3, 4, 4), 4));
test("bad range", () => assert.throws(() => clamp(1, 5, 2), RangeError));`, 6),

  t("slugify", "slugify a title", "easy", "slugify",
    "`slugify(s)` lowercases, replaces every run of characters that are not a-z or 0-9 with a single `-`, and removes leading and trailing `-`.",
    `export const slugify = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");`,
    `test("basic", () => assert.equal(slugify("Hello, World!"), "hello-world"));
test("runs", () => assert.equal(slugify("  a --- b  "), "a-b"));
test("digits", () => assert.equal(slugify("Top 10 Tips"), "top-10-tips"));
test("empty", () => assert.equal(slugify("***"), ""));`, 5),

  t("chunk", "split an array into chunks", "easy", "chunk",
    "`chunk(arr, size)` splits an array into arrays of at most `size` items, in order. Throws a RangeError unless `size` is a positive integer.",
    `export function chunk(arr, size) {
  if (!Number.isInteger(size) || size < 1) throw new RangeError("size must be a positive integer");
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}`,
    `test("even", () => assert.deepEqual(chunk([1, 2, 3, 4], 2), [[1, 2], [3, 4]]));
test("remainder", () => assert.deepEqual(chunk([1, 2, 3], 2), [[1, 2], [3]]));
test("empty", () => assert.deepEqual(chunk([], 3), []));
test("bad size", () => { assert.throws(() => chunk([1], 0), RangeError); assert.throws(() => chunk([1], 1.5), RangeError); });`, 8),

  t("camel-to-snake", "camelCase to snake_case", "easy", "camelToSnake",
    "`camelToSnake(s)` converts camelCase or PascalCase to snake_case: a lowercase underscore before each capital letter that follows a lowercase letter or digit, then everything lowercased.",
    `export const camelToSnake = (s) => s.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();`,
    `test("camel", () => assert.equal(camelToSnake("userFirstName"), "user_first_name"));
test("pascal", () => assert.equal(camelToSnake("UserName"), "user_name"));
test("digits", () => assert.equal(camelToSnake("item2Name"), "item2_name"));
test("already snake", () => assert.equal(camelToSnake("a_b"), "a_b"));`, 4),

  t("group-by", "group items by a key function", "easy", "groupBy",
    "`groupBy(items, keyFn)` returns a plain object whose keys are `keyFn(item)` and whose values are arrays of the items with that key, in original order.",
    `export function groupBy(items, keyFn) {
  const out = {};
  for (const it of items) (out[keyFn(it)] ??= []).push(it);
  return out;
}`,
    `test("groups", () => assert.deepEqual(groupBy([1, 2, 3, 4, 5], (n) => (n % 2 ? "odd" : "even")), { odd: [1, 3, 5], even: [2, 4] }));
test("empty", () => assert.deepEqual(groupBy([], String), {}));
test("order kept", () => assert.deepEqual(groupBy(["b1", "a1", "b2"], (s) => s[0]).b, ["b1", "b2"]));`, 7),

  t("dedupe-by", "remove duplicates by key", "easy", "dedupeBy",
    "`dedupeBy(items, keyFn)` returns the items with duplicates removed, where two items are duplicates when `keyFn` returns the same value. The first of each is kept; order is preserved.",
    `export function dedupeBy(items, keyFn) {
  const seen = new Set();
  return items.filter((it) => { const k = keyFn(it); if (seen.has(k)) return false; seen.add(k); return true; });
}`,
    `test("first wins", () => assert.deepEqual(dedupeBy([{ id: 1, v: "a" }, { id: 1, v: "b" }, { id: 2, v: "c" }], (x) => x.id), [{ id: 1, v: "a" }, { id: 2, v: "c" }]));
test("none", () => assert.deepEqual(dedupeBy([], (x) => x), []));
test("order", () => assert.deepEqual(dedupeBy([3, 1, 3, 2, 1], (x) => x), [3, 1, 2]));`, 7),

  t("format-bytes", "format a byte count", "medium", "formatBytes",
    "`formatBytes(n)` formats a non-negative integer with units B, KB, MB, GB (1024 steps). Bytes have no decimals (`512 B`); larger units show one decimal, but a trailing `.0` is dropped (`1 KB`, `1.5 KB`). Throws a RangeError for negative or non-integer input. Anything of a GB or more is shown in GB.",
    `export function formatBytes(n) {
  if (!Number.isInteger(n) || n < 0) throw new RangeError("n must be a non-negative integer");
  const units = ["B", "KB", "MB", "GB"];
  let i = 0, v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return i === 0 ? \`\${n} B\` : \`\${String(Math.round(v * 10) / 10)} \${units[i]}\`;
}`,
    `test("bytes", () => assert.equal(formatBytes(512), "512 B"));
test("zero", () => assert.equal(formatBytes(0), "0 B"));
test("kb", () => assert.equal(formatBytes(1024), "1 KB"));
test("fraction", () => assert.equal(formatBytes(1536), "1.5 KB"));
test("mb", () => assert.equal(formatBytes(5 * 1024 * 1024), "5 MB"));
test("gb and beyond", () => assert.equal(formatBytes(2048 * 1024 * 1024), "2 GB"));
test("big gb", () => assert.equal(formatBytes(5000 * 1024 * 1024 * 1024), "5000 GB"));
test("bad", () => { assert.throws(() => formatBytes(-1), RangeError); assert.throws(() => formatBytes(1.5), RangeError); });`, 14),

  t("range-summary", "summarize sorted integers as ranges", "medium", "rangeSummary",
    "`rangeSummary(nums)` takes a sorted array of unique integers and returns a comma-separated string where runs of three or more consecutive numbers become `a-b`, and shorter runs stay as single numbers (`[1,2,3,5,7,8]` gives `1-3,5,7,8`). An empty array gives an empty string.",
    `export function rangeSummary(nums) {
  const out = [];
  for (let i = 0; i < nums.length; ) {
    let j = i;
    while (j + 1 < nums.length && nums[j + 1] === nums[j] + 1) j++;
    if (j - i >= 2) out.push(\`\${nums[i]}-\${nums[j]}\`);
    else for (let k = i; k <= j; k++) out.push(String(nums[k]));
    i = j + 1;
  }
  return out.join(",");
}`,
    `test("mixed", () => assert.equal(rangeSummary([1, 2, 3, 5, 7, 8]), "1-3,5,7,8"));
test("empty", () => assert.equal(rangeSummary([]), ""));
test("single", () => assert.equal(rangeSummary([4]), "4"));
test("all one run", () => assert.equal(rangeSummary([1, 2, 3, 4, 5]), "1-5"));
test("pair stays", () => assert.equal(rangeSummary([1, 2]), "1,2"));
test("negatives", () => assert.equal(rangeSummary([-2, -1, 0, 4]), "-2-0,4"));`, 18),

  t("roman-to-int", "roman numerals to integer", "medium", "romanToInt",
    "`romanToInt(s)` converts a valid Roman numeral (I V X L C D M, with subtractive pairs like IV and CM) to an integer.",
    `export function romanToInt(s) {
  const v = { I: 1, V: 5, X: 10, L: 50, C: 100, D: 500, M: 1000 };
  let total = 0;
  for (let i = 0; i < s.length; i++) total += v[s[i]] < (v[s[i + 1]] ?? 0) ? -v[s[i]] : v[s[i]];
  return total;
}`,
    `test("simple", () => assert.equal(romanToInt("III"), 3));
test("subtractive", () => assert.equal(romanToInt("IV"), 4));
test("nine", () => assert.equal(romanToInt("IX"), 9));
test("lviii", () => assert.equal(romanToInt("LVIII"), 58));
test("mcmxciv", () => assert.equal(romanToInt("MCMXCIV"), 1994));`, 12),

  t("deep-get", "read a nested path", "medium", "deepGet",
    "`deepGet(obj, path, fallback)` reads a nested value by a path like `a.b[0].c`. Returns `fallback` when any step is missing (null or undefined along the way), but returns a stored `null`, `0` or `false` as is.",
    `export function deepGet(obj, path, fallback) {
  const keys = path.replace(/\\[(\\d+)\\]/g, ".$1").split(".").filter(Boolean);
  let cur = obj;
  for (const k of keys) {
    if (cur === null || cur === undefined || !(k in Object(cur))) return fallback;
    cur = cur[k];
  }
  return cur === undefined ? fallback : cur;
}`,
    `test("nested", () => assert.equal(deepGet({ a: { b: { c: 1 } } }, "a.b.c"), 1));
test("array index", () => assert.equal(deepGet({ a: [{ c: "x" }] }, "a[0].c"), "x"));
test("missing", () => assert.equal(deepGet({ a: 1 }, "a.b.c", "d"), "d"));
test("falsy values kept", () => { assert.equal(deepGet({ a: 0 }, "a", 9), 0); assert.equal(deepGet({ a: false }, "a", 9), false); assert.equal(deepGet({ a: null }, "a", 9), null); });
test("null in the middle", () => assert.equal(deepGet({ a: null }, "a.b", "f"), "f"));`, 14),

  t("truncate-middle", "shorten text in the middle", "medium", "truncateMiddle",
    "`truncateMiddle(s, max)` returns `s` unchanged if it is at most `max` long. Otherwise it keeps the start and the end and puts one `…` between, for a total of exactly `max` characters; when the kept length is odd the start gets the extra character. Throws a RangeError if `max < 3`.",
    `export function truncateMiddle(s, max) {
  if (max < 3) throw new RangeError("max must be at least 3");
  if (s.length <= max) return s;
  const keep = max - 1, head = Math.ceil(keep / 2), tail = Math.floor(keep / 2);
  return s.slice(0, head) + "…" + (tail ? s.slice(s.length - tail) : "");
}`,
    `test("short stays", () => assert.equal(truncateMiddle("abc", 5), "abc"));
test("even keep", () => assert.equal(truncateMiddle("abcdefghij", 5), "ab…ij"));
test("odd keep", () => assert.equal(truncateMiddle("abcdefghij", 6), "abc…ij"));
test("exact", () => assert.equal(truncateMiddle("abcde", 5), "abcde"));
test("min", () => assert.equal(truncateMiddle("abcdef", 3), "a…f"));
test("too small", () => assert.throws(() => truncateMiddle("abc", 2), RangeError));`, 12),

  t("is-balanced", "balanced brackets", "medium", "isBalanced",
    "`isBalanced(s)` returns true when every `(`, `[` and `{` in the string is closed by the matching bracket in the right order. Other characters are ignored. An empty string is balanced.",
    `export function isBalanced(s) {
  const pairs = { ")": "(", "]": "[", "}": "{" };
  const stack = [];
  for (const ch of s) {
    if ("([{".includes(ch)) stack.push(ch);
    else if (ch in pairs && stack.pop() !== pairs[ch]) return false;
  }
  return stack.length === 0;
}`,
    `test("ok", () => assert.equal(isBalanced("a(b[c]{d})"), true));
test("empty", () => assert.equal(isBalanced(""), true));
test("wrong order", () => assert.equal(isBalanced("([)]"), false));
test("unclosed", () => assert.equal(isBalanced("(("), false));
test("extra closer", () => assert.equal(isBalanced("())"), false));
test("closer first", () => assert.equal(isBalanced(")("), false));`, 12),

  t("parse-csv-line", "parse one CSV line", "hard", "parseCsvLine",
    "`parseCsvLine(line)` splits one CSV line into fields. Fields are separated by commas. A field may be wrapped in double quotes, in which case it may contain commas, and `\"\"` inside quotes means one `\"`. Unquoted fields are kept as is (not trimmed). An empty line gives `[\"\"]`.",
    `export function parseCsvLine(line) {
  const out = [];
  let cur = "", q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) {
      if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; }
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ",") { out.push(cur); cur = ""; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}`,
    `test("plain", () => assert.deepEqual(parseCsvLine("a,b,c"), ["a", "b", "c"]));
test("quoted comma", () => assert.deepEqual(parseCsvLine('a,"b,c",d'), ["a", "b,c", "d"]));
test("escaped quote", () => assert.deepEqual(parseCsvLine('"say ""hi""",x'), ['say "hi"', "x"]));
test("empty fields", () => assert.deepEqual(parseCsvLine(",,"), ["", "", ""]));
test("empty line", () => assert.deepEqual(parseCsvLine(""), [""]));
test("spaces kept", () => assert.deepEqual(parseCsvLine(" a , b"), [" a ", " b"]));
test("quoted empty", () => assert.deepEqual(parseCsvLine('"",a'), ["", "a"]));`, 25),

  t("semver-compare", "compare semantic versions", "hard", "semverCompare",
    "`semverCompare(a, b)` compares two semantic version strings (`1.2.3`, `1.0.0-alpha.1`) and returns -1, 0 or 1. Numeric parts compare as numbers. A version with a prerelease is lower than the same version without one. Prerelease identifiers compare left to right: numeric ones as numbers, text ones as strings, a numeric identifier is lower than a text one, and a shorter list is lower when all earlier identifiers are equal. Build metadata (`+...`) is ignored.",
    `export function semverCompare(a, b) {
  const parse = (v) => { const [core, pre] = v.split("+")[0].split(/-(.*)/s); return { n: core.split(".").map(Number), pre: pre ? pre.split(".") : [] }; };
  const x = parse(a), y = parse(b);
  for (let i = 0; i < 3; i++) if (x.n[i] !== y.n[i]) return x.n[i] < y.n[i] ? -1 : 1;
  if (!x.pre.length || !y.pre.length) return x.pre.length === y.pre.length ? 0 : x.pre.length ? -1 : 1;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i], q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    const pn = /^\\d+$/.test(p), qn = /^\\d+$/.test(q);
    if (pn && qn) { if (+p !== +q) return +p < +q ? -1 : 1; }
    else if (pn !== qn) return pn ? -1 : 1;
    else if (p !== q) return p < q ? -1 : 1;
  }
  return 0;
}`,
    `test("equal", () => assert.equal(semverCompare("1.2.3", "1.2.3"), 0));
test("numeric not text", () => assert.equal(semverCompare("1.10.0", "1.9.0"), 1));
test("major", () => assert.equal(semverCompare("1.0.0", "2.0.0"), -1));
test("prerelease lower", () => assert.equal(semverCompare("1.0.0-alpha", "1.0.0"), -1));
test("prerelease order", () => assert.equal(semverCompare("1.0.0-alpha.1", "1.0.0-alpha.beta"), -1));
test("numeric ids", () => assert.equal(semverCompare("1.0.0-rc.11", "1.0.0-rc.2"), 1));
test("shorter lower", () => assert.equal(semverCompare("1.0.0-alpha", "1.0.0-alpha.1"), -1));
test("build ignored", () => assert.equal(semverCompare("1.0.0+a", "1.0.0+b"), 0));
test("symmetry", () => assert.equal(semverCompare("1.0.0", "1.0.0-alpha"), 1));`, 30),

  t("lru-cache", "a small LRU cache", "hard", "LRUCache",
    "Export a class `LRUCache` with `constructor(capacity)`, `get(key)` (returns undefined when missing, and marks the key as most recently used), `set(key, value)` (adds or updates, marks as most recently used, and evicts the least recently used key when over capacity) and a `size` getter. Throws a RangeError unless capacity is a positive integer.",
    `export class LRUCache {
  #cap; #map = new Map();
  constructor(capacity) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new RangeError("capacity must be a positive integer");
    this.#cap = capacity;
  }
  get size() { return this.#map.size; }
  get(key) {
    if (!this.#map.has(key)) return undefined;
    const v = this.#map.get(key);
    this.#map.delete(key); this.#map.set(key, v);
    return v;
  }
  set(key, value) {
    this.#map.delete(key); this.#map.set(key, value);
    if (this.#map.size > this.#cap) this.#map.delete(this.#map.keys().next().value);
  }
}`,
    `test("stores and reads", () => { const c = new LRUCache(2); c.set("a", 1); assert.equal(c.get("a"), 1); assert.equal(c.get("zz"), undefined); });
test("evicts least recently used", () => { const c = new LRUCache(2); c.set("a", 1); c.set("b", 2); c.set("c", 3); assert.equal(c.get("a"), undefined); assert.equal(c.size, 2); });
test("get refreshes", () => { const c = new LRUCache(2); c.set("a", 1); c.set("b", 2); c.get("a"); c.set("c", 3); assert.equal(c.get("b"), undefined); assert.equal(c.get("a"), 1); });
test("set refreshes and updates", () => { const c = new LRUCache(2); c.set("a", 1); c.set("b", 2); c.set("a", 9); c.set("c", 3); assert.equal(c.get("a"), 9); assert.equal(c.get("b"), undefined); assert.equal(c.size, 2); });
test("falsy values are stored", () => { const c = new LRUCache(1); c.set("a", 0); assert.equal(c.get("a"), 0); });
test("bad capacity", () => { assert.throws(() => new LRUCache(0), RangeError); assert.throws(() => new LRUCache(1.5), RangeError); });`, 30),
];
