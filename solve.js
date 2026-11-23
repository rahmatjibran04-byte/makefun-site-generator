// solve.js — a fast, dependency-free re-implementation of makefun-site 1.0.0's
// build(input), written from the behavioural specification (SPEC.md).
//
// The module answers one case: run(input) returns the output tree
// { outputPath: text } exactly as the reference generator would.  It uses only
// the Node 22 standard library, no WASM, no native add-ons, no external imports.
//
// Design notes (all behaviour-preserving):
//  - Markdown inline rendering works on whole plain-text runs: characters are
//    scanned with charCodeAt/indexOf and escaped in bulk, instead of one regex
//    replacement per character.
//  - Templates are parsed once per case into small node trees.  Rendering writes
//    into arrays that are joined once, and an include whose template only reads
//    values that are already fixed for a given scope is rendered once and its
//    string reused (memoised on the resolved values of its free variables plus
//    the include depth, which is the whole render state).
//  - slugify / longDate results are memoised per case; the slug fast path skips
//    Unicode normalisation for pure-ASCII input.
//  - The Markdown lexer uses direct character tests instead of a regex per line.

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

const RESERVED_DIRS = ['posts', 'tags', 'page'];

/** Code-unit order (never the locale's). */
const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// ------------------------------------------------------------------ text helpers

const ESCAPE_RE = /[&<>"']/g;

/** `text` with & < > " and ' escaped (one pass, each hit rewritten by kind). */
function escapeHtml(text) {
  return text.replace(ESCAPE_RE, (hit) => {
    switch (hit) {
      case '&': return '&amp;';
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '"': return '&quot;';
      default: return '&#39;';
    }
  });
}

/** A YYYY-MM-DD date in words, from the string alone. */
function longDate(date) {
  const y = date.slice(0, 4);
  const m = date.slice(5, 7);
  const d = date.slice(8, 10);
  return `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}`;
}

const MARK_RE = /\p{M}/gu;

/**
 * The slug of `text`: NFKD, combining marks dropped, A-Z lowered, every run of
 * characters other than a-z and 0-9 one "-", none at either end, at most 64
 * characters (a "-" left at the cut dropped), and "untitled" when nothing is left.
 */
function slugifyRaw(text) {
  let s = text;
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) >= 128) {
      s = text.normalize('NFKD').replace(MARK_RE, '');
      break;
    }
  }
  let out = '';
  let gap = false;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    let keep = -1;
    if (c >= 65 && c <= 90) keep = c + 32;
    else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) keep = c;
    if (keep < 0) {
      if (out.length > 0) gap = true;
      continue;
    }
    if (gap) {
      out += '-';
      gap = false;
    }
    out += String.fromCharCode(keep);
  }
  if (out.length > 64) out = out.slice(0, 64);
  let end = out.length;
  while (end > 0 && out.charCodeAt(end - 1) === 45) end--;
  if (end < out.length) out = out.slice(0, end);
  return out === '' ? 'untitled' : out;
}

/** `slug` made unique against `taken` (and added to it). */
function uniqueSlug(slug, taken) {
  let candidate = slug;
  let suffix = 2;
  while (taken.has(candidate)) {
    candidate = `${slug}-${suffix}`;
    suffix += 1;
  }
  taken.add(candidate);
  return candidate;
}

