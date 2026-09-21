import assert from 'node:assert/strict';
import test from 'node:test';
import { browseBox, emptyBoxQuery } from '../src/boxes/browse.js';
import { calculateStats } from '../src/adapters/combatant_ingest.js';
const stats = n => Object.fromEntries(['hp','atk','def','spa','spd','spe'].map(stat=>[stat,n]));
const species = {
  bulbasaur: {name:'Bulbasaur',num:1,types:['grass','poison'],baseStats:stats(50)},
  charmander: {name:'Charmander',num:4,types:['fire'],baseStats:stats(50)},
  missing: {name:'Unknown',types:[],baseStats:stats(50)}
};
const dataset = {get(kind,id) {return ({species,natures:{hardy:{},modest:{boostedStat:'spa',nerfedStat:'atk'}},abilities:{overgrow:{name:'Overgrow'},blaze:{name:'Blaze'}},items:{leftovers:{name:'Leftovers'}}})[kind]?.[id];}};
const record = (id,extra={}) => ({id,speciesId:'bulbasaur',displayName:'Bulbasaur',nickname:id,level:30,natureId:'hardy',abilityId:'overgrow',itemId:null,gender:'M',majorStatus:null,baseStats:stats(50),ivs:stats(31),evs:stats(0),moves:[{moveId:'tackle',name:'Tackle'}],...extra});
const records = [record('Alpha',{nickname:'Álpha',itemId:'leftovers',majorStatus:'tox'}),record('Beta',{speciesId:'charmander',displayName:'Charmander',level:40,abilityId:'blaze',gender:'F'}),record('Gamma',{natureId:'modest',ivs:stats(0),evs:stats(252),gender:'N'}),record('Delta',{speciesId:'missing',gender:null})];
const box={pokemonOrder:records.map(r=>r.id),pokemon:Object.fromEntries(records.map(r=>[r.id,r])),parties:{one:{pokemonIds:['Gamma','Alpha']}}};
const query = extra => browseBox(box,dataset,{...emptyBoxQuery(),...extra}).map(r=>r.id);
test('Box filters combine both types and record-specific fields',()=>{
  assert.deepEqual(query({type1:'grass',type2:'poison',ability:'overgrow',move:'tackle',gender:'M',status:'tox',item:'leftovers'}),['Alpha']);
  assert.deepEqual(query({type1:'grass',type2:'fire'}),[]);
  assert.deepEqual(query({gender:'N'}),['Gamma']); assert.deepEqual(query({gender:'unknown'}),['Delta']);
  assert.deepEqual(query({item:'none',status:'healthy',gender:'F'}),['Beta']);
  assert.deepEqual(query({move:'surf'}),[]);
  assert.deepEqual(query({search:'alpha leftovers tackle'}),['Alpha']);
  assert.deepEqual(query({search:'charmander blaze'}),['Beta']);
});
test('Box sorting uses calculated stats, stable ties, and puts missing dex last in either direction',()=>{
  assert.deepEqual(query({sort:'dex'}),['Alpha','Gamma','Beta','Delta']);
  assert.deepEqual(query({sort:'dex',direction:'desc'}),['Beta','Alpha','Gamma','Delta']);
  assert.deepEqual(query({sort:'level',direction:'desc'}),['Beta','Alpha','Gamma','Delta']);
  assert.deepEqual(query({sort:'name'}),['Alpha','Beta','Delta','Gamma']);
  for(const stat of ['hp','atk','def','spa','spd','spe']) {
    const expected=[...records].sort((a,b)=>calculateStats(b,dataset)[stat]-calculateStats(a,dataset)[stat]).map(r=>r.id);
    assert.deepEqual(query({sort:stat,direction:'desc'}),expected);
  }
});
test('Box browsing never changes canonical or Party order',()=>{
  const before=structuredClone(box);
  assert.deepEqual(query({direction:'desc'}),['Delta','Gamma','Beta','Alpha']);
  query({search:'grass',sort:'hp'}); query({sort:'level'});
  assert.deepEqual(box,before);
});
