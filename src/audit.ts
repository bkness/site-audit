#!/usr/bin/env node
import { load } from 'cheerio';
import type { AnyNode } from 'domhandler';
import { writeFile, mkdir } from 'node:fs/promises';
import { fetchHtml } from './fetchHtml.js';
import { renderReport } from './renderReport.js';

export type FindingLevel = 'info' | 'warn' | 'error';
export type FindingCategory = 'seo' | 'accessibility' | 'performance' | 'security' | 'technical';
type FindingConfidence = 'high-confidence' | 'runtime-limited';

export type Finding = {
    level: FindingLevel;
    category: FindingCategory;
    rule: string;
    message: string;
    confidence: FindingConfidence;
    impact?: string;
};

export type AuditSummary = {
    title: string;
    description: string;
    findings: Finding[];
};

type ImageSizeSample = {
    url: string;
    bytes: number;
};

type CurrencySignals = {
    symbols: Set<string>;
    codes: Set<string>;
    priceLikeCount: number;
};

type AuditProfile = 'balanced' | 'strict' | 'enterprise';

export type AuditConfig = {
    profile: AuditProfile;
    seo: {
        allowBrandTitleLeniency: boolean;
    };
    performance: {
        respectCustomLazyLoadingSignals: boolean;
        largestImageWarnBytes: number;
        largestImageErrorBytes: number;
        totalImageWarnBytes: number;
    };
};

export type ReportOptions = {
    minLevel: FindingLevel;
    showConfidence: boolean;
};

const HEAD_TIMEOUT_MS = 2_500;
const RANGE_TIMEOUT_MS = 4_000;
const IMAGE_PROBE_CONCURRENCY = 6;

const PROFILE_CONFIGS: Record<AuditProfile, AuditConfig> = {
    balanced: {
        profile: 'balanced',
        seo: {
            allowBrandTitleLeniency: true
        },
        performance: {
            respectCustomLazyLoadingSignals: true,
            largestImageWarnBytes: 500_000,
            largestImageErrorBytes: 1_000_000,
            totalImageWarnBytes: 5_000_000
        }
    },
    strict: {
        profile: 'strict',
        seo: {
            allowBrandTitleLeniency: false
        },
        performance: {
            respectCustomLazyLoadingSignals: false,
            largestImageWarnBytes: 300_000,
            largestImageErrorBytes: 700_000,
            totalImageWarnBytes: 3_000_000
        }
    },
    enterprise: {
        profile: 'enterprise',
        seo: {
            allowBrandTitleLeniency: false
        },
        performance: {
            respectCustomLazyLoadingSignals: false,
            largestImageWarnBytes: 200_000,
            largestImageErrorBytes: 500_000,
            totalImageWarnBytes: 2_000_000
        }
    }
};

export const levelOrder: FindingLevel[] = ['error', 'warn', 'info'];
export const categoryOrder: FindingCategory[] = ['accessibility', 'seo', 'performance', 'security', 'technical'];
export const levelRank: Record<FindingLevel, number> = {
    info: 0,
    warn: 1,
    error: 2
};

const USAGE = 'Usage: npx tsx src/audit.ts <url> [--profile balanced|strict|enterprise] [--min-level info|warn|error] [--show-confidence] [--json]';

export function countFindingsByLevel(findings: Finding[]): Record<FindingLevel, number> {
    return findings.reduce(
        (acc, finding) => {
            acc[finding.level] += 1;
            return acc;
        },
        { error: 0, warn: 0, info: 0 } as Record<FindingLevel, number>
    );
}

// Score model: start at 100, deduct per finding by severity.
// Errors hurt most since they're high-confidence, concrete problems.
export const LEVEL_PENALTY: Record<FindingLevel, number> = {
    error: 9,
    warn: 4,
    info: 1
};

export type Grade = { letter: string; band: 'good' | 'fair' | 'poor' };

export function computeScore(findings: Finding[]): number {
    const raw = findings.reduce((score, finding) => score - LEVEL_PENALTY[finding.level], 100);
    return Math.max(raw, 0);
}

export function scoreToGrade(score: number): Grade {
    if (score >= 90) return { letter: 'A', band: 'good' };
    if (score >= 80) return { letter: 'B', band: 'good' };
    if (score >= 70) return { letter: 'C', band: 'fair' };
    if (score >= 60) return { letter: 'D', band: 'fair' };
    return { letter: 'F', band: 'poor' };
}

export function filterFindingsByMinLevel(findings: Finding[], minLevel: FindingLevel): Finding[] {
    const threshold = levelRank[minLevel];
    return findings.filter((finding) => levelRank[finding.level] >= threshold);
}

function normalizeText(value: string): string {
    return value.replace(/\s+/g, ' ').trim();
}

