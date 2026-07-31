export const productionGates=['DomainAuthority','TenantIsolation','IdentityAuthorization','DataProtection','DatabaseMigration','AsyncCorrectness','Recovery','ObservabilityIncidentResponse','ReleaseSafety','CapacityDependencies']as const;
export type ProductionGate=typeof productionGates[number];
export type GateResult='Passed'|'Failed'|'NotExecuted';
export interface GateEvidence{readonly gate:ProductionGate;readonly controlVersion:'mvp-production-gate-v1';readonly result:GateResult;readonly environmentId:string;readonly releaseArtifactDigest:string;readonly schemaFingerprint:string;readonly evidenceReferences:readonly string[];readonly executedAt:Date;readonly expiresAt:Date;readonly humanOwner:string;readonly humanApprover?:string|undefined;readonly exceptionReference?:string|undefined;}
export interface GateException{readonly exceptionReference:string;readonly gate:ProductionGate;readonly expiresAt:Date;readonly approvedByHuman:string;readonly blastRadius:string;readonly compensatingControl:string;readonly remediation:string;readonly nonWaivableInvariantAffected:boolean;}
export interface ProductionDecision{readonly approved:boolean;readonly blockers:readonly string[];}
const sha256=/^sha256:[a-f0-9]{64}$/u;
const fingerprint=/^[a-f0-9]{32,128}$/u;
const placeholder=/(todo|tbd|placeholder|example|unknown|unassigned)/iu;

export function evaluateProductionReadiness(input:{readonly environmentId:string;readonly releaseArtifactDigest:string;readonly schemaFingerprint:string;readonly now:Date;readonly evidence:readonly GateEvidence[];readonly exceptions:readonly GateException[];readonly criticalVulnerabilityCount:number}):ProductionDecision{
 const blockers:string[]=[];
 if(input.environmentId.trim().length===0||placeholder.test(input.environmentId))blockers.push('Environment identity is missing or placeholder');
 if(!sha256.test(input.releaseArtifactDigest))blockers.push('Release artifact digest is not an immutable sha256 identity');
 if(!fingerprint.test(input.schemaFingerprint))blockers.push('Schema fingerprint is invalid');
 if(input.criticalVulnerabilityCount>0)blockers.push('Unresolved critical vulnerabilities exist');
 for(const gate of productionGates){const matching=input.evidence.filter(item=>item.gate===gate&&item.environmentId===input.environmentId&&item.releaseArtifactDigest===input.releaseArtifactDigest&&item.schemaFingerprint===input.schemaFingerprint);if(matching.length!==1){blockers.push(`${gate} must have exactly one matching evidence record`);continue;}const item=matching[0];if(item===undefined)continue;if(item.expiresAt.getTime()<=input.now.getTime())blockers.push(`${gate} evidence is expired`);if(item.evidenceReferences.length===0)blockers.push(`${gate} has no evidence references`);if(placeholder.test(item.humanOwner)||item.humanOwner.trim().length===0)blockers.push(`${gate} has no named Human owner`);if(item.result!=='Passed'){const exception=item.exceptionReference===undefined?undefined:input.exceptions.find(candidate=>candidate.exceptionReference===item.exceptionReference&&candidate.gate===gate);if(exception===undefined)blockers.push(`${gate} did not pass and has no valid exception`);else if(exception.expiresAt.getTime()<=input.now.getTime()||exception.nonWaivableInvariantAffected)blockers.push(`${gate} exception is expired or affects a non-waivable invariant`);}}
 return{approved:blockers.length===0,blockers};
}
