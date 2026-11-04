import { createRequire } from 'node:module';import fs from 'node:fs';import path from 'node:path';
const require=createRequire('/private/tmp/claude-501/-Users-omkamath-Documents-PersonalProject-agent-btt/217c7b07-0595-471f-b795-32a2f94498a3/scratchpad/e2e/x.js');const {chromium}=require('playwright');
const mode=process.argv[2];const W=path.resolve('work');const FPS=30,TOTAL=630;
const cursor=JSON.parse(fs.readFileSync('work/cursor.json')).log;
const b=await chromium.launch({channel:'chrome',headless:true,args:['--allow-file-access-from-files']});
const p=await (await b.newContext({viewport:{width:1920,height:1080},deviceScaleFactor:1,colorScheme:'light'})).newPage();
await p.goto('file://'+W+'/stage.html');await p.evaluate(c=>setCursor(c),cursor);
const frame=async(i,out)=>{const t=i/FPS,a=Math.min(i,566);await p.evaluate(([t,s])=>setFrame(t,s),[t,'app/'+String(a).padStart(4,'0')+'.jpg']);await p.screenshot({path:out,type:'jpeg',quality:96})};
if(mode==='stills'){fs.mkdirSync('work/stills',{recursive:true});for(const f of fs.readdirSync('work/stills'))fs.rmSync('work/stills/'+f);
  for(const [n,t] of process.argv.slice(3).entries())await frame(Math.round(+t*FPS),'work/stills/'+String(n).padStart(2,'0')+'.jpg')}
else{fs.mkdirSync('work/frames',{recursive:true});for(let i=0;i<TOTAL;i++)await frame(i,'work/frames/'+String(i).padStart(4,'0')+'.jpg')}
await b.close();
