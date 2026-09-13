/** Compose only explicitly reviewed Casual repairs; original native cells remain byte-identical. No provider operations. */
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CASUAL_POSTPROCESS_REPAIR_ID, collectCasualPostprocessRepairFiles } from './casual-postprocess-repair-provenance.mjs';
import { acquireLock, immutable, installCasualWindow, sha256 } from './casual-generation-transport.mjs';
import { CASUAL_SELECTIVE_REPAIR_ID as ID, CASUAL_REPAIR_TARGETS as TARGETS, collectCasualSelectiveRepairFiles } from './casual-selective-repair-provenance.mjs';
const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'..'),DIRECTORY=join(ROOT,'.artifacts/casual-generation-v1');
const PREPARATION=join(ROOT,'.artifacts/casual-selective-repair/merged-preparation-v2/preparation.json');
const SHA=/^[a-f0-9]{64}$/;
const fields=['animationName','qualityTier','frameWidth','frameHeight','frameCount','processingVersion','path','sha256','bytes','mime','rawPath','rawSha256','rawBytes','rawWidth','rawHeight','rawMime','animationFormat','gridCols','gridRows','derivativeId','uniqueFrameCount'];
const pick=(value,keys)=>Object.fromEntries(keys.filter(key=>value[key]!==undefined).map(key=>[key,value[key]]));
const jsonBytes=value=>Buffer.from(JSON.stringify(value,null,2)+'\n');
const read=(root,entry)=>{const path=resolve(root,entry.path);assert(path.startsWith(resolve(root)+'/'));const bytes=readFileSync(path);assert.equal(sha256(bytes),entry.sha256);if(entry.bytes!==undefined)assert.equal(bytes.length,entry.bytes);return bytes};
export function selectiveCompositionOptions(args){
 assert(args.every(arg=>arg==='--apply'||/^(--review=|--review-sha256=|--sheets-reviewed=|--confirm=)/.test(arg)));
 const get=name=>{const found=args.filter(arg=>arg.startsWith(`--${name}=`));assert(found.length<=1);return found[0]?.slice(name.length+3)};
 assert(get('review'));assert(SHA.test(get('review-sha256')??''),'Exact native review SHA required');const apply=args.includes('--apply');
 if(apply){assert.equal(get('confirm'),ID);assert(SHA.test(get('sheets-reviewed')??''),'Review the complete sheet-set hash before apply')}
 return{review:resolve(get('review')),reviewSha256:get('review-sha256'),apply,sheetsReviewed:get('sheets-reviewed')};
}
export async function composeCasualSelectiveRepair(args=process.argv.slice(2)){
 const options=selectiveCompositionOptions(args),reviewBytes=readFileSync(options.review);assert.equal(sha256(reviewBytes),options.reviewSha256);
 const review=JSON.parse(reviewBytes);assert.equal(review.schemaVersion,1);assert.equal(review.id,ID);
 const expected=Object.entries(TARGETS).flatMap(([animationName,numbers])=>numbers.map(uniqueFrame=>`${animationName}:${uniqueFrame}`)).sort();
 assert.deepEqual(review.frames.map(frame=>`${frame.animationName}:${frame.uniqueFrame}`).sort(),expected,'Every approved replacement needs one exact review');
 const manifestPath=join(DIRECTORY,'manifest.json'),manifestBytes=readFileSync(manifestPath),manifest=JSON.parse(manifestBytes);
 const prepared=JSON.parse(readFileSync(PREPARATION));assert(prepared.completed&&prepared.noPaidCalls&&prepared.noNetwork);assert.deepEqual(prepared.identity,manifest.identity);
 assert(!(manifest.derivatives??[]).some(item=>item.id===ID),'Selective repair already applied');
 for(const file of manifest.productFiles)assert.equal(sha256(readFileSync(join(ROOT,file.path))),file.sha256,'Product fingerprint must be audited before composition');
 const{installCanvasRuntime}=await import('../processor/src/canvasRuntime.ts');installCanvasRuntime();
 const{loadImage}=await import('../processor/node_modules/@napi-rs/canvas/index.js');
 const{composeGeminiRefinedSprite}=await import('../src/services/GeminiApi.ts');
 const processingVersion=Number(readFileSync(join(ROOT,'src/services/CharacterPipeline.ts'),'utf8').match(/export const SPRITE_PROCESSING_VERSION = (\d+)/)?.[1]);assert(processingVersion>0);
 const base=`derivatives/${ID}`,put=(path,bytes,mime)=>{immutable(join(DIRECTORY,path),bytes);return{path,sha256:sha256(bytes),bytes:bytes.length,mime}};
 const json=(path,value)=>put(path,jsonBytes(value),'application/json');
 const image=async bytes=>{const decoded=await loadImage(bytes);return{...put(`${base}/frames/${sha256(bytes)}.png`,bytes,'image/png'),width:decoded.width,height:decoded.height}};
 const originalManifest=put(`${base}/original-manifest.json`,read(dirname(PREPARATION),prepared.originalManifest),'application/json');
 const original=JSON.parse(read(DIRECTORY,originalManifest));
 const targetMap=put(`${base}/repair-target-map.json`,read(dirname(PREPARATION),prepared.targetMap),'application/json');
 const priorManifests=prepared.priorManifests.map(entry=>put(`${base}/history/manifest-${entry.sha256}.json`,read(dirname(PREPARATION),entry),'application/json'));
 const preparation=json(`${base}/preparation.json`,{...prepared,originalManifest,targetMap,priorManifests,priorPreparations:undefined});
 const changes=[],nativeFetch=globalThis.fetch,diagnostics=[],restore=installCasualWindow(diagnostics);
 try{
  globalThis.fetch=async()=>{throw Error('Selective finalizer forbids provider/network operations')};
  for(const animationName of Object.keys(TARGETS)){
   const group=prepared.groups.find(item=>item.animationName===animationName);assert(group);
   const current=manifest.sprites.find(item=>item.animationName===animationName&&item.qualityTier==='contender');assert.deepEqual(pick(current,fields),pick(group.championOriginal,fields),'Original Champion changed before composition');
   const raw=[],clean=[],frames=[];
   for(const item of group.frames){
    const originalRaw=await image(read(dirname(PREPARATION),item.raw)),originalClean=await image(read(dirname(PREPARATION),item.cleaned));
    const frame={uniqueFrame:item.uniqueFrame,playbackFrames:item.playbackFrames,originalRaw,originalClean,outputRaw:originalRaw,outputClean:originalClean};
    if(TARGETS[animationName].includes(item.uniqueFrame)){
     const selected=review.frames.find(value=>value.animationName===animationName&&value.uniqueFrame===item.uniqueFrame),directory=resolve(DIRECTORY,selected.resultDirectory);
     assert(directory.startsWith(DIRECTORY+'/review/'),'Receipts must remain inside reviewed generation artifacts');
     const plan=JSON.parse(readFileSync(join(directory,'plan.json')));assert.equal(sha256(JSON.stringify(plan)),selected.planSha256);assert(SHA.test(plan.fingerprint));assert.equal(plan.pose.sha256,item.pose.sha256);
     const renderResult=JSON.parse(readFileSync(join(directory,'render.result.json'))),cleanResult=JSON.parse(readFileSync(join(directory,'clean.result.json')));
     assert.equal(renderResult.planSha256,selected.planSha256);assert.equal(cleanResult.planSha256,selected.planSha256);assert.deepEqual(renderResult.parent,item.render);assert.deepEqual(cleanResult.parent,item.render);
     assert.equal(renderResult.image.sha256,selected.rawReviewedSha256);assert.equal(cleanResult.image.sha256,selected.cleanReviewedSha256);
     frame.outputRaw=await image(read(DIRECTORY,renderResult.image));frame.outputClean=await image(read(DIRECTORY,cleanResult.image));
     const receiptFields=['schemaVersion','id','step','planSha256','parent','target','image','requests'];
     const successful=renderResult.requests.filter(request=>request.status==='complete');assert.equal(successful.length,1);assert.equal(successful[0].requestSha256,plan.request.sha256);
     assert.deepEqual(plan.target,{animationName,qualityTier:'contender',uniqueFrame:item.uniqueFrame,playbackFrames:item.playbackFrames});
     assert.equal(plan.identity.sha256,manifest.sources.find(source=>source.kind===plan.identity.kind)?.sha256);
     frame.replacementReceipt={successfulRenderRequestId:successful[0].id,renderResult:pick(renderResult,receiptFields),cleanResult:pick(cleanResult,receiptFields),rawReviewedSha256:selected.rawReviewedSha256,cleanReviewedSha256:selected.cleanReviewedSha256,generationFingerprint:plan.fingerprint,generationProductFiles:plan.productFiles};
     if(renderResult.requests.length===2){
      assert.equal(animationName,'low_kick');assert.equal(item.uniqueFrame,4);
      const path=join(DIRECTORY,'archive/casual-pilot-unknown-recovery-v1/reconciliation.json'),bytes=readFileSync(path),proof=JSON.parse(bytes);
      const ledger=JSON.parse(readFileSync(join(DIRECTORY,'provider-ledger.json'))),unknown=renderResult.requests.find(request=>request.status==='unknown'),child=ledger.requests[successful[0].id];
      assert.equal(child.parentAttemptId,unknown.id);assert.equal(child.reconciliationId,'casual-pilot-unknown-recovery-v1');
      frame.replacementReceipt.reconciliation={id:'casual-pilot-unknown-recovery-v1',parentId:unknown.id,childId:successful[0].id,requestSha256:successful[0].requestSha256,parentOutcome:'unknown',maximumChildrenPerParent:1,exactBodyReplay:true,sourceSha256:sha256(bytes)};
      assert(proof); // The full archived proof stays private; sealed proof contains only immutable linkage/hashes.
     }
    }
    raw.push(read(DIRECTORY,frame.outputRaw).toString('base64'));clean.push(read(DIRECTORY,frame.outputClean).toString('base64'));frames.push(frame);
   }
   const result=await composeGeminiRefinedSprite({rawUniqueCells:raw,cleanedUniqueCells:clean,animName:animationName,frames:group.playbackFrameOrderOneBased.length,...(group.normalizationReference?{normalizationReference:group.normalizationReference}:{})});
   assert.equal(result.frameCount,group.playbackFrameOrderOneBased.length);
   const processedBytes=Buffer.from(result.imageBase64,'base64'),rawBytes=Buffer.from(result.rawBase64,'base64'),rawImage=await loadImage(rawBytes);
   const processed=put(`${base}/outputs/${animationName}-${sha256(processedBytes)}.png`,processedBytes,'image/png'),native=put(`${base}/outputs/${animationName}-raw-${sha256(rawBytes)}.png`,rawBytes,'image/png');
   const outputEntry={...pick(current,fields),...processed,processingVersion,rawPath:native.path,rawSha256:native.sha256,rawBytes:native.bytes,rawWidth:rawImage.width,rawHeight:rawImage.height,rawMime:'image/png',frameCount:result.frameCount,gridCols:result.gridCols,gridRows:result.gridRows,derivativeId:ID,uniqueFrameCount:group.uniqueFrameCount};
   changes.push({animationName,qualityTier:'contender',originalEntry:pick(current,fields),outputEntry,uniqueFrameCount:group.uniqueFrameCount,playbackFrameOrderOneBased:group.playbackFrameOrderOneBased,frames});
  }
 }finally{globalThis.fetch=nativeFetch;restore()}
 const compositionPaths=['src/services/GeminiApi.ts','src/services/SpritePostProcess.ts','src/services/AnimationProfiles.ts','src/services/FrameSequence.ts','src/services/AlphaMask.ts','processor/src/canvasRuntime.ts'];
 const proof={schemaVersion:1,id:ID,identity:manifest.identity,originalManifest,originalProductFingerprint:original.fingerprint,preparation,targetMap,compositionProductFiles:compositionPaths.map(path=>({path,sha256:sha256(readFileSync(join(ROOT,path)))})),
  walk9Review:{animationName:'walk',uniqueFrame:9,approved:true,originalPoseSha256:prepared.groups.find(g=>g.animationName==='walk').frames[8].pose.sha256,reason:'Preserve the lifted rear heel and passing step from Rookie; the previous Champion frame substituted a planted guard.'},changes,nativeReviewSha256:options.reviewSha256,providerCallsDuringComposition:0};
 const derivative={id:ID,...json(`${base}/provenance.json`,proof)};
 const next={...manifest,sprites:manifest.sprites.map(sprite=>sprite.qualityTier==='contender'?changes.find(change=>change.animationName===sprite.animationName)?.outputEntry??sprite:sprite),derivatives:[...(manifest.derivatives??[]),derivative]};
 const corrected=manifest.derivatives?.find(item=>item.id===CASUAL_POSTPROCESS_REPAIR_ID);
 if(corrected)collectCasualPostprocessRepairFiles({manifest:{...manifest,sprites:manifest.sprites.map(sprite=>pick(sprite,fields))},derivative:corrected,checkedJson:entry=>JSON.parse(read(DIRECTORY,entry)),includeMedia:entry=>read(DIRECTORY,entry),spriteFields:fields,pick});
 const validationView={...next,sprites:next.sprites.map(sprite=>{const prior=original.sprites.find(item=>item.animationName===sprite.animationName&&item.qualityTier===sprite.qualityTier);return pick(sprite.derivativeId==='casual-postprocess-repair-v1'?prior:sprite,fields)})};
 collectCasualSelectiveRepairFiles({manifest:validationView,derivative,checkedJson:entry=>JSON.parse(read(DIRECTORY,entry)),includeMedia:entry=>read(DIRECTORY,entry),spriteFields:fields,pick});
 const sheets=changes.map(change=>({animationName:change.animationName,processedSha256:change.outputEntry.sha256,rawSha256:change.outputEntry.rawSha256})),sheetsSha256=sha256(JSON.stringify(sheets));
 if(options.apply){assert.equal(options.sheetsReviewed,sheetsSha256);const release=acquireLock(DIRECTORY);try{assert.equal(sha256(readFileSync(manifestPath)),sha256(manifestBytes));immutable(join(DIRECTORY,'archive',ID,`manifest-before-${sha256(manifestBytes)}.json`),manifestBytes);next.updatedAt=new Date().toISOString();const path=`${manifestPath}.selective-apply-${process.pid}`;writeFileSync(path,jsonBytes(next),{flag:'wx',mode:0o600});renameSync(path,manifestPath)}finally{release()}}
 console.log(JSON.stringify({status:options.apply?'applied':'awaiting-composed-sheet-review',derivative,sheets,sheetsSha256,providerCalls:0},null,2));return{proof,sheets,sheetsSha256};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)composeCasualSelectiveRepair().catch(error=>{console.error(error.message);process.exitCode=1});
