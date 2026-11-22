const { spawn } = require('node:child_process');

const bin = 'D:/MyWorkspace/codex-deepseek/dist/codex.exe';
const child = spawn(bin, ['app-server', '--listen', 'stdio://'], {
  env: process.env,
  stdio: ['pipe', 'pipe', 'pipe'],
  windowsHide: true,
});

let buffer = '';
let nextId = 1;
const pending = new Map();

function send(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    setTimeout(() => {
      if (pending.delete(id)) reject(new Error(`${method} timeout`));
    }, 30000);
  });
}

child.stdout.setEncoding('utf8');
child.stdout.on('data', (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line.startsWith('{')) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      continue;
    }
    if (message.id !== undefined && pending.has(message.id)) {
      const entry = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) entry.reject(new Error(JSON.stringify(message.error)));
      else entry.resolve(message.result);
    }
  }
});
child.stderr.setEncoding('utf8');
child.stderr.on('data', () => {});

(async () => {
  try {
    await send('initialize', {
      clientInfo: { name: 'probe2', title: 'Probe2', version: '0.1.0' },
      capabilities: { experimentalApi: true, requestAttestation: false },
    });
    const list = await send('thread/list', { limit: 5 });
    for (const thread of list.data || []) {
      console.log('THREAD', thread.id, JSON.stringify(thread.preview).slice(0, 40), thread.model, thread.updatedAt);
    }
    const target = (list.data || [])[0];
    if (!target) {
      console.log('NO_THREADS');
      process.exit(0);
    }
    const resumed = await send('thread/resume', { threadId: target.id });
    const turns = resumed.thread.turns || [];
    console.log('TURNS', turns.length);
    for (const turn of turns) {
      console.log('TURN', turn.id, 'status=', turn.status, 'error=', JSON.stringify(turn.error));
      for (const item of turn.items || []) {
        if (item.type === 'agentMessage') {
          console.log('  AGENT', JSON.stringify(item.text || '').slice(0, 300));
        } else if (item.type === 'userMessage') {
          console.log('  USER', JSON.stringify(item.content).slice(0, 200));
        } else {
          console.log('  ITEM', item.type, JSON.stringify(item).slice(0, 160));
        }
      }
    }
    child.kill();
    process.exit(0);
  } catch (error) {
    console.log('PROBE2_ERROR', error.message);
    child.kill();
    process.exit(1);
  }
})();