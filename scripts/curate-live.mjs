#!/usr/bin/env node
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
const config=JSON.parse(fs.readFileSync(new URL('./curate-live.config.json',import.meta.url)));
const root=path.resolve(process.env.OUTPUT_DIR || '.');fs.mkdirSync(root,{recursive:true});
const local=process.env.SOURCE_SNAPSHOT_DIR;
const attrs=s=>Object.fromEntries([...s.matchAll(/([\w-]+)="([^"]*)"/g)].map(m=>[m[1].toLowerCase(),m[2]]));
function title(s){let quoted=false,at=-1;for(let i=0;i<s.length;i++){if(s[i]==='"')quoted=!quoted;if(s[i]===','&&!quoted)at=i;}return s.slice(at+1).trim().replace(/\s+by\s+@\S+/ig,'').replace(/\s+/g,' ');}
export function parse(text){
 const out=[];let row=null;
 const flush=()=>{if(row?.url)out.push(row);row=null;};
 for(const raw of text.split(/\r?\n/)){
  const l=raw.trim();
  if(l.startsWith('#EXTINF:')){flush();row={name:title(l),attrs:attrs(l),props:[]};}
  else if(row&&/^#(?:KODIPROP|EXTVLCOPT|EXTHTTP):/i.test(l))row.props.push(l);
  else if(row&&/^https?:\/\//i.test(l)&&!row.url)row.url=l;
 }
 flush();return out;
}
function safeProperty(l){
 // HTTP header values need Latin-1 even if the upstream author puts emoji in UA.
 const safe=v=>String(v).replace(/[^\t\x20-\xFF]/g,'').trim();
 if(/^#EXTVLCOPT:http-(?:user-agent|referrer|referer|cookie|extra-headers)=/i.test(l)){
  const at=l.indexOf('=');return l.slice(0,at+1)+safe(l.slice(at+1));
 }
 if(/^#EXTHTTP:/i.test(l)){
  try { const clean=o=>Object.fromEntries(Object.entries(o).map(([k,v])=>[k,v&&typeof v==='object'?clean(v):safe(v)]));return '#EXTHTTP:'+JSON.stringify(clean(JSON.parse(l.slice(l.indexOf(':')+1)))); } catch{return l;}
 }
 return l;
}

const regional=/\b(hindi|hin|telugu|tel|kannada|kan|malayalam|mal|bangla|bengali|marathi|gujarati|punjabi|urdu|bhojpuri|odia|assamese|arabic|spanish|sinhala|nepali)\b/i;
const tamil=/\b(tamil|tam|ta)\b/i,english=/\b(english|eng|en)\b/i;
function language(r){const tag=r.attrs['tvg-language']||'';const name=r.name;
 if(regional.test(name)||regional.test(tag))return {excluded:true,reason:'regional or conflicting language'};
 const named=tamil.test(name)?'Tamil':english.test(name)?'English':'';
 const tagged=tamil.test(tag)?'Tamil':english.test(tag)?'English':'';
 if(named&&tagged&&named!==tagged)return {reason:'conflicting Tamil/English metadata'};
 if(tag && !tagged)return {reason:'unrecognized language metadata'};
 return {value:named||tagged,reason:named||tagged?'':'no explicit Tamil/English label'};
}
function family(r,source){if(/bigg?\s*boss|biggboss/i.test(r.name))return 'Bigg Boss';if(/star\s*sports/i.test(r.name))return 'Star Sports';if(/sony\s*(?:sports\s*)?ten/i.test(r.name))return 'Sony Sports';if(/fan\s*code/i.test(r.name))return 'FanCode';if(/willow/i.test(r.name))return 'Willow';if(/cri[bc]buzz/i.test(r.name))return 'Cricbuzz';if(source.family==='FanCode')return 'FanCode';return '';}
function expired(r){const text=[r.url,...r.props].join(' ');for(const m of text.matchAll(/(?:exp|expires)(?:=|%3D)(\d{10})(?!\d)/ig))if(Number(m[1])*1000<Date.now()+60000)return true;return false;}
function render(r){const clean=v=>String(v).replace(/[\r\n"]/g,' ').replace(/,/g,'%2C');const group=r.review?'Review - language uncertain':r.family==='Bigg Boss'?'Bigg Boss Tamil 24/7':`Sports - ${r.family} - ${r.language}`;const name=r.family==='Bigg Boss'?'Bigg Boss Tamil 24/7':r.family==='FanCode'&&!/fan\s*code/i.test(r.name)?`FanCode - ${r.name}`:r.name;
 const a={'tvg-id':r.attrs['tvg-id']||'', 'tvg-name':name,'tvg-logo':r.attrs['tvg-logo']||'', 'group-title':group,...(r.language?{'tvg-language':r.language}:{})};return [`#EXTINF:-1 ${Object.entries(a).map(([k,v])=>`${k}="${clean(v)}"`).join(' ')},${name.replace(/,/g,' ')}`,...r.props.map(safeProperty),r.url].join('\n');}
const stats={generatedAt:new Date().toISOString(),sources:[],main:{},review:{},dropped:{regional:0,expired:0,duplicate:0,unsupported:0},playbackVerified:false};const main=[],review=[],seen=new Set();
for(const source of config.sources){try{let text;if(local)text=fs.readFileSync(path.join(local,source.repo,source.file),'utf8');else{const res=await fetch(`https://raw.githubusercontent.com/${source.repo}/HEAD/${source.file}`,{signal:AbortSignal.timeout(20000),headers:{'User-Agent':'jash-live-curator'}});if(!res.ok)throw Error(`HTTP ${res.status}`);text=await res.text();}if(!/#EXTINF:/i.test(text))throw Error('No playlist entries');const rows=parse(text);stats.sources.push({repo:source.repo,file:source.file,ok:true,parsed:rows.length});for(const r of rows){const f=family(r,source);if(!f)continue;const lang=language(r);if(lang.excluded){stats.dropped.regional++;continue;}if(f==='Bigg Boss'&&lang.value!=='Tamil')continue;if(expired(r)){stats.dropped.expired++;continue;}const stream=r.url.split('|')[0];if(!/^https:\/\//i.test(stream)||/\.(ts|flv|mkv|avi)(?:\?|$)/i.test(stream)){stats.dropped.unsupported++;continue;}const sig=crypto.createHash('sha256').update(stream+'|'+JSON.stringify(r.props)+'|'+f+'|'+(lang.value||'')).digest('hex');if(seen.has(sig)){stats.dropped.duplicate++;continue;}seen.add(sig);const entry={...r,family:f,language:lang.value||'',review:!lang.value,reason:lang.reason,source:{repo:source.repo,file:source.file}};if(entry.review)review.push(entry);else main.push(entry);}}catch(e){stats.sources.push({repo:source.repo,file:source.file,ok:false,error:e.name==='TimeoutError'?'timeout':String(e.message).slice(0,80)});}}
for(const rows of [main,review])rows.sort((a,b)=>(a.family==='Bigg Boss'?-1:b.family==='Bigg Boss'?1:config.families.indexOf(a.family)-config.families.indexOf(b.family))||a.language.localeCompare(b.language)||a.name.localeCompare(b.name));
for(const r of main){const k=r.family+(r.language?' / '+r.language:'');stats.main[k]=(stats.main[k]||0)+1;}for(const r of review)stats.review[r.family]=(stats.review[r.family]||0)+1;
if(!main.length||!stats.sources.some(s=>s.ok&&s.repo==='sportlive18/Sportlink-wtf')||!stats.sources.some(s=>s.ok&&s.repo==='maybetv/Jo'))throw Error('Insufficient source coverage; existing output preserved.');
// Missing Bigg Boss/families are reported, never invented or relabeled.
stats.missingFamilies=config.families.filter(f=>!main.some(r=>r.family===f));
const output=rows=>'#EXTM3U\n#PLAYLIST:JaSH - Tamil Bigg Boss and Tamil/English Sports\n#NOTE:Community source metadata only; playback and rights not independently verified.\n\n'+rows.map(render).join('\n\n')+'\n';
fs.writeFileSync(path.join(root,'jash-live.m3u'),output(main));fs.writeFileSync(path.join(root,'jash-review.m3u'),output(review));fs.writeFileSync(path.join(root,'jash-live.stats.json'),JSON.stringify(stats,null,2)+'\n');fs.writeFileSync(path.join(root,'jash-review.json'),JSON.stringify(review.map(r=>({name:r.name,family:r.family,reason:r.reason,source:r.source})),null,2)+'\n');
console.log(JSON.stringify({mainEntries:main.length,reviewEntries:review.length,main:stats.main,missingFamilies:stats.missingFamilies,sourcesOK:stats.sources.filter(s=>s.ok).length}));
