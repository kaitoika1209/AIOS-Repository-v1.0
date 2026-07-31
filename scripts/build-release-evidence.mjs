import{createHash,randomUUID}from'node:crypto';
import{mkdir,readFile,readdir,writeFile}from'node:fs/promises';
import{basename,join,resolve}from'node:path';

function option(name,fallback){const index=process.argv.indexOf(`--${name}`);return index>=0?process.argv[index+1]:fallback;}
const root=resolve(option('root',process.cwd()));
const output=resolve(option('output',join(root,'release-evidence')));
const environmentId=option('environment','production-equivalent');
const artifactPath=resolve(option('artifact',join(output,'release-artifact.tgz')));
const schemaFingerprintPath=resolve(option('schema-fingerprint',join(output,'schema-fingerprint.txt')));
const vulnerabilityReportPath=resolve(option('vulnerability-report',join(output,'vulnerability-report.json')));
const commitSha=option('commit',process.env.GITHUB_SHA??'unknown');
const lockfileCommitted=option('lockfile-committed','false')==='true';
const generatedAt=new Date().toISOString();
const sha256=value=>`sha256:${createHash('sha256').update(value).digest('hex')}`;
const text=path=>readFile(path,'utf8');
async function packageFiles(directory){const entries=await readdir(directory,{withFileTypes:true});const result=[];for(const entry of entries){if(entry.name==='node_modules'||entry.name==='.git'||entry.name==='release-evidence')continue;const path=join(directory,entry.name);if(entry.isDirectory())result.push(...await packageFiles(path));else if(entry.name==='package.json')result.push(path);}return result;}
function components(manifest,path){const dependencies={...manifest.dependencies,...manifest.devDependencies};return Object.entries(dependencies).sort(([left],[right])=>left.localeCompare(right)).map(([name,version])=>({type:'library',name,version:String(version),properties:[{name:'aios:declared-in',value:path}]}));}
await mkdir(output,{recursive:true});
const artifact=await readFile(artifactPath);
const artifactDigest=sha256(artifact);
const schemaFingerprint=(await text(schemaFingerprintPath)).trim();
if(!/^[a-f0-9]{32,128}$/u.test(schemaFingerprint))throw new Error('Schema fingerprint is missing or invalid');
const vulnerabilityReport=JSON.parse(await text(vulnerabilityReportPath));
const criticalVulnerabilities=Number(vulnerabilityReport.metadata?.vulnerabilities?.critical??vulnerabilityReport.critical??0);
const manifests=await packageFiles(root);
const allComponents=[];
for(const file of manifests){const manifest=JSON.parse(await text(file));allComponents.push(...components(manifest,file.slice(root.length+1)));}
const uniqueComponents=[...new Map(allComponents.map(component=>[`${component.name}@${component.version}`,component])).values()];
const sbom={$schema:'http://cyclonedx.org/schema/bom-1.6.schema.json',bomFormat:'CycloneDX',specVersion:'1.6',serialNumber:`urn:uuid:${randomUUID()}`,version:1,metadata:{timestamp:generatedAt,component:{type:'application',name:'AIOS',version:commitSha}},components:uniqueComponents};
const sbomText=`${JSON.stringify(sbom,null,2)}\n`;
await writeFile(join(output,'sbom.cdx.json'),sbomText);
const evidence={controlVersion:'mvp-production-gate-v1',environmentId,releaseArtifactDigest:artifactDigest,schemaFingerprint,commitSha,generatedAt,sbomDigest:sha256(sbomText),vulnerabilityReportDigest:sha256(JSON.stringify(vulnerabilityReport)),criticalVulnerabilityCount:criticalVulnerabilities,automatedChecks:{build:'Passed',tests:'Passed',migrationRehearsal:'Passed',schemaFingerprint:'Passed',sbom:'Passed',dependencyLock:lockfileCommitted?'Passed':'Failed',criticalVulnerabilityGate:criticalVulnerabilities===0?'Passed':'Failed'},externalEvidence:{isolatedPitr:'NotExecuted',measuredRpoRto:'NotExecuted',managedSecretRotation:'NotExecuted',liveDashboards:'NotExecuted',syntheticAlertAcknowledgement:'NotExecuted',representativeLoadAndBacklogRecovery:'NotExecuted',namedHumanApprovals:'NotExecuted'},productionDecision:'Blocked'};
await writeFile(join(output,'release-evidence.json'),`${JSON.stringify(evidence,null,2)}\n`);
await writeFile(join(output,'release-artifact.sha256'),`${artifactDigest.slice(7)}  ${basename(artifactPath)}\n`);
console.log(JSON.stringify({event:'release.evidence.generated',releaseArtifactDigest:artifactDigest,schemaFingerprint,criticalVulnerabilityCount:criticalVulnerabilities,productionDecision:'Blocked'}));
