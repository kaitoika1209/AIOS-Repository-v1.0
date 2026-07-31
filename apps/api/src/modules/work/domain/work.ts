export type WorkStatus = 'Draft' | 'InProgress' | 'WaitingForDecision' | 'Completed' | 'Cancelled';
export type WorkActor = { readonly actorType: 'HumanMember'; readonly identityId: string; readonly membershipId: string };
export type WorkDetails = { readonly title: string; readonly description: string; readonly intendedOutcome: string };
export type WorkAssignment = { readonly membershipId: string; readonly assignmentType: 'Owner' | 'Assignee' };
export type WorkEventType = 'WorkCreated' | 'WorkDetailsUpdated' | 'WorkAssignmentChanged' | 'WorkStarted' | 'WorkCompleted' | 'WorkCancelled';
export interface WorkEvent { readonly eventId: string; readonly eventType: WorkEventType; readonly organizationId: string; readonly workId: string; readonly aggregateVersion: number; readonly occurredAt: Date; readonly actor: WorkActor; readonly payload: Readonly<Record<string, unknown>> }

export interface WorkState {
  readonly workId: string; readonly organizationId: string; readonly creator: WorkActor;
  readonly status: WorkStatus; readonly details: WorkDetails; readonly assignments: readonly WorkAssignment[];
  readonly version: number; readonly createdAt: Date; readonly updatedAt: Date;
  readonly startedAt?: Date | undefined; readonly startedBy?: WorkActor | undefined;
  readonly completedAt?: Date | undefined; readonly completedBy?: WorkActor | undefined; readonly completionSummary?: string | undefined;
  readonly cancelledAt?: Date | undefined; readonly cancelledBy?: WorkActor | undefined; readonly cancellationReason?: string | undefined;
}

export class WorkInvariantViolation extends Error {}
export class WorkAuthorityViolation extends Error {}

const requireHuman = (actor: WorkActor): void => { if (actor.actorType !== 'HumanMember') throw new WorkAuthorityViolation('Only a Human Member may change Work lifecycle'); };
const validDetails = (details: WorkDetails): boolean => details.title.trim().length>0 && details.title.trim().length<=200 && details.intendedOutcome.trim().length>0 && details.intendedOutcome.length<=4000 && details.description.length<=20000;

export class Work {
  private events: WorkEvent[] = [];
  private constructor(private current: WorkState, private readonly eventId: () => string) {}

  static create(input: { workId: string; organizationId: string; actor: WorkActor; details: WorkDetails; now: Date; eventId: () => string }): Work {
    requireHuman(input.actor);
    if (!validDetails(input.details)) throw new WorkInvariantViolation('Work details are invalid');
    const work = new Work({ workId:input.workId,organizationId:input.organizationId,creator:input.actor,status:'Draft',details:input.details,assignments:[],version:1,createdAt:input.now,updatedAt:input.now },input.eventId);
    work.emit('WorkCreated',input.actor,input.now,{});
    return work;
  }
  static rehydrate(state: WorkState,eventId:()=>string): Work { return new Work(state,eventId); }
  get state(): WorkState { return this.current; }
  pullEvents(): readonly WorkEvent[] { const result=this.events; this.events=[]; return result; }

  updateDetails(actor:WorkActor,details:WorkDetails,now:Date):void { this.requireMutable(['Draft','InProgress']); requireHuman(actor); if(!validDetails(details)) throw new WorkInvariantViolation('Work details are invalid'); this.bump({...this.current,details},'WorkDetailsUpdated',actor,now,{}); }
  assign(actor:WorkActor,membershipId:string,assignmentType:WorkAssignment['assignmentType'],now:Date):void { this.requireMutable(['Draft','InProgress','WaitingForDecision']); requireHuman(actor); if(this.current.assignments.some(x=>x.membershipId===membershipId&&x.assignmentType===assignmentType)) throw new WorkInvariantViolation('Duplicate active assignment'); this.bump({...this.current,assignments:[...this.current.assignments,{membershipId,assignmentType}]},'WorkAssignmentChanged',actor,now,{membershipId,assignmentType}); }
  start(actor:WorkActor,now:Date):void { this.requireStatus('Draft'); requireHuman(actor); if(!validDetails(this.current.details)) throw new WorkInvariantViolation('Work is not ready to start'); this.bump({...this.current,status:'InProgress',startedAt:now,startedBy:actor},'WorkStarted',actor,now,{}); }
  complete(actor:WorkActor,summary:string|undefined,now:Date):void { this.requireStatus('InProgress'); requireHuman(actor); this.bump({...this.current,status:'Completed',completedAt:now,completedBy:actor,completionSummary:summary},'WorkCompleted',actor,now,{completionSummary:summary??null,completionRecordId:this.eventId()}); }
  cancel(actor:WorkActor,reason:string,now:Date):void { this.requireMutable(['Draft','InProgress','WaitingForDecision']); requireHuman(actor); if(!reason.trim()) throw new WorkInvariantViolation('Cancellation reason is required'); this.bump({...this.current,status:'Cancelled',cancelledAt:now,cancelledBy:actor,cancellationReason:reason.trim()},'WorkCancelled',actor,now,{reason:reason.trim()}); }

  private requireStatus(status:WorkStatus):void { if(this.current.status!==status) throw new WorkInvariantViolation(`Expected ${status} Work`); }
  private requireMutable(statuses:readonly WorkStatus[]):void { if(!statuses.includes(this.current.status)) throw new WorkInvariantViolation('Work is terminal or command is invalid for its state'); }
  private bump(next:WorkState,type:WorkEventType,actor:WorkActor,now:Date,payload:Readonly<Record<string,unknown>>):void { this.current={...next,version:this.current.version+1,updatedAt:now}; this.emit(type,actor,now,payload); }
  private emit(type:WorkEventType,actor:WorkActor,occurredAt:Date,payload:Readonly<Record<string,unknown>>):void { this.events.push({eventId:this.eventId(),eventType:type,organizationId:this.current.organizationId,workId:this.current.workId,aggregateVersion:this.current.version,occurredAt,actor,payload}); }
}
