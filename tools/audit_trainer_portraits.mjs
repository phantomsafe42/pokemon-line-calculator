// Read-only coverage audit. Optional owner worktrees are explicit inputs;
// this tool never writes generated datasets, assets, or runtime state.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {pathToFileURL, fileURLToPath} from 'node:url';
import {createDatasetContext, REQUIRED_DATASET_SOURCES} from '../src/adapters/standardized_dataset.js';
import {campaignTrainerGroups, trainerSpriteQuery, trainerPortraitParticipants} from '../src/ui/trainer_selector.js';

const arg = name => {const i=process.argv.indexOf(name); return i<0 ? null : process.argv[i+1];};
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const assets=arg('--asset-root');
if (!assets) throw Error('Pass --asset-root for the owning Assets worktree.');
await import(pathToFileURL(path.resolve(assets,'consumer/pokemon_asset_resolver.global.js')));
const release=path.resolve(assets,'release');
const resolver=globalThis.PokemonAssets.createResolver({baseUrl:'https://assets.invalid',fetch:async url=>{
  const target=path.resolve(release, '.'+new URL(url).pathname);
  if (!target.startsWith(release+path.sep)) return new Response('',{status:403});
  return fs.existsSync(target)?new Response(fs.readFileSync(target)):new Response('',{status:404});
}});
const generated=path.join(root,'src/generated/datasets');
const datasetRoot=arg('--dataset-root'), datasetExport=arg('--dataset-export');
if(datasetRoot&&datasetExport) throw Error('Choose one explicit Dataset input.');
const ownerRoots=new Map();
if(datasetRoot) for(const entry of fs.readdirSync(datasetRoot,{withFileTypes:true})) {
  if(!entry.isDirectory()) continue;
  const dir=path.join(datasetRoot,entry.name,'source-data'),manifest=path.join(dir,'dataset_manifest.json');
  if(fs.existsSync(manifest)) ownerRoots.set(JSON.parse(fs.readFileSync(manifest)).gameId,dir);
}
const checks=new Map(),games=[];
function leaves(trainer) {
  const participants=trainerPortraitParticipants(trainer);
  if(participants.length) return participants.flatMap(leaves);
  const identity=trainer.trainerVisualIdentity;
  if(identity?.status==='ambiguous'&&identity.alternatives?.length&&identity.alternatives.every(row=>row.status==='resolved'))
    return identity.alternatives.map(trainerVisualIdentity=>({trainerVisualIdentity}));
  return [trainer];
}
for(const game of fs.readdirSync(generated)) {
  if(datasetRoot&&!ownerRoots.has(game)) throw Error('Missing owning Dataset source: '+game);
  const base=datasetExport?path.join(datasetExport,'datasets',game):ownerRoots.get(game)||path.join(generated,game),read=f=>JSON.parse(fs.readFileSync(path.join(base,f)));
  const documents=Object.fromEntries([...REQUIRED_DATASET_SOURCES,'starter_selection.json'].filter(f=>fs.existsSync(path.join(base,f))).map(f=>[f,read(f)]));
  const dataset=createDatasetContext({manifest:read('dataset_manifest.json'),mechanics:read('battle_mechanics.json'),documents});
  const seen=new Map();
  for(const starter of [null,...(dataset.starterSelection?.choices||[]).map(c=>c.id)])
    for(const group of campaignTrainerGroups(dataset.trainerGroups(starter))) for(const trainer of group.trainers)
      for(const id of trainer.encounter?.enemySlotTrainerIds||[trainer.id]) seen.set(id,dataset.trainer(id));
  const missing=[],wild=[];let portraits=0;
  for(const trainer of seen.values()) {
    if(!trainer.trainerVisualParticipants?.length&&trainer.trainerVisualIdentity?.status==='inapplicable'
      &&(trainer.sourceType==='boss-wild'||(game==='volt-white-2r'&&['vw2r-trainer-0043','vw2r-trainer-0377'].includes(trainer.id)))) {
      wild.push({id:trainer.id,name:trainer.displayName}); continue;
    }
    const failures=[];
    for(const leaf of leaves(trainer)) {
      const query=trainerSpriteQuery(leaf);
      if(!query){failures.push({reason:leaf.trainerVisualIdentity?.status||'identity-absent'});continue;}
      const key=JSON.stringify(query);
      if(!checks.has(key)) checks.set(key,(async()=>{
        const result=await resolver.resolveAsset(query);
        if(result.status!=='ok') return result;
        const bytes=fs.readFileSync(path.join(release,result.path));
        if(createHash('sha256').update(bytes).digest('hex')!==result.sha256) throw Error('Asset digest mismatch: '+result.path);
        return result;
      })());
      const result=await checks.get(key);
      if(result.status==='ok') portraits++; else failures.push({query,reason:result.reason});
    }
    if(failures.length) missing.push({id:trainer.id,name:trainer.displayName,failures});
  }
  games.push({game,trainers:seen.size,portraits,missing,wild});
}
const report={schemaVersion:1,games:games.length,trainers:games.reduce((n,g)=>n+g.trainers,0),
  distinctQueries:checks.size,missingTrainers:games.reduce((n,g)=>n+g.missing.length,0),
  wildEncounters:games.reduce((n,g)=>n+g.wild.length,0),details:games};
if(arg('--output')) {const out=path.resolve(arg('--output'));fs.mkdirSync(path.dirname(out),{recursive:true});fs.writeFileSync(out,JSON.stringify(report,null,2)+'\n');}
console.log(JSON.stringify(report,null,2));
if(arg('--expect-missing')!==null&&report.missingTrainers!==Number(arg('--expect-missing'))) process.exitCode=1;
