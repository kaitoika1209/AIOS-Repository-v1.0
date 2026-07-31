export interface EligibleWork{readonly id:string;readonly organizationId:string;readonly eligibleAt:Date;}
export class FairScheduler{
 private readonly activeByOrganization=new Map<string,number>();
 constructor(private readonly globalLimit:number,private readonly organizationLimit:number,private activeGlobal=0){}
 select(items:readonly EligibleWork[]):readonly EligibleWork[]{const selected:EligibleWork[]=[];const ordered=[...items].sort((left,right)=>left.eligibleAt.getTime()-right.eligibleAt.getTime()||left.id.localeCompare(right.id));for(const item of ordered){if(this.activeGlobal+selected.length>=this.globalLimit)break;const already=(this.activeByOrganization.get(item.organizationId)??0)+selected.filter(candidate=>candidate.organizationId===item.organizationId).length;if(already>=this.organizationLimit)continue;selected.push(item);}return selected;}
 start(item:EligibleWork):void{if(this.activeGlobal>=this.globalLimit)throw new Error('Global concurrency exhausted');const count=this.activeByOrganization.get(item.organizationId)??0;if(count>=this.organizationLimit)throw new Error('Organization concurrency exhausted');this.activeGlobal+=1;this.activeByOrganization.set(item.organizationId,count+1);}
 finish(item:EligibleWork):void{const count=this.activeByOrganization.get(item.organizationId)??0;if(count<=0)throw new Error('Work was not active');this.activeGlobal-=1;if(count===1)this.activeByOrganization.delete(item.organizationId);else this.activeByOrganization.set(item.organizationId,count-1);}
}
