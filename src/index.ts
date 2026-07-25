// Public library surface for @bkness/site-audit.
// Consumers import from here — internal helpers stay in ./audit.js.

// Runtime exports
export { runAudit, PROFILE_CONFIGS } from './audit.js';
export { renderReport } from './renderReport.js';

// Type exports
export type {
    AuditResult,
    AuditSummary,
    AuditConfig,
    ReportOptions,
    AuditProfile,
    Finding,
    FindingLevel,
    FindingCategory,
    Grade,
} from './audit.js';