// Business-facing "so what" text per rule.
// Formula: what's broken → who it hurts → what it costs.
// Rules without an entry fall back to just showing the technical message.
const IMPACTS: Record<string, string> = {
    'a11y-link-name-missing': "Screen readers announce these as just 'link' with no context. Blind and low-vision visitors — roughly 2% of traffic — hit a dead end. Also one of the most-cited issues in ADA lawsuits.",
    'a11y-form-label-missing': "Anyone using assistive tech can't tell what these fields are asking for. Contact forms are usually the most valuable page on a small business site — losing conversions here costs more than anywhere else.",
    'a11y-image-alt-missing': "Every image is invisible to blind visitors, and Google can't index them for image search either. You lose both accessibility reach and organic traffic.",
    'a11y-button-name-missing': "Screen readers announce these as 'button' with no indication of what happens if activated. Anyone using a keyboard or voice control can't reliably use them.",
    'a11y-h1-missing': "The H1 is Google's single strongest signal of what a page is about. Without one, you're competing for search rankings with a hand tied behind your back.",
    'tech-duplicate-ids': "Duplicate IDs cause invisible bugs — analytics fire on the wrong element, JavaScript grabs the wrong node, form fields misbehave. Silent tax on every visitor.",
    'sec-insecure-resource': "An HTTPS page loading content over HTTP is 'mixed content' — modern browsers block these outright or throw a warning. Chrome may flag the whole page as 'Not Secure.'",
    'sec-target-blank-rel': "External links let destination sites reach into your visitors' browser tabs — a well-known phishing vector. Small fix, real risk.",
    'sec-https-missing': "Modern browsers show a 'Not Secure' warning on non-HTTPS pages, and Google actively demotes them in search rankings. Every visitor sees the warning before your content.",
    'seo-title-missing': "Without a page title, Google shows your URL in search results and browsers show blank tabs. This is the first thing every visitor sees before deciding to click.",
    'seo-title-length': "Titles too short don't tell searchers enough; too long, and Google truncates them with '…' in search results — often cutting mid-word.",
    'seo-description-missing': "Google generates its own snippet from a random paragraph on your page — usually not the pitch you'd write. A meta description lets you control that first impression.",
    'seo-canonical-missing': "Google may treat different versions of the same page (www vs no-www, trailing slash, tracking params) as separate URLs. Your ranking splits across all of them.",
    'seo-open-graph-incomplete': "When someone shares your page on Facebook, LinkedIn, iMessage, or Slack, the preview will be missing or ugly. Most 'my link looks broken' complaints trace back to this.",
    'perf-render-blocking-scripts': "Visitors see a blank page while your site waits for outside code to download — often 1-3 seconds on mobile. Many bail during that wait.",
    'perf-image-largest-heavy': "One image is doing most of the damage to your load time. On a phone this alone can add 5-15 seconds — most visitors leave before it appears.",
    'perf-image-total-heavy': "Your homepage ships more image data than most 30-second phone videos. Each additional second of load time typically costs 7% of your visitors.",
    'perf-image-lazy-loading': "Images below the fold load immediately anyway, slowing your first paint. Deferring them until the visitor scrolls close cuts initial load time significantly.",
    'perf-script-count-high': "Each external script is a separate download, parse, and execute. Cumulative overhead adds up fast — often more than the content itself.",
    'perf-stylesheet-count-high': "Stylesheets block the first paint until they finish loading. Consolidating to one or two files is one of the easiest performance wins.",
    'a11y-heading-skip': "Heading levels act as a page outline for screen readers. Jumping levels breaks the mental map of your structure — like a table of contents that skips chapters.",
    'a11y-main-missing': "The <main> landmark lets screen reader and keyboard users skip past navigation and jump straight to your content. Without it, they re-read the header on every page.",
    'a11y-lang-missing': "The language attribute tells screen readers which pronunciation to use. Without it, English text may be read with a Spanish accent — nearly unintelligible to the visitor.",
    'a11y-h1-multiple': "Multiple H1s dilute the signal to Google about your page's topic. Screen reader users navigating by heading level also see a fractured outline.",
    'a11y-iframe-title-missing': "Screen readers announce untitled iframes as just 'frame' — visitors have no way to know what's embedded there (map, video, form) before entering.",
    'tech-bad-fragment-links': "Anchor links pointing to missing targets quietly break in-page navigation like FAQ jump-tos, table-of-contents links, and 'back to top' shortcuts.",
    'tech-structured-data-missing': "Structured data helps Google understand your hours, reviews, address, and offerings — enabling rich search results like map cards, review stars, and event listings.",
    'seo-viewport-missing': "Without the viewport meta tag, mobile browsers render your page at desktop width and shrink to fit — resulting in tiny, unreadable text. This is why Google flags sites as 'not mobile-friendly.'",
    'seo-charset-missing': "Without a declared charset, browsers guess how to interpret special characters — accents, currency symbols, and smart quotes may show as ??? or garbled text.",
    'seo-noindex': "This tag tells Google to keep the page out of search results entirely. Often set accidentally during development and left in production — killing all organic traffic to the page.",
    'seo-description-length': "Meta descriptions outside the 50-160 character range either don't tell searchers enough or get truncated with '…' in results, sometimes mid-sentence.",
    'seo-twitter-card-missing': "When your link is shared on X (Twitter), it won't have a preview card — just a bare URL. Cards typically double engagement on shared links."
};

