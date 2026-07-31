import type{Memory,MemoryContent,MemoryEvent,MemoryState}from'../domain/memory.js';
export interface WorkCompletedForMemory{readonly eventId:string;readonly organizationId:string;readonly workId:string;readonly workVersion:number;readonly workRevisionId:string;readonly completedAt:Date;readonly completedByMembershipId:string;}
export interface MemorySourceSnapshot{readonly snapshotId:string;readonly organizationId:string;readonly sourceWorkId:string;readonly workCompletedEventId:string;readonly workVersion:number;readonly workRevisionId:string;readonly content:Readonly<Record<string,unknown>>;readonly sourceHash:string;readonly capturedAt:Date;}
export type GenerationStatus='Pending'|'Generating'|'RetryPending'|'Generated'|'Failed'|'Abandoned';
export interface MemoryGenerationOperation{readonly operationId:string;readonly organizationId:string;readonly sourceWorkId:string;readonly sourceEventId:string;readonly sourceSnapshotId:string;readonly sourceSnapshotHash:string;readonly providerInputHash:string;readonly generationPolicyVersion:string;readonly promptPolicyVersion:string;readonly status:GenerationStatus;readonly attemptCount:number;readonly claimVersion:number;readonly lockedBy?:string|undefined;readonly lockedUntil?:Date|undefined;readonly nextAttemptAt?:Date|undefined;readonly memoryId?:string|undefined;readonly lastFailureCode?:string|undefined;}
export interface GenerationClaim{readonly operationId:string;readonly organizationId:string;readonly claimVersion:number;readonly lockedBy:string;readonly lockedUntil:Date;readonly sourceSnapshot:MemorySourceSnapshot;readonly providerInputHash:string;readonly generationPolicyVersion:string;readonly promptPolicyVersion:string;}
export interface MemoryCandidate{readonly schemaVersion:1;readonly content:MemoryContent;readonly sourceSnapshotId:string;readonly sourceSnapshotHash:string;readonly providerInputHash:string;readonly provider:string;readonly model:string;readonly promptPolicyVersion:string;readonly generationPolicyVersion:string;}
export interface MemoryRepository{get(organizationId:string,memoryId:string):Promise<MemoryState|undefined>;getByWork(organizationId:string,workId:string):Promise<MemoryState|undefined>;add(organizationId:string,memory:Memory):Promise<void>;save(organizationId:string,memory:Memory,expectedVersion:number):Promise<void>;}
export interface MemoryGenerationStore{
 initialize(event:WorkCompletedForMemory,input:{operationId:string;snapshotId:string;sourceHash:string;providerInputHash:string;generationPolicyVersion:string;promptPolicyVersion:string;capturedAt:Date}):Promise<MemoryGenerationOperation>;
 claim(organizationId:string,operationId:string,workerId:string,leaseUntil:Date,now:Date):Promise<GenerationClaim|undefined>;
 finalize(claim:GenerationClaim,memory:Memory,events:readonly MemoryEvent[],now:Date):Promise<void>;
 fail(claim:GenerationClaim,failure:{code:string;retryable:boolean;nextAttemptAt?:Date|undefined},now:Date):Promise<void>;
 abandon(organizationId:string,operationId:string,actorMembershipId:string,reason:string,idempotencyKey:string,now:Date):Promise<void>;
}
export interface MemorySourceReader{capture(event:WorkCompletedForMemory):Promise<Readonly<Record<string,unknown>>|undefined>;}
export interface MemoryProvider{generate(input:{source:Readonly<Record<string,unknown>>;sourceSnapshotId:string;sourceSnapshotHash:string;providerInputHash:string;promptPolicyVersion:string;generationPolicyVersion:string;signal:AbortSignal}):Promise<MemoryCandidate>;}
export interface MemoryReviewTransaction{transaction<T>(operation:()=>Promise<T>):Promise<T>;}
export interface MemoryReviewAuthorization{require(permission:'memory.edit'|'memory.submit'|'memory.review'|'memory.reopen',organizationId:string,membershipId:string):Promise<void>;}
export interface MemoryEventWriter{append(events:readonly MemoryEvent[]):Promise<void>;}
export interface MemoryIds{operationId():string;snapshotId():string;memoryId():string;eventId():string;revisionId():string;reviewId():string;hash(value:unknown):string;}
export interface MemoryClock{now():Date;}
export interface MemoryGenerationPorts{readonly store:MemoryGenerationStore;readonly source:MemorySourceReader;readonly provider:MemoryProvider;readonly ids:MemoryIds;readonly clock:MemoryClock;readonly workerId:string;readonly timeoutMs:number;readonly leaseMs:number;readonly maxAttempts:number;readonly generationPolicyVersion:string;readonly promptPolicyVersion:string;}
