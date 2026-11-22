const { spawn } = require('node:child_process');
const bin = 'D:/MyWorkspace/codex-deepseek/dist/codex.exe';
const child = spawn(bin, ['app-server', '--listen', 'stdio://'], { env: process.env, stdio: ['pipe','pipe','pipe'], windowsHide: true });
let buffer=''; let nextId=1; const pending=new Map();
function send(method, params){ const id=nextId++; return new Promise((resolve,reject)=>{ pending.set(id,{resolve,reject}); child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n'); setTimeout(()=>{ if(pending.delete(id)) reject(new Error(method+' timeout')); },20000); }); }
child.stdout.setEncoding('utf8');
child.stdout.on('data',(chunk)=>{ buffer+=chunk; let i; while((i=buffer.indexOf('\n'))>=0){ const line=buffer.slice(0,i).trim(); buffer=buffer.slice(i+1); if(!line.startsWith('{')) continue; let m; try{m=JSON.parse(line);}catch{continue;} if(m.id!==undefined && pending.has(m.id)){ const e=pending.get(m.id); pending.delete(m.id); if(m.error) e.reject(new Error(JSON.stringify(m.error))); else e.resolve(m.result); } } });
child.stderr.setEncoding('utf8'); child.stderr.on('data',(c)=>{});
(async()=>{
  try{
    await send('initialize',{clientInfo:{name:'probe-v07',title:'Probe',version:'0.7.0'},capabilities:{experimentalApi:true,requestAttestation:false}});
    for (const [method, params] of [
      ['collaborationMode/list', {}],
      ['project/list', { limit: 20 }],
      ['thread/search', { searchTerm: 'OK', limit: 5 }],
      ['model/list', { limit: 20 }],
      ['experimentalFeature/list', { limit: 10 }],
    ]) {
      try { const r = await send(method, params); console.log(method, 'OK', JSON.stringify(r).slice(0, 500)); }
      catch(e){ console.log(method, 'ERR', e.message.slice(0,200)); }
    }
  }catch(e){ console.log('PROBE_ERROR', e.message); }
  child.kill(); process.exit(0);
})();
