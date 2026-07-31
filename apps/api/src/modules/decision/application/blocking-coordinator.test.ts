import{describe,expect,it,vi}from'vitest';
import type{HumanMemberPrincipal}from'../../identity-organization/public.js';
import type{WorkState}from'../../work/public.js';
import type{DecisionContent}from'../domain/decision.js';
import{RequestBlockingDecisionService}from'./blocking-coordinator.js';
const principal:HumanMemberPrincipal={principalType:'HumanMember',principalId:'member-a',identityId:'human-a',membershipId:'member-a',organizationId:'org-a',roles:['Member']};
const work:WorkState={workId:'work-a',organizationId:'org-a',creator:{actorType:'HumanMember',identityId:'human-a',membershipId:'member-a'},status:'InProgress',details:{title:'M3',description:'',intendedOutcome:'Reviewed'},assignments:[],version:2,createdAt:new Date(0),updatedAt:new Date(0),startedAt:new Date(0),startedBy:{actorType:'HumanMember',identityId:'human-a',membershipId:'member-a'},completionGate:{type:'NotRequired'}};
const content:DecisionContent={title:'Proceed?',summary:'Review',rationale:'Risk',proposal:'Proceed',supportingReferences:[]};
describe('RequestBlockingDecisionService',()=>{
 it('persists submitted Decision and matching Work Pending gate in one transaction',async()=>{let sequence=0;const add=vi.fn(()=>Promise.resolve());const save=vi.fn(()=>Promise.resolve());const service=new RequestBlockingDecisionService({transactions:{transaction:(operation)=>operation()},work:{getForUpdate:()=>Promise.resolve(work),save},decisions:{add,get:()=>Promise.resolve(undefined),save:()=>Promise.resolve()},commands:{result:()=>Promise.resolve(undefined),record:()=>Promise.resolve()},outbox:{appendDomain:()=>Promise.resolve(),appendWork:()=>Promise.resolve(),appendOutcome:()=>Promise.resolve()},clock:{now:()=>new Date()},ids:{eventId:()=>`e-${String(++sequence)}`,revisionId:()=>`r-${String(++sequence)}`,reviewId:()=>`v-${String(++sequence)}`,hash:()=>`hash`}});const result=await service.execute({commandId:'cmd',organizationId:'org-a',principal},{workId:'work-a',workExpectedVersion:2,decisionId:'decision-a',content});expect(add).toHaveBeenCalledTimes(1);expect(save).toHaveBeenCalledTimes(1);expect(result).toMatchObject({reference:{decisionId:'decision-a',revisionNumber:1}});});
});
