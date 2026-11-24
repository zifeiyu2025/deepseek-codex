const http = require('node:http');
const fs = require('node:fs');
const nodePath = require('node:path');
const {
  parseComputerKeyChord,
  windowRelativePoint,
} = require('../mcp/computer-input.cjs');

const port = Number(process.argv[2] || 9333);
const pdfFixture = process.env.SMOKE_PDF_FIXTURE || '';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function getJson(url) {
  return new Promise((resolve, reject) => {
    http
      .get(url, (response) => {
        let data = '';
        response.on('data', (chunk) => (data += chunk));
        response.on('end', () => resolve(JSON.parse(data)));
      })
      .on('error', reject);
  });
}

async function evaluateCdpTarget(target, expression, userGesture = false) {
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  try {
    const id = 1;
    const response = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('guest evaluate timeout')), 5000);
      socket.addEventListener('message', (event) => {
        const message = JSON.parse(event.data);
        if (message.id !== id) return;
        clearTimeout(timer);
        resolve(message);
      });
      socket.send(
        JSON.stringify({
          id,
          method: 'Runtime.evaluate',
          params: { expression, awaitPromise: true, returnByValue: true, userGesture },
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
  const targets = await getJson(`http://127.0.0.1:${port}/json/list`);
  const page = targets.find((target) => target.type === 'page' && target.url.includes('index.html'));
  if (!page) throw new Error(`page not found on port ${port}`);

  const socket = new WebSocket(page.webSocketDebuggerUrl);
  let nextId = 0;
  const pending = new Map();
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
    }
  });
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve);
    socket.addEventListener('error', reject);
  });

  const send = (method, params) =>
    new Promise((resolve) => {
      const id = ++nextId;
      pending.set(id, resolve);
      socket.send(JSON.stringify({ id, method, params }));
    });

  await send('Runtime.enable', {});

  async function evaluate(expression) {
    const response = await send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (response.result?.exceptionDetails) {
      throw new Error(
        response.result.exceptionDetails.exception?.description ||
          response.result.exceptionDetails.text,
      );
    }
    return response.result?.result?.value;
  }

  await evaluate(
    "(()=>{const overlay=[...document.querySelectorAll('.key-overlay')].find(e=>e.innerText.includes('DEEPSEEK ACCESS')); const later=overlay?[...overlay.querySelectorAll('button')].find(b=>b.textContent.trim()==='稍后'):null; if(later) later.click(); return true;})()",
  );
  await evaluate(
    "(()=>{const button=document.querySelector('.page-view .page-ghost, .plugins-page .page-ghost'); if(button) button.click(); return true;})()",
  );
  await sleep(300);

  const failures = [];
  const check = (name, condition, detail = '') => {
    if (condition) {
      console.log(`PASS ${name}${detail ? ` · ${detail}` : ''}`);
    } else {
      failures.push(`${name}${detail ? ` · ${detail}` : ''}`);
      console.log(`FAIL ${name}${detail ? ` · ${detail}` : ''}`);
    }
  };

  const boot = JSON.parse(
    await evaluate(
      "JSON.stringify({titlebar:!!document.querySelector('.titlebar'),online:document.querySelector('.statusbar')?.classList.contains('ready'),nav:[...document.querySelectorAll('.nav-row')].map(e=>e.textContent.trim()),composer:!!document.querySelector('.composer textarea'),model:!!document.querySelector('.model-pill'),theme:document.documentElement.dataset.theme||''})",
    ),
  );
  check('无边框标题栏', boot.titlebar);
  check('引擎在线', boot.online);
  check('侧栏导航', ['新对话', '插件', '定时任务'].every((item) => boot.nav.some((text) => text.includes(item))), boot.nav.join(' / '));
  check('输入框与模型选择器', boot.composer && boot.model);
  check('主题标记', Boolean(boot.theme), boot.theme);

  if (pdfFixture) {
    const pdfPreview = JSON.parse(
      await evaluate(`(async()=>{
        const result=await window.codex.readFile({
          root:${JSON.stringify(nodePath.dirname(pdfFixture))},
          path:${JSON.stringify(nodePath.basename(pdfFixture))}
        });
        return JSON.stringify({
          kind:result.kind,
          dataUrl:typeof result.dataUrl==='string'&&result.dataUrl.startsWith('data:application/pdf;base64,'),
          size:result.size
        });
      })()`),
    );
    check(
      'PDF 预览数据',
      pdfPreview.kind === 'pdf' && pdfPreview.dataUrl && pdfPreview.size > 0,
      JSON.stringify({ kind: pdfPreview.kind, size: pdfPreview.size }),
    );

    const defaultCwd = await evaluate(
      "(async()=>{const config=await window.codex.getConfig();return config.defaultCwd||'';})()",
    );
    let uiPdf = '';
    try {
      if (defaultCwd) {
        const fileName = `shanui-pdf-smoke-${process.pid}.pdf`;
        uiPdf = nodePath.join(defaultCwd, fileName);
        fs.copyFileSync(pdfFixture, uiPdf);
        await evaluate(
          `window.dispatchEvent(new CustomEvent('deepseek-codex:file-search',{detail:{query:${JSON.stringify(fileName)}}})); true`,
        );
        let clicked = false;
        for (let attempt = 0; attempt < 30 && !clicked; attempt += 1) {
          await sleep(150);
          clicked = await evaluate(`(()=>{
            const row=[...document.querySelectorAll('.file-results .file-row.file')]
              .find(entry=>entry.textContent.includes(${JSON.stringify(fileName)}));
            if(!row) return false;
            row.click();
            return true;
          })()`);
        }
        let viewer = null;
        for (let attempt = 0; attempt < 40; attempt += 1) {
          await sleep(150);
          viewer = JSON.parse(
            await evaluate(`JSON.stringify({
              canvas:!!document.querySelector('.pdf-page-canvas'),
              width:document.querySelector('.pdf-page-canvas')?.width||0,
              pages:document.querySelector('.pdf-annotation-page')?.textContent||'',
              pageValue:document.querySelector('.pdf-page-input')?.value||''
            })`),
          );
          if (viewer.canvas && viewer.width > 0 && viewer.pages.includes('2')) break;
        }
        check(
          'PDF.js 查看器渲染',
          clicked && viewer?.canvas && viewer.width > 0 && viewer.pages.includes('2'),
          JSON.stringify({ clicked, viewer }),
        );
        await evaluate(
          "document.querySelector('button[title=\"下一页\"]')?.click(); true",
        );
        await sleep(500);
        const pageTwo = await evaluate(
          "document.querySelector('.pdf-page-input')?.value||''",
        );
        await evaluate("document.querySelector('button[title=\"放大\"]')?.click(); true");
        await sleep(300);
        const zoom = await evaluate(
          "document.querySelector('.pdf-zoom-label')?.textContent||''",
        );
        await evaluate("document.querySelector('.pdf-select-toggle')?.click(); true");
        await sleep(150);
        await evaluate(`(()=>{
          const surface=document.querySelector('.pdf-select-surface.active');
          if(!surface) return false;
          const rect=surface.getBoundingClientRect();
          const points=[
            ['pointerdown',0.18,0.22],
            ['pointermove',0.55,0.46],
            ['pointerup',0.55,0.46]
          ];
          for(const [type,x,y] of points){
            surface.dispatchEvent(new PointerEvent(type,{
              bubbles:true,
              pointerId:1,
              isPrimary:true,
              clientX:rect.left+rect.width*x,
              clientY:rect.top+rect.height*y
            }));
          }
          return true;
        })()`);
        await sleep(200);
        const pending = await evaluate("!!document.querySelector('.pdf-pending-rect')");
        await evaluate(`(()=>{
          const input=document.querySelector('.pdf-annotation-form input.setting-input');
          if(!input) return false;
          const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;
          setter.call(input,'smoke highlight');
          input.dispatchEvent(new Event('input',{bubbles:true}));
          return true;
        })()`);
        await sleep(150);
        await evaluate(
          "document.querySelector('.pdf-annotation-form .settings-button')?.click(); true",
        );
        await sleep(350);
        const highlight = JSON.parse(
          await evaluate(`JSON.stringify({
            boxes:document.querySelectorAll('.pdf-highlight-box:not(.draft)').length,
            stored:(localStorage.getItem('deepseek-codex.pdfAnnotations')||'').includes('smoke highlight')
          })`),
        );
        check(
          'PDF 图形批注',
          pageTwo === '2' && zoom && zoom !== '100%' && pending && highlight.boxes > 0 && highlight.stored,
          JSON.stringify({ pageTwo, zoom, pending, highlight }),
        );
        let textSpans = 0;
        for (let attempt = 0; attempt < 40 && textSpans === 0; attempt += 1) {
          await sleep(150);
          textSpans = Number(
            await evaluate(
              "document.querySelectorAll('.pdf-text-layer span').length",
            ),
          );
        }
        const selected = await evaluate(`(()=>{
          const spans=[...document.querySelectorAll('.pdf-text-layer span')]
            .filter(span=>span.firstChild && span.textContent.trim());
          if(!spans.length) return false;
          const range=document.createRange();
          range.setStart(spans[0].firstChild,0);
          range.setEnd(spans[spans.length-1].firstChild,spans[spans.length-1].firstChild.length);
          const selection=window.getSelection();
          selection.removeAllRanges();
          selection.addRange(range);
          document.querySelector('.pdf-page-sheet')?.dispatchEvent(new MouseEvent('mouseup',{bubbles:true}));
          return true;
        })()`);
        await sleep(250);
        const textPending = await evaluate(
          "document.querySelector('.pdf-pending-rect')?.textContent?.includes('文本')||false",
        );
        const textInput = await evaluate(
          "document.querySelector('.pdf-annotation-form input.setting-input')?.value||''",
        );
        await evaluate(
          "[...document.querySelectorAll('.pdf-annotation-form .settings-button')][0]?.click(); true",
        );
        await sleep(350);
        const textHighlight = JSON.parse(
          await evaluate(`JSON.stringify({
            boxes:document.querySelectorAll('.pdf-highlight-box:not(.draft)').length,
            stored:(localStorage.getItem('deepseek-codex.pdfAnnotations')||'').includes('"kind":"text"')
          })`),
        );
        check(
          'PDF 文本锚定批注',
          textSpans > 0 &&
            selected &&
            textPending &&
            textInput.includes('Smoke PDF Page 2') &&
            textHighlight.boxes > 1 &&
            textHighlight.stored,
          JSON.stringify({ textSpans, selected, textPending, textInput, textHighlight }),
        );
        const graphicalPdf = JSON.parse(
          await evaluate(`(async()=>{
            const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
            const setTool=value=>{
              const select=document.querySelector('.pdf-draw-tool');
              const setter=Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set;
              setter.call(select,value);
              select.dispatchEvent(new Event('change',{bubbles:true}));
            };
            const dispatch=(surface,type,x,y)=>surface.dispatchEvent(new PointerEvent(type,{
              bubbles:true,
              pointerId:7,
              isPrimary:true,
              clientX:surface.getBoundingClientRect().left+surface.getBoundingClientRect().width*x,
              clientY:surface.getBoundingClientRect().top+surface.getBoundingClientRect().height*y
            }));
            const colorInput=document.querySelector('.pdf-draw-color');
            const colorSetter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;
            colorSetter.call(colorInput,'#00ff00');
            colorInput.dispatchEvent(new Event('input',{bubbles:true}));
            colorInput.dispatchEvent(new Event('change',{bubbles:true}));
            const widthSelect=document.querySelector('.pdf-draw-width');
            const widthSetter=Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set;
            widthSetter.call(widthSelect,'5');
            widthSelect.dispatchEvent(new Event('change',{bubbles:true}));
            setTool('rect');
            await delay(120);
            let surface=document.querySelector('.pdf-draw-surface.active');
            if(!surface) return JSON.stringify({ok:false,stage:'rect-surface'});
            dispatch(surface,'pointerdown',0.12,0.12);
            dispatch(surface,'pointermove',0.34,0.32);
            dispatch(surface,'pointerup',0.34,0.32);
            await delay(200);
            setTool('ink');
            await delay(120);
            surface=document.querySelector('.pdf-draw-surface.active');
            if(!surface) return JSON.stringify({ok:false,stage:'ink-surface'});
            dispatch(surface,'pointerdown',0.12,0.55);
            dispatch(surface,'pointermove',0.22,0.58);
            dispatch(surface,'pointermove',0.32,0.54);
            dispatch(surface,'pointermove',0.42,0.60);
            dispatch(surface,'pointerup',0.42,0.60);
            await delay(220);
            let list=Object.values(JSON.parse(localStorage.getItem('deepseek-codex.pdfAnnotations')||'{}'))[0]||[];
            const shape=list.find(annotation=>annotation.kind==='shape'&&annotation.shape==='rect');
            const ink=list.some(annotation=>annotation.kind==='ink'&&annotation.points?.length>2);
            const shapeStyle=shape?.color==='#00ff00'&&shape?.width===5;
            const shapeNodes=document.querySelectorAll('.pdf-shape-layer rect').length;
            const inkNodes=document.querySelectorAll('.pdf-shape-layer polyline').length;
            const shapeRow=[...document.querySelectorAll('.pdf-annotation-row')]
              .find(row=>row.querySelector('.pdf-annotation-text')?.textContent.includes('矩形批注'));
            const rowColor=shapeRow?.querySelector('.pdf-annotation-style input[type=color]');
            const rowWidth=shapeRow?.querySelector('.pdf-annotation-style select');
            if(rowColor&&rowWidth){
              colorSetter.call(rowColor,'#123456');
              rowColor.dispatchEvent(new Event('input',{bubbles:true}));
              rowColor.dispatchEvent(new Event('change',{bubbles:true}));
              widthSetter.call(rowWidth,'3');
              rowWidth.dispatchEvent(new Event('change',{bubbles:true}));
            }
            await delay(220);
            list=Object.values(JSON.parse(localStorage.getItem('deepseek-codex.pdfAnnotations')||'{}'))[0]||[];
            const editedShape=list.find(annotation=>annotation.id===shape?.id);
            const styleEdited=editedShape?.color==='#123456'&&editedShape?.width===3;
            setTool('erase');
            await delay(120);
            surface=document.querySelector('.pdf-draw-surface.active');
            if(surface) {
              dispatch(surface,'pointerdown',0.20,0.20);
              dispatch(surface,'pointerup',0.20,0.20);
            }
            await delay(220);
            list=Object.values(JSON.parse(localStorage.getItem('deepseek-codex.pdfAnnotations')||'{}'))[0]||[];
            const erased=!list.some(annotation=>annotation.kind==='shape');
            setTool('none');
            return JSON.stringify({ok:true,shape:Boolean(shape),shapeStyle,styleEdited,ink,shapeNodes,inkNodes,erased});
          })()`),
        );
        check(
          'PDF 图形与墨迹批注',
          graphicalPdf.ok &&
            graphicalPdf.shape &&
            graphicalPdf.shapeStyle &&
            graphicalPdf.styleEdited &&
            graphicalPdf.ink &&
            graphicalPdf.shapeNodes > 0 &&
            graphicalPdf.inkNodes > 0 &&
            graphicalPdf.erased,
          JSON.stringify(graphicalPdf),
        );
        const crossPage = JSON.parse(
          await evaluate(`(async()=>{
            const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
            const input=document.querySelector('.pdf-annotation-form input.setting-input');
            const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;
            setter.call(input,'Smoke PDF');
            input.dispatchEvent(new Event('input',{bubbles:true}));
            await delay(120);
            document.querySelector('.pdf-anchor-btn')?.click();
            let status='';
            for(let attempt=0;attempt<60;attempt+=1){
              await delay(100);
              status=document.querySelector('.pdf-anchor-status')?.textContent||'';
              if(status.includes('锚定')) break;
            }
            const list=Object.values(JSON.parse(localStorage.getItem('deepseek-codex.pdfAnnotations')||'{}'))[0]||[];
            const pages=[...new Set(list.filter(annotation=>annotation.anchorText==='Smoke PDF').map(annotation=>annotation.page))].sort();
            return JSON.stringify({status,pages});
          })()`),
        );
        check(
          'PDF 跨页文本锚定',
          crossPage.status.includes('已在') &&
            crossPage.pages.includes(1) &&
            crossPage.pages.includes(2),
          JSON.stringify(crossPage),
        );
      }
    } finally {
      if (uiPdf) fs.rmSync(uiPdf, { force: true });
    }
  }

  const protocol = JSON.parse(
    await evaluate(`(async () => {
      const list = await window.codex.request('thread/list', { limit: 5 });
      const modes = await window.codex.request('collaborationMode/list', {});
      const projects = await window.codex.request('project/list', { limit: 5 });
      const sandbox = await window.codex.request('windowsSandbox/readiness', {}).catch((error) => ({ error: error.message }));
      return JSON.stringify({
        threads: Array.isArray(list.data),
        modes: Array.isArray(modes.data) && modes.data.length > 0,
        projects: Array.isArray(projects.data),
        sandbox: sandbox.status || sandbox.error || 'unknown',
      });
    })()`),
  );
  check('thread/list 协议', protocol.threads);
  check('collaborationMode/list 协议', protocol.modes);
  check('project/list 协议', protocol.projects);
  check('Windows 沙箱就绪查询', Boolean(protocol.sandbox), protocol.sandbox);
  const subagentRpc = JSON.parse(
    await evaluate(`(async()=>{
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
      const listed=await window.codex.request('thread/subagents/list',{
        threadId:created.thread.id
      });
      let waitedOk=false;
      try {
        const waited=await window.codex.request('thread/subagents/wait',{
          threadId:created.thread.id,
          agentThreadId:'00000000-0000-0000-0000-000000000001',
          timeoutMs:100
        });
        waitedOk=Boolean(waited)&&waited.timedOut===true&&!waited.agent;
      } catch {
        waitedOk=false;
      }
      return JSON.stringify({
        agents:Array.isArray(listed.agents),
        count:listed.agents?.length??-1,
        waited:waitedOk
      });
    })()`),
  );
  check(
    '子代理管理 RPC',
    subagentRpc.agents && subagentRpc.count === 0 && subagentRpc.waited,
    JSON.stringify(subagentRpc),
  );

  const terminalOpen = await evaluate("!!document.querySelector('.terminal-dock')");
  if (!terminalOpen) {
    await evaluate(
      "window.dispatchEvent(new KeyboardEvent('keydown',{key:'j',ctrlKey:true,bubbles:true})); true",
    );
    await sleep(3000);
  }
  const terminal = JSON.parse(
    await evaluate(
      "JSON.stringify({dock:!!document.querySelector('.terminal-dock'),xterm:!!document.querySelector('.xterm'),bg:!!document.querySelector('.terminal-bg-toggle')})",
    ),
  );
  check('PTY 终端挂载', terminal.dock && terminal.xterm);
  check('后台终端入口', terminal.bg);
  if (terminal.dock) {
    await evaluate(
      "window.dispatchEvent(new KeyboardEvent('keydown',{key:'j',ctrlKey:true,bubbles:true})); true",
    );
    await sleep(400);
    const hidden = JSON.parse(
      await evaluate(
        "JSON.stringify({dock:!!document.querySelector('.terminal-dock'),xterm:!!document.querySelector('.xterm'),display:document.querySelector('.terminal-dock')?.style.display})",
      ),
    );
    await evaluate(
      "window.dispatchEvent(new KeyboardEvent('keydown',{key:'j',ctrlKey:true,bubbles:true})); true",
    );
    await sleep(700);
    const shown = JSON.parse(
      await evaluate(
        "JSON.stringify({xterm:!!document.querySelector('.xterm'),display:document.querySelector('.terminal-dock')?.style.display})",
      ),
    );
    check(
      '终端收起保活',
      hidden.dock && hidden.xterm && shown.xterm && shown.display !== 'none',
      `hidden=${JSON.stringify(hidden)} shown=${JSON.stringify(shown)}`,
    );
    if (!terminalOpen) {
      await evaluate(
        "window.dispatchEvent(new KeyboardEvent('keydown',{key:'j',ctrlKey:true,bubbles:true})); true",
      );
      await sleep(400);
    }
  }

  const threadMenuOpened = await evaluate(
    "(()=>{const button=document.querySelector('.thread-more'); if(!button) return false; button.click(); return true;})()",
  );
  await sleep(200);
  check(
    '会话菜单统一操作',
    threadMenuOpened &&
      (await evaluate(
        "(()=>{const text=[...document.querySelectorAll('.thread-menu button')].map(b=>b.textContent.trim()).join('|'); return text.includes('重命名') && text.includes('分叉会话') && text.includes('删除');})()",
      )),
  );
  await evaluate(
    "document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})); true",
  );
  await sleep(200);
  check('会话菜单 Esc 关闭', !(await evaluate("!!document.querySelector('.thread-menu')")));

  check(
    '菜单 aria 状态',
    (await evaluate(
      "(()=>{const b=document.querySelector('.account-settings'); return b?.getAttribute('aria-haspopup')==='menu' && b.getAttribute('aria-expanded')==='false';})()",
    )) === true,
  );
  await evaluate("document.querySelector('.account-settings')?.click(); true");
  await sleep(200);
  check(
    '菜单展开 aria 状态',
    (await evaluate("document.querySelector('.account-settings')?.getAttribute('aria-expanded')")) ===
      'true',
  );
  await evaluate(
    "document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})); true",
  );
  await sleep(200);
  check('菜单 Esc 关闭', !(await evaluate("!!document.querySelector('.account-menu')")));
  await evaluate("document.querySelector('.account-settings')?.click(); true");
  await sleep(200);
  await evaluate("document.body.dispatchEvent(new MouseEvent('mousedown',{bubbles:true})); true");
  await sleep(200);
  check('菜单外部点击关闭', !(await evaluate("!!document.querySelector('.account-menu')")));
  await evaluate("document.querySelector('.account-settings')?.click(); true");
  await sleep(200);
  await evaluate("[...document.querySelectorAll('.account-menu button')].find(b=>b.textContent.includes('设置'))?.click(); true");
  await sleep(700);
  const settingsTabs = await evaluate(
    "[...document.querySelectorAll('.settings-nav-item')].map(e=>e.textContent)",
  );
  check(
    '设置中心页签',
    ['通用', '外观', '通知', '实验功能', '快捷键', '诊断', '关于'].every((tab) =>
      settingsTabs.includes(tab),
    ),
    settingsTabs.join(' / '),
  );
  await evaluate(
    "(()=>{const option=document.querySelector('.settings-pane:not(.hidden) .question-option:not(.selected)'); if(option) option.click(); return true;})()",
  );
  await sleep(250);
  check(
    '设置修改后保持打开',
    await evaluate("!!document.querySelector('.settings-back')"),
  );
  const appPermission = JSON.parse(
    await evaluate(`(async()=>{
      const before=await window.codex.localToolsStatus();
      const listed=await window.codex.listComputerApps();
      const appId='C:\\\\Windows\\\\System32\\\\notepad.exe';
      const added=await window.codex.allowComputerApp(appId);
      const deduped=await window.codex.allowComputerApp(appId);
      const restored=await window.codex.setLocalTools({
        ...deduped,
        computerAllowedApps:before.computerAllowedApps
      });
      const clientBlocked=await window.codex.allowComputerApp('DeepSeek Codex.exe').then(()=>false).catch(()=>true);
      return JSON.stringify({
        listed:Array.isArray(listed),
        added:added.computerAllowedApps.some(app=>app.toLowerCase()===appId.toLowerCase()),
        deduped:deduped.computerAllowedApps.filter(app=>app.toLowerCase()===appId.toLowerCase()).length===1,
        restored:JSON.stringify(restored.computerAllowedApps)===JSON.stringify(before.computerAllowedApps),
        clientBlocked
      });
    })()`),
  );
  check(
    '电脑应用授权持久化',
    appPermission.listed &&
      appPermission.added &&
      appPermission.deduped &&
      appPermission.restored &&
      appPermission.clientBlocked,
    JSON.stringify(appPermission),
  );
  const computerTools = JSON.parse(
    await evaluate(`(async()=>{
      const before=await window.codex.localToolsStatus();
      try {
        await window.codex.setLocalTools({...before,computer:true});
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
        const status=await window.codex.request('mcpServerStatus/list',{
          threadId:created.thread.id,
          serverName:'shanui_local',
          detail:'toolsAndAuthOnly'
        });
        const server=(status.data||[]).find(entry=>entry.name==='shanui_local');
        const names=Object.keys(server?.tools||{});
        return JSON.stringify({
          listWindows:names.includes('computer_list_windows'),
          getWindow:names.includes('computer_get_window'),
          launchApp:names.includes('computer_launch_app'),
          activateWindow:names.includes('computer_activate_window'),
          windowState:names.includes('computer_window_state'),
          drag:names.includes('computer_drag'),
          setValue:names.includes('computer_set_value'),
          elementAction:names.includes('computer_element_action')
        });
      } finally {
        await window.codex.setLocalTools(before);
      }
    })()`),
  );
  check(
    '电脑窗口上下文工具',
    computerTools.listWindows &&
      computerTools.getWindow &&
      computerTools.launchApp &&
      computerTools.activateWindow &&
      computerTools.windowState &&
      computerTools.drag &&
      computerTools.setValue &&
      computerTools.elementAction,
    JSON.stringify(computerTools),
  );
  const keyChord = parseComputerKeyChord('Control_L+Shift_L+period');
  const keyPoint = windowRelativePoint({
    x: 12,
    y: 34,
    originX: 100,
    originY: 200,
    width: 800,
    height: 600,
  });
  let windowsShortcutBlocked = false;
  try {
    parseComputerKeyChord('Win+r');
  } catch {
    windowsShortcutBlocked = true;
  }
  check(
    '电脑键名与窗口相对坐标',
    keyChord.primary.vk === 0xbe &&
      keyChord.modifiers.some((modifier) => modifier.vk === 0x11) &&
      keyChord.modifiers.some((modifier) => modifier.vk === 0x10) &&
      keyPoint.x === 112 &&
      keyPoint.y === 234 &&
      windowsShortcutBlocked,
    JSON.stringify({ keyChord, keyPoint, windowsShortcutBlocked }),
  );
  const browserTools = JSON.parse(
    await evaluate(`(async()=>{
      const before=await window.codex.localToolsStatus();
      try {
        await window.codex.setLocalTools({...before,browser:true});
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
        const status=await window.codex.request('mcpServerStatus/list',{
          threadId:created.thread.id,
          serverName:'shanui_local',
          detail:'toolsAndAuthOnly'
        });
        const server=(status.data||[]).find(entry=>entry.name==='shanui_local');
        const names=Object.keys(server?.tools||{});
        return JSON.stringify({
          snapshot:names.includes('browser_snapshot'),
          upload:names.includes('browser_upload'),
          find:names.includes('browser_find'),
          wait:names.includes('browser_wait_for'),
          hover:names.includes('browser_hover'),
          select:names.includes('browser_select'),
          tabs:['browser_tab_list','browser_tab_open','browser_tab_select','browser_tab_close'].every(name=>names.includes(name)),
          inspect:['browser_dialog','browser_network_log','browser_wait_for_response','browser_wait_for_download','browser_element_screenshot','browser_check','browser_press','browser_element','browser_clipboard','browser_download'].every(name=>names.includes(name)),
          evalTool:names.includes('browser_eval')
        });
      } finally {
        await window.codex.setLocalTools(before);
      }
    })()`),
  );
  check(
    '浏览器工具集',
    browserTools.snapshot &&
      browserTools.upload &&
      browserTools.find &&
      browserTools.wait &&
      browserTools.hover &&
      browserTools.select &&
      browserTools.tabs &&
      browserTools.inspect &&
      !browserTools.evalTool,
    JSON.stringify(browserTools),
  );
  const browserPrivacy = JSON.parse(
    await evaluate(`(async()=>{
      const before=await window.codex.localToolsStatus();
      try {
        const sites=await window.codex.browserListSiteData(['https://example.com/docs']);
        const listed=sites.some(site=>site.host==='example.com'&&site.hasHistory);
        const cleared=await window.codex.browserClearSiteData({
          host:'example.com',
          origins:['https://example.com/docs'],
        });
        await window.codex.browserSetSitePermissions({
          origins:['https://example.com/docs'],
          permissions:['media','geolocation'],
          enabled:true,
        });
        await window.codex.browserSetSiteDownloadPolicy({
          origins:['https://example.com/docs'],
          policy:'allow',
        });
        const configured=(await window.codex.browserListSiteData(['https://example.com/docs']))
          .find(site=>site.host==='example.com');
        const sitePermissions=configured?.permissions?.includes('media')&&configured?.permissions?.includes('geolocation');
        const siteDownload=configured?.downloadPolicy==='allow';
        await window.codex.browserSetSitePermissions({
          origins:['https://example.com/docs'],
          permissions:['media','geolocation'],
          enabled:false,
        });
        await window.codex.browserSetSiteDownloadPolicy({
          origins:['https://example.com/docs'],
          policy:'default',
        });
        const saved=await window.codex.setLocalTools({
          ...before,
          browserDownloadPolicy:'deny',
          browserFileAccess:true,
        });
        const persisted=saved.browserDownloadPolicy==='deny'&&saved.browserFileAccess===true;
        return JSON.stringify({listed,cleared:cleared===true,sitePermissions,siteDownload,persisted});
      } finally {
        await window.codex.setLocalTools(before);
      }
    })()`),
  );
  check(
    '浏览器站点数据与传输权限',
    browserPrivacy.listed &&
      browserPrivacy.cleared &&
      browserPrivacy.sitePermissions &&
      browserPrivacy.siteDownload &&
      browserPrivacy.persisted,
    JSON.stringify(browserPrivacy),
  );
  await evaluate("document.querySelector('.settings-back')?.click(); true");
  await sleep(500);

  await evaluate(
    "[...document.querySelectorAll('.nav-row')].find(e=>e.textContent.includes('定时任务'))?.click(); true",
  );
  await sleep(500);
  check(
    '定时任务页',
    (await evaluate("document.querySelector('.page-view h1')?.textContent")) === '定时任务',
  );
  await evaluate("document.querySelector('.page-view .page-ghost')?.click(); true");
  await sleep(300);

  await evaluate(
    "[...document.querySelectorAll('button')].find(b=>b.getAttribute('aria-label')==='用引擎审查代码变更')?.click(); true",
  );
  await sleep(300);
  check(
    '审查弹窗',
    (await evaluate("document.querySelector('.key-overlay')?.getAttribute('aria-labelledby')")) ===
      'review-dialog-title',
  );
  await evaluate(
    "(()=>{const active=document.activeElement; active?.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})); return true;})()",
  );
  await sleep(300);
  check('审查弹窗 Esc 关闭', !(await evaluate("!!document.querySelector('.key-overlay')")));

  await evaluate(
    "[...document.querySelectorAll('.nav-row')].find(e=>e.textContent.includes('插件'))?.click(); true",
  );
  await sleep(2500);
  const capabilitySections = await evaluate(
    "[...document.querySelectorAll('.cap-section .setting-label')].map(e=>e.textContent)",
  );
  check(
    '能力面板区块',
    ['MCP 服务器', '插件', 'Hooks', '模型'].every((label) =>
      capabilitySections.includes(label),
    ),
    capabilitySections.join(' / '),
  );
  check('插件市场表单', await evaluate("!!document.querySelector('.marketplace-form')"));
  await evaluate(
    "[...document.querySelectorAll('.page-tabs button')].find(b=>b.textContent.trim()==='技能')?.click(); true",
  );
  await sleep(400);
  check(
    'Hooks 在技能页可见',
    await evaluate(
      "(()=>{const label=[...document.querySelectorAll('.cap-section .setting-label')].find(e=>e.textContent.trim()==='Hooks'); return !!label && label.getClientRects().length>0;})()",
    ),
  );
  await evaluate("document.querySelector('.plugins-page .page-ghost')?.click(); true");
  await sleep(400);

  await evaluate(
    "window.dispatchEvent(new KeyboardEvent('keydown',{key:'t',ctrlKey:true,bubbles:true})); true",
  );
  await sleep(1200);
  check('内置浏览器挂载', await evaluate("!!document.querySelector('.browser-frame')"));
  const permissionServer = http.createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(
      '<!doctype html><title>permission smoke</title><p>permission smoke</p>' +
        '<button aria-label="Smoke Button">Smoke Button</button>' +
        '<label>Smoke Input <input id="smoke-input" placeholder="smoke placeholder"></label>' +
        '<select aria-label="Smoke Select"><option value="a">Alpha</option><option value="b">Beta</option></select>' +
        '<label><input id="smoke-check" type="checkbox"> Smoke Check</label>' +
        '<button id="dialog-button" onclick="alert(\'smoke-dialog\')">Dialog</button>',
    );
  });
  await new Promise((resolve) => permissionServer.listen(0, resolve));
  const permissionPort = permissionServer.address().port;
  const permissionOrigin = `http://127.0.0.1:${permissionPort}`;
  try {
    await evaluate(`window.codex.browserSetSitePermissions({
      origins:[${JSON.stringify(permissionOrigin)}],
      permissions:['notifications','geolocation'],
      enabled:true
    })`);
    await evaluate(
      `window.dispatchEvent(new CustomEvent('deepseek-codex:browser-open',{detail:{url:${JSON.stringify(permissionOrigin)}}})); true`,
    );
    let guestTarget = null;
    for (let attempt = 0; attempt < 66 && !guestTarget; attempt += 1) {
      await sleep(150);
      const targets = await getJson(`http://127.0.0.1:${port}/json/list`);
      guestTarget = targets.find(
        (target) =>
          target.webSocketDebuggerUrl &&
          target.url.startsWith(permissionOrigin),
      );
    }
    let notification = '';
    let geolocation = '';
    if (guestTarget) {
      notification = await evaluateCdpTarget(
        guestTarget,
        "Notification.requestPermission()",
      );
      geolocation = await evaluateCdpTarget(
        guestTarget,
        "navigator.permissions.query({name:'geolocation'}).then(p=>p.state)",
      );
    }
    check(
      '浏览器站点权限生效',
      Boolean(guestTarget) && notification === 'granted' && geolocation === 'granted',
      JSON.stringify({ guest: Boolean(guestTarget), notification, geolocation }),
    );

    const promptOrigin = `http://localhost:${permissionPort}`;
    await evaluate(
      `window.dispatchEvent(new CustomEvent('deepseek-codex:browser-open',{detail:{url:${JSON.stringify(promptOrigin)}}})); true`,
    );
    let promptTarget = null;
    for (let attempt = 0; attempt < 66 && !promptTarget; attempt += 1) {
      await sleep(150);
      const targets = await getJson(`http://127.0.0.1:${port}/json/list`);
      promptTarget = targets.find(
        (target) =>
          target.webSocketDebuggerUrl && target.url.startsWith(promptOrigin),
      );
    }
    let promptVisible = false;
    let promptResult = '';
    if (promptTarget) {
      await evaluate(
        "(()=>{window.__permissionEvents=[];window.__permissionUnsubscribe=window.codex.onBrowserPermissionRequest(request=>window.__permissionEvents.push(request));return true;})()",
      );
      await sleep(500);
      await evaluateCdpTarget(
        promptTarget,
        "(()=>{window.__shanuiPermissionPromise=Notification.requestPermission();return 'started';})()",
        true,
      );
      for (let attempt = 0; attempt < 40 && !promptVisible; attempt += 1) {
        await sleep(150);
        promptVisible = await evaluate(
          "!!document.querySelector('.browser-permission-card')",
        );
      }
      if (promptVisible) {
        await evaluate(
          "[...document.querySelectorAll('.browser-permission-actions button')].find(button=>button.textContent.includes('始终允许'))?.click(); true",
        );
        await sleep(300);
      }
      promptResult = await evaluateCdpTarget(
        promptTarget,
        "window.__shanuiPermissionPromise ? Promise.race([window.__shanuiPermissionPromise.then(value=>'value:'+value),new Promise(resolve=>setTimeout(()=>resolve('pending'),1000))]) : ''",
      );
    }
    const promptEvents = await evaluate(
      "JSON.stringify(window.__permissionEvents||[])",
    );
    check(
      '浏览器权限请求弹窗',
      Boolean(promptTarget) && promptVisible && promptResult === 'value:granted',
      JSON.stringify({
        guest: Boolean(promptTarget),
        promptVisible,
        promptResult,
        promptEvents: JSON.parse(promptEvents || '[]').length,
      }),
    );

    const browserApi = JSON.parse(
      await evaluate(`(async()=>{
        const before=await window.codex.localToolsStatus();
        try {
          await window.codex.setLocalTools({...before,browser:true});
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
          const call=async(tool,args)=>{
            const response=await window.codex.request('mcpServer/tool/call',{
              threadId:created.thread.id,
              server:'shanui_local',
              tool,
              arguments:args
            });
            if(response?.isError) throw new Error(response.content?.[0]?.text||tool+' failed');
            const text=(response.content||[]).find(entry=>entry.type==='text')?.text||'';
            if(!text) return null;
            try { return JSON.parse(text); } catch { return text; }
          };
          await call('browser_navigate',{url:${JSON.stringify(permissionOrigin)}});
          const waited=await call('browser_wait_for',{text:'permission smoke',timeout_ms:5000});
          const found=await call('browser_find',{role:'button',name:'Smoke Button'});
          const ref=found?.elements?.[0]?.ref||'';
          const hovered=await call('browser_hover',{ref});
          const elementShotResponse=await window.codex.request('mcpServer/tool/call',{
            threadId:created.thread.id,
            server:'shanui_local',
            tool:'browser_element_screenshot',
            arguments:{ref}
          });
          const elementShot=(elementShotResponse.content||[]).some(entry=>entry.type==='image'&&entry.data?.length>1000);
          const checked=await call('browser_check',{selector:'#smoke-check',checked:true});
          const checkState=await call('browser_element',{selector:'#smoke-check',property:'is_checked'});
          const buttonText=await call('browser_element',{selector:'#dialog-button',property:'text_content'});
          const buttonLabel=await call('browser_element',{selector:'button[aria-label="Smoke Button"]',property:'attribute',attribute:'aria-label'});
          await call('browser_press',{selector:'#smoke-input',key:'Enter'});
          const stateWait=await call('browser_wait_for',{selector:'#smoke-check',state:'visible',timeout_ms:2000});
          const selected=await call('browser_select',{selector:'select',label:'Beta'});
          const tabsBefore=await call('browser_tab_list',{});
          const opened=await call('browser_tab_open',{url:${JSON.stringify(permissionOrigin)}+'?tab=2'});
          const tabsOpened=await call('browser_tab_list',{});
          const tabSelected=await call('browser_tab_select',{tab_id:opened?.tab?.id});
          const tabClosed=await call('browser_tab_close',{tab_id:opened?.tab?.id});
          const tabsAfter=await call('browser_tab_list',{});
          await call('browser_navigate',{url:${JSON.stringify(permissionOrigin)}+'/network-smoke'});
          const responseWait=await call('browser_wait_for_response',{
            url_contains:'/network-smoke',
            status:200,
            timeout_ms:5000
          });
          const networkLog=await call('browser_network_log',{
            url_contains:'/network-smoke',
            limit:10
          });
          await call('browser_navigate',{url:${JSON.stringify(permissionOrigin)}+'/dialog-page'});
          await new Promise(resolve=>setTimeout(resolve,300));
          await call('browser_click',{selector:'#dialog-button'});
          let dialog=null;
          for(let attempt=0;attempt<20&&!dialog;attempt+=1){
            await new Promise(resolve=>setTimeout(resolve,100));
            const current=await call('browser_dialog',{action:'get'});
            dialog=current?.dialog||null;
          }
          const dialogHandled=dialog
            ? await call('browser_dialog',{action:'accept'})
            : null;
          return JSON.stringify({
            waited:waited?.matched===true,
            found:found?.elements?.some(element=>element.name.includes('Smoke Button')),
            ref:Boolean(ref),
            hovered:String(hovered||'').includes('已悬停'),
            elementShot,
            checked:checked?.checked===true&&checkState?.value===true,
            buttonText:String(buttonText?.value||'').includes('Dialog'),
            buttonLabel:buttonLabel?.value==='Smoke Button',
            stateWait:stateWait?.matched===true,
            selected:selected?.value==='b'&&selected?.label==='Beta',
            tabsBefore:Array.isArray(tabsBefore?.tabs)&&tabsBefore.tabs.length>=1,
            tabOpened:tabsOpened?.tabs?.some(tab=>tab.id===opened?.tab?.id),
            tabSelected:tabSelected?.tab?.id===opened?.tab?.id,
            tabClosed:tabClosed?.closed?.id===opened?.tab?.id,
            tabsAfter:Array.isArray(tabsAfter?.tabs)&&!tabsAfter.tabs.some(tab=>tab.id===opened?.tab?.id),
            networkWait:responseWait?.response?.status===200,
            networkLogged:networkLog?.entries?.some(entry=>entry.url.includes('/network-smoke')),
            dialog:Boolean(dialog&&dialogHandled?.handled==='accept')
          });
        } finally {
          await window.codex.setLocalTools(before);
        }
      })()`),
    );
    check(
      '浏览器常用工具调用',
      browserApi.waited &&
        browserApi.found &&
        browserApi.ref &&
        browserApi.hovered &&
        browserApi.elementShot &&
        browserApi.checked &&
        browserApi.buttonText &&
        browserApi.buttonLabel &&
        browserApi.stateWait &&
        browserApi.selected &&
        browserApi.tabsBefore &&
        browserApi.tabOpened &&
        browserApi.tabSelected &&
        browserApi.tabClosed &&
        browserApi.tabsAfter &&
        browserApi.networkWait &&
        browserApi.networkLogged &&
        browserApi.dialog,
      JSON.stringify(browserApi),
    );
  } finally {
    await evaluate(`window.codex.browserSetSitePermissions({
      origins:[${JSON.stringify(permissionOrigin)}],
      permissions:['notifications','geolocation'],
      enabled:false
    })`).catch(() => null);
    await new Promise((resolve) => permissionServer.close(resolve));
  }

  await evaluate(
    "(()=>{const trigger=document.querySelector('.thread-heading-actions button'); if(!trigger) return false; trigger.focus(); trigger.click(); return true;})()",
  );
  await sleep(200);
  await evaluate(
    "[...document.querySelectorAll('.thread-heading-menu button')].find(b=>b.textContent.includes('新建分区'))?.click(); true",
  );
  await sleep(300);
  const dialog = JSON.parse(
    await evaluate(
      "JSON.stringify({role:document.querySelector('.key-overlay')?.getAttribute('role'),modal:document.querySelector('.key-overlay')?.getAttribute('aria-modal'),labelled:document.querySelector('.key-overlay')?.getAttribute('aria-labelledby'),focusInside:!!document.querySelector('.key-overlay')?.contains(document.activeElement),title:document.getElementById('section-dialog-title')?.textContent})",
    ),
  );
  check(
    '弹窗语义与焦点',
    dialog.role === 'dialog' &&
      dialog.modal === 'true' &&
      dialog.labelled === 'section-dialog-title' &&
      dialog.focusInside,
    JSON.stringify(dialog),
  );
  check(
    '弹窗遮挡内置浏览器',
    (await evaluate("document.querySelector('.browser-frame')?.style.visibility")) === 'hidden',
  );
  check(
    '弹窗焦点陷阱',
    await evaluate(
      "(()=>{const overlay=document.querySelector('.key-overlay'); if(!overlay) return false; const items=[...overlay.querySelectorAll('button:not([disabled]),input:not([disabled]),textarea:not([disabled]),select:not([disabled])')].filter(e=>e.getClientRects().length>0); if(items.length<2) return false; const last=items[items.length-1]; last.focus(); last.dispatchEvent(new KeyboardEvent('keydown',{key:'Tab',bubbles:true})); return document.activeElement===items[0];})()",
    ),
  );
  await evaluate(
    "(()=>{const active=document.activeElement; active?.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})); return true;})()",
  );
  await sleep(300);
  const dialogClosed = JSON.parse(
    await evaluate(
      "JSON.stringify({dialog:!!document.querySelector('.key-overlay'),focusRestored:document.activeElement===document.querySelector('.thread-heading-actions button'),browserVisible:document.querySelector('.browser-frame')?.style.visibility !== 'hidden'})",
    ),
  );
  check(
    'Esc 关闭并恢复焦点',
    !dialogClosed.dialog && dialogClosed.focusRestored && dialogClosed.browserVisible,
    JSON.stringify(dialogClosed),
  );

  await evaluate("document.querySelector('.thread-heading-actions button')?.click(); true");
  await sleep(150);
  await evaluate(
    "[...document.querySelectorAll('.thread-heading-menu button')].find(b=>b.textContent.includes('查看已归档会话'))?.click(); true",
  );
  await sleep(500);
  check(
    '归档视图切换',
    await evaluate("document.querySelector('.thread-heading span')?.textContent.includes('归档')"),
  );
  await evaluate("document.querySelector('.thread-heading-actions button')?.click(); true");
  await sleep(150);
  await evaluate(
    "[...document.querySelectorAll('.thread-heading-menu button')].find(b=>b.textContent.includes('返回对话列表'))?.click(); true",
  );
  await sleep(500);
  check(
    '归档视图返回',
    await evaluate("document.querySelector('.thread-heading span')?.textContent.includes('最近')"),
  );

  const setComposer = (value) =>
    evaluate(`(()=>{const ta=document.querySelector('.composer textarea'); const setter=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set; setter.call(ta, ${JSON.stringify(value)}); ta.dispatchEvent(new Event('input',{bubbles:true})); ta.focus(); return true;})()`);
  const pressComposer = (key) =>
    evaluate(`(()=>{const ta=document.querySelector('.composer textarea'); ta.dispatchEvent(new KeyboardEvent('keydown',{key:${JSON.stringify(key)},bubbles:true,cancelable:true})); return true;})()`);

  await setComposer('/');
  await sleep(200);
  const slashMenu = JSON.parse(
    await evaluate(
      "JSON.stringify({count:document.querySelectorAll('.slash-item').length,titles:[...document.querySelectorAll('.slash-item strong')].map(e=>e.textContent),active:document.querySelector('.slash-item.active code')?.textContent})",
    ),
  );
  check(
    '输入框斜杠命令面板',
    slashMenu.count >= 10 &&
      slashMenu.titles.includes('计划模式') &&
      slashMenu.titles.includes('设置目标'),
    JSON.stringify(slashMenu),
  );
  await pressComposer('ArrowDown');
  check('斜杠命令键盘选择', (await evaluate("document.querySelector('.slash-item.active code')?.textContent")) === '/goal');
  await pressComposer('Escape');
  await sleep(120);
  check('斜杠命令 Esc 关闭', await evaluate("document.querySelectorAll('.slash-menu').length === 0"));

  await setComposer('/plan');
  await pressComposer('Enter');
  await sleep(200);
  check('斜杠命令执行计划模式', await evaluate("Boolean(document.querySelector('.plan-banner'))"));
  await setComposer('/plan');
  await pressComposer('Enter');
  await sleep(200);
  check('斜杠命令退出计划模式', await evaluate("!document.querySelector('.plan-banner')"));

  await setComposer('/goal');
  await pressComposer('Enter');
  await sleep(200);
  check('斜杠命令打开目标弹窗', await evaluate("Boolean(document.querySelector('#goal-dialog-title'))"));
  await evaluate(
    "[...document.querySelectorAll('.key-card .key-actions button')].find(b=>b.textContent.trim()==='取消')?.click(); true",
  );
  await sleep(150);

  await setComposer('/project');
  await pressComposer('Enter');
  await sleep(200);
  check('斜杠命令打开项目选择', await evaluate("Boolean(document.querySelector('#project-picker-title'))"));
  await evaluate(
    "[...document.querySelectorAll('.key-card .key-actions button')].find(b=>b.textContent.trim()==='取消')?.click(); true",
  );
  await sleep(150);

  socket.close();
  if (failures.length > 0) {
    console.error(`\nSMOKE_FAILED ${failures.length} 项`);
    process.exit(1);
  }
  console.log('\nSMOKE_PASS');
})().catch((error) => {
  console.error('SMOKE_ERROR', error.message);
  process.exit(1);
});
