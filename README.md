# makefun-site, faster — site-generator-speed-01

[![make.fun · site-generator-speed-01-run-20261122](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/rahmatjibran04-byte/makefun-site-generator/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/rahmatjibran04-byte/makefun-site-generator/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)

A fast, dependency-free drop-in for make.fun's own `makefun-site` 1.0.0 — an entry for the [site-generator-speed-01 bounty](https://make.fun/bounty/site-generator-speed-01-run-20261122).
`solve.js` returns, for every case input, exactly the answer makefun-site 1.0.0
returns — the output tree of a generated static site, byte for byte — and does
it in a fraction of the baseline's CPU time.

## Files

| File | What it is |
|---|---|
| `solve.js` | The entry. ES module, no imports, no dependencies. Exports `run(input)`. |
| `main.ts` | The harness driver. Identical to the house baseline's driver: reads every case from `/input/cases.json` (or `MAKEFUN_INPUT_DIR`), answers each with `run`, writes `/output/answers.json` (or `MAKEFUN_OUTPUT_DIR`). V8 incremental marking is off (`--no-incremental-marking`) before `solve.js` is imported. |
| `SPEC.md` | The behavioural specification the implementation was written from (front matter, slug, Markdown subset, template dialect, report format, and every edge case). Working notes, not part of the entry. |
| `README.md` | This file. |
| `LICENSE` | MIT. |

## How to run

```sh
node main.ts
```

Outside a container, point it at the practice set:

```sh
MAKEFUN_INPUT_DIR=../site-generator-speed-01-run-20261122-kit/practice/input \
MAKEFUN_OUTPUT_DIR=/tmp/sgs-out \
node main.ts
```

Node 22 is required. There is nothing to install: `solve.js` uses only the
language itself, no WASM, no native addon, no prebuilt binary.

## What it does

`run(input)` builds one site, `{ site, templates, files }`, into its output
tree — a JSON object of every path written (each page's `index.html`, the index
and tag pages, `build-report.txt`, and each static file) and that file's text.
The behaviour follows makefun-site 1.0.0 exactly: its front matter (with every
refusal reason, in order), its slug rule (Unicode NFKD, 64 characters,
`untitled` when empty, unique per directory), its Markdown subset (not
CommonMark), its template dialect (`{{ }}`, `{{{ }}}`, `{% for %}`, `{% if %}`,
`{% include %}`), its collections and tags, its link resolution and broken-link
report, and its `build-report.txt`. Where the README and the reference code
differ, the code wins — see `SPEC.md` §13 for the twelve differences found.

## How it is fast

The output is identical; the work is not repeated:

- **Templates are precompiled once per case** into an instruction list, and
  includes are memoised on their resolved free variables — shared partials
  (`head`, `header`, `footer`, `nav`) and cards render once per case or once
  per post instead of once per page.
- **The Markdown inline renderer scans by hand** (`charCodeAt` / `indexOf`),
  escapes whole runs at once, and only escapes when the run needs it.
- **Slugs and long dates are cached** per case; the ASCII fast path skips
  Unicode normalisation.
- **Strings are built with arrays and one `join`**, not repeated `+=`.
- **Collections, tags and the index are computed once per case**, not per page.

## Test results (Node 22.23.4, practice set)

| Check | Result |
|---|---|
| Correctness vs `practice/reference/expected.json` | **3/3 cases identical** — g-0001 (276 paths), g-0002 (350 paths), g-0003 (509 paths); 0 differing paths, 0 missing, 0 extra |
| Differential vs the vendor, hand-written cases | 201/201 pass (front-matter refusals, quoted strings, slug edge cases, every Markdown construct, template parse errors, includes, pagination, `base_url` variants, static shadowing, duplicate paths) |
| Random fuzz vs the vendor | 1,200/1,200 pass (4 seeds × 300 cases) |
| Speed, `run()` only (3 cases, median of 5 interleaved runs) | Baseline 578.3 ms → this entry 162.3 ms = **3.56× faster** |
| Speed, `main.ts` wall (startup + JSON parse/stringify included) | Baseline 1,085 ms → this entry 619 ms = **1.75× faster** |
| Determinism | Two runs of `main.ts` produce byte-identical `answers.json` (same sha256) |

The entry was written from the behavioural specification (`SPEC.md`), not by
copying the reference code: after a rewrite pass, no verbatim block of five or
more lines remains shared with the vendor sources (longest remaining match is
four lines of generic fragments).

## Limits

- Node 22, standard library only; no network, no clock, no randomness — the
  output depends on the input alone, so two runs agree byte for byte.
- Repository total is far below the 4 MiB cap.