function addFinding(
    findings: Finding[],
    level: FindingLevel,
    category: FindingCategory,
    rule: string,
    message: string,
    confidence: FindingConfidence = 'high-confidence',
    impact?: string
): void {
    const resolvedImpact = impact ?? IMPACTS[rule];
    if (resolvedImpact == null) {
        findings.push({ level, category, rule, message, confidence });
        return;
    }

    findings.push({ level, category, rule, message, confidence, impact: resolvedImpact });
}

function hasAccessibleName($: ReturnType<typeof load>, element: AnyNode): boolean {
    const node = $(element);
    const text = normalizeText(node.text());
    const ariaLabel = node.attr('aria-label')?.trim();
    const labelledBy = node.attr('aria-labelledby')?.trim();
    const title = node.attr('title')?.trim();
    const svgTitle = normalizeText(node.find('svg title').first().text());
    const imageAlt = node.find('img[alt]').toArray().some((img) => {
        const alt = $(img).attr('alt');
        return alt != null && alt.trim().length > 0;
    });

    return text.length > 0 || Boolean(ariaLabel) || Boolean(labelledBy) || Boolean(title) || svgTitle.length > 0 || imageAlt;
}

function hasCustomLazyLoadingSignals($: ReturnType<typeof load>): boolean {
    const domSignals = $('img[data-src], img[data-srcset], img[data-lazy-src], img[data-original], img[class*="lazy" i], source[data-srcset]').length > 0;

    if (domSignals) {
        return true;
    }

    return $('script').toArray().some((script) => {
        const scriptText = $(script).html() ?? '';
        return /IntersectionObserver|lazyload|lazysizes/i.test(scriptText);
    });
}

function resolveImageUrls($: ReturnType<typeof load>, pageUrl: string): string[] {
    const baseUrl = new URL(pageUrl);

    const imageUrls = $('img')
        .toArray()
        .map((img) => $(img).attr('src'))
        .filter((src): src is string => Boolean(src))
        .map((src) => {
            try {
                return new URL(src, baseUrl).href;
            } catch {
                return null;
            }
        })
        .filter((url): url is string => Boolean(url))
        .filter((url) => !url.startsWith('data:'));

    return [...new Set(imageUrls)];
}

function formatBytes(bytes: number): string {
    if (bytes < 1024) {
        return `${bytes} B`;
    }

    if (bytes < 1024 * 1024) {
        return `${(bytes / 1024).toFixed(1)} KB`;
    }

    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

async function timedFetch(
    input: string,
    init: RequestInit,
    timeoutMs: number
): Promise<Response> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
        return await fetch(input, {
            ...init,
            signal: controller.signal
        });
    } finally {
        clearTimeout(timeoutId);
    }
}

async function mapWithConcurrency<T, R>(
    items: T[],
    limit: number,
    mapper: (item: T, index: number) => Promise<R>
): Promise<R[]> {
    if (items.length === 0) {
        return [];
    }

    const results: R[] = new Array(items.length);
    let nextIndex = 0;

    async function worker(): Promise<void> {
        while (true) {
            const currentIndex = nextIndex;
            if (currentIndex >= items.length) {
                return;
            }

            nextIndex += 1;
            const item = items[currentIndex];
            if (item == null) {
                continue;
            }
            results[currentIndex] = await mapper(item, currentIndex);
        }
    }

    const workerCount = Math.min(Math.max(limit, 1), items.length);
    await Promise.all(Array.from({ length: workerCount }, () => worker()));

    return results;
}

function collectCurrencySignals($: ReturnType<typeof load>): CurrencySignals {
    const text = normalizeText($('body').text());
    const symbols = new Set<string>();
    const codes = new Set<string>();

    const symbolMatches = text.match(/[$€£¥₹]/g) ?? [];
    for (const symbol of symbolMatches) {
        symbols.add(symbol);
    }

    const codeMatches = text.match(/\b(USD|EUR|GBP|CAD|AUD|NZD|JPY|CNY|INR|CHF|SEK|NOK|DKK|MXN|BRL|ZAR)\b/gi) ?? [];
    for (const code of codeMatches) {
        codes.add(code.toUpperCase());
    }

    const priceLikeMatches = text.match(/\b\d{1,3}(?:,\d{3})*(?:\.\d{2})\b/g) ?? [];

    return {
        symbols,
        codes,
        priceLikeCount: priceLikeMatches.length
    };
}

