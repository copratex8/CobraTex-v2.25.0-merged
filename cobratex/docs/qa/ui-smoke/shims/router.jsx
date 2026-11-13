import React,{createContext,useContext,useEffect,useState,useCallback,useMemo} from 'react';
const listeners=new Set(); const emit=()=>listeners.forEach(f=>f());
function useLoc(){const [,s]=useState(0);useEffect(()=>{const f=()=>s(x=>x+1);listeners.add(f);window.addEventListener('popstate',f);return()=>{listeners.delete(f);window.removeEventListener('popstate',f)}},[]);return {pathname:location.pathname,search:location.search,hash:location.hash,state:null,key:'k'}}
export function navigate(to,opts){ if(typeof to==='number'){history.go(to);return;} if(opts&&opts.replace) history.replaceState(null,'',to); else history.pushState(null,'',to); emit(); }
const Ctx=createContext({params:{},outlet:null});
export function BrowserRouter({children}){return children}
export function Route(){return null}
function build(children,base){const out=[];React.Children.forEach(children,c=>{if(!c||!c.props)return;const p=c.props;const full=p.path?p.path:null;out.push({path:full,element:p.element,children:build(p.children)});});return out}
function match(pattern,path){const a=pattern.split('/').filter(Boolean),b=path.split('/').filter(Boolean);if(a.length!==b.length)return null;const params={};for(let i=0;i<a.length;i++){if(a[i].startsWith(':'))params[a[i].slice(1)]=decodeURIComponent(b[i]);else if(a[i]!==b[i])return null}return params}
function find(nodes,path,chain){for(const n of nodes){const c=[...chain,n];if(n.path){const m=match(n.path,path);if(m&&!n.children.length)return {chain:c,params:m}}if(n.children.length){const r=find(n.children,path,c);if(r)return r}}return null}
export function Routes({children}){const loc=useLoc();const tree=useMemo(()=>build(children),[children]);const r=find(tree,loc.pathname,[]);
 if(!r) return React.createElement('div',{'data-testid':'no-route'},'NO ROUTE '+loc.pathname);
 let el=null;for(let i=r.chain.length-1;i>=0;i--){const n=r.chain[i];const inner=el;el=React.createElement(Ctx.Provider,{value:{params:r.params,outlet:inner}},n.element||React.createElement(Outlet));}
 return el}
export function Outlet(){return useContext(Ctx).outlet}
export function useParams(){return useContext(Ctx).params}
export function useLocation(){return useLoc()}
export function useNavigate(){return useCallback((to,o)=>navigate(to,o),[])}
export function Navigate({to,replace}){useEffect(()=>{navigate(to,{replace})},[to]);return null}
export function Link({to,children,onClick,replace,...r}){return React.createElement('a',{href:to,...r,onClick:e=>{onClick&&onClick(e);if(e.defaultPrevented||e.button||e.metaKey||e.ctrlKey||r.target)return;e.preventDefault();navigate(to,{replace})}},children)}
export function NavLink({to,children,className,style,end,...r}){const l=useLoc();const active=end?l.pathname===to:l.pathname===to||l.pathname.startsWith(to.replace(/\/$/,'')+'/');const st={isActive:active,isPending:false};return React.createElement(Link,{to,...r,className:typeof className==='function'?className(st):className,style:typeof style==='function'?style(st):style},typeof children==='function'?children(st):children)}
export function useSearchParams(){const l=useLoc();const sp=useMemo(()=>new URLSearchParams(l.search),[l.search]);const set=useCallback((n,o)=>{const v=typeof n==='function'?n(new URLSearchParams(location.search)):n;const s=new URLSearchParams(v).toString();navigate(location.pathname+(s?'?'+s:''),{replace:true})},[]);return [sp,set]}
