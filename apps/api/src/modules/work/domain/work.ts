export type WorkStatus = 'Draft' | 'InProgress' | 'WaitingForDecision' | 'Completed' | 'Cancelled';
export type WorkActor = { readonly actorType: 'HumanMember'; readonly identityId: string; readonly membershipId: string };
export type WorkSystemActor = { readonly actorType:'System';readonly systemId:string };
export type DecisionGateReference={readonly decisionId:string;readonly revisionNumber:number;readonly submittedSnapshotId:string};
export type CompletionGate={readonly type:'NotRequired'}|({readonly type:'Pending'}&DecisionGateReference)|({readonly type:'Satisfied';readonly outcome:'Approved'}&DecisionGateReference)|({readonly type:'Unsatisfied';readonly outcome:'Rejected'|'Withdrawn'}&DecisionGateReference);
export type WorkDetails = { readonly title: string; readonly description: string; readonly intendedOutcome: string };
export type WorkAssignment = { readonly membershipId: string; readonly assignmentType: 'Owner' | 'Assignee' };
export type WorkEventType = 'WorkCreated' | 'WorkDetailsUpdated' | 'WorkAssignmentChanged' | 'WorkStarted' | 'WorkDecisionRequested' | 'WorkDecisionOutcomeRecorded' | 'WorkCompleted' | 'WorkCancelled';
export interface WorkEvent { readonly eventId: string; readonly eventType: WorkEventType; readonly organizationId: string; readonly workId: string; readonly aggregateVersion: number; readonly occurredAt: Date; readonly actor: WorkActor|WorkSystemActor; readonly payload: Readonly<Record<string, unknown>> }

export interface WorkState {
  readonly workId: string; readonly organizationId: string; readonly creator: WorkActor;
  readonly status: WorkStatus; readonly details: WorkDetails; readonly assignments: readonly WorkAssignment[];
  readonly version: number; readonly createdAt: Date; readonly updatedAt: Date;
  readonly startedAt?: Date | undefined; readonly startedBy?: WorkActor | undefined;
  readonly completedAt?: Date | undefined; readonly completedBy?: WorkActor | undefined; readonly completionSummary?: string | undefined;
  readonly cancelledAt?: Date | undefined; readonly cancelledBy?: WorkActor | undefined; readonly cancellationReason?: string | undefined;
  readonly completionGate?:CompletionGate|undefined;readonly activeBlockingDecision?:DecisionGateReference|undefined;readonly appliedDecisionEventIds?:readonly string[]|undefined;
}

export class WorkInvariantViolation extends Error {}
export class WorkAuthorityViolation extends Error {}

const validDetails = (details: WorkDetails): boolean => details.title.trim().length>0 && details.title.trim().length<=200 && details.intendedOutcome.trim().length>0 && details.intendedOutcome.length<=4000 && details.description.length<=20000;

export class Work {
  private events: WorkEvent[] = [];
  private constructor(private current: WorkState, private readonly eventId: () => string) {}

  static create(input: { workId: string; organizationId: string; actor: WorkActor; details: WorkDetails; now: Date; eventId: () => string }): Work {
    if (!validDetails(input.details)) throw new WorkInvariantViolation('Work details are invalid');
    const work = new Work({ workId:input.workId,organizationId:input.organizationId,creator:input.actor,status:'Draft',details:input.details,assignments:[],version:1,createdAt:input.now,updatedAt:input.now,completionGate:{type:'NotRequired'},appliedDecisionEventIds:[] },input.eventId);
    work.emit('WorkCreated',input.actor,input.now,{});
    return work;
  }
  static rehydrate(state: WorkState,eventId:()=>string): Work { return new Work(state,eventId); }
  get state(): WorkState { return this.current; }
  pullEvents(): readonly WorkEvent[] { const result=this.events; this.events=[]; return result; }

