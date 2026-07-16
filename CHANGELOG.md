# Changelog

All notable changes to this project are documented here.
Format loosely follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), versioning follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.2.1] — 2026-07-16

### Fixed
- Published `0.2.0` shipped with a stale build — the `--json` flag was documented but the compiled output on npm didn't include the parser code. Re-published with a clean rebuild. No source changes; same features as 0.2.0 intended.

## [0.2.0] — 2026-07-16

### Added
- `--json` flag: outputs the audit as a single JSON object to stdout, skipping the HTML report entirely. Includes `url`, `auditedAt`, `profile`, `minLevel`, `title`, `description`, `score`, `grade`, `counts`, and `findings[]`. Ideal for piping into `jq`, CI scripts, and custom renderers.
- Exit code behavior: exits `1` if any errors are found (post-min-level filter), `0` if clean, `2` if the audit itself fails (network/parse error). Enables CI gating: `site-audit https://x.com --min-level error --json > audit.json || echo "failed audit"`.
- Score and grade computation moved from `renderReport.ts` to `audit.ts` as exported functions (`computeScore`, `scoreToGrade`), single source of truth for both HTML and JSON output.

### Example
```bash
# Pipe into jq
npx @bkness/site-audit https://example.com --json | jq '.grade'

# CI gate: fail build if any errors
npx @bkness/site-audit https://example.com --min-level error --json > audit.json
```

## [0.1.3] — 2026-07-15

### Changed
- HTTP request headers now match a full Chrome browser fingerprint (User-Agent, Sec-CH-UA-*, Sec-Fetch-*, Accept-Language, Upgrade-Insecure-Requests). Significantly reduces 403s from sites with moderate bot detection.

### Known limits
- Sites behind Cloudflare's JS-challenge protection (e.g. surfline.com) still cannot be audited from a static fetch. This is a fundamental limit of non-browser tools; a `--headless` flag using Puppeteer is planned for a future release.

## [0.1.2] — 2026-07-15

### Added
- README screenshot preview showing a live audit output (GitHub.com scored an F).

## [0.1.1] — 2026-07-15

### Added
- `LICENSE` file (MIT).
- `funding` field pointing to author's portfolio.
- This changelog.

## [0.1.0] — 2026-07-15

Initial release.

### Added
- Static-HTML audit engine covering 5 categories: Accessibility, SEO, Performance, Security, Technical.
- 33+ rules across all categories, each tagged with a confidence label (`high-confidence` vs `runtime-limited`).
- Business-facing impact text for every high-frequency rule — findings explain the consequence, not just the technical detail.
- Three audit profiles (`balanced`, `strict`, `enterprise`) with per-profile thresholds for image weight and lazy-loading tolerance.
- CLI flags: `--profile`, `--min-level`, `--show-confidence`.
- Beautiful, portable HTML report output with:
  - Letter grade (A–F) computed from severity-weighted findings.
  - "What's costing you the most right now" top-issues callout.
  - Category-grouped findings with severity badges and copper accent design.
  - Print-ready styling.
- Image byte-size probing via HEAD requests with Range-request fallback, timeouts, and concurrency limits.
- Custom lazy-loading detection (Intersection Observer, `data-src` patterns, popular libraries) to reduce false positives on modern SPAs.
- Brand-title leniency for well-known domains (opt-in via `balanced` profile).

### Notes
- Static HTML analysis only — runtime metrics (Core Web Vitals, focus management, header-based CSP) are out of scope and honestly flagged as `runtime-limited` when relevant.
