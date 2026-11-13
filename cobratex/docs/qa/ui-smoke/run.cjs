const http=require('http'),fs=require('fs'),path=require('path');
const {chromium}=require(process.env.PW||'playwright');
const FE='/home/claude/cobratex/frontend/src/App.tsx';
const routes=[...fs.readFileSync(FE,'utf8').matchAll(/path="([^"]+)"/g)].map(m=>m[1]).filter(p=>p!=='/login');
const ID='00000000-0000-4000-8000-000000000001';
const reqs=new Map();
const OV=JSON.parse(fs.existsSync('overrides.json')?fs.readFileSync('overrides.json','utf8'):'{}');
const SH=Object.entries(JSON.parse(fs.readFileSync('shapes.json','utf8')));
const FX=Object.assign({},...['fixtures1.json','fixtures2.json'].filter(f=>fs.existsSync(f)).map(f=>JSON.parse(fs.readFileSync(f,'utf8'))));
function mock(method,p){
  if(method!=='GET') return {};
  if(FX[p]!==undefined) return FX[p];
  for(const [k,v] of Object.entries(OV)) if(p.includes(k)) return v;
  for(const [re,k] of SH) if(new RegExp(re).test(p)) return k==='array'?[]:{data:[],page:1,pageSize:20,total:0,totalPages:0,unreadCount:0};
  if(process.env.DEF==='array') return [];
  const last=p.split('/').filter(Boolean).pop()||'';
  if(/^[0-9a-f-]{36}$/.test(last)) return {};
  return /(s|list|rows|items|history|ledger|summary)$/.test(last)?[]:{};
}
const srv=http.createServer((q,r)=>{
  const u=new URL(q.url,'http://x');
  if(u.pathname.startsWith('/api')){const p=u.pathname.slice(4);reqs.set(q.method+' '+p,(reqs.get(q.method+' '+p)||0)+1);r.setHeader('content-type','application/json');r.end(JSON.stringify(mock(q.method,p)));return;}
  let f=path.join('dist',u.pathname==='/'?'index.html':u.pathname);
  if(!fs.existsSync(f)||fs.statSync(f).isDirectory()) f='dist/index.html';
  const ext=path.extname(f);r.setHeader('content-type',{'.js':'text/javascript','.json':'application/json','.html':'text/html','.svg':'image/svg+xml','.png':'image/png'}[ext]||'application/octet-stream');r.end(fs.readFileSync(f));
}).listen(8765,async()=>{
  const b=await chromium.launch();const ctx=await b.newContext({viewport:{width:1280,height:900}});
  const tok='x.'+Buffer.from(JSON.stringify({userId:ID,branchIds:[ID]})).toString('base64')+'.y';
  await ctx.addInitScript(t=>{localStorage.setItem('cobratex_access_token',t);localStorage.setItem('cobratex_refresh_token','r')},tok);
  const results=[];
  for(const rt of routes){
    const url='http://127.0.0.1:8765'+rt.replace(/:[a-zA-Z]+/g,ID);
    const pg=await ctx.newPage();const errs=[];
    pg.on('pageerror',e=>errs.push('PAGEERROR '+String(e.message).slice(0,200)));
    pg.on('console',m=>{if(m.type()==='error'){const t=m.text();if(!/Failed to load resource/.test(t))errs.push('CONSOLE '+t.slice(0,200))}});
    try{await pg.goto(url,{waitUntil:'load',timeout:15000});await pg.waitForTimeout(700);}catch(e){errs.push('NAV '+e.message.slice(0,100))}
    const txt=(await pg.evaluate(()=>document.getElementById('root')?.innerText||'')).trim();
    const finalPath=new URL(pg.url()).pathname;
    results.push({route:rt,finalPath,textLen:txt.length,errs:[...new Set(errs)].slice(0,4),head:txt.slice(0,60).replace(/\n/g,' ')});
    await pg.close();
  }
  fs.writeFileSync('results.json',JSON.stringify(results,null,1));fs.writeFileSync('reqs.json',JSON.stringify([...reqs.keys()].sort(),null,0));
  await b.close();srv.close();
  const bad=results.filter(r=>r.errs.length||r.textLen<5||r.finalPath!==r.route.replace(/:[a-zA-Z]+/g,ID));
  console.log('routes',results.length,'problem',bad.length);
  for(const x of bad)console.log(x.route,'|',x.finalPath,'| len',x.textLen,'|',x.errs.join(' || '));
});