function hasCurrencySwitcher($: ReturnType<typeof load>): boolean {
    return (
        $('select[name*="currency" i], select[id*="currency" i]').length > 0
        || $('[data-currency], [data-currency-code]').length > 0
        || $('[class*="currency" i], [id*="currency" i]').length > 0
    );
}

function runCurrencyGapChecks($: ReturnType<typeof load>, findings: Finding[]): void {
    const signals = collectCurrencySignals($);
    const uniqueCurrencyCount = signals.symbols.size + signals.codes.size;
    const switcherPresent = hasCurrencySwitcher($);
    const commerceIntent = /\b(cart|checkout|buy now|add to cart|shop)\b/i.test(normalizeText($('body').text()));

    if (signals.priceLikeCount > 0 && uniqueCurrencyCount === 0) {
        addFinding(
            findings,
            'warn',
            'technical',
            'tech-currency-gap-missing',
            `Detected ${signals.priceLikeCount} price-like value${signals.priceLikeCount === 1 ? '' : 's'} but no clear currency symbol/code.`,
            'runtime-limited'
        );
    }

    if (uniqueCurrencyCount > 1 && !switcherPresent) {
        addFinding(
            findings,
            'warn',
            'technical',
            'tech-currency-gap-mixed',
            `Multiple currency signals detected (${uniqueCurrencyCount}) without a visible currency selector.`,
            'runtime-limited'
        );
    }

    if (commerceIntent && uniqueCurrencyCount === 0) {
        addFinding(
            findings,
            'info',
            'technical',
            'tech-currency-gap-commerce',
            'Commerce intent detected, but currency signals were not found in page content.',
            'runtime-limited'
        );
    }
}

async function readImageSizeBytes(imageUrl: string): Promise<number | null> {
    const commonHeaders = {
        'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
        'accept-language': 'en-US,en;q=0.9',
        'sec-ch-ua': '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"macOS"',
        'sec-fetch-dest': 'image',
        'sec-fetch-mode': 'no-cors',
        'sec-fetch-site': 'cross-site'
    };

    try {
        const headResponse = await timedFetch(imageUrl, {
            method: 'HEAD',
            headers: commonHeaders,
            redirect: 'follow'
        }, HEAD_TIMEOUT_MS);

        if (headResponse.ok) {
            const contentLength = Number(headResponse.headers.get('content-length') ?? '');
            if (Number.isFinite(contentLength) && contentLength > 0) {
                return contentLength;
            }
        }
    } catch {
        // Fall through to GET range request.
    }

    try {
        const rangeResponse = await timedFetch(imageUrl, {
            method: 'GET',
            headers: {
                ...commonHeaders,
                range: 'bytes=0-0'
            },
            redirect: 'follow'
        }, RANGE_TIMEOUT_MS);

        const contentRange = rangeResponse.headers.get('content-range') ?? '';
        const rangeMatch = contentRange.match(/\/(\d+)$/);

        if (rangeMatch?.[1]) {
            const totalBytes = Number(rangeMatch[1]);
            if (Number.isFinite(totalBytes) && totalBytes > 0) {
                rangeResponse.body?.cancel();
                return totalBytes;
            }
        }

        const contentLength = Number(rangeResponse.headers.get('content-length') ?? '');
        if (Number.isFinite(contentLength) && contentLength > 0) {
            rangeResponse.body?.cancel();
            return contentLength;
        }

        rangeResponse.body?.cancel();
    } catch {
        return null;
    }

    return null;
}

async function runImageByteSizeChecks(
    imageUrls: string[],
    findings: Finding[],
    config: AuditConfig
): Promise<void> {
    if (imageUrls.length === 0) {
        return;
    }

    const imageSizes = await mapWithConcurrency(
        imageUrls,
        IMAGE_PROBE_CONCURRENCY,
        async (url) => {
            const bytes = await readImageSizeBytes(url);
            return bytes == null ? null : { url, bytes };
        }
    );

    const samples: ImageSizeSample[] = imageSizes.filter((sample): sample is ImageSizeSample => sample != null);
    const unreadableCount = imageUrls.length - samples.length;

    if (samples.length === 0) {
        addFinding(
            findings,
            'info',
            'performance',
            'perf-image-byte-size-unavailable',
            'Unable to read byte size metadata for page images.',
            'runtime-limited'
        );
        return;
    }

    const totalBytes = samples.reduce((sum, sample) => sum + sample.bytes, 0);
    const largestSample = samples.reduce((largest, sample) =>
        sample.bytes > largest.bytes ? sample : largest
    );

    addFinding(
        findings,
        'info',
        'performance',
        'perf-image-byte-size-summary',
        `${samples.length}/${imageUrls.length} image sizes read, total ${formatBytes(totalBytes)}, largest ${formatBytes(largestSample.bytes)}.`,
        'runtime-limited'
    );

    if (largestSample.bytes > config.performance.largestImageErrorBytes) {
        addFinding(
            findings,
            'error',
            'performance',
            'perf-image-largest-heavy',
            `Largest image is ${formatBytes(largestSample.bytes)} (${largestSample.url}).`
        );
    } else if (largestSample.bytes > config.performance.largestImageWarnBytes) {
        addFinding(
            findings,
            'warn',
            'performance',
            'perf-image-largest-heavy',
            `Largest image is ${formatBytes(largestSample.bytes)} (${largestSample.url}).`
        );
    }

    if (totalBytes > config.performance.totalImageWarnBytes) {
        addFinding(
            findings,
            'warn',
            'performance',
            'perf-image-total-heavy',
            `Total image weight is ${formatBytes(totalBytes)}.`
        );
    }

    if (unreadableCount > 0) {
        addFinding(
            findings,
            'info',
            'performance',
            'perf-image-byte-size-partial',
            `${unreadableCount} image${unreadableCount === 1 ? '' : 's'} could not be sized from HTTP metadata.`,
            'runtime-limited'
        );
    }
}

