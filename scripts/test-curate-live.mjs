import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {execFileSync} from 'node:child_process';
import assert from 'node:assert/strict';
const config=JSON.parse(fs.readFileSync(new URL('./curate-live.config.json',import.meta.url)));
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'jash-curation-'));
try{
 const fixture=`#EXTM3U
#EXTINF:-1 tvg-language="Tamil",Bigboss 24/7 live-TAMIL
https://fixture.example/bb.m3u8
#EXTINF:-1 tvg-language="English",Star Sports 1 HD
https://fixture.example/star.mpd
#KODIPROP:inputstream.adaptive.license_type=clearkey
#KODIPROP:inputstream.adaptive.license_key=00112233445566778899aabbccddeeff:ffeeddccbbaa99887766554433221100
#EXTVLCOPT:http-user-agent=Fixture🙂
#EXTINF:-1 tvg-language="Tamil",Sony Sports Ten 4 Tamil
https://fixture.example/sony.m3u8
#EXTINF:-1 tvg-language="English",FanCode Match
https://fixture.example/fan.m3u8
#EXTINF:-1,Willow Cricket
https://fixture.example/willow.m3u8
#EXTINF:-1,Cricbuzz
https://fixture.example/cric.m3u8
#EXTINF:-1 tvg-language="Hindi",Sony Sports Ten 4
https://fixture.example/conflict.m3u8
#EXTINF:-1 tvg-language="Tamil",Star Sports 1 Hindi
https://fixture.example/hindi.m3u8
#EXTINF:-1 tvg-language="English",Star Sports Expired
https://fixture.example/expired.m3u8?exp=1600000000
#EXTINF:-1 tvg-language="English",Star Sports Raw
https://fixture.example/raw.ts
`;
 for(const s of config.sources){const p=path.join(temp,'sources',s.repo,s.file);fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,fixture);}
 execFileSync(process.execPath,[new URL('./curate-live.mjs',import.meta.url).pathname],{env:{...process.env,SOURCE_SNAPSHOT_DIR:path.join(temp,'sources'),OUTPUT_DIR:path.join(temp,'output')},stdio:'pipe'});
 const main=fs.readFileSync(path.join(temp,'output/jash-live.m3u'),'utf8'),review=fs.readFileSync(path.join(temp,'output/jash-review.m3u'),'utf8');
 assert.equal((main.match(/#EXTINF:/g)||[]).length,4);
 assert.equal((review.match(/#EXTINF:/g)||[]).length,2);
 assert(!/conflict\.m3u8|hindi\.m3u8|raw\.ts|expired\.m3u8/.test(main+review));
 assert(review.includes('Willow Cricket')&&review.includes('Cricbuzz'));
 assert(main.includes('#KODIPROP:inputstream.adaptive.license_key=')); // post-URL metadata retained
 assert(main.includes('http-user-agent=Fixture\n')); // emoji removed only from header
 assert(main.includes('Bigg Boss Tamil 24/7'));
 const stats=JSON.parse(fs.readFileSync(path.join(temp,'output/jash-live.stats.json')));
 assert(stats.dropped.duplicate>0&&stats.dropped.expired>0&&stats.dropped.regional>0);
 console.log('PASS: curator language conflict/exclusion, review, expiry, rawTS, duplicate and trailing DRM/header fixtures');
}finally{fs.rmSync(temp,{recursive:true,force:true});}
