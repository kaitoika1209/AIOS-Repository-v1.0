export const decisionModule = 'decision' as const;
export{Decision,DecisionInvariantViolation}from'./domain/decision.js';
export type{DecisionContent,DecisionEvent,DecisionOutcome,DecisionReview,DecisionRevision,DecisionState,DecisionStatus,HumanDecisionActor,SubmittedDecisionReference}from'./domain/decision.js';
export{DecisionService,DecisionConcurrencyConflict,DecisionNotFound,DecisionPermissionDenied}from'./application/decision-service.js';
export{RequestBlockingDecisionService}from'./application/blocking-coordinator.js';
export{DecisionOutcomeConsumer}from'./application/outcome-consumer.js';
export type{CoordinatedWorkRepository,DecisionClock,DecisionCommandLedger,DecisionEventLedger,DecisionIds,DecisionOutbox,DecisionOutcomeOccurred,DecisionRepository,DecisionTransaction}from'./application/ports.js';
