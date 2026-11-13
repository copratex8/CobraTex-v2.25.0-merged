const fs=require('fs'),path=require('path');
function walk(d,o=[]){for(const f of fs.readdirSync(d)){const p=path.join(d,f);fs.statSync(p).isDirectory()?walk(p,o):/\.tsx?$/.test(f)&&o.push(p)}return o}
const shapes={};
for(const f of walk('/home/claude/cobratex/frontend/src')){const s=fs.readFileSync(f,'utf8');
 for(const m of s.matchAll(/(?:apiClient\.get|useGet)<([^()]*?)>\(\s*([`'])([^`']+)\2/g)){const t=m[1].trim(),p=m[3];
  let kind=null; if(/\[\]$/.test(t)||/^Array</.test(t)) kind='array'; else if(/^PaginatedResponse</.test(t)||t==='NotificationsPage') kind='page';
  if(!kind)continue; const esc=p.split(/\$\{[^}]+\}/).map(x=>x.replace(/[.*+?^$()|[\]\\\/]/g,'\\$&')).join('[^/]+'); shapes['^'+esc+'$']=kind;}}
fs.writeFileSync('shapes.json',JSON.stringify(shapes,null,1));console.log(Object.keys(shapes).length,'shapes');
