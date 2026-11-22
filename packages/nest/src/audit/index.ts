/**
 * Audit trail: `AuditModule`, `AuditService.record()` (best effort) and
 * `AuditService.enqueue()` (transactional outbox).
 *
 * @packageDocumentation
 */
export { AuditModule } from './audit.module.js';
export {
  type AuditEnqueueOptions,
  type AuditEntry,
  type AuditRequest,
  AuditService,
} from './audit.service.js';
