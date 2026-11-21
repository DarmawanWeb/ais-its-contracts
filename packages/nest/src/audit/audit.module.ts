import { Global, Module } from '@nestjs/common';

import { AuditService } from './audit.service.js';

/**
 * Audit trail (spec §7.3): {@link AuditService} publishes `audit.recorded.v1`
 * events. Global: import it once (in `AppModule`) and inject `AuditService`
 * in any feature module. Requires `NatsModule` (global) in the application.
 */
@Global()
@Module({
  providers: [AuditService],
  exports: [AuditService],
})
export class AuditModule {}
