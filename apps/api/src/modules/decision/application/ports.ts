import type{Decision,DecisionEvent,DecisionState}from'../domain/decision.js';
import type{Work,WorkEvent,WorkState}from'../../work/public.js';
export interface DecisionRepository{add(organizationId:string,decision:Decision):Promise<void>;get(organizationId:string,decisionId:string):Promise<DecisionState|undefined>;save(organizationId:string,decision:Decision,expectedVersion:number):Promise<void>;}
export interface CoordinatedWorkRepository{getForUpdate(organizationId:string,workId:string):Promise<WorkState|undefined>;save(organizationId:string,work:Work,expectedVersion:number):Promise<void>;}
export interface DecisionTransaction{transaction<T>(operation:()=>Promise<T>):Promise<T>;}
export interface DecisionCommandLedger{result(commandId:string):Promise<unknown>;record(commandId:string,organizationId:string,commandType:string,result:unknown):Promise<void>;}
export interface DecisionEventLedger{has(eventId:string,consumer:string):Promise<boolean>;record(eventId:string,consumer:string,organizationId:string,outcome:'Applied'|'TerminalNoOp'|'RejectedPoison',aggregateId:string):Promise<void>;}
export interface DecisionOutbox{appendDomain(events:readonly DecisionEvent[]):Promise<void>;appendWork(events:readonly WorkEvent[]):Promise<void>;appendOutcome(event:DecisionOutcomeOccurred):Promise<void>;}
export interface DecisionOutcomeOccurred{readonly eventId:string;readonly organizationId:string;readonly workId:string;readonly decisionId:string;readonly revisionNumber:number;readonly submittedSnapshotId:string;readonly decisionAggregateVersion:number;readonly outcome:'Approved'|'Rejected'|'Withdrawn';readonly resolvedByMembershipId:string;readonly resolvedAt:Date;}
export interface DecisionIds{eventId():string;revisionId():string;reviewId():string;hash(content:unknown):string;}
export interface DecisionClock{now():Date;}
