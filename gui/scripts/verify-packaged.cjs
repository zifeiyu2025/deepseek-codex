const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const guiRoot = path.resolve(__dirname, '..');
const executable = path.resolve(
  process.argv[2] || path.join(guiRoot, 'release-04552', 'DeepSeek-Codex-0.45.52.exe'),
);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function getJson(url) {
  return new Promise((resolve, reject) => {
    http
      .get(url, (response) => {
        let data = '';
        response.on('data', (chunk) => (data += chunk));
        response.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch (error) {
            reject(error);
          }
        });
      })
      .on('error', reject);
  });
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

async function waitForPage(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const targets = await getJson(`http://127.0.0.1:${port}/json/list`);
      const page = targets.find(
        (target) => target.type === 'page' && target.url.includes('index.html'),
      );
      if (page) return page;
    } catch {
      /* not ready */
    }
    await sleep(300);
  }
  throw new Error('packaged renderer did not expose CDP');
}

async function evaluate(page, expression) {
  const socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  try {
    const response = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('packaged evaluate timeout')), 90000);
      socket.addEventListener('message', (event) => {
        const message = JSON.parse(event.data);
        if (message.id !== 1) return;
        clearTimeout(timer);
        resolve(message);
      });
      socket.send(
        JSON.stringify({
          id: 1,
          method: 'Runtime.evaluate',
          params: { expression, awaitPromise: true, returnByValue: true },
        }),
      );
    });
    if (response.result?.exceptionDetails) {
      throw new Error(
        response.result.exceptionDetails.exception?.description ||
          response.result.exceptionDetails.text,
      );
    }
    return response.result?.result?.value;
  } finally {
    socket.close();
  }
}

(async () => {
  if (!fs.existsSync(executable)) throw new Error(`package not found: ${executable}`);
  const port = await freePort();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'deepseek-codex-package-'));
  const child = spawn(executable, [`--remote-debugging-port=${port}`], {
    env: { ...process.env, DEEPSEEK_CODEX_USER_DATA: profile },
    stdio: 'ignore',
    windowsHide: true,
  });
  let page = null;
  try {
    page = await waitForPage(port, 45000);
    const result = JSON.parse(
      await evaluate(
        page,
        `(async()=>{
          for(let attempt=0;attempt<120;attempt+=1){
            if(document.querySelector('.statusbar')?.classList.contains('ready')) break;
            await new Promise(resolve=>setTimeout(resolve,250));
          }
          const ready=document.querySelector('.statusbar')?.classList.contains('ready')||false;
          const config=await window.codex.getConfig();
          const created=await window.codex.request('thread/start',{
            cwd:config.defaultCwd,
            model:config.defaultModel,
            modelProvider:config.defaultProvider,
            threadSource:'user',
            approvalPolicy:'never',
            sandbox:'danger-full-access',
            ephemeral:true
          });
          const before=await window.codex.localToolsStatus();
          let toolsReady=false;
          let jsReady=false;
          let installedReady=false;
          try {
            await window.codex.setLocalTools({...before,computer:true});
            const computerThread=await window.codex.request('thread/start',{
              cwd:config.defaultCwd,
              model:config.defaultModel,
              modelProvider:config.defaultProvider,
              threadSource:'user',
              approvalPolicy:'never',
              sandbox:'danger-full-access',
              ephemeral:true
            });
            const status=await window.codex.request('mcpServerStatus/list',{
              threadId:computerThread.thread.id,
              serverName:'shanui_local',
              detail:'toolsAndAuthOnly'
            });
            const server=(status.data||[]).find(entry=>entry.name==='shanui_local');
            const names=Object.keys(server?.tools||{});
            toolsReady=names.includes('js')&&names.includes('js_reset')&&names.includes('computer_list_installed_apps');
            const callJs=async(code)=>{
              const response=await window.codex.request('mcpServer/tool/call',{
                threadId:computerThread.thread.id,
                server:'shanui_local',
                tool:'js',
                arguments:{code}
              });
              if(response?.isError) throw new Error(response.content?.[0]?.text||'js failed');
              return (response.content||[]).find(entry=>entry.type==='text')?.text||'';
            };
            const text=await callJs('const blocked=(fn)=>{try{fn();return false}catch{return true}};const windows=await sky.list_windows();const installed=await sky.list_installed_apps({limit:1});nodeRepl.write(JSON.stringify({windows:Array.isArray(windows.windows),installed:Array.isArray(installed.apps),invokeHidden:typeof __shanuiInvoke,sandboxed:blocked(()=>sky.list_apps.constructor("return process")())&&blocked(()=>globalThis.constructor.constructor("return process")())}));');
            const parsed=JSON.parse(text);
            jsReady=parsed.windows===true&&parsed.installed===true&&parsed.invokeHidden==='undefined'&&parsed.sandboxed===true;
            installedReady=parsed.installed===true;
          } finally {
            await window.codex.setLocalTools(before);
          }
          const modelsReady=Array.isArray(config.models)&&
            config.models.some(model=>model.slug==='deepseek-flash')&&
            config.models.some(model=>model.slug==='deepseek-v4-pro');
          return JSON.stringify({
            ready,
            threadId:created?.thread?.id||'',
            model:config.defaultModel,
            provider:config.defaultProvider,
            title:document.title,
            modelsReady,
            toolsReady,
            jsReady,
            installedReady
          });
        })()`,
      ),
    );
    if (
      !result.ready ||
      !result.threadId ||
      !result.modelsReady ||
      result.provider !== 'deepseek' ||
      !result.toolsReady ||
      !result.jsReady ||
      !result.installedReady
    ) {
      throw new Error(JSON.stringify(result));
    }
    console.log(JSON.stringify({ ok: true, executable, ...result }, null, 2));
  } finally {
    try {
      spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      });
    } catch {
      /* ignore */
    }
    await sleep(700);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        fs.rmSync(profile, { recursive: true, force: true });
        break;
      } catch {
        await sleep(300);
      }
    }
  }
})().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
