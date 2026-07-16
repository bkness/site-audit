import type { AuditSummary, AuditConfig, ReportOptions, Finding, FindingCategory } from './audit.js';
import { levelOrder, categoryOrder, levelRank, countFindingsByLevel, computeScore, scoreToGrade, filterFindingsByMinLevel } from './audit.js';

function escapeHtml(s: string): string {
    return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

// Category labels — acronyms get proper casing instead of naive Title Case.
const CATEGORY_LABELS: Record<FindingCategory, string> = {
    seo: 'SEO',
    accessibility: 'Accessibility',
    performance: 'Performance',
    security: 'Security',
    technical: 'Technical'
};

const CATEGORY_CODES: Record<FindingCategory, string> = {
    seo: 'SEO',
    accessibility: 'A11Y',
    performance: 'PERF',
    security: 'SEC',
    technical: 'TECH'
};

// Pick the highest-signal findings for the top-issues callout:
// errors first, then warnings, capped at 3, high-confidence preferred.
function selectTopIssues(findings: Finding[]): Finding[] {
    const sorted = [...findings].sort((a, b) => {
        const levelDiff = levelRank[b.level] - levelRank[a.level];
        if (levelDiff !== 0) return levelDiff;
        if (a.confidence !== b.confidence) {
            return a.confidence === 'high-confidence' ? -1 : 1;
        }
        return 0;
    });

    return sorted.filter((f) => f.level !== 'info').slice(0, 3);
}

export function renderReport(url: string, summary: AuditSummary, config: AuditConfig, reportOptions: ReportOptions): string {
    const visibleFindings = filterFindingsByMinLevel(summary.findings, reportOptions.minLevel);
    const timestamp = new Date().toLocaleString();

    const countsByLevel = countFindingsByLevel(visibleFindings);

    const score = computeScore(visibleFindings);
    const grade = scoreToGrade(score);
    const topIssues = selectTopIssues(visibleFindings);

    const groupedByCategory = new Map<FindingCategory, Finding[]>();
    for (const category of categoryOrder) {
        groupedByCategory.set(category, []);
    }

    for (const finding of visibleFindings) {
        const list = groupedByCategory.get(finding.category);
        if (list) {
            list.push(finding);
        }
    }

    const domain = new URL(url).hostname;
    const title = summary.title || domain;

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Site Audit Report – ${escapeHtml(domain)}</title>
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,400;9..144,600;9..144,700&family=Sora:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">
    <style>
        :root {
            --ink: #0F172A;
            --slate: #475569;
            --slate-light: #64748B;
            --bg: #F7F8FA;
            --card: #FFFFFF;
            --border: #E5E7EB;
            --copper: #B8560F;
            --amber: #D97706;
            --error: #DC2626;
            --error-bg: #FEF2F2;
            --warn: #D97706;
            --warn-bg: #FFFBEB;
            --info: #64748B;
            --info-bg: #F8FAFC;
            --good: #15803D;
            --fair: #B45309;
            --poor: #B91C1C;
        }

        * { margin: 0; padding: 0; box-sizing: border-box; }

        body {
            font-family: 'Sora', -apple-system, BlinkMacSystemFont, sans-serif;
            background: var(--bg);
            color: var(--ink);
            line-height: 1.6;
            padding: 2rem 1rem;
        }

        .container {
            max-width: 760px;
            margin: 0 auto;
            background: var(--card);
            border-radius: 10px;
            box-shadow: 0 1px 3px rgba(15, 23, 42, 0.08), 0 8px 24px rgba(15, 23, 42, 0.06);
            overflow: hidden;
        }

        /* ---------- Header ---------- */
        .header {
            background: var(--ink);
            background-image: linear-gradient(135deg, #0F172A 0%, #1E293B 100%);
            color: white;
            padding: 2.75rem 2rem 2.25rem;
            position: relative;
        }

        .header-top {
            display: flex;
            justify-content: space-between;
            align-items: flex-start;
            gap: 1.5rem;
        }

        .header-meta {
            min-width: 0;
        }

        .eyebrow {
            font-family: 'JetBrains Mono', monospace;
            font-size: 0.7rem;
            letter-spacing: 0.14em;
            text-transform: uppercase;
            color: var(--amber);
            margin-bottom: 0.6rem;
        }

        .header h1 {
            font-family: 'Fraunces', serif;
            font-weight: 600;
            font-size: 1.9rem;
            margin-bottom: 0.4rem;
            word-break: break-word;
        }

        .header .domain {
            font-size: 0.9rem;
            opacity: 0.75;
            font-family: 'JetBrains Mono', monospace;
            margin-bottom: 0.35rem;
        }

        .header .domain a {
            color: inherit;
            text-decoration: none;
            border-bottom: 1px dotted rgba(255, 255, 255, 0.3);
        }

        .header .domain a:hover {
            border-bottom-color: rgba(255, 255, 255, 0.7);
        }

        .header .timestamp {
            font-size: 0.8rem;
            opacity: 0.6;
        }

        /* ---------- Score badge ---------- */
        .score-badge {
            flex-shrink: 0;
            width: 92px;
            height: 92px;
            border-radius: 50%;
            background: rgba(255, 255, 255, 0.06);
            border: 3px solid var(--amber);
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
        }

        .score-badge .grade {
            font-family: 'Fraunces', serif;
            font-weight: 700;
            font-size: 2.1rem;
            line-height: 1;
        }

        .score-badge .score-num {
            font-family: 'JetBrains Mono', monospace;
            font-size: 0.65rem;
            opacity: 0.7;
            margin-top: 0.2rem;
        }

        /* ---------- Summary counts ---------- */
        .summary {
            display: grid;
            grid-template-columns: repeat(3, 1fr);
            gap: 1rem;
            padding: 1.5rem 2rem;
            background: var(--bg);
            border-bottom: 1px solid var(--border);
        }

        .summary-card {
            text-align: center;
            padding: 1.1rem 0.5rem;
            background: var(--card);
            border-radius: 8px;
            border: 1px solid var(--border);
        }

        .summary-card .number {
            font-family: 'JetBrains Mono', monospace;
            font-size: 2rem;
            font-weight: 600;
            margin-bottom: 0.3rem;
        }

        .summary-card .label {
            font-size: 0.72rem;
            color: var(--slate-light);
            text-transform: uppercase;
            letter-spacing: 0.08em;
            font-weight: 600;
        }

        .summary-card.errors .number { color: var(--error); }
        .summary-card.warnings .number { color: var(--warn); }
        .summary-card.infos .number { color: var(--info); }

        /* ---------- Top issues callout ---------- */
        .top-issues {
            margin: 1.75rem 2rem 0;
            padding: 1.5rem;
            background: #FFF8F1;
            border: 1px solid #F2D9BE;
            border-radius: 8px;
        }

        .top-issues h2 {
            font-family: 'Fraunces', serif;
            font-size: 1.05rem;
            font-weight: 600;
            color: var(--copper);
            margin-bottom: 0.9rem;
        }

        .top-issues ol {
            list-style: none;
            display: flex;
            flex-direction: column;
            gap: 0.65rem;
        }

        .top-issues li {
            display: flex;
            gap: 0.7rem;
            font-size: 0.92rem;
            align-items: baseline;
        }

        .top-issues .tag {
            font-family: 'JetBrains Mono', monospace;
            font-size: 0.68rem;
            font-weight: 600;
            color: white;
            background: var(--copper);
            padding: 0.15rem 0.4rem;
            border-radius: 4px;
            flex-shrink: 0;
        }

        /* ---------- Content ---------- */
        .content {
            padding: 2rem;
        }

        .category {
            margin-bottom: 2.25rem;
        }

        .category:last-child {
            margin-bottom: 0;
        }

        .category h2 {
            font-family: 'JetBrains Mono', monospace;
            font-size: 0.78rem;
            font-weight: 600;
            letter-spacing: 0.1em;
            text-transform: uppercase;
            color: var(--slate);
            margin-bottom: 1rem;
            padding-bottom: 0.6rem;
            border-bottom: 2px solid var(--border);
            display: flex;
            align-items: center;
            gap: 0.5rem;
        }

        .category h2::before {
            content: '';
            width: 6px;
            height: 6px;
            border-radius: 50%;
            background: var(--copper);
        }

        .finding {
            margin-bottom: 0.85rem;
            padding: 1rem 1.15rem;
            background: var(--bg);
            border-left: 3px solid var(--border);
            border-radius: 5px;
            display: flex;
            gap: 0.85rem;
        }

        .finding:last-child { margin-bottom: 0; }

        .finding.error { border-left-color: var(--error); background: var(--error-bg); }
        .finding.warn { border-left-color: var(--warn); background: var(--warn-bg); }
        .finding.info { border-left-color: var(--info); background: var(--info-bg); }

        .finding-badge {
            flex-shrink: 0;
            width: 22px;
            height: 22px;
            border-radius: 50%;
            display: flex;
            align-items: center;
            justify-content: center;
            font-family: 'JetBrains Mono', monospace;
            font-size: 0.7rem;
            font-weight: 700;
            color: white;
            margin-top: 1px;
        }

        .finding.error .finding-badge { background: var(--error); }
        .finding.warn .finding-badge { background: var(--warn); }
        .finding.info .finding-badge { background: var(--info); }

        .finding-content { flex: 1; min-width: 0; }

        .finding-message {
            font-size: 0.93rem;
            margin-bottom: 0.3rem;
            word-break: break-word;
            font-weight: 500;
        }

        .finding-impact {
            font-size: 0.87rem;
            color: var(--slate);
            line-height: 1.55;
            margin-top: 0.35rem;
        }

        .finding-impact::before {
            content: '→ ';
            color: var(--copper);
            font-weight: 600;
        }

        .finding-confidence {
            font-family: 'JetBrains Mono', monospace;
            font-size: 0.72rem;
            color: var(--slate-light);
            margin-top: 0.4rem;
        }

        .empty-category {
            color: #9CA3AF;
            font-style: italic;
            font-size: 0.88rem;
            padding: 1rem 0;
        }

        /* ---------- CTA + footer ---------- */
        .cta {
            margin: 0 2rem 2rem;
            padding: 1.75rem;
            background: var(--ink);
            border-radius: 8px;
            text-align: center;
        }

        .cta h2 {
            font-family: 'Fraunces', serif;
            color: white;
            font-size: 1.15rem;
            font-weight: 600;
            margin-bottom: 0.5rem;
        }

        .cta p {
            color: rgba(255, 255, 255, 0.7);
            font-size: 0.88rem;
            margin-bottom: 1.1rem;
        }

        .cta a {
            display: inline-block;
            background: var(--amber);
            color: var(--ink);
            font-weight: 600;
            font-size: 0.88rem;
            padding: 0.7rem 1.5rem;
            border-radius: 6px;
            text-decoration: none;
        }

        .footer {
            background: var(--bg);
            border-top: 1px solid var(--border);
            padding: 1.5rem 2rem;
            font-size: 0.78rem;
            color: var(--slate-light);
            text-align: center;
            line-height: 1.7;
        }

        .footer a { color: var(--copper); }

        @media (max-width: 480px) {
            .header-top { flex-direction: column-reverse; align-items: flex-start; gap: 1rem; }
        }

        @media print {
            body { padding: 0; background: white; }
            .container { box-shadow: none; }
            .cta { display: none; }
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <div class="header-top">
                <div class="header-meta">
                    <div class="eyebrow">Site Audit Report</div>
                    <h1>${escapeHtml(title)}</h1>
                    <div class="domain"><a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(domain)}</a></div>
                    <div class="timestamp">Audited ${timestamp} · ${escapeHtml(config.profile)} profile</div>
                </div>
                <div class="score-badge">
                    <div class="grade">${grade.letter}</div>
                    <div class="score-num">${score}/100</div>
                </div>
            </div>
        </div>

        <div class="summary">
            <div class="summary-card errors">
                <div class="number">${countsByLevel.error}</div>
                <div class="label">Error${countsByLevel.error !== 1 ? 's' : ''}</div>
            </div>
            <div class="summary-card warnings">
                <div class="number">${countsByLevel.warn}</div>
                <div class="label">Warning${countsByLevel.warn !== 1 ? 's' : ''}</div>
            </div>
            <div class="summary-card infos">
                <div class="number">${countsByLevel.info}</div>
                <div class="label">Info</div>
            </div>
        </div>

        ${topIssues.length > 0 ? `<div class="top-issues">
            <h2>What's costing you the most right now</h2>
            <ol>
                ${topIssues.map(issue => `<li><span class="tag">${CATEGORY_CODES[issue.category]}</span><span>${escapeHtml(issue.message)}</span></li>`).join('')}
            </ol>
        </div>` : ''}

        <div class="content">
            ${categoryOrder.map(category => {
        const items = (groupedByCategory.get(category) ?? [])
            .sort((left, right) => levelOrder.indexOf(left.level) - levelOrder.indexOf(right.level));
        if (items.length === 0) {
            return `<div class="category">
                    <h2>${CATEGORY_LABELS[category]}</h2>
                    <div class="empty-category">No issues found</div>
                </div>`;
        }
        return `<div class="category">
                    <h2>${CATEGORY_LABELS[category]}</h2>
                    ${items.map(item => `<div class="finding ${item.level}" data-rule="${escapeHtml(item.rule)}">
                        <div class="finding-badge">${item.level.charAt(0).toUpperCase()}</div>
                        <div class="finding-content">
                            <div class="finding-message">${escapeHtml(item.message)}</div>
                            ${item.impact ? `<div class="finding-impact">${escapeHtml(item.impact)}</div>` : ''}
                            ${reportOptions.showConfidence ? `<div class="finding-confidence">${item.confidence}</div>` : ''}
                        </div>
                    </div>`).join('')}
                </div>`;
    }).join('')}
        </div>

        <div class="cta">
            <h2>Want these fixed?</h2>
            <p>DevForge builds and ships fixes for exactly what's flagged above.</p>
            <a href="https://brandon-kelly.netlify.app">Get a free consult →</a>
        </div>

        <div class="footer">
            <p>Generated by Site Audit on ${timestamp}.</p>
            <p>Static HTML analysis — some issues like lazy-loading behavior, runtime CSP, and dynamic content can only be verified in a browser.</p>
            <p>Audit tool made with ❤️ by Brandon Kelly. <a href="https://github.com/bkness/">GitHub</a></p>
        </div>
    </div>
</body>
</html>`;

    return html;
}
