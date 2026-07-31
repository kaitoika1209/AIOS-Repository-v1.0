import type { HumanMemberPrincipal } from '../../identity-organization/public.js';
import { Work, type WorkDetails, type WorkState } from '../domain/work.js';
import type { WorkAuthorizationAudit, WorkClock, WorkCommandLedger, WorkEventWriter, WorkIds, WorkRepository, WorkTransaction } from './ports.js';

export class WorkNotFound extends Error { constructor(){super('The resource was not found or is not available');} }
export class WorkConcurrencyConflict extends Error {}
export class WorkPermissionDenied extends Error { constructor(){super('The resource was not found or is not available');} }

type Dependencies={transactions:WorkTransaction;repository:WorkRepository;commands:WorkCommandLedger;events:WorkEventWriter;audit:WorkAuthorizationAudit;clock:WorkClock;ids:WorkIds};
type CommandContext={commandId:string;organizationId:string;principal:HumanMemberPrincipal};

export class WorkService {
  constructor(private readonly dependencies:Dependencies) {}

  create(context:CommandContext,input:{workId:string;details:WorkDetails}):Promise<unknown> {
    return this.execute(context,'CreateWork','work.create',input.workId,async()=>{
      const work=Work.create({workId:input.workId,organizationId:context.organizationId,actor:this.actor(context),details:input.details,now:this.dependencies.clock.now(),eventId:()=>this.dependencies.ids.eventId()});
      await this.dependencies.repository.add(context.organizationId,work); await this.dependencies.events.append(work.pullEvents()); return {workId:input.workId,version:work.state.version,status:work.state.status};
    });
  }
  update(context:CommandContext,input:{workId:string;expectedVersion:number;details:WorkDetails}):Promise<unknown>{return this.mutate(context,'UpdateWork','work.update',input.workId,input.expectedVersion,(work)=>work.updateDetails(this.actor(context),input.details,this.dependencies.clock.now()));}
  assign(context:CommandContext,input:{workId:string;expectedVersion:number;membershipId:string;assignmentType:'Owner'|'Assignee'}):Promise<unknown>{return this.mutate(context,'AssignWork','work.assign',input.workId,input.expectedVersion,(work)=>work.assign(this.actor(context),input.membershipId,input.assignmentType,this.dependencies.clock.now()));}
  start(context:CommandContext,input:{workId:string;expectedVersion:number}):Promise<unknown>{return this.mutate(context,'StartWork','work.start',input.workId,input.expectedVersion,(work)=>work.start(this.actor(context),this.dependencies.clock.now()));}
  complete(context:CommandContext,input:{workId:string;expectedVersion:number;completionSummary?:string|undefined}):Promise<unknown>{return this.mutate(context,'CompleteWork','work.complete',input.workId,input.expectedVersion,(work)=>work.complete(this.actor(context),input.completionSummary,this.dependencies.clock.now()));}
  cancel(context:CommandContext,input:{workId:string;expectedVersion:number;reason:string}):Promise<unknown>{return this.mutate(context,'CancelWork','work.cancel',input.workId,input.expectedVersion,(work)=>work.cancel(this.actor(context),input.reason,this.dependencies.clock.now()));}
  async get(principal:HumanMemberPrincipal,organizationId:string,workId:string):Promise<WorkState>{this.requireScope(principal,organizationId); const state=await this.dependencies.repository.get(organizationId,workId); if(!state)throw new WorkNotFound(); return state;}

  private mutate(context:CommandContext,type:string,permission:string,workId:string,expectedVersion:number,change:(work:Work)=>void):Promise<unknown>{
    return this.execute(context,type,permission,workId,async()=>{const state=await this.dependencies.repository.get(context.organizationId,workId);if(!state)throw new WorkNotFound();if(state.version!==expectedVersion)throw new WorkConcurrencyConflict();const work=Work.rehydrate(state,()=>this.dependencies.ids.eventId());change(work);await this.dependencies.repository.save(context.organizationId,work,expectedVersion);await this.dependencies.events.append(work.pullEvents());return {workId,version:work.state.version,status:work.state.status};});
  }
  private execute(context:CommandContext,type:string,permission:string,workId:string,operation:()=>Promise<unknown>):Promise<unknown>{
    this.requireScope(context.principal,context.organizationId);
    return this.dependencies.transactions.transaction(async()=>{const prior=await this.dependencies.commands.result(context.commandId);if(prior!==undefined)return prior;await this.dependencies.audit.record({commandId:context.commandId,organizationId:context.organizationId,workId,membershipId:context.principal.membershipId,permission,outcome:'Allow',reasonCode:'AUTHORIZED'});const result=await operation();await this.dependencies.commands.record(context.commandId,context.organizationId,type,result);return result;});
  }
  private requireScope(principal:HumanMemberPrincipal,organizationId:string):void {if(principal.principalType!=='HumanMember'||principal.organizationId!==organizationId)throw new WorkPermissionDenied();}
  private actor(context:CommandContext){return {actorType:'HumanMember' as const,identityId:context.principal.identityId,membershipId:context.principal.membershipId};}
}
