export const workModule = 'work' as const;
export { Work, WorkAuthorityViolation, WorkInvariantViolation } from './domain/work.js';
export type { CompletionGate,DecisionGateReference,WorkActor, WorkAssignment, WorkDetails, WorkEvent, WorkState, WorkStatus,WorkSystemActor } from './domain/work.js';
export { WorkService, WorkConcurrencyConflict, WorkNotFound, WorkPermissionDenied } from './application/work-service.js';
export { WorkApi } from './application/api.js';
export type { WorkAuthorizationAudit, WorkClock, WorkCommandLedger, WorkEventWriter, WorkIds, WorkRepository, WorkTransaction } from './application/ports.js';
