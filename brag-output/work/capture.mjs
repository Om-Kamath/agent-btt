import { createRequire } from 'node:module';import fs from 'node:fs';
const require=createRequire('/private/tmp/claude-501/-Users-omkamath-Documents-PersonalProject-agent-btt/217c7b07-0595-471f-b795-32a2f94498a3/scratchpad/e2e/x.js');const {chromium}=require('playwright');
const STEP=Number(process.argv[2]||1), OUT='work/app', FPS=30, LAST=Math.round(18.75*FPS)+3;
fs.mkdirSync(OUT,{recursive:true});
const A=JSON.parse(fs.readFileSync('work/answers.json'));const ID='bdfaa68d8984f0dc02beaca527b76f20';
const b=await chromium.launch({channel:'chrome',headless:true});
const ctx=await b.newContext({viewport:{width:1600,height:1000},deviceScaleFactor:2,colorScheme:'light'});
await ctx.addInitScript(id=>{
  localStorage.setItem('margin.lastPaper',id);
  const orig=window.fetch;const enc=new TextEncoder();
  window.__push=o=>window.__c.enqueue(enc.encode('data: '+JSON.stringify(o)+'\n\n'));
  window.__close=()=>window.__c.close();
  window.fetch=(u,o)=>String(u).includes('/ask')?Promise.resolve(new Response(new ReadableStream({start(c){window.__c=c}}),{status:200,headers:{'content-type':'text/event-stream'}})):orig(u,o);
  Element.prototype.scrollIntoView=function(){};
},ID);
const p=await ctx.newPage();const errs=[];p.on('pageerror',e=>errs.push(e.message));
await p.goto('http://127.0.0.1:8000/');await p.waitForSelector('.textLayer span',{timeout:20000});await p.waitForTimeout(600);
await p.evaluate(()=>{const r=document.querySelector('.reader');const g=document.querySelector('.page[data-page-number="4"]');r.scrollTop=g.offsetTop+120});
await p.waitForSelector('.page[data-page-number="4"] .textLayer span',{timeout:15000});await p.waitForTimeout(1500);
await p.addStyleTag({content:'*{cursor:none!important} .hint{display:none!important}'});
const ends=await p.evaluate(()=>{const spans=[...document.querySelectorAll('.page[data-page-number="4"] .textLayer span')];
  const pos=(re,last)=>{for(const e of spans){const t=e.firstChild;if(!t||t.nodeType!==3)continue;const m=t.data.match(re);if(!m)continue;const r=document.createRange();r.setStart(t,m.index);r.setEnd(t,m.index+m[0].length);const c=r.getBoundingClientRect();return {x:last?c.right:c.left,y:c.top+c.height/2}}return null};
  return {start:pos(/We compute the dot/,false),end:pos(/^\s*values\./,true)}});
