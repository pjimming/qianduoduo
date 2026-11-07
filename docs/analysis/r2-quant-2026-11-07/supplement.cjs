'use strict';
const fs=require('node:fs'), path=require('node:path'),z=require('node:zlib');
const {createHash}=require('node:crypto');
const root=path.resolve(__dirname,'../../..');
const src=require(path.join(root,'server/modules/r2-screening/source'));
const {openPublicBrowser}=require(path.join(root,'server/modules/r2-screening/product-list'));
const results=require('./results.json');
const {shares}=JSON.parse(z.gunzipSync(fs.readFileSync(path.join(__dirname,'evidence.json.gz'))));
const keys=new Set([...results.groups.flatMap(g=>g.allocations.map(a=>a.key)),...Object.values(results.rules_comparison).flat()]);
async function main(){
 const started_at=new Date().toISOString(),signal=AbortSignal.timeout(600000),browser=await openPublicBrowser(signal),records=[];
 const temp=path.join(__dirname,'pdf-temp');fs.mkdirSync(temp,{recursive:true});
 try{
  const cf=await src.createCfClient(browser.context,signal,{});
  const targets=shares.filter(p=>keys.has(p.channel+'/'+p.code));let next=0;
  await Promise.all(Array.from({length:4},async()=>{while(next<targets.length){
   const p=targets[next++],row={key:p.channel+'/'+p.code,requested_at:new Date().toISOString()};
   try{
    const doc=await cf('/api/ProductNotice/getSAProductExplain',null,{saaCod:p.channel,funCod:p.code});
    row.title=doc?.infoTitle;row.disclosure_date=doc?.addDate;row.url=doc?.prdCode===p.code?src.publicPdf(doc.content):null;
    if(!row.url) throw new Error('no_public_pdf');
    const response=await fetch(row.url,{redirect:'error',signal:AbortSignal.any([signal,AbortSignal.timeout(20000)])});
    if(!response.ok) throw new Error('HTTP '+response.status);
    const buffer=Buffer.from(await response.arrayBuffer());
    if(buffer.length>15000000||buffer.subarray(0,4).toString()!=='%PDF')throw new Error('invalid_pdf');
    row.sha256=createHash('sha256').update(buffer).digest('hex');
    row.sha256_encoding='raw_bytes'; row.bytes=buffer.length;row.file=p.channel+'-'+p.code+'.pdf';
    fs.writeFileSync(path.join(temp,row.file),buffer);
   }catch(e){row.error=e.message;}
   row.checked_at=new Date().toISOString();records.push(row);
  }}));
  fs.writeFileSync(path.join(__dirname,'supplement-index.json'),JSON.stringify({started_at,finished_at:new Date().toISOString(),records},null,2));
  console.log(JSON.stringify({requested:targets.length,downloaded:records.filter(r=>!r.error).length,errors:records.filter(r=>r.error)}));
 }finally{await browser.close();}
}
main().catch(e=>{console.error(e.stack);process.exitCode=1;});
