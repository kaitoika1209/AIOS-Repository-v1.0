import{describe,expect,it}from'vitest';
import{FairScheduler}from'./fair-scheduler.js';
import{baselineProfile,InvalidWorkerProfile,validateProfile}from'./runtime-profile.js';
import{retryDecision,retryProfiles}from'./retry.js';
import{evaluateSlo,UnsafeMetricDimensions,validateMetricDimensions}from'./telemetry.js';
describe('MVP Worker runtime',()=>{
 it('validates lease, concurrency, and database budgets',()=>{expect(validateProfile(baselineProfile)).toBe(baselineProfile);expect(()=>{validateProfile({...baselineProfile,roles:{...baselineProfile.roles,'memory-generation':{...baselineProfile.roles['memory-generation'],leaseMs:1000}}});}).toThrow(InvalidWorkerProfile);});
 it('calculates deterministic bounded full jitter and stops permanent failures',()=>{const input={profile:retryProfiles['memory-generation-v1'],category:'TransientExternalDependency' as const,operationIdentity:'operation-a',attemptCount:2,elapsedMs:1000,databaseNow:new Date(0)};expect(retryDecision(input)).toEqual(retryDecision(input));expect(retryDecision({...input,category:'PermanentSecurity'})).toEqual({retry:false});});
 it('keeps tenant concurrency fair while preserving oldest eligible order',()=>{const scheduler=new FairScheduler(3,1);const selected=scheduler.select([{id:'a-1',organizationId:'org-a',eligibleAt:new Date(0)},{id:'a-2',organizationId:'org-a',eligibleAt:new Date(1)},{id:'b-1',organizationId:'org-b',eligibleAt:new Date(2)},{id:'c-1',organizationId:'org-c',eligibleAt:new Date(3)}]);expect(selected.map(item=>item.id)).toEqual(['a-1','b-1','c-1']);});
 it('treats missing metrics as unknown and rejects tenant identifiers',()=>{expect(evaluateSlo({target:0.99,minimumVolume:10})).toEqual({state:'InsufficientData'});expect(()=>{validateMetricDimensions({organizationId:'org-a'});}).toThrow(UnsafeMetricDimensions);});
});
