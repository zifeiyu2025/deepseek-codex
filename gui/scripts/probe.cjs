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
    } else if (message.method) {
      console.log('NOTIF', message.method, JSON.stringify(message.params || {}).slice(0, 260));
    }
  }
});
child.stderr.setEncoding('utf8');
child.stderr.on('data', (chunk) => {
  const line = chunk.trim();
  if (line) console.log('STDERR', line.slice(0, 220));
});

(async () => {
  try {
    const init = await send('initialize', {
      clientInfo: { name: 'probe', title: 'Probe', version: '0.1.0' },
      capabilities: { experimentalApi: true, requestAttestation: false },
    });
    console.log('INIT_OK', JSON.stringify(init).slice(0, 160));

    const thread = await send('thread/start', {
      cwd: 'D:/MyWorkspace/codex-deepseek',
      model: 'deepseek-flash',
      modelProvider: 'deepseek',
      approvalPolicy: 'on-request',
    });
    console.log('THREAD_OK id=', thread.thread && thread.thread.id, 'model=', thread.model);

    const turn = await send('turn/start', {
      threadId: thread.thread.id,
      input: [{ type: 'text', text: '只回复 OK', text_elements: [] }],
    });
    console.log('TURN_OK id=', turn.turn && turn.turn.id);

    setTimeout(() => {
      console.log('PROBE_DONE');
      child.kill();
      process.exit(0);
    }, 15000);
  } catch (error) {
    console.log('PROBE_ERROR', error.message);
    child.kill();
    process.exit(1);
  }
})();