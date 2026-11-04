import fs from 'node:fs';
const SR=44100,LEN=21,N=SR*LEN,B=0.75;const L=new Float32Array(N),R=new Float32Array(N),SL=new Float32Array(N),SR_=new Float32Array(N);
const midi=m=>440*2**((m-69)/12);let seed=7;const rnd=()=>{seed=(seed*1664525+1013904223)>>>0;return seed/2**32*2-1};
function put(i,v,pan,send){if(i<0||i>=N)return;const l=Math.cos((pan+1)*Math.PI/4),r=Math.sin((pan+1)*Math.PI/4);L[i]+=v*l;R[i]+=v*r;SL[i]+=v*l*send;SR_[i]+=v*r*send}
function piano(t,m,vel,pan=0,send=.4,decay=2.2){const f=midi(m),s=Math.floor(t*SR),n=Math.floor(SR*Math.min(decay*2.2,LEN-t));
  const h=[[1,1,1],[2,.28,.55],[3,.08,.33],[4,.025,.22]];
  for(let k=0;k<n;k++){const x=k/SR,a=Math.min(1,x/.009);let v=0;for(const [p,g,d] of h)v+=g*Math.exp(-x/(decay*d))*Math.sin(2*Math.PI*f*p*x*(1+.00012*p));put(s+k,v*a*vel,pan,send)}}
function pad(t,dur,ms,g){const s=Math.floor(t*SR),n=Math.floor(SR*Math.min(dur+1.2,LEN-t));for(const m of ms){const f=midi(m);const ph=[Math.random()*0+m,m*2.1];
  for(let k=0;k<n;k++){const x=k/SR,e=Math.min(1,x/.9)*Math.min(1,Math.max(0,(dur+1.2-x)/1.2));const tr=1+.12*Math.sin(2*Math.PI*.22*x+m);
    const vl=Math.sin(2*Math.PI*f*.998*x+ph[0])+.25*Math.sin(2*Math.PI*f*2*.998*x);const vr=Math.sin(2*Math.PI*f*1.002*x+ph[1])+.25*Math.sin(2*Math.PI*f*2*1.002*x);
    const i=s+k;if(i>=N)break;L[i]+=vl*e*g*tr;R[i]+=vr*e*g*tr;SL[i]+=vl*e*g*.45;SR_[i]+=vr*e*g*.45}}}
function bass(t,dur,m,g){const f=midi(m),s=Math.floor(t*SR),n=Math.floor(SR*Math.min(dur,LEN-t));for(let k=0;k<n;k++){const x=k/SR,e=Math.min(1,x/.02)*Math.min(1,(dur-x)/.15);put(s+k,(Math.sin(2*Math.PI*f*x)+.18*Math.sin(4*Math.PI*f*x))*e*g*Math.exp(-x/2.2),0,.05)}}
function kick(t,g){const s=Math.floor(t*SR),n=Math.floor(SR*.34);let ph=0;for(let k=0;k<n;k++){const x=k/SR,f=46+50*Math.exp(-x/.035);ph+=2*Math.PI*f/SR;put(s+k,Math.sin(ph)*Math.exp(-x/.09)*Math.min(1,x/.003)*g,0,.08)}}
function shaker(t,g,pan){const s=Math.floor(t*SR),n=Math.floor(SR*.09);let prev=0;for(let k=0;k<n;k++){const x=k/SR,w=rnd(),hp=w-prev;prev=w;put(s+k,hp*Math.exp(-x/.018)*Math.min(1,x/.004)*g,pan,.2)}}
function tick(t,m,g){const f=midi(m),s=Math.floor(t*SR),n=Math.floor(SR*.12);for(let k=0;k<n;k++){const x=k/SR;put(s+k,(Math.sin(2*Math.PI*f*x)+.3*Math.sin(2*Math.PI*f*2.76*x)*Math.exp(-x/.01))*Math.exp(-x/.028)*Math.min(1,x/.0015)*g,.1,.55)}}
function bell(t,m,g,pan=0){const f=midi(m),s=Math.floor(t*SR),n=Math.floor(SR*Math.min(3.2,LEN-t));for(let k=0;k<n;k++){const x=k/SR,mod=Math.sin(2*Math.PI*f*2*x)*1.1*Math.exp(-x/.35);put(s+k,Math.sin(2*Math.PI*f*x+mod)*Math.exp(-x/.9)*Math.min(1,x/.006)*g,pan,.8)}}
function swell(t,dur,g){const s=Math.floor(t*SR),n=Math.floor(SR*dur);let lp=0;for(let k=0;k<n;k++){const x=k/dur/SR,c=.012+.05*Math.sin(Math.PI*x);lp+=c*(rnd()-lp);const e=Math.sin(Math.PI*Math.min(1,x*1.15))**2;put(s+k,lp*e*g,Math.sin(x*3)*.3,.7)}}
// Harmony by beat, in D major: [start beat, length, root, chord tones]
const C=[[0,4,38,[62,66,69,73,76]],[4,4,35,[59,62,66,69,73]],[8,4,31,[55,59,62,66,69]],[12,4,33,[57,62,64,69,71]],[16,4,38,[62,66,69,73,76]],[20,4,31,[55,59,62,66,69]],[24,1,33,[57,61,64,69,71]],[25,3,38,[62,66,69,74,78]]];
for(const [b,len,root,ch] of C){const t=b*B,d=len*B;pad(t,d,ch.slice(0,4).map(m=>m-12),b<6?.012:.016);
  if(b>=4)bass(t,d,root+12,.11);
  const up=[ch[0]+12,ch[2]+12,ch[1]+12,ch[3]+12,ch[4]+12,ch[2]+12,ch[3]+12,ch[1]+12];
  const eighths=b>=8&&b<25;const step=eighths?.5:1;
  for(let q=0;q<len;q+=step){const bt=b+q;const i=Math.round(q/step);const accent=q%2===0?1:.72;const v=(b<4?.055:b<16?.06:.065)*accent*(i%2?.8:1);piano(bt*B,up[i%up.length],v,(i%2?.22:-.22),.42)}}