function runSeoChecks($: ReturnType<typeof load>, pageUrl: string, findings: Finding[], config: AuditConfig): void {
    const title = $('title').first().text().trim();
    const description = $('meta[name="description"]').attr('content')?.trim() ?? '';
    const canonical = $('link[rel="canonical"]').attr('href')?.trim();
    const viewport = $('meta[name="viewport"]').attr('content')?.trim();
    const charset = $('meta[charset]').attr('charset')?.trim();
    const robots = $('meta[name="robots"]').attr('content')?.trim();
    const ogTitle = $('meta[property="og:title"]').attr('content')?.trim();
    const ogDescription = $('meta[property="og:description"]').attr('content')?.trim();
    const ogImage = $('meta[property="og:image"]').attr('content')?.trim();
    const twitterCard = $('meta[name="twitter:card"]').attr('content')?.trim();
    const host = new URL(pageUrl).hostname.replace(/^www\./, '');
    const brandToken = host.split('.')[0]?.toLowerCase() ?? '';
    const normalizedTitleToken = title.toLowerCase().replace(/[^a-z0-9]/g, '');
    const isBrandOnlyTitle = config.seo.allowBrandTitleLeniency && Boolean(brandToken) && normalizedTitleToken === brandToken;

    if (!title) {
        addFinding(findings, 'error', 'seo', 'seo-title-missing', 'Missing <title>.');
    } else if (title.length < 20 || title.length > 70) {
        const level: FindingLevel = isBrandOnlyTitle ? 'info' : 'warn';
        addFinding(findings, level, 'seo', 'seo-title-length', `Title length is ${title.length} characters (recommended: 20-70).`);
    }

    if (!description) {
        const level: FindingLevel = isBrandOnlyTitle ? 'info' : 'warn';
        addFinding(findings, level, 'seo', 'seo-description-missing', 'Missing meta description (search engines may still generate snippets).');
    } else if (description.length < 50 || description.length > 160) {
        addFinding(
            findings,
            'warn',
            'seo',
            'seo-description-length',
            `Meta description length is ${description.length} characters (recommended: 50-160).`
        );
    }

    if (!canonical) {
        addFinding(findings, 'warn', 'seo', 'seo-canonical-missing', 'Missing canonical URL (<link rel="canonical">).');
    }

    if (!viewport) {
        addFinding(findings, 'warn', 'seo', 'seo-viewport-missing', 'Missing viewport meta tag.');
    }

    if (!charset) {
        addFinding(findings, 'warn', 'seo', 'seo-charset-missing', 'Missing charset meta declaration.');
    }

    if (robots?.toLowerCase().includes('noindex')) {
        addFinding(findings, 'warn', 'seo', 'seo-noindex', 'Meta robots includes noindex.');
    }

    if (!ogTitle || !ogDescription || !ogImage) {
        addFinding(findings, 'warn', 'seo', 'seo-open-graph-incomplete', 'Open Graph tags are incomplete (need og:title, og:description, og:image).');
    }

    if (!twitterCard) {
        addFinding(findings, 'info', 'seo', 'seo-twitter-card-missing', 'Missing twitter:card meta tag.');
    }

    if ($('link[rel="icon"], link[rel="shortcut icon"], link[rel="apple-touch-icon"], link[rel="mask-icon"], link[rel="manifest"]').length === 0) {
        addFinding(
            findings,
            'info',
            'seo',
            'seo-favicon-missing',
            'No explicit favicon link found (browser may still discover /favicon.ico).',
            'runtime-limited'
        );
    }
}