  updateDetails(actor:WorkActor,details:WorkDetails,now:Date):void { this.requireMutable(['Draft','InProgress']); if(!validDetails(details)) throw new WorkInvariantViolation('Work details are invalid'); this.bump({...this.current,details},'WorkDetailsUpdated',actor,now,{}); }
  assign(actor:WorkActor,membershipId:string,assignmentType:WorkAssignment['assignmentType'],now:Date):void { this.requireMutable(['Draft','InProgress','WaitingForDecision']); if(this.current.assignments.some(x=>x.membershipId===membershipId&&x.assignmentType===assignmentType)) throw new WorkInvariantViolation('Duplicate active assignment'); this.bump({...this.current,assignments:[...this.current.assignments,{membershipId,assignmentType}]},'WorkAssignmentChanged',actor,now,{membershipId,assignmentType}); }
  start(actor:WorkActor,now:Date):void { this.requireStatus('Draft'); if(!validDetails(this.current.details)) throw new WorkInvariantViolation('Work is not ready to start'); this.bump({...this.current,status:'InProgress',startedAt:now,startedBy:actor},'WorkStarted',actor,now,{}); }
  requestBlockingDecision(actor:WorkActor,reference:DecisionGateReference,now:Date):void{this.requireStatus('InProgress');if(this.current.activeBlockingDecision)throw new WorkInvariantViolation('A blocking Decision is already pending');const gate:CompletionGate={type:'Pending',...reference};this.bump({...this.current,status:'WaitingForDecision',completionGate:gate,activeBlockingDecision:reference},'WorkDecisionRequested',actor,now,reference);}
  recordDecisionOutcome(system:WorkSystemActor,input:DecisionGateReference&{readonly sourceEventId:string;readonly outcome:'Approved'|'Rejected'|'Withdrawn';readonly resolvedByMembershipId:string},now:Date):'Applied'|'Duplicate'{if((this.current.appliedDecisionEventIds??[]).includes(input.sourceEventId))return'Duplicate';this.requireStatus('WaitingForDecision');const active=this.current.activeBlockingDecision;if(!active||active.decisionId!==input.decisionId||active.revisionNumber!==input.revisionNumber||active.submittedSnapshotId!==input.submittedSnapshotId)throw new WorkInvariantViolation('Decision outcome does not match the active submitted snapshot');const gate:CompletionGate=input.outcome==='Approved'?{type:'Satisfied',outcome:'Approved',decisionId:input.decisionId,revisionNumber:input.revisionNumber,submittedSnapshotId:input.submittedSnapshotId}:{type:'Unsatisfied',outcome:input.outcome,decisionId:input.decisionId,revisionNumber:input.revisionNumber,submittedSnapshotId:input.submittedSnapshotId};this.bump({...this.current,status:'InProgress',completionGate:gate,activeBlockingDecision:undefined,appliedDecisionEventIds:[...(this.current.appliedDecisionEventIds??[]),input.sourceEventId]},'WorkDecisionOutcomeRecorded',system,now,input);return'Applied';}
  complete(actor:WorkActor,summary:string|undefined,now:Date):void { this.requireStatus('InProgress'); const gate=this.current.completionGate??{type:'NotRequired'};if(gate.type!=='NotRequired'&&gate.type!=='Satisfied')throw new WorkInvariantViolation('Completion Gate is not satisfied');this.bump({...this.current,status:'Completed',completedAt:now,completedBy:actor,completionSummary:summary},'WorkCompleted',actor,now,{completionSummary:summary??null,completionRecordId:this.eventId(),completionGate:gate}); }
  cancel(actor:WorkActor,reason:string,now:Date):void { this.requireMutable(['Draft','InProgress','WaitingForDecision']); if(!reason.trim()) throw new WorkInvariantViolation('Cancellation reason is required'); this.bump({...this.current,status:'Cancelled',activeBlockingDecision:undefined,cancelledAt:now,cancelledBy:actor,cancellationReason:reason.trim()},'WorkCancelled',actor,now,{reason:reason.trim()}); }

  private requireStatus(status:WorkStatus):void { if(this.current.status!==status) throw new WorkInvariantViolation(`Expected ${String(status)} Work`); }
  private requireMutable(statuses:readonly WorkStatus[]):void { if(!statuses.includes(this.current.status)) throw new WorkInvariantViolation('Work is terminal or command is invalid for its state'); }
  private bump(next:WorkState,type:WorkEventType,actor:WorkActor|WorkSystemActor,now:Date,payload:Readonly<Record<string,unknown>>):void { this.current={...next,version:this.current.version+1,updatedAt:now}; this.emit(type,actor,now,payload); }
  private emit(type:WorkEventType,actor:WorkActor|WorkSystemActor,occurredAt:Date,payload:Readonly<Record<string,unknown>>):void { this.events.push({eventId:this.eventId(),eventType:type,organizationId:this.current.organizationId,workId:this.current.workId,aggregateVersion:this.current.version,occurredAt,actor,payload}); }
}