/** The words of a body: its runs of characters other than whitespace. */
function wordsOf(text) {
  let count = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    // Whitespace below 128 is exactly tab, LF, VT, FF, CR and space; above it
    // the real \s class decides (rare path, one regex test per character).
    const ws = c < 128 ? c === 32 || (c >= 9 && c <= 13) : WS_RE.test(text[i]);
    if (ws) inWord = false;
    else if (!inWord) {
      inWord = true;
      count++;
    }
  }
  return count;
}

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/** `rel` (a link's path, "/"-separated) from the directory `dir`, or null when it climbs out of the root. */
function resolvePath(dir, rel) {
  // Collect the directory's segments by scanning for '/' separators by hand,
  // then walk the relative path segment by segment the same way.
  const parts = [];
  if (dir !== '') {
    let start = 0;
    for (;;) {
      const cut = dir.indexOf('/', start);
      parts.push(cut === -1 ? dir.slice(start) : dir.slice(start, cut));
      if (cut === -1) break;
      start = cut + 1;
    }
  }
  let pos = 0;
  for (;;) {
    const cut = rel.indexOf('/', pos);
    const seg = cut === -1 ? rel.slice(pos) : rel.slice(pos, cut);
    const len = seg.length;
    if (len === 1 && seg === '.') {
      // skip
    } else if (len === 2 && seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else if (len > 0) {
      parts.push(seg);
    }
    if (cut === -1) break;
    pos = cut + 1;
  }
  return parts.join('/');
}

// ------------------------------------------------------------------ front matter

const FM_KEYS = new Set(['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary']);
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const NAME_RE = /^[a-z0-9-]+$/;
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TAG_RE = /^[^"[\]]+$/;

/** The days of month `m` (1-12) of year `y`, by the Gregorian rule. */
function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** A quoted string value (raw starts with '"'): its unescaped content, or why it is refused. */
function quotedValue(raw) {
  if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) {
    return { error: 'a quoted string is not closed' };
  }
  let acc = '';
  let p = 1;
  const last = raw.length - 1;
  while (p < last) {
    const ch = raw[p];
    if (ch === '\\') {
      const nxt = raw[p + 1];
      const badEscape = (nxt !== '"' && nxt !== '\\') || p + 1 === last;
      if (badEscape) {
        return { error: 'a quoted string holds an escape other than \\" or \\\\' };
      }
      acc += nxt;
      p += 2;
    } else if (ch === '"') {
      return { error: 'a quoted string holds a stray quote' };
    } else {
      acc += ch;
      p += 1;
    }
  }
  return { value: acc };
}

/** A string value: "..." with \" and \\ its only escapes, or bare (never opening on " or [). */
function stringValue(raw) {
  if (raw.charCodeAt(0) === 34) return quotedValue(raw);
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' };
  return { value: raw };
}

/** One key's value, or why it is refused. */
function valueOfKey(key, raw) {
  if (key === 'title' || key === 'summary') {
    const parsed = stringValue(raw);
    if ('error' in parsed) return { error: `key "${key}": ${parsed.error}` };
    return parsed;
  }
  if (key === 'date') {
    const found = DATE_RE.exec(raw);
    let ok = false;
    if (found !== null) {
      const year = Number(found[1]);
      const month = Number(found[2]);
      const day = Number(found[3]);
      ok = year >= 1970 && year <= 2099 && month >= 1 && month <= 12 && day >= 1 && day <= daysIn(year, month);
    }
    if (!ok) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
    return { value: raw };
  }
  if (key === 'tags') {
    if (raw.charCodeAt(0) !== 91 || raw.charCodeAt(raw.length - 1) !== 93) {
      return { error: 'key "tags": not a list [a, b]' };
    }
    const inside = raw.slice(1, -1);
    if (inside.trim() === '') return { value: [] };
    const cleaned = [];
    for (const piece of inside.split(',')) {
      const tag = piece.trim();
      if (tag === '' || !TAG_RE.test(tag)) {
        return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      }
      cleaned.push(tag);
    }
    return { value: cleaned };
  }
  if (key === 'draft') {
    if (raw === 'true') return { value: true };
    if (raw === 'false') return { value: false };
    return { error: 'key "draft": true or false' };
  }
  if (key === 'layout') {
    return NAME_RE.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
  }
  if (key === 'slug') {
    const valid = SLUG_RE.test(raw) && raw.length <= 64;
    return valid ? { value: raw } : { error: 'key "slug": not a slug' };
  }
  return { error: `unknown key "${key}"` };
}

/** Whether a line holds only spaces and tabs. */
function isBlank(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/**
 * A "key: value" line split into [key, raw] (raw with trailing spaces/tabs
 * dropped), or null when the line is not of that shape.  The key is [a-z_]+,
 * the colon follows at once, and after it comes either nothing or one space
 * plus the rest of the line.
 */
function splitKeyValue(line) {
  let k = 0;
  while (k < line.length) {
    const c = line.charCodeAt(k);
    if ((c >= 97 && c <= 122) || c === 95) k++;
    else break;
  }
  if (k === 0 || line.charCodeAt(k) !== 58) return null;
  const key = line.slice(0, k);
  let raw;
  if (k + 1 === line.length) raw = '';
  else if (line.charCodeAt(k + 1) === 32) raw = line.slice(k + 2);
  else return null;
  let e = raw.length;
  while (e > 0 && (raw.charCodeAt(e - 1) === 32 || raw.charCodeAt(e - 1) === 9)) e--;
  if (e < raw.length) raw = raw.slice(0, e);
  return [key, raw];
}

/**
 * A source's front matter and body: { data, body }, or { error } with the first
 * reason it is refused.  `text` has "\n" line ends.  Lines are walked with
 * indexOf, so the body is never split and re-joined: it is the slice after
 * the closing line.
 */
function parseFrontMatter(text) {
  if (text !== '---' && !text.startsWith('---\n')) return { error: 'no front matter' };
  const data = {};
  let pos = 4;
  let lineNo = 1;
  while (true) {
    if (pos > text.length) return { error: 'the front matter is not closed' };
    const nl = text.indexOf('\n', pos);
    const line = nl === -1 ? text.slice(pos) : text.slice(pos, nl);
    const next = nl === -1 ? text.length + 1 : nl + 1;
    lineNo++;
    if (line === '---') {
      if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
      return { data, body: next > text.length ? '' : text.slice(next) };
    }
    if (isBlank(line) || line.charCodeAt(0) === 35) {
      pos = next;
      continue;
    }
    const kv = splitKeyValue(line);
    if (kv === null) return { error: `line ${lineNo} is not "key: value"` };
    const key = kv[0];
    const raw = kv[1];
    if (!FM_KEYS.has(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = valueOfKey(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
    pos = next;
  }
}

// ------------------------------------------------------------------ Markdown

/** Whether a character code is a fence language character (A-Z a-z 0-9 _ + -). */
function isLangChar(c) {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45;
}

/** A fence opening line's language, or null when the line is not a fence opening. */
function fenceLang(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return null;
  let i = 3;
  while (i < line.length && isLangChar(line.charCodeAt(i))) i++;
  const lang = line.slice(3, i);
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return null;
    i++;
  }
  return lang;
}

/** Whether a line closes a fence: three backticks plus only spaces/tabs. */
function isFenceClose(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return false;
  for (let i = 3; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A heading line's level and text, or null (a heading's text is never empty). */
function headingOf(line) {
  let n = 0;
  while (n < line.length && line.charCodeAt(n) === 35) n++;
  if (n === 0 || n > 6) return null;
  let i = n;
  let sp = 0;
  while (i < line.length && (line.charCodeAt(i) === 32 || line.charCodeAt(i) === 9)) {
    i++;
    sp++;
  }
  if (sp === 0) return null;
  let e = line.length;
  while (e > i && (line.charCodeAt(e - 1) === 32 || line.charCodeAt(e - 1) === 9)) e--;
  if (e === i) return null;
  return { depth: n, text: line.slice(i, e) };
}

/** Whether a line is a thematic break: --- or *** plus only spaces/tabs. */
function isHr(line) {
  const c0 = line.charCodeAt(0);
  if (c0 !== 45 && c0 !== 42) return false;
  if (line.charCodeAt(1) !== c0 || line.charCodeAt(2) !== c0) return false;
  for (let i = 3; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A line with spaces and tabs at either end dropped. */
function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  return a === 0 && b === line.length ? line : line.slice(a, b);
}

/** A bullet marker's item text (after "- " or "* "), or null. */
function bulletText(line) {
  const c = line.charCodeAt(0);
  if ((c === 45 || c === 42) && line.charCodeAt(1) === 32) return line.slice(2);
  return null;
}

/** An ordered marker: { num, text } after "N. ", or null (N is 1-9 digits). */
function orderedOf(line) {
  let d = 0;
  while (d < line.length && line.charCodeAt(d) >= 48 && line.charCodeAt(d) <= 57) d++;
  if (d === 0 || d > 9) return null;
  if (line.charCodeAt(d) !== 46 || line.charCodeAt(d + 1) !== 32) return null;
  return { num: line.slice(0, d), text: line.slice(d + 2) };
}

const WS1_RE = /\s/;

/** Whether a line continues a list item: 2+ spaces, then a non-whitespace character. */
function isContinued(line) {
  let j = 0;
  while (j < line.length && line.charCodeAt(j) === 32) j++;
  return j >= 2 && j < line.length && !WS1_RE.test(line[j]);
}

/** Whether `line` ends a paragraph: a blank line, a fence, a heading or a thematic break. */
function endsParagraph(line) {
  // Only the first character can decide: a fence opens on `, a heading on #,
  // a break on - or *, and a blank line is empty or opens on a space/tab.
  const c0 = line.length === 0 ? -1 : line.charCodeAt(0);
  if (c0 === 96) return fenceLang(line) !== null;
  if (c0 === 35) return headingOf(line) !== null;
  if (c0 === 45 || c0 === 42) return isHr(line);
  if (c0 === -1 || c0 === 32 || c0 === 9) return isBlank(line);
  return false;
}

/** The characters a backslash escapes, as a lookup table over character codes. */
const ESCAPABLE_TAB = new Uint8Array(128);
for (const ch of '\\`_*[]()#+-.!>') ESCAPABLE_TAB[ch.charCodeAt(0)] = 1;

const WS_RE = /\s/;

/**
 * The first index from `from` where `s` holds `what` outside a backslash escape,
 * or -1.  A candidate is escaped exactly when an odd run of backslashes stands
 * immediately before it (escapes pair up left to right, and both `**` and `]`
 * are escapable, so the run's parity decides).
 */
function findUnescaped(s, what, from) {
  let k = s.indexOf(what, from);
  while (k !== -1) {
    let b = k - 1;
    let n = 0;
    while (b >= from && s.charCodeAt(b) === 92) {
      n++;
      b--;
    }
    if (n % 2 === 0) return k;
    k = s.indexOf(what, k + 1);
  }
  return -1;
}

/** Scan for a lone `*` at or after `from`: one that is not escaped and not part of a `**` pair; -1 when there is none. */
function findSingleStar(s, from) {
  let j = from;
  while (j < s.length) {
    const k = s.indexOf('*', j);
    if (k === -1) return -1;
    let b = k - 1;
    let n = 0;
    while (b >= from && s.charCodeAt(b) === 92) {
      n++;
      b--;
    }
    if (n % 2 === 1) {
      j = k + 1;
      continue;
    }
    if (s.charCodeAt(k + 1) === 42) {
      j = k + 2;
      continue;
    }
    return k;
  }
  return -1;
}

/** The characters escapeHtml rewrites, as a lookup table over character codes. */
const HTML_ESC_TAB = new Uint8Array(128);
for (const ch of '&<>"\'') HTML_ESC_TAB[ch.charCodeAt(0)] = 1;

const INLINE_CONSTRUCT_RE = /[\\`*\[]/;
const HTML_SPECIAL_RE = /[&<>"']/;

/**
 * `s` rendered inline; `link(target)` is a link's href.  A string holding no
 * construct opener is plain text: it is only escaped.  Otherwise plain-text
 * runs are escaped in bulk; constructs consume their span and render their
 * content recursively, exactly as the reference does.  While scanning, the loop
 * notes whether the pending run holds any character escapeHtml would rewrite,
 * so a clean run is pushed as-is instead of paying for a regex replacement.
 */
function inline(s, link) {
  if (!INLINE_CONSTRUCT_RE.test(s)) return HTML_SPECIAL_RE.test(s) ? escapeHtml(s) : s;
  const out = [];
  const n = s.length;
  let i = 0;
  let run = 0;
  let runEsc = false;
  const flush = (end) => {
    if (run < end) out.push(runEsc ? escapeHtml(s.slice(run, end)) : s.slice(run, end));
    runEsc = false;
  };
  while (i < n) {
    const c = s.charCodeAt(i);
    if (c === 92 && i + 1 < n) {
      const d = s.charCodeAt(i + 1);
      if (d < 128 && ESCAPABLE_TAB[d]) {
        flush(i);
        out.push(d === 62 ? '&gt;' : s[i + 1]);
        i += 2;
        run = i;
        continue;
      }
      i++;
      continue;
    }
    if (c === 96) {
      const j = s.indexOf('`', i + 1);
      if (j > i + 1) {
        flush(i);
        out.push(`<code>${escapeHtml(s.slice(i + 1, j))}</code>`);
        i = j + 1;
        run = i;
      } else {
        i++;
      }
      continue;
    }
    if (c === 42) {
      if (s.charCodeAt(i + 1) === 42) {
        const j = findUnescaped(s, '**', i + 2);
        if (j > i + 2) {
          flush(i);
          out.push(`<strong>${inline(s.slice(i + 2, j), link)}</strong>`);
          i = j + 2;
          run = i;
        } else {
          i += 2;
        }
      } else {
        const j = findSingleStar(s, i + 1);
        if (j > i + 1) {
          flush(i);
          out.push(`<em>${inline(s.slice(i + 1, j), link)}</em>`);
          i = j + 1;
          run = i;
        } else {
          i++;
        }
      }
      continue;
    }
    if (c === 91) {
      const k = findUnescaped(s, ']', i + 1);
      let m = -1;
      if (k !== -1 && s.charCodeAt(k + 1) === 40) m = s.indexOf(')', k + 2);
      if (m !== -1) {
        const target = s.slice(k + 2, m);
        if (target !== '' && !WS_RE.test(target)) {
          flush(i);
          out.push(`<a href="${escapeHtml(link(target))}">${inline(s.slice(i + 1, k), link)}</a>`);
          i = m + 1;
          run = i;
          continue;
        }
      }
      i++;
      continue;
    }
    if (HTML_ESC_TAB[c]) runEsc = true;
    i++;
  }
  flush(n);
  return out.join('');
}

/**
 * `src` rendered: its HTML (each block on its own line, a "\n" after the last),
 * its table of contents (every level 2 and 3 heading: level, id and its inline
 * HTML) and its excerpt (the first paragraph's inline HTML, or "").
 * `slugify` is the case's memoised slug function.
 */
function renderMarkdown(src, link, slugify) {
  const lines = src.split('\n');
  const ids = new Set();
  const blocks = [];
  const toc = [];
  let excerpt = null;
  let i = 0;
  const n = lines.length;
  // A paragraph starting at lines[i]: its lines, trimmed, joined with "\n".
  const doParagraph = () => {
    const body = [trimLine(lines[i])];
    i++;
    while (i < n && !endsParagraph(lines[i])) body.push(trimLine(lines[i++]));
    const html = inline(body.join('\n'), link);
    if (excerpt === null) excerpt = html;
    blocks.push(`<p>${html}</p>`);
  };
  while (i < n) {
    const line = lines[i];
    // A line opening on a space or tab (or empty) is blank or a paragraph
    // line: no other block can open there, so the full blank scan is only
    // needed for such lines.
    const c0 = line.length === 0 ? -1 : line.charCodeAt(0);
    if (c0 === -1 || c0 === 32 || c0 === 9) {
      if (isBlank(line)) {
        i++;
        continue;
      }
      doParagraph();
      continue;
    }
    const lang = c0 === 96 ? fenceLang(line) : null;
    if (lang !== null) {
      i++;
      const body = [];
      while (i < n && !isFenceClose(lines[i])) body.push(lines[i++]);
      i++;
      const cls = lang === '' ? '' : ` class="language-${escapeHtml(lang)}"`;
      const code = body.length === 0 ? '' : `${escapeHtml(body.join('\n'))}\n`;
      blocks.push(`<pre><code${cls}>${code}</code></pre>`);
      continue;
    }
    const h = c0 === 35 ? headingOf(line) : null;
    if (h !== null) {
      const id = uniqueSlug(slugify(h.text), ids);
      const html = inline(h.text, link);
      blocks.push(`<h${h.depth} id="${id}">${html}</h${h.depth}>`);
      if (h.depth === 2 || h.depth === 3) toc.push({ level: h.depth, id, html });
      i++;
      continue;
    }
    if ((c0 === 45 || c0 === 42) && isHr(line)) {
      blocks.push('<hr>');
      i++;
      continue;
    }
    if (c0 === 62) {
      const q = [];
      while (i < n && lines[i].charCodeAt(0) === 62) {
        let t = lines[i].slice(1);
        if (t.charCodeAt(0) === 32) t = t.slice(1);
        q.push(t);
        i++;
      }
      const kept = [];
      for (const l of q) {
        const t = trimLine(l);
        if (t !== '') kept.push(t);
      }
      blocks.push(kept.length === 0 ? '<blockquote>\n</blockquote>' : `<blockquote>\n<p>${inline(kept.join('\n'), link)}</p>\n</blockquote>`);
      continue;
    }
    // A bullet opens on - or *, an ordered marker on a digit; nothing else
    // can be a list here.
    const b = c0 === 45 || c0 === 42 ? bulletText(line) : null;
    const o = b === null && c0 >= 48 && c0 <= 57 ? orderedOf(line) : null;
    if (b !== null || o !== null) {
      const isOrdered = o !== null;
      const items = [];
      let start = 1;
      if (isOrdered) start = Number(o.num);
      while (i < n) {
        const cur = lines[i];
        if (isOrdered) {
          const m = orderedOf(cur);
          if (m !== null) {
            items.push([trimLine(m.text)]);
            i++;
            continue;
          }
        } else {
          const t = bulletText(cur);
          if (t !== null) {
            items.push([trimLine(t)]);
            i++;
            continue;
          }
        }
        if (isContinued(cur)) {
          items[items.length - 1].push(trimLine(cur));
          i++;
          continue;
        }
        break;
      }
      const tag = isOrdered ? 'ol' : 'ul';
      const open = isOrdered && start !== 1 ? `<ol start="${start}">` : `<${tag}>`;
      let s = `${open}\n`;
      for (const parts of items) s += `<li>${inline(parts.join('\n'), link)}</li>\n`;
      s += `</${tag}>`;
      blocks.push(s);
      continue;
    }
    doParagraph();
  }
  return { html: blocks.length === 0 ? '' : `${blocks.join('\n')}\n`, toc, excerpt: excerpt === null ? '' : excerpt };
}

// ------------------------------------------------------------------ templates

/** The deepest an include nests: one past it renders nothing. */
const INCLUDE_DEPTH = 8;

/** A template that does not parse: its name and why. */
class TemplateError extends Error {}

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;

/** The path `text` names, split at its dots, or a TemplateError. */
function splitPath(name, text) {
  if (!PATH_RE.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/**
 * `src`'s tokens: text, {{ }}, {{{ }}} and {% %}.  A {% %} tag alone on its
 * line (only spaces or tabs beside it) takes its whole line with it, its
 * newline included.
 */
function tokenizeTemplate(name, src) {
  const out = [];
  const pending = [];
  const n = src.length;
  let cursor = 0;
  const flushPending = () => {
    if (pending.length === 0) return;
    out.push({ t: 'text', text: pending.join('') });
    pending.length = 0;
  };
  // A [from, to) slice holding only spaces/tabs (or nothing at all).
  const onlyBlank = (from, to) => {
    for (let p = from; p < to; p++) {
      const code = src.charCodeAt(p);
      if (code !== 32 && code !== 9) return false;
    }
    return true;
  };
  while (cursor < n) {
    const brace = src.indexOf('{', cursor);
    if (brace === -1 || brace === n - 1) {
      pending.push(src.slice(cursor));
      cursor = n;
      break;
    }
    const second = src[brace + 1];
    if (second !== '{' && second !== '%') {
      pending.push(src.slice(cursor, brace + 1));
      cursor = brace + 1;
      continue;
    }
    pending.push(src.slice(cursor, brace));
    if (second === '{') {
      const triple = src.charCodeAt(brace + 2) === 123;
      const closer = triple ? '}}}' : '}}';
      const headLen = triple ? 3 : 2;
      const shut = src.indexOf(closer, brace + headLen);
      if (shut === -1) {
        throw new TemplateError(`template "${name}": a ${triple ? '{{{' : '{{'} is not closed`);
      }
      flushPending();
      const inner = src.slice(brace + headLen, shut).trim();
      out.push({ t: triple ? 'raw' : 'var', path: splitPath(name, inner) });
      cursor = shut + headLen;
      continue;
    }
    const shut = src.indexOf('%}', brace + 2);
    if (shut === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const afterTag = shut + 2;
    const rowStart = src.lastIndexOf('\n', brace - 1) + 1;
    const rowNl = src.indexOf('\n', afterTag);
    const rowEnd = rowNl === -1 ? n : rowNl;
    const alone = onlyBlank(rowStart, brace) && onlyBlank(afterTag, rowEnd);
    if (alone) {
      // Drop the whitespace that precedes the tag on its line: it was the
      // tail of the pending text just pushed above.
      const drop = brace - rowStart;
      const joined = pending.join('');
      pending.length = 0;
      const kept = joined.slice(0, joined.length - drop);
      if (kept !== '') pending.push(kept);
    }
    flushPending();
    out.push({ t: 'tag', tag: src.slice(brace + 2, shut).trim() });
    cursor = alone ? (rowNl === -1 ? n : rowNl + 1) : afterTag;
  }
  flushPending();
  return out;
}

/** `src` parsed into its tree of nodes (a TemplateError when it does not parse). */
function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenizeTemplate(name, src)) {
    if (tok.t === 'text') {
      body.push({ kind: 'text', text: tok.text });
      continue;
    }
    if (tok.t === 'var' || tok.t === 'raw') {
      body.push({ kind: tok.t, path: tok.path });
      continue;
    }
    const tag = tok.tag;
    const top = stack[stack.length - 1];
    let m;
    if ((m = FOR_RE.exec(tag)) !== null) {
      const node = { kind: 'for', name: m[1], path: splitPath(name, m[2]), body: [] };
      body.push(node);
      stack.push(node);
      body = node.body;
    } else if ((m = IF_RE.exec(tag)) !== null) {
      const node = { kind: 'if', not: m[1] !== undefined, path: splitPath(name, m[2]), then: [], else: null };
      body.push(node);
      stack.push(node);
      body = node.then;
    } else if (tag === 'else') {
      const open = stack[stack.length - 1];
      const misplaced = open.kind !== 'if' || open.else !== null;
      if (misplaced) throw new TemplateError(`template "${name}": an else outside an if`);
      open.else = [];
      body = open.else;
    } else if (tag === 'endfor' || tag === 'endif') {
      const wanted = tag === 'endfor' ? 'for' : 'if';
      if (top.kind !== wanted) {
        throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
      }
      stack.pop();
      const parent = stack[stack.length - 1];
      body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else !== null ? parent.else : parent.then;
    } else if ((m = INCLUDE_RE.exec(tag)) !== null) {
      body.push({ kind: 'include', name: m[1] });
    } else {
      throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) {
    const openKind = stack[stack.length - 1].kind;
    throw new TemplateError(`template "${name}": a ${openKind} is not closed`);
  }
  return root.body;
}

/**
 * A template's own free variables (first path segments it reads that no
 * enclosing `for` binds) and the templates it includes, collected from its
 * node tree.  `bound` holds the names bound by enclosing loops.
 */
function collectOwn(nodes, bound, own, inc) {
  for (const n of nodes) {
    if (n.kind === 'var' || n.kind === 'raw' || n.kind === 'if') {
      if (!bound.has(n.path[0])) own.add(n.path[0]);
    }
    if (n.kind === 'if') {
      collectOwn(n.then, bound, own, inc);
      if (n.else !== null) collectOwn(n.else, bound, own, inc);
    } else if (n.kind === 'for') {
      if (!bound.has(n.path[0])) own.add(n.path[0]);
      const inner = new Set(bound);
      inner.add(n.name);
      inner.add('loop');
      collectOwn(n.body, inner, own, inc);
    } else if (n.kind === 'include') {
      inc.add(n.name);
    }
  }
}

/**
 * Every parsed template's free variables: its own, plus those of every template
 * it (transitively) includes.  The include contribution ignores what the
 * including loops bind, which can only add names to the key, never drop one a
 * render could read — so a memoised render is never shared across different
 * inputs.
 */
function analyzeFreeVars(templates) {
  const includesOf = new Map();
  for (const [name, t] of templates) {
    const own = new Set();
    const inc = new Set();
    collectOwn(t.nodes, new Set(), own, inc);
    t.free = own;
    includesOf.set(name, inc);
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const [name, t] of templates) {
      for (const u of includesOf.get(name)) {
        const other = templates.get(u);
        if (other === undefined) continue;
        for (const v of other.free) {
          if (!t.free.has(v)) {
            t.free.add(v);
            changed = true;
          }
        }
      }
    }
  }
  for (const t of templates.values()) t.free = [...t.free].sort();
}

/** The value at `path` in the scope chain: its first name from the nearest scope holding it, then own properties. */
function lookup(scope, path) {
  let holder = null;
  for (let frame = scope; frame !== null; frame = frame.parent) {
    if (Object.hasOwn(frame.vars, path[0])) {
      holder = frame.vars;
      break;
    }
  }
  if (holder === null) return undefined;
  let current = holder[path[0]];
  for (let depth = 1; depth < path.length; depth++) {
    const key = path[depth];
    if (current === null || typeof current !== 'object') return undefined;
    if (!Object.hasOwn(current, key)) return undefined;
    current = current[key];
  }
  return current;
}

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
function textOf(v) {
  const kind = Array.isArray(v) ? 'array' : typeof v;
  switch (kind) {
    case 'string':
      return v;
    case 'number':
      return String(v);
    case 'boolean':
      return v ? 'true' : 'false';
    case 'array': {
      const pieces = new Array(v.length);
      for (let i = 0; i < v.length; i++) pieces[i] = textOf(v[i]);
      return pieces.join(', ');
    }
    default:
      return '';
  }
}

/** Whether a value counts as true in an if: not undefined, null, false, "", 0 or an empty array. */
function truthy(v) {
  if (v === undefined || v === null || v === false) return false;
  if (typeof v === 'string') return v.length !== 0;
  if (typeof v === 'number') return v !== 0;
  if (Array.isArray(v)) return v.length !== 0;
  return true;
}

/** A memoised render lookup: walk the trie of key parts, or undefined on a miss. */
function memoGet(root, key) {
  let m = root;
  for (let i = 0; i < key.length; i++) {
    m = m.get(key[i]);
    if (m === undefined) return undefined;
  }
  return m;
}

/** Store a rendered string under its key parts in the trie. */
function memoSet(root, key, value) {
  let m = root;
  for (let i = 0; i < key.length - 1; i++) {
    let next = m.get(key[i]);
    if (next === undefined) {
      next = new Map();
      m.set(key[i], next);
    }
    m = next;
  }
  m.set(key[key.length - 1], value);
}

/**
 * `nodes` rendered into `out` (an array of strings) in `scope`, at include
 * depth `depth`.  `ctx` holds the parsed templates.  An include is memoised on
 * the depth it renders at plus the resolved values of the target's free
 * variables — together with the fixed template map, that is the whole state a
 * render can read.
 */
function renderNodes(nodes, scope, ctx, depth, out) {
  for (const n of nodes) {
    switch (n.kind) {
      case 'text':
        out.push(n.text);
        break;
      case 'var':
        out.push(escapeHtml(textOf(lookup(scope, n.path))));
        break;
      case 'raw':
        out.push(textOf(lookup(scope, n.path)));
        break;
      case 'if': {
        const v = truthy(lookup(scope, n.path));
        const branch = v !== n.not ? n.then : n.else;
        if (branch !== null) renderNodes(branch, scope, ctx, depth, out);
        break;
      }
      case 'for': {
        const xs = lookup(scope, n.path);
        if (Array.isArray(xs)) {
          for (let k = 0; k < xs.length; k++) {
            const vars = {};
            vars[n.name] = xs[k];
            vars.loop = { index: k + 1, first: k === 0, last: k === xs.length - 1, length: xs.length };
            renderNodes(n.body, { vars, parent: scope }, ctx, depth, out);
          }
        }
        break;
      }
      case 'include': {
        if (depth >= INCLUDE_DEPTH) break;
        const t = ctx.templates.get(n.name);
        if (t === undefined) break;
        const key = [depth + 1];
        for (const fv of t.free) key.push(lookup(scope, [fv]));
        const hit = memoGet(t.memo, key);
        if (hit !== undefined) {
          out.push(hit);
          break;
        }
        const tmp = [];
        renderNodes(t.nodes, scope, ctx, depth + 1, tmp);
        const str = tmp.join('');
        memoSet(t.memo, key, str);
        out.push(str);
        break;
      }
    }
  }
}

// ------------------------------------------------------------------ link resolution

const SCHEME_RE = /^[A-Za-z][A-Za-z0-9+.-]*:/;

/**
 * A Markdown link's href: schemes, absolute paths and fragments pass through;
 * a relative path resolves from the source's directory against the built pages
 * and the static files, and anything else is a broken link (reported once per
 * source and target) whose href is left as written.
 */
function resolveLink(target, dir, srcPath, bySource, staticPaths, base, broken) {
  if (SCHEME_RE.test(target) || target.startsWith('/') || target.startsWith('#')) return target;
  const hash = target.indexOf('#');
  const rel = hash === -1 ? target : target.slice(0, hash);
  const frag = hash === -1 ? '' : target.slice(hash);
  const path = rel === '' ? null : resolvePath(dir, rel);
  if (path !== null) {
    const page = bySource.get(path);
    if (page !== undefined) return `${page.url}${frag}`;
    if (staticPaths.has(path)) return `${base}/${path}${frag}`;
  }
  broken.add(`broken-link ${srcPath} -> ${target}`);
  return target;
}

// ------------------------------------------------------------------ build

/** A source's tags, each slug once, in its own order. */
function ownTagNames(data, slugify) {
  const seen = new Set();
  const out = [];
  for (const name of data.tags ?? []) {
    const slug = slugify(name);
    if (!seen.has(slug)) {
      seen.add(slug);
      out.push(name);
    }
  }
  return out;
}

/** One site's output tree: path -> text. */
function buildSite(input) {
  // 0. Parse every template, in code-unit order of name.  One that does not
  // parse is reported and treated as absent.
  const report = [];
  const templates = new Map();
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    let parsed = null;
    let failure = null;
    try {
      parsed = parseTemplate(name, input.templates[name]);
    } catch (err) {
      failure = err;
    }
    if (failure !== null) {
      if (!(failure instanceof TemplateError)) throw failure;
      report.push(failure.message);
      continue;
    }
    templates.set(name, { nodes: parsed, free: null, memo: new Map() });
  }
  analyzeFreeVars(templates);

  const base = input.site.base_url.replace(/\/+$/, '');

  // Per-case memoised pure functions.
  const slugCache = new Map();
  const slugify = (text) => {
    let s = slugCache.get(text);
    if (s === undefined) {
      s = slugifyRaw(text);
      slugCache.set(text, s);
    }
    return s;
  };
  const dateCache = new Map();
  const longDateOf = (date) => {
    let s = dateCache.get(date);
    if (s === undefined) {
      s = longDate(date);
      dateCache.set(date, s);
    }
    return s;
  };

  // 1. The sources, in code-unit order of their paths; a source that is not
  // .md is static.  Line ends of sources are made "\n".
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  let sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) sources.push({ path: f.path, text: f.content.replace(/\r\n?/g, '\n') });
    else statics.push({ path: f.path, content: f.content });
  }

  // 2. Each source's front matter: a refused source is reported and dropped, and so is a draft.
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.post = s.path.startsWith('posts/');
    s.data = fm.data;
    s.body = fm.body;
    let own = null;
    if (s.path.startsWith('tags/')) own = 'tags';
    else if (s.path.startsWith('page/')) own = 'page';
    if (own !== null) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }
  sources = kept;

  // 3. Each page's output directory and url: its slug made unique in its directory, in source order.
  const taken = new Map();
  const bySource = new Map();
  for (const s of sources) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    let takenInDir = taken.get(dir);
    if (takenInDir === undefined) {
      takenInDir = new Set(dir === '' ? RESERVED_DIRS : []);
      taken.set(dir, takenInDir);
    }
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), takenInDir);
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // 4. Each body's Markdown, its links resolved to the pages and static files they name.
  const staticPaths = new Set(statics.map((f) => f.path));
  const broken = new Set();
  for (const s of sources) {
    const dir = dirOf(s.path);
    const link = (target) => resolveLink(target, dir, s.path, bySource, staticPaths, base, broken);
    const rendered = renderMarkdown(s.body, link, slugify);
    Object.assign(s, { html: rendered.html, toc: rendered.toc, excerpt: rendered.excerpt });
  }

  // 5. The posts, newest first and then by slug; each post's newer and older neighbours.
  const posts = sources.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  for (let k = 0; k < posts.length; k++) {
    const p = posts[k];
    p.newer = k > 0 ? posts[k - 1] : null;
    p.older = k + 1 < posts.length ? posts[k + 1] : null;
  }

  // 6. The tags: grouped by their slug, each named as first met in the posts' order, ordered by count and then slug.
  const bySlug = new Map();
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTagNames(p.data, slugify)) {
      const slug = slugify(name);
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: `${base}/tags/${slug}/`, posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of sources) {
    if (s.post) continue;
    s.tagRefs = ownTagNames(s.data, slugify).map((name) => {
      const slug = slugify(name);
      return bySlug.get(slug) ?? { name, slug, url: '', posts: [] };
    });
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // A page's link record as templates read it.
  function linkOf(s) {
    if (s === null) return null;
    const d = s.data;
    const dated = d.date !== undefined;
    return {
      title: d.title,
      url: s.url,
      date: dated ? d.date : '',
      date_long: dated ? longDateOf(d.date) : '',
    };
  }

  // A post's card, as lists show it.
  function cardOf(s) {
    const d = s.data;
    const dated = d.date !== undefined;
    const minutes = Math.max(1, Math.ceil(wordsOf(s.body) / 200));
    const tagList = s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url }));
    return {
      title: d.title,
      url: s.url,
      date: dated ? d.date : '',
      date_long: dated ? longDateOf(d.date) : '',
      summary: d.summary ?? '',
      excerpt: s.excerpt,
      reading_minutes: minutes,
      tags: tagList,
    };
  }

  // A page as its layout reads it.
  function pageOf(s, card) {
    const view = { ...card };
    view.slug = s.slug;
    view.content = s.html;
    view.toc = s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html }));
    view.newer = linkOf(s.newer ?? null);
    view.older = linkOf(s.older ?? null);
    view.is_post = s.post;
    return view;
  }

  // 7. Every page through its layout, the index pages and the tag pages through theirs.
  const cards = new Map();
  for (const p of posts) cards.set(p, cardOf(p));
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const ctx = { templates };
  const render = (name, vars) => {
    const t = templates.get(name);
    if (t === undefined) return null;
    const out = [];
    renderNodes(t.nodes, { vars: { site, tags: allTags, recent, ...vars }, parent: null }, ctx, 0, out);
    return out.join('');
  };
  const output = {};
  for (const s of sources) {
    const card = s.post ? cards.get(s) : cardOf(s);
    output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s, card) });
  }
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    const html = render('tag', {
      tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) },
    });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // 8. The report: every refusal, draft, broken link and template that did not parse, sorted, then the counts.
  const lines = [...report, ...broken].sort(byCodeUnits);
  const pageCount = sources.filter((s) => !s.post).length;
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output['build-report.txt'] = `${lines.join('\n')}\n`;
  return output;
}

/** makefun-site 1.0.0's answer for one case's input. */
export function run(input) {
  return buildSite(input);
}
