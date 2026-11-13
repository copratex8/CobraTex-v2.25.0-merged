import React,{createContext,useContext,useEffect,useState,useRef,useCallback} from 'react';
const QC=createContext(null);
export class QueryClient{constructor(o){this.o=o;this.subs=new Set();this.cache=new Map()} invalidateQueries(){this.subs.forEach(f=>f());return Promise.resolve()} refetchQueries(){return this.invalidateQueries()} setQueryData(k,d){this.cache.set(JSON.stringify(k),d)} getQueryData(k){return this.cache.get(JSON.stringify(k))} removeQueries(){} cancelQueries(){return Promise.resolve()} prefetchQuery(){return Promise.resolve()} clear(){}}
export function QueryClientProvider({client,children}){return React.createElement(QC.Provider,{value:client},children)}
export function useQueryClient(){return useContext(QC)}
export function useQuery(opts){const qc=useContext(QC);const key=JSON.stringify(opts.queryKey);const enabled=opts.enabled!==false;
 const [st,setSt]=useState({data:undefined,error:null,status:enabled?'pending':'pending',fetching:enabled});const [tick,setTick]=useState(0);const optsRef=useRef(opts);optsRef.current=opts;
 useEffect(()=>{if(!enabled){setSt(s=>({...s,fetching:false}));return}let dead=false;setSt(s=>({...s,fetching:true}));
  Promise.resolve().then(()=>optsRef.current.queryFn({queryKey:optsRef.current.queryKey,signal:undefined})).then(d=>{if(!dead)setSt({data:d,error:null,status:'success',fetching:false})},e=>{if(!dead){console.error('[query-failed]',key,String(e&&e.message));setSt(s=>({data:undefined,error:e,status:'error',fetching:false}))}});return()=>{dead=true}},[key,enabled,tick]);
 useEffect(()=>{const f=()=>setTick(x=>x+1);qc&&qc.subs.add(f);return()=>qc&&qc.subs.delete(f)},[qc]);
 let data=st.data;if(data!==undefined&&opts.select)data=opts.select(data);if(data===undefined&&opts.placeholderData!==undefined)data=typeof opts.placeholderData==='function'?opts.placeholderData():opts.placeholderData;
 const refetch=useCallback(()=>{setTick(x=>x+1);return Promise.resolve()},[]);
 return {data,error:st.error,status:st.status,isLoading:st.status==='pending'&&st.fetching,isPending:st.status==='pending',isError:st.status==='error',isSuccess:st.status==='success',isFetching:st.fetching,refetch,fetchStatus:st.fetching?'fetching':'idle'}}
export function useMutation(opts){const qc=useContext(QC);const [st,setSt]=useState({status:'idle',error:null,data:undefined});
 const mutateAsync=useCallback(async(v,o2)=>{setSt({status:'pending',error:null,data:undefined});try{const d=await opts.mutationFn(v);setSt({status:'success',error:null,data:d});opts.onSuccess&&await opts.onSuccess(d,v);o2&&o2.onSuccess&&o2.onSuccess(d,v);return d}catch(e){setSt({status:'error',error:e,data:undefined});opts.onError&&opts.onError(e,v);o2&&o2.onError&&o2.onError(e,v);throw e}},[opts.mutationFn]);
 const mutate=useCallback((v,o2)=>{mutateAsync(v,o2).catch(()=>{})},[mutateAsync]);
 return {mutate,mutateAsync,status:st.status,isPending:st.status==='pending',isError:st.status==='error',isSuccess:st.status==='success',error:st.error,data:st.data,reset:()=>setSt({status:'idle',error:null,data:undefined})}}
