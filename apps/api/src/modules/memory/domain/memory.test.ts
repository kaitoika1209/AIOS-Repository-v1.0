import{describe,expect,it}from'vitest';
import{Memory,MemoryInvariantViolation,type MemoryContent}from'./memory.js';
const human={actorType:'HumanMember' as const,identityId:'human-a',membershipId:'member-a'};
const system={actorType:'System' as const,systemId:'memory-generation-v1'};
const content:MemoryContent={title:'Release retrospective',summary:'The release completed.',outcome:'Customers received the change.',lessonsObserved:['Use a canary'],unresolvedItems:[],additionalContext:''};
const provenance={sourceWorkId:'work-a',sourceSnapshotId:'snapshot-a',sourceSnapshotHash:'source-hash',generationOperationId:'operation-a',providerInputHash:'input-hash',provider:'provider-a',model:'model-a',promptPolicyVersion:'prompt-v1',generationPolicyVersion:'generation-v1'};
function memory(){let id=0;return Memory.generate({memoryId:'memory-a',organizationId:'org-a',content,provenance,actor:system,now:new Date(0),ids:{eventId:()=>`event-${String(++id)}`,revisionId:()=>`revision-${String(++id)}`,reviewId:()=>`review-${String(++id)}`,hash:()=>`hash-${String(++id)}`}});}
describe('Memory',()=>{
  it('requires Human submission and approval of the exact immutable revision',()=>{const item=memory();item.submit(human,new Date(1));expect(()=>item.edit(human,{...content,title:'changed'},new Date(2))).toThrow(MemoryInvariantViolation);item.approve(human,'Confirmed',new Date(3));expect(item.state).toMatchObject({status:'Approved',approvedAt:new Date(3)});expect(()=>item.reopen(human,new Date(4))).toThrow(MemoryInvariantViolation);expect(item.pullEvents().map(event=>event.eventType)).toEqual(['MemoryGenerated','MemorySubmittedForReview','MemoryApproved']);});
  it('reopens a rejected Memory as a new draft revision without changing provenance',()=>{const item=memory();item.submit(human,new Date(1));item.reject(human,'Missing context',new Date(2));item.reopen(human,new Date(3));expect(item.state).toMatchObject({status:'Generated',provenance});expect(item.state.revisions).toHaveLength(2);});
});
