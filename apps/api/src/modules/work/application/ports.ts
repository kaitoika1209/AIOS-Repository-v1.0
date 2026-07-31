import type { Work, WorkEvent, WorkState } from '../domain/work.js';

export interface WorkRepository {
  add(organizationId:string,work:Work):Promise<void>;
  get(organizationId:string,workId:string):Promise<WorkState|undefined>;
  save(organizationId:string,work:Work,expectedVersion:number):Promise<void>;
}
export interface WorkTransaction { transaction<T>(operation:()=>Promise<T>):Promise<T>; }
export interface WorkCommandLedger { result(commandId:string):Promise<unknown>; record(commandId:string,organizationId:string,commandType:string,result:unknown):Promise<void>; }
export interface WorkEventWriter { append(events:readonly WorkEvent[]):Promise<void>; }
export interface WorkAuthorizationAudit { record(input:{commandId:string;organizationId:string;workId:string;membershipId:string;permission:string;outcome:'Allow'|'Deny';reasonCode:string}):Promise<void>; }
export interface WorkClock { now():Date; }
export interface WorkIds { eventId():string; }
