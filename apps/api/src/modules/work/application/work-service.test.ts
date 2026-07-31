import { describe,expect,it,vi } from 'vitest';
import type { HumanMemberPrincipal } from '../../identity-organization/public.js';
import type { WorkState } from '../domain/work.js';
import type { WorkAuthorizationAudit,WorkCommandLedger,WorkEventWriter,WorkRepository } from './ports.js';
import { WorkConcurrencyConflict,WorkPermissionDenied,WorkService } from './work-service.js';

const principal:HumanMemberPrincipal={principalType:'HumanMember',principalId:'member-a',identityId:'human-a',membershipId:'member-a',organizationId:'org-a',roles:['Member']};
const started:WorkState={workId:'work-a',organizationId:'org-a',creator:{actorType:'HumanMember',identityId:'human-a',membershipId:'member-a'},status:'InProgress',details:{title:'M2',description:'',intendedOutcome:'Complete safely'},assignments:[],version:2,createdAt:new Date(0),updatedAt:new Date(0),startedAt:new Date(0),startedBy:{actorType:'HumanMember',identityId:'human-a',membershipId:'member-a'}};

function harness(state:WorkState=started){
  let saved=state; const results=new Map<string,unknown>(); const appended:unknown[]=[];
  const save=vi.fn((_organizationId:string,work:{state:WorkState},expected:number)=>{if(saved.version!==expected)return Promise.reject(new WorkConcurrencyConflict());saved=work.state;return Promise.resolve();});
  const repository:WorkRepository={add:(_organizationId,work)=>{saved=work.state;return Promise.resolve();},get:(organizationId,workId)=>Promise.resolve(saved.organizationId===organizationId&&saved.workId===workId?saved:undefined),save};
  const commands:WorkCommandLedger={result:(commandId)=>Promise.resolve(results.get(commandId)),record:(commandId,_organizationId,_type,result)=>{results.set(commandId,result);return Promise.resolve();}};
  const events:WorkEventWriter={append:(batch)=>{appended.push(...batch);return Promise.resolve();}};
  const audit:WorkAuthorizationAudit={record:()=>Promise.resolve()};
  let event=0; const service=new WorkService({transactions:{transaction:(operation)=>operation()},repository,commands,events,audit,clock:{now:()=>new Date('2026-07-31T00:00:00Z')},ids:{eventId:()=>`event-${String(++event)}`}});
  return {service,save,appended,state:()=>saved};
}

describe('WorkService',()=>{
  it('atomically completes Work and appends one WorkCompleted event',async()=>{const h=harness();await h.service.complete({commandId:'cmd-1',organizationId:'org-a',principal},{workId:'work-a',expectedVersion:2,completionSummary:'Done'});expect(h.state()).toMatchObject({status:'Completed'});expect(h.appended).toHaveLength(1);expect(h.appended[0]).toMatchObject({eventType:'WorkCompleted',aggregateVersion:3});});
  it('returns the stored result for a duplicate command without a second business effect',async()=>{const h=harness();const context={commandId:'cmd-1',organizationId:'org-a',principal};await h.service.complete(context,{workId:'work-a',expectedVersion:2});await h.service.complete(context,{workId:'work-a',expectedVersion:2});expect(h.save).toHaveBeenCalledTimes(1);expect(h.appended).toHaveLength(1);});
  it('rejects stale expected versions',async()=>{const h=harness();await expect(h.service.complete({commandId:'cmd-2',organizationId:'org-a',principal},{workId:'work-a',expectedVersion:1})).rejects.toBeInstanceOf(WorkConcurrencyConflict);});
  it('fails closed across Organizations before repository access',async()=>{const h=harness();await expect(h.service.complete({commandId:'cmd-3',organizationId:'org-b',principal},{workId:'work-a',expectedVersion:2})).rejects.toBeInstanceOf(WorkPermissionDenied);expect(h.save).not.toHaveBeenCalled();});
});