console.log('selection ends',JSON.stringify(ends));
const ease=x=>x<.5?2*x*x:1-Math.pow(-2*x+2,2)/2;const lerp=(a,b,x)=>a+(b-a)*x;
let cur={x:1300,y:760,down:false};const log=[];let moveA=null;
const moveTo=(x,y,t0,t1)=>{moveA={fx:cur.x,fy:cur.y,x,y,t0,t1}};
const sheetScroll={};let scrollA=null;
const fired=new Set();const at=async(t,when,fn)=>{if(t>=when-1e-6&&!fired.has(when)){fired.add(when);await fn()}};
const md=A.explain.markdown;const tok={from:7.5,to:9.6,sent:0};
const res=(a)=>({type:'result',markdown:a.markdown,visual:a.visual,check:a.check,caveat:a.caveat,sources:a.sources,via:{provider:'ollama',model:'gemma4:e4b',local:true}});
const sel=async()=>p.evaluate(()=>getSelection().toString().replace(/\s+/g,' '));
for(let i=0;i<=LAST;i++){const t=i/FPS;
  await at(t,1.2,async()=>moveTo(ends.start.x+1,ends.start.y,1.2,1.5));
  await at(t,1.5,async()=>{await p.mouse.move(ends.start.x+1,ends.start.y);await p.mouse.down();cur.down=true;moveTo(ends.end.x-1,ends.end.y,1.5,2.85)});
  await at(t,3.0,async()=>{await p.mouse.up();cur.down=false;await p.waitForSelector('.pill');console.log('selected:',await sel());
    const r=await p.evaluate(()=>{const c=document.querySelector('.pill button').getBoundingClientRect();return {x:c.left+c.width/2,y:c.top+c.height/2}});moveTo(r.x,r.y,3.3,4.3)});
  await at(t,4.5,async()=>{await p.mouse.down();await p.mouse.up();await p.waitForSelector('.sheet.open');});
  await at(t,4.6,async()=>{await p.evaluate(()=>__push({type:'step',agent:'coordinator'}));moveTo(1250,820,4.7,5.6)});
  await at(t,5.625,async()=>p.evaluate(()=>__push({type:'step',agent:'librarian'})));
  await at(t,6.75,async()=>p.evaluate(()=>__push({type:'step',agent:'tutor'})));
  if(t>=tok.from&&tok.sent<md.length){const want=Math.min(md.length,Math.round(md.length*Math.min(1,(t-tok.from)/(tok.to-tok.from))));const piece=md.slice(tok.sent,want);tok.sent=want;
    if(piece){await p.evaluate(s=>__push({type:'token',text:s}),piece);await p.waitForTimeout(95)}}
  await at(t,9.75,async()=>p.evaluate(()=>__push({type:'step',agent:'reviewer'})));
  await at(t,11.25,async()=>{await p.evaluate(r=>{__push(r);__close()},res(A.explain));await p.waitForTimeout(120);
    const r=await p.evaluate(()=>{const c=[...document.querySelectorAll('.chip')].find(x=>x.textContent==='Visualize').getBoundingClientRect();return {x:c.left+c.width/2,y:c.top+c.height/2}});moveTo(r.x,r.y,11.5,12.5)});
  await at(t,12.75,async()=>{await p.mouse.down();await p.mouse.up();await p.waitForTimeout(150)});
  await at(t,12.8,async()=>{await p.evaluate(()=>__push({type:'step',agent:'illustrator'}));moveTo(1040,700,12.9,13.6);
    const s=await p.evaluate(()=>{const b=document.querySelector('.sheet-body');const ts=[...document.querySelectorAll('.turn')];const c=ts[ts.length-1].getBoundingClientRect();const r=b.getBoundingClientRect();return {from:b.scrollTop,to:b.scrollTop+c.top-r.top-12}});scrollA={...s,t0:12.85,t1:13.65}});
  await at(t,14.25,async()=>{await p.evaluate(r=>{__push(r);__close()},res(A.visualize));await p.waitForSelector('.diagram svg',{timeout:15000});await p.waitForTimeout(120)});
  await at(t,16.5,async()=>moveTo(1320,900,16.5,17.2));
  if(scrollA&&t>=scrollA.t0){const x=ease(Math.min(1,(t-scrollA.t0)/(scrollA.t1-scrollA.t0)));await p.evaluate(v=>{document.querySelector('.sheet-body').scrollTop=v},lerp(scrollA.from,scrollA.to,x))}
  if(moveA&&t>=moveA.t0){const x=ease(Math.min(1,(t-moveA.t0)/(moveA.t1-moveA.t0)));cur.x=lerp(moveA.fx,moveA.x,x);cur.y=lerp(moveA.fy,moveA.y,x);await p.mouse.move(cur.x,cur.y)}
  await p.evaluate(vt=>new Promise(res=>{for(const a of document.getAnimations()){if(a.__s===undefined){a.__s=vt;a.pause()}a.currentTime=(vt-a.__s)*1000}requestAnimationFrame(()=>requestAnimationFrame(res))}),t);
  log.push({x:+cur.x.toFixed(1),y:+cur.y.toFixed(1),down:cur.down});
  if(i%STEP===0)await p.screenshot({path:OUT+'/'+String(i).padStart(4,'0')+'.jpg',type:'jpeg',quality:92});
}
fs.writeFileSync('work/cursor.json',JSON.stringify({ends,log}));console.log('errors',JSON.stringify(errs));await b.close();