function runAccessibilityChecks($: ReturnType<typeof load>, findings: Finding[]): void {
    const lang = $('html').attr('lang')?.trim() ?? '';
    const h1Count = $('h1').length;

    if (!lang) {
        addFinding(findings, 'warn', 'accessibility', 'a11y-lang-missing', 'Missing lang attribute on <html>.');
    }

    if (h1Count === 0) {
        addFinding(findings, 'warn', 'accessibility', 'a11y-h1-missing', 'No <h1> found.');
    } else if (h1Count > 1) {
        addFinding(findings, 'warn', 'accessibility', 'a11y-h1-multiple', `Found ${h1Count} <h1> elements.`);
    }

    const headingLevels = $('h1, h2, h3, h4, h5, h6')
        .toArray()
        .map((element) => Number(element.tagName?.replace('h', '') ?? 0))
        .filter((level) => level >= 1 && level <= 6);

    for (let index = 1; index < headingLevels.length; index += 1) {
        const previous = headingLevels[index - 1];
        const current = headingLevels[index];

        if (previous == null || current == null) {
            continue;
        }

        if (current - previous > 1) {
            addFinding(findings, 'warn', 'accessibility', 'a11y-heading-skip', `Heading level jumps from h${previous} to h${current}.`);
            break;
        }
    }

    const imagesMissingAlt = $('img').filter((_, image) => $(image).attr('alt') == null).length;
    if (imagesMissingAlt > 0) {
        addFinding(
            findings,
            'error',
            'accessibility',
            'a11y-image-alt-missing',
            `${imagesMissingAlt} image${imagesMissingAlt === 1 ? '' : 's'} missing alt text.`
        );
    }

    const unnamedLinks = $('a[href]').filter((_, link) => !hasAccessibleName($, link)).length;
    if (unnamedLinks > 0) {
        addFinding(
            findings,
            'error',
            'accessibility',
            'a11y-link-name-missing',
            `${unnamedLinks} link${unnamedLinks === 1 ? '' : 's'} missing an accessible name.`
        );
    }

    const controlsMissingLabel = $('input, select, textarea').filter((_, control) => {
        const node = $(control);
        const tag = control.tagName?.toLowerCase() ?? '';
        const type = node.attr('type')?.toLowerCase() ?? '';

        if (tag === 'input' && ['hidden', 'submit', 'reset', 'button', 'image'].includes(type)) {
            return false;
        }

        const id = node.attr('id');
        const hasForLabel = id ? $(`label[for="${id}"]`).length > 0 : false;
        const hasParentLabel = node.parents('label').length > 0;
        const hasAriaLabel = Boolean(node.attr('aria-label')?.trim());
        const hasLabelledBy = Boolean(node.attr('aria-labelledby')?.trim());

        return !(hasForLabel || hasParentLabel || hasAriaLabel || hasLabelledBy);
    }).length;

    if (controlsMissingLabel > 0) {
        addFinding(
            findings,
            'error',
            'accessibility',
            'a11y-form-label-missing',
            `${controlsMissingLabel} form control${controlsMissingLabel === 1 ? '' : 's'} missing label association.`
        );
    }

    const unnamedButtons = $('button').filter((_, button) => !hasAccessibleName($, button)).length;
    if (unnamedButtons > 0) {
        addFinding(
            findings,
            'error',
            'accessibility',
            'a11y-button-name-missing',
            `${unnamedButtons} button${unnamedButtons === 1 ? '' : 's'} missing an accessible name.`
        );
    }

    const iframesMissingTitle = $('iframe').filter((_, iframe) => !($(iframe).attr('title')?.trim())).length;
    if (iframesMissingTitle > 0) {
        addFinding(
            findings,
            'warn',
            'accessibility',
            'a11y-iframe-title-missing',
            `${iframesMissingTitle} iframe${iframesMissingTitle === 1 ? '' : 's'} missing title.`
        );
    }

    const mainCount = $('main').length;
    if (mainCount === 0) {
        addFinding(findings, 'warn', 'accessibility', 'a11y-main-missing', 'Missing <main> landmark.');
    } else if (mainCount > 1) {
        addFinding(findings, 'warn', 'accessibility', 'a11y-main-multiple', `Found ${mainCount} <main> landmarks.`);
    }
}

