function mk(cfg0){
  const reqI=[],resI=[];
  const inst={defaults:cfg0||{}, interceptors:{request:{use:f=>reqI.push(f)},response:{use:(ok,err)=>resI.push({ok,err})}}};
  async function call(method,url,data,cfg={}){
    let config={method,url,data,baseURL:(cfg0||{}).baseURL,headers:{...(cfg.headers||{})},params:cfg.params,responseType:cfg.responseType,...cfg};
    for(const f of reqI) config=await f(config)||config;
    const run=async()=>{
      const u=new URL((config.baseURL||'')+config.url, location.href);
      if(config.params) for(const [k,v] of Object.entries(config.params)) if(v!==undefined&&v!==null) u.searchParams.set(k,String(v));
      const isForm=typeof FormData!=='undefined'&&config.data instanceof FormData;
      const h={...config.headers}; if(config.data!==undefined&&!isForm&&!h['Content-Type']) h['Content-Type']='application/json';
      const r=await fetch(u,{method:config.method.toUpperCase(),headers:h,body:config.data===undefined?undefined:(isForm?config.data:JSON.stringify(config.data))});
      let d; if(config.responseType==='blob') d=await r.blob(); else {const t=await r.text(); try{d=t?JSON.parse(t):undefined}catch{d=t}}
      const resp={data:d,status:r.status,headers:Object.fromEntries(r.headers.entries()),config};
      if(!r.ok){const e=new Error('Request failed '+r.status);e.isAxiosError=true;e.response=resp;e.config=config;throw e;}
      return resp;
    };
    let p=run();
    for(const {ok,err} of resI) p=p.then(ok,err);
    return p;
  }
  for(const m of ['get','delete','head','options']) inst[m]=(u,c)=>call(m,u,undefined,c);
  for(const m of ['post','put','patch']) inst[m]=(u,d,c)=>call(m,u,d,c);
  inst.request=c=>call(c.method||'get',c.url,c.data,c);
  return inst;
}
const axios=mk({}); axios.create=mk; axios.isAxiosError=e=>!!(e&&e.isAxiosError);
export default axios; export const isAxiosError=axios.isAxiosError;
