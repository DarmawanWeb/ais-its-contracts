import { Module } from '@nestjs/common';

import { AuditService } from './audit.service.js';

/**
 * Audit trail (spec §7.3): {@link AuditService} publishes `audit.recorded.v1`
 * events. Requires `NatsModule` (global) in the application.
 */
@Module({
  providers: [AuditService],
  exports: [AuditService],
})
export class AuditModule {}