async function runPerformanceChecks($: ReturnType<typeof load>, pageUrl: string, findings: Finding[], config: AuditConfig): Promise<void> {
    const scriptCount = $('script[src]').length;
    const blockingScripts = $('head script[src]').filter((_, script) => {
        const node = $(script);
        return !node.attr('async') && !node.attr('defer') && node.attr('type') !== 'module';
    }).length;
    const cssCount = $('link[rel="stylesheet"]').length;
    const lazyMissing = $('img').filter((_, image) => {
        const loading = $(image).attr('loading')?.toLowerCase();
        return loading !== 'lazy';
    }).length;
    const hasCustomLazyLoading = hasCustomLazyLoadingSignals($);

    if (scriptCount > 20) {
        addFinding(findings, 'warn', 'performance', 'perf-script-count-high', `High external script count (${scriptCount}).`);
    }

    if (blockingScripts > 0) {
        addFinding(
            findings,
            'warn',
            'performance',
            'perf-render-blocking-scripts',
            `${blockingScripts} script${blockingScripts === 1 ? '' : 's'} in <head> appear render-blocking (missing async/defer).`
        );
    }

    if (cssCount > 10) {
        addFinding(findings, 'warn', 'performance', 'perf-stylesheet-count-high', `High stylesheet count (${cssCount}).`);
    }

    if (lazyMissing > 0) {
        if (hasCustomLazyLoading && config.performance.respectCustomLazyLoadingSignals) {
            addFinding(
                findings,
                'info',
                'performance',
                'perf-image-lazy-loading-heuristic',
                `${lazyMissing} image${lazyMissing === 1 ? '' : 's'} without loading="lazy", but custom lazy-loading signals were detected.`,
                'runtime-limited'
            );
        } else {
            addFinding(
                findings,
                'info',
                'performance',
                'perf-image-lazy-loading',
                `${lazyMissing} image${lazyMissing === 1 ? '' : 's'} without loading="lazy".`,
                'runtime-limited'
            );
        }
    }

    const imageUrls = resolveImageUrls($, pageUrl);
    await runImageByteSizeChecks(imageUrls, findings, config);
}

function runSecurityChecks($: ReturnType<typeof load>, url: string, findings: Finding[]): void {
    const parsedUrl = new URL(url);

    if (parsedUrl.protocol !== 'https:') {
        addFinding(findings, 'warn', 'security', 'sec-https-missing', 'URL is not using HTTPS.');
    }

    const insecureResourceCount = $('script[src], link[href], img[src], iframe[src], video[src], audio[src]').filter((_, resource) => {
        const node = $(resource);
        const href = node.attr('href');
        const src = node.attr('src');
        const value = href ?? src ?? '';
        return value.startsWith('http://');
    }).length;

    if (insecureResourceCount > 0) {
        addFinding(
            findings,
            'error',
            'security',
            'sec-insecure-resource',
            `${insecureResourceCount} resource${insecureResourceCount === 1 ? '' : 's'} loaded over HTTP.`
        );
    }

    const targetBlankUnsafe = $('a[target="_blank"]').filter((_, link) => {
        const rel = ($(link).attr('rel') ?? '').toLowerCase();
        return !(rel.includes('noopener') || rel.includes('noreferrer'));
    }).length;

    if (targetBlankUnsafe > 0) {
        addFinding(
            findings,
            'warn',
            'security',
            'sec-target-blank-rel',
            `${targetBlankUnsafe} target="_blank" link${targetBlankUnsafe === 1 ? '' : 's'} missing rel="noopener" or rel="noreferrer".`
        );
    }

    const cspMeta = $('meta[http-equiv="Content-Security-Policy"]').attr('content')?.trim();
    if (!cspMeta) {
        addFinding(
            findings,
            'info',
            'security',
            'sec-csp-meta-missing',
            'No CSP meta tag detected (header-based CSP cannot be checked from HTML alone).',
            'runtime-limited'
        );
    }
}

function runTechnicalChecks($: ReturnType<typeof load>, findings: Finding[]): void {
    const idSet = new Set<string>();
    const duplicateIds = new Set<string>();

    $('[id]').each((_, element) => {
        const id = $(element).attr('id')?.trim();
        if (!id) {
            return;
        }

        if (idSet.has(id)) {
            duplicateIds.add(id);
            return;
        }

        idSet.add(id);
    });

    if (duplicateIds.size > 0) {
        addFinding(
            findings,
            'error',
            'technical',
            'tech-duplicate-ids',
            `Duplicate id values found (${Array.from(duplicateIds).slice(0, 5).join(', ')}${duplicateIds.size > 5 ? ', ...' : ''}).`
        );
    }

    const badHashLinks = $('a[href^="#"]').filter((_, link) => {
        const href = $(link).attr('href') ?? '';

        if (href === '#' || href.trim() === '') {
            return true;
        }

        const id = href.slice(1);
        return id.length === 0 || $(`#${id}`).length === 0;
    }).length;

    if (badHashLinks > 0) {
        addFinding(
            findings,
            'warn',
            'technical',
            'tech-bad-fragment-links',
            `${badHashLinks} fragment link${badHashLinks === 1 ? '' : 's'} point to missing targets or '#'.`
        );
    }

    const schemaCount = $('script[type="application/ld+json"]').length;
    if (schemaCount === 0) {
        addFinding(findings, 'info', 'technical', 'tech-structured-data-missing', 'No JSON-LD structured data detected.');
    }

    runCurrencyGapChecks($, findings);
}

async function collectAudit($: ReturnType<typeof load>, url: string, config: AuditConfig): Promise<AuditSummary> {
    const findings: Finding[] = [];

    runSeoChecks($, url, findings, config);
    runAccessibilityChecks($, findings);
    await runPerformanceChecks($, url, findings, config);
    runSecurityChecks($, url, findings);
    runTechnicalChecks($, findings);

    const title = $('title').first().text().trim();
    const description = $('meta[name="description"]').attr('content')?.trim() ?? '';

    return { title, description, findings };
}