for(let b=6;b<25;b+=2)kick(b*B,.2);
for(let b=10;b<25;b++){shaker((b+.5)*B,.018,.25);if(b%2==0)shaker(b*B,.009,-.25)}
// Effects, in key and on the grid
piano(4*B,81,.075,.1,.6,1.6);            // selection released
tick(6*B,74,.05);swell(6*B,1.9,.16);     // Explain clicked, the veil falls
bell(10*B,78,.018,-.2);                  // explanation starts
tick(17*B,74,.045);                      // Visualize clicked
bell(19*B,81,.035,.15);bell(19*B+B/2,86,.022,-.15); // diagram appears
bell(22*B,74,.02);                       // this computer
for(const [i,m] of [50,62,69,74,78,81].entries())piano(25*B+i*.012,m,.11,(i-2.5)*.08,.6,3);
bell(25*B,86,.03,0);kick(25*B,.22);
// Shared room: Schroeder reverb on the send bus
function verb(x,tun){const out=new Float32Array(N);for(const [d,fb] of [[1557,.84],[1617,.83],[1491,.85],[1422,.84]]){const dl=d+tun,buf=new Float32Array(dl);let p=0,lp=0;for(let i=0;i<N;i++){const o=buf[p];lp=o*.55+lp*.45;buf[p]=x[i]+lp*fb;out[i]+=o*.25;p=(p+1)%dl}}
  for(const [d,g] of [[225,.5],[556,.5]]){const dl=d+tun,buf=new Float32Array(dl);let p=0;for(let i=0;i<N;i++){const b=buf[p],v=out[i];buf[p]=v+b*g;out[i]=b-v*g;p=(p+1)%dl}}return out}
const WL=verb(SL,0),WR=verb(SR_,23);let peak=0;const fadeAt=19.9;
for(let i=0;i<N;i++){const t=i/SR;let e=t>fadeAt?Math.cos(Math.PI/2*(t-fadeAt)/(LEN-fadeAt))**1.5:1;if(t<.04)e*=t/.04;for(const [a,w] of [[L,WL],[R,WR]]){a[i]=Math.tanh((a[i]+w[i]*.55)*e*1.1);peak=Math.max(peak,Math.abs(a[i]))}}
const norm=.84/peak;const pcm=Buffer.alloc(N*4);for(let i=0;i<N;i++){pcm.writeInt16LE(Math.round(L[i]*norm*32767),i*4);pcm.writeInt16LE(Math.round(R[i]*norm*32767),i*4+2)}
const h=Buffer.alloc(44);h.write('RIFF',0);h.writeUInt32LE(36+pcm.length,4);h.write('WAVEfmt ',8);h.writeUInt32LE(16,16);h.writeUInt16LE(1,20);h.writeUInt16LE(2,22);h.writeUInt32LE(SR,24);h.writeUInt32LE(SR*4,28);h.writeUInt16LE(4,32);h.writeUInt16LE(16,34);h.write('data',36);h.writeUInt32LE(pcm.length,40);
fs.writeFileSync('work/music.wav',Buffer.concat([h,pcm]));console.log('peak',peak.toFixed(3),'norm',norm.toFixed(3));
