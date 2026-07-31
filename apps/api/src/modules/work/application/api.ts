import type { HumanMemberPrincipal } from '../../identity-organization/public.js';
import type { WorkDetails } from '../domain/work.js';
import type { WorkService } from './work-service.js';

export class WorkApi {
  constructor(private readonly service:WorkService){}
  create(principal:HumanMemberPrincipal,organizationId:string,request:{commandId:string;workId:string;details:WorkDetails}){return this.service.create({commandId:request.commandId,organizationId,principal},request);}
  update(principal:HumanMemberPrincipal,organizationId:string,request:{commandId:string;workId:string;expectedVersion:number;details:WorkDetails}){return this.service.update({commandId:request.commandId,organizationId,principal},request);}
  assign(principal:HumanMemberPrincipal,organizationId:string,request:{commandId:string;workId:string;expectedVersion:number;membershipId:string;assignmentType:'Owner'|'Assignee'}){return this.service.assign({commandId:request.commandId,organizationId,principal},request);}
  start(principal:HumanMemberPrincipal,organizationId:string,request:{commandId:string;workId:string;expectedVersion:number}){return this.service.start({commandId:request.commandId,organizationId,principal},request);}
  complete(principal:HumanMemberPrincipal,organizationId:string,request:{commandId:string;workId:string;expectedVersion:number;completionSummary?:string|undefined}){return this.service.complete({commandId:request.commandId,organizationId,principal},request);}
  cancel(principal:HumanMemberPrincipal,organizationId:string,request:{commandId:string;workId:string;expectedVersion:number;reason:string}){return this.service.cancel({commandId:request.commandId,organizationId,principal},request);}
  get(principal:HumanMemberPrincipal,organizationId:string,workId:string){return this.service.get(principal,organizationId,workId);}
}