function parseCliArgs(args: string[]): { url: string | null; profile: AuditProfile; minLevel: FindingLevel; showConfidence: boolean; json: boolean } {
    let url: string | null = null;
    let profile: AuditProfile = 'balanced';
    let minLevel: FindingLevel = 'info';
    let showConfidence = false;
    let json = false;
    const isAuditProfile = (value: string | undefined): value is AuditProfile => {
        return value === 'balanced' || value === 'strict' || value === 'enterprise';
    };
    const isFindingLevel = (value: string | undefined): value is FindingLevel => {
        return value === 'info' || value === 'warn' || value === 'error';
    };

    for (let index = 0; index < args.length; index += 1) {
        const value = args[index];

        if (!value) {
            continue;
        }

        if (value.startsWith('--profile=')) {
            const candidate = value.split('=')[1] as AuditProfile | undefined;
            if (isAuditProfile(candidate)) {
                profile = candidate;
                continue;
            }

            throw new Error('Invalid profile value. Use "balanced", "strict", or "enterprise".');
        }

        if (value === '--profile') {
            const candidate = args[index + 1] as AuditProfile | undefined;
            if (isAuditProfile(candidate)) {
                profile = candidate;
                index += 1;
                continue;
            }

            throw new Error('Missing or invalid value for --profile. Use "balanced", "strict", or "enterprise".');
        }

        if (value.startsWith('--min-level=')) {
            const candidate = value.split('=')[1] as FindingLevel | undefined;
            if (isFindingLevel(candidate)) {
                minLevel = candidate;
                continue;
            }

            throw new Error('Invalid min level. Use "info", "warn", or "error".');
        }

        if (value === '--min-level') {
            const candidate = args[index + 1] as FindingLevel | undefined;
            if (isFindingLevel(candidate)) {
                minLevel = candidate;
                index += 1;
                continue;
            }

            throw new Error('Missing or invalid value for --min-level. Use "info", "warn", or "error".');
        }

        if (value === '--show-confidence') {
            showConfidence = true;
            continue;
        }

        if (value === '--json') {
            json = true;
            continue;
        }

        if (value.startsWith('--')) {
            throw new Error(`Unknown option: ${value}`);
        }

        if (/^https?:\/\//i.test(value)) {
            if (url != null) {
                throw new Error(`Only one URL can be audited at a time. Received a second: ${value}`);
            }
            url = value;
            continue;
        }

        throw new Error(`Unexpected argument: ${value}`);
    }

    return { url, profile, minLevel, showConfidence, json };
}

async function audit(url: string, config: AuditConfig, reportOptions: ReportOptions, jsonMode: boolean): Promise<number> {
    const html = await fetchHtml(url);
    const $ = load(html);
    const summary = await collectAudit($, url, config);

    const visibleFindings = filterFindingsByMinLevel(summary.findings, reportOptions.minLevel);
    const counts = countFindingsByLevel(visibleFindings);
    const score = computeScore(visibleFindings);
    const grade = scoreToGrade(score);

    if (jsonMode) {
        const payload = {
            url,
            auditedAt: new Date().toISOString(),
            profile: config.profile,
            minLevel: reportOptions.minLevel,
            title: summary.title,
            description: summary.description,
            score,
            grade: grade.letter,
            counts,
            findings: visibleFindings
        };
        process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
        return counts.error;
    }

    const hostname = new URL(url).hostname;
    const domainSlug = hostname.replace(/[^a-z0-9]/gi, '-');
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:.]/g, '-');
    const outPath = `./reports/${domainSlug}-${stamp}.html`;

    const reportHtml = renderReport(url, summary, config, reportOptions);
    await mkdir('./reports', { recursive: true });
    await writeFile(outPath, reportHtml);

    console.log(`audited ${hostname} [${config.profile}] — ${counts.error} error${counts.error === 1 ? '' : 's'}, ${counts.warn} warning${counts.warn === 1 ? '' : 's'}, ${counts.info} info`);
    console.log(`report → ${outPath}`);
    return counts.error;
}

const cli = ((): ReturnType<typeof parseCliArgs> => {
    try {
        return parseCliArgs(process.argv.slice(2));
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`Argument error: ${message}`);
        console.error(USAGE);
        process.exit(1);
    }
})();

const { url, profile, minLevel, showConfidence, json } = cli;

if (!url) {
    console.error(USAGE);
    process.exit(1);
}

const config = PROFILE_CONFIGS[profile];
const reportOptions: ReportOptions = {
    minLevel,
    showConfidence
};

audit(url, config, reportOptions, json).then((errorCount) => {
    process.exit(errorCount > 0 ? 1 : 0);
}).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Audit failed: ${message}`);
    process.exit(2);
});
