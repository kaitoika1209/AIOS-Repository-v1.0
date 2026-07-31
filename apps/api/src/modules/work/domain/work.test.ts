import { describe,expect,it } from 'vitest';
import { Work,WorkInvariantViolation,type WorkActor,type WorkState } from './work.js';

const actor:WorkActor={actorType:'HumanMember',identityId:'human-a',membershipId:'member-a'};
const details={title:'Ship M2',description:'Vertical slice',intendedOutcome:'A Human can complete Work safely'};
let id=0;
const eventId=()=>`event-${String(++id)}`;
const at=(minute:number)=>new Date(`2026-07-31T00:${String(minute).padStart(2,'0')}:00.000Z`);

describe('Work lifecycle',()=>{
  it('executes Draft to InProgress to Completed and emits WorkCompleted once',()=>{
    const work=Work.create({workId:'work-a',organizationId:'org-a',actor,details,now:at(0),eventId});
    expect(work.state.status).toBe('Draft');
    work.start(actor,at(1)); work.complete(actor,'Done',at(2));
    expect(work.state).toMatchObject({status:'Completed',version:3,completionSummary:'Done'});
    expect(work.pullEvents().map(event=>event.eventType)).toEqual(['WorkCreated','WorkStarted','WorkCompleted']);
    expect(()=>{work.complete(actor,'Again',at(3));}).toThrow(WorkInvariantViolation);
    expect(work.pullEvents()).toHaveLength(0);
  });
  it.each([
    ['Draft','cancel'],['InProgress','complete'],['InProgress','cancel'],['WaitingForDecision','cancel'],
  ] as const)('allows the normative %s command %s',(status,command)=>{
    const state:WorkState={workId:'w',organizationId:'o',creator:actor,status,details,assignments:[],version:2,createdAt:at(0),updatedAt:at(0),...(status==='Draft'?{}:{startedAt:at(1),startedBy:actor})};
    const work=Work.rehydrate(state,eventId);
    if(command==='complete')work.complete(actor,undefined,at(2));else work.cancel(actor,'Stopped',at(2));
    expect(['Completed','Cancelled']).toContain(work.state.status);
  });
  it('rejects terminal mutation and duplicate assignment',()=>{
    const work=Work.create({workId:'w',organizationId:'o',actor,details,now:at(0),eventId});
    work.assign(actor,'member-b','Assignee',at(1));
    expect(()=>{work.assign(actor,'member-b','Assignee',at(2));}).toThrow(WorkInvariantViolation);
    work.cancel(actor,'Stopped',at(3));
    expect(()=>{work.updateDetails(actor,details,at(4));}).toThrow(WorkInvariantViolation);
  });
  it('does not provide any Decision or Secretary completion command',()=>{
    expect('completeFromDecision' in Work.prototype).toBe(false);
    expect('completeAsSecretary' in Work.prototype).toBe(false);
  });
});
