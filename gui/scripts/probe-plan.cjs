const { spawn } = require('node:child_process');
const bin = 'D:/MyWorkspace/codex-deepseek/dist/codex.exe';
const child = spawn(bin, ['app-server', '--listen', 'stdio://'], { env: process.env, stdio: ['pipe','pipe','pipe'], windowsHide: true });
let buffer=''; let nextId=1; const pending=new Map();
function send(method, params, timeout=60000){ const id=nextId++; return new Promise((resolve,reject)=>{ pending.set(id,{resolve,reject}); child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n'); setTimeout(()=>{ if(pending.delete(id)) reject(new Error(method+' timeout')); }, timeout); }); }
child.stdout.setEncoding('utf8');
child.stdout.on('data',(chunk)=>{ buffer+=chunk; let i; while((i=buffer.indexOf('\n'))>=0){ const line=buffer.slice(0,i).trim(); buffer=buffer.slice(i+1); if(!line.startsWith('{')) continue; let m; try{m=JSON.parse(line);}catch{continue;} if(m.id!==undefined && pending.has(m.id)){ const e=pending.get(m.id); pending.delete(m.id); if(m.error) e.reject(new Error(JSON.stringify(m.error))); else e.resolve(m.result); } else if (m.method) { if (m.method.startsWith('item/') || m.method.startsWith('turn/') || m.method === 'error') console.log('NOTIF', m.method, JSON.stringify(m.params||{}).slice(0,160)); } } });
child.stderr.setEncoding('utf8'); child.stderr.on('data',(c)=>{ const s=String(c).trim(); if(s) console.log('STDERR', s.slice(0,200)); });
(async()=>{
  try{
    await send('initialize',{clientInfo:{name:'probe-plan',title:'Probe',version:'0.7.0'},capabilities:{experimentalApi:true,requestAttestation:false}});
    const thread = await send('thread/start',{cwd:'D:/MyWorkspace/codex-deepseek',model:'deepseek-flash',modelProvider:'deepseek',approvalPolicy:'never',sandbox:'danger-full-access'});
    console.log('THREAD', thread.thread.id);
    const turn = await send('turn/start',{
      threadId: thread.thread.id,
      model:'deepseek-flash',
      effort:'low',
      sandboxPolicy:{type:'dangerFullAccess'},
      collaborationMode:{mode:'plan',settings:{model:'deepseek-flash',reasoning_effort:'low',developer_instructions:null}},
      input:[{type:'text',text:'只回复 OK 两个字母，不要做任何操作',text_elements:[]}],
    });
    console.log('TURN_STARTED', JSON.stringify(turn).slice(0,220));
    setTimeout(()=>{ console.log('PROBE_DONE'); child.kill(); process.exit(0); }, 25000);
  }catch(e){ console.log('PROBE_ERROR', e.message); child.kill(); process.exit(1); }
})();
