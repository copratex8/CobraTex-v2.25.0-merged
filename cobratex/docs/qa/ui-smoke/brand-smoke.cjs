const http=require('http'),fs=require('fs'),path=require('path');const {chromium}=require('playwright');
const T='00000000-0000-4000-8000-0000000000a1';const seen=[];
const srv=http.createServer((q,r)=>{const u=new URL(q.url,'http://x');
 if(u.pathname.startsWith('/api')){const p=u.pathname.slice(4);seen.push(p+u.search);r.setHeader('content-type','application/json');
  if(p==='/public/brand')return r.end(u.searchParams.get('c')==='acme'?JSON.stringify({tenantId:T,brand:{appName:'مصنع أكمي',appNameEn:'Acme ERP',theme:{gold:'#123456'}}}):'{"tenantId":null,"brand":{}}');
  if(p==='/public/status')return r.end('{"status":"active"}');return r.end('{}');}
 let f=path.join('dist',u.pathname==='/'?'index.html':u.pathname);if(!fs.existsSync(f)||fs.statSync(f).isDirectory())f='dist/index.html';
 r.setHeader('content-type',{'.js':'text/javascript','.json':'application/json','.html':'text/html'}[path.extname(f)]||'application/octet-stream');r.end(fs.readFileSync(f));}).listen(8765,async()=>{
 const b=await chromium.launch();
 for(const [name,url] of [['with client link','/login?c=acme'],['plain link','/login']]){
  const ctx=await b.newContext();const pg=await ctx.newPage();const errs=[];pg.on('pageerror',e=>errs.push(e.message));
  await pg.goto('http://127.0.0.1:8765'+url);await pg.waitForTimeout(800);
  const title=await pg.title();const gold=await pg.evaluate(()=>getComputedStyle(document.documentElement).getPropertyValue('--gold').trim());
  const fields=await pg.locator('input').count();const txt=(await pg.evaluate(()=>document.getElementById('root').innerText)).replace(/\n/g,' ').slice(0,110);
  const saved=await pg.evaluate(()=>localStorage.getItem('cobratex_client_slug'));
  console.log(name,'| title:',title,'| --gold:',gold,'| inputs:',fields,'| saved slug:',saved,'| errors:',errs.length);console.log('   ',txt);
  if(name==='with client link'){await pg.goto('http://127.0.0.1:8765/login');await pg.waitForTimeout(600);console.log('   after revisit w/o query → title:',await pg.title());}
  await ctx.close();}
 console.log([...new Set(seen.filter(x=>x.startsWith('/public/brand')))].join('\n'));await b.close();srv.close();});
