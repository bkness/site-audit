#!/usr/bin/env node
import { writeFile, mkdir } from 'node:fs/promises';
import {
    type AuditConfig,
    type AuditProfile,
    type FindingLevel,
    type ReportOptions,
    PROFILE_CONFIGS,
    runAudit,
} from './audit.js';
import { renderReport } from './renderReport.js';

const USAGE = 'Usage: npx tsx src/cli.ts <url> [--profile balanced|strict|enterprise] [--min-level info|warn|error] [--show-confidence] [--json]';

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

async function runWorkflow(url: string, config: AuditConfig, reportOptions: ReportOptions, jsonMode: boolean): Promise<number> {
    const result = await runAudit(url, config, reportOptions);

    if (jsonMode) {
        const payload = {
            url,
            auditedAt: result.auditedAt,
            profile: result.profile,
            minLevel: result.minLevel,
            title: result.summary.title,
            description: result.summary.description,
            score: result.score,
            grade: result.grade.letter,
            counts: result.counts,
            findings: result.visibleFindings
        };
        process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
        return result.counts.error;
    }

    const hostname = new URL(url).hostname;
    const domainSlug = hostname.replace(/[^a-z0-9]/gi, '-');
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:.]/g, '-');
    const outPath = `./reports/${domainSlug}-${stamp}.html`;

    const reportHtml = renderReport(url, result.summary, config, reportOptions);
    await mkdir('./reports', { recursive: true });
    await writeFile(outPath, reportHtml);

    console.log(`audited ${hostname} [${config.profile}] — ${result.counts.error} error${result.counts.error === 1 ? '' : 's'}, ${result.counts.warn} warning${result.counts.warn === 1 ? '' : 's'}, ${result.counts.info} info`);
    console.log(`report → ${outPath}`);

    return result.counts.error;
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

runWorkflow(url, config, reportOptions, json).then((errorCount) => {
    process.exit(errorCount > 0 ? 1 : 0);
}).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Audit failed: ${message}`);
    process.exit(2);
});
