const allowedDimensions=new Set(['workerRole','consumerName','eventType','status','failureCategory','policyVersion','provider']);
const prohibitedDimensions=new Set(['organizationId','eventId','aggregateId','operationId','orderingKey','workerId','claimVersion','principalId']);
export class UnsafeMetricDimensions extends Error{}
export function validateMetricDimensions(dimensions:Readonly<Record<string,string>>):Readonly<Record<string,string>>{for(const[key,value]of Object.entries(dimensions)){if(prohibitedDimensions.has(key)||!allowedDimensions.has(key)||value.length===0||value.length>100)throw new UnsafeMetricDimensions(`Metric dimension is not bounded: ${key}`);}return dimensions;}
export type SloHealth={readonly state:'Healthy'|'Breached'|'InsufficientData';readonly ratio?:number|undefined};
export function evaluateSlo(input:{successful?:number|undefined;total?:number|undefined;target:number;minimumVolume:number}):SloHealth{if(input.successful===undefined||input.total===undefined||input.total<input.minimumVolume)return{state:'InsufficientData'};const ratio=input.total===0?0:input.successful/input.total;return{state:ratio>=input.target?'Healthy':'Breached',ratio};}
