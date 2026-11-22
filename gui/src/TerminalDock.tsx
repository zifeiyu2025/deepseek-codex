import { useCallback, useEffect, useRef, useState } from 'react';
import { Activity, Plus, Terminal as TerminalIcon, X } from 'lucide-react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

type Tab = {
  key: number;
  title: string;
  termId: string | null;
  status: 'starting' | 'running' | 'exited';
};

const THEME = {
  background: '#0b0c0a',
  foreground: '#ece7d9',
  cursor: '#d08a4a',
  cursorAccent: '#0b0c0a',
  selectionBackground: 'rgba(208, 138, 74, 0.28)',
  black: '#0b0c0a',
  red: '#c9705f',
  green: '#8fa585',
  yellow: '#d8b98c',
  blue: '#9fb8dd',
  magenta: '#c4a3d0',
  cyan: '#8fb8b0',
  white: '#ece7d9',
  brightBlack: '#5e5b50',
  brightRed: '#e08a78',
  brightGreen: '#a8c79d',
  brightYellow: '#e6cfa8',
  brightBlue: '#b8cde8',
  brightMagenta: '#d8bce0',
  brightCyan: '#a8cbc3',
  brightWhite: '#f7f2e5',
};

export function TerminalDock({
  cwd,
  threadId,
  visible,
  onClose,
}: {
  cwd: string;
  threadId?: string | null;
  visible: boolean;
  onClose: () => void;
}) {
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeKey, setActiveKey] = useState<number | null>(null);
  const [showBackground, setShowBackground] = useState(false);
  const [backgroundTasks, setBackgroundTasks] = useState<any[]>([]);
  const [backgroundError, setBackgroundError] = useState<string | null>(null);
  const [backgroundBusy, setBackgroundBusy] = useState(false);
  const seqRef = useRef(0);
  const hostsRef = useRef(new Map<number, HTMLDivElement>());
  const xtermsRef = useRef(new Map<number, { term: XTerm; fit: FitAddon }>());
  const termIdsRef = useRef(new Map<number, string>());
  const cwdRef = useRef(cwd);
  const initializedRef = useRef(false);

  const addTab = useCallback(() => {
    const key = ++seqRef.current;
    setTabs((list) => [
      ...list,
      { key, title: `终端 ${list.length + 1}`, termId: null, status: 'starting' },
    ]);
    setActiveKey(key);
  }, []);

  const initialize = useCallback((key: number, host: HTMLDivElement) => {
    if (xtermsRef.current.has(key)) return;
    const term = new XTerm({
      cursorBlink: true,
      fontFamily: "'IBM Plex Mono', 'Cascadia Mono', monospace",
      fontSize: 12.5,
      lineHeight: 1.25,
      scrollback: 8000,
      theme: THEME,
      allowProposedApi: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    try {
      fit.fit();
    } catch {
      /* host may be hidden during first paint */
    }
    xtermsRef.current.set(key, { term, fit });
    term.writeln('\x1b[38;5;245m# 正在启动本地终端…\x1b[0m');
    term.onData((data) => {
      const termId = termIdsRef.current.get(key);
      if (termId) window.codex.terminalInput({ id: termId, data }).catch(() => {});
    });
    window.codex
      .terminalStart({ cwd: cwdRef.current, cols: term.cols, rows: term.rows })
      .then(({ id }) => {
        if (!xtermsRef.current.has(key)) {
          window.codex.terminalStop(id).catch(() => {});
          return;
        }
        termIdsRef.current.set(key, id);
        setTabs((list) =>
          list.map((tab) => (tab.key === key ? { ...tab, termId: id, status: 'running' } : tab)),
        );
        term.focus();
      })
      .catch((error: Error) => {
        term.writeln(`\r\n\x1b[31m终端启动失败：${error.message}\x1b[0m`);
        setTabs((list) =>
          list.map((tab) => (tab.key === key ? { ...tab, status: 'exited' } : tab)),
        );
      });
  }, []);

  const setHost = useCallback(
    (key: number) => (element: HTMLDivElement | null) => {
      if (element) {
        hostsRef.current.set(key, element);
        initialize(key, element);
      } else {
        hostsRef.current.delete(key);
      }
    },
    [initialize],
  );

  const disposeTab = useCallback((key: number) => {
    const termId = termIdsRef.current.get(key);
    if (termId) window.codex.terminalStop(termId).catch(() => {});
    termIdsRef.current.delete(key);
    const entry = xtermsRef.current.get(key);
    try {
      entry?.term.dispose();
    } catch {
      /* ignore */
    }
    xtermsRef.current.delete(key);
    hostsRef.current.delete(key);
  }, []);

  const closeTab = useCallback(
    (key: number) => {
      disposeTab(key);
      setTabs((list) => {
        const index = list.findIndex((tab) => tab.key === key);
        const next = list.filter((tab) => tab.key !== key);
        if (next.length === 0) {
          onClose();
          return next;
        }
        setActiveKey((current) =>
          current === key ? next[Math.min(Math.max(index, 0), next.length - 1)].key : current,
        );
        return next;
      });
    },
    [disposeTab, onClose],
  );

  useEffect(() => {
    if (!visible) return;
    if (!initializedRef.current) {
      initializedRef.current = true;
      addTab();
      return;
    }
    if (tabs.length === 0) addTab();
  }, [addTab, tabs.length, visible]);

  useEffect(() => {
    const offData = window.codex.onTerminalData(({ id, data }) => {
      for (const [key, termId] of termIdsRef.current.entries()) {
        if (termId === id) xtermsRef.current.get(key)?.term.write(data);
      }
    });
    const offExit = window.codex.onTerminalExit(({ id, code }) => {
      for (const [key, termId] of termIdsRef.current.entries()) {
        if (termId !== id) continue;
        xtermsRef.current
          .get(key)
          ?.term.writeln(`\r\n\x1b[38;5;245m[进程已退出${code == null ? '' : ` ${code}`}]\x1b[0m`);
        setTabs((list) =>
          list.map((tab) => (tab.key === key ? { ...tab, status: 'exited' } : tab)),
        );
      }
    });
    return () => {
      offData();
      offExit();
    };
  }, []);

  useEffect(() => {
    if (cwdRef.current === cwd) return;
    cwdRef.current = cwd;
    for (const id of termIdsRef.current.values()) {
      window.codex.terminalStop(id).catch(() => {});
    }
    for (const entry of xtermsRef.current.values()) {
      try {
        entry.term.dispose();
      } catch {
        /* ignore */
      }
    }
    xtermsRef.current.clear();
    termIdsRef.current.clear();
    hostsRef.current.clear();
    const key = ++seqRef.current;
    setTabs([{ key, title: '终端 1', termId: null, status: 'starting' }]);
    setActiveKey(key);
  }, [cwd]);

  useEffect(
    () => () => {
      for (const id of termIdsRef.current.values()) {
        window.codex.terminalStop(id).catch(() => {});
      }
      for (const entry of xtermsRef.current.values()) {
        try {
          entry.term.dispose();
        } catch {
          /* ignore */
        }
      }
    },
    [],
  );

  useEffect(() => {
    if (visible) return;
    const active = document.activeElement;
    if (active instanceof HTMLElement && active.closest('.terminal-dock')) {
      active.blur();
    }
  }, [visible]);

  useEffect(() => {
    if (!visible || activeKey == null) return;
    const entry = xtermsRef.current.get(activeKey);
    if (!entry) return;
    const timer = setTimeout(() => {
      try {
        entry.fit.fit();
      } catch {
        /* ignore */
      }
      entry.term.focus();
      const termId = termIdsRef.current.get(activeKey);
      if (termId) {
        window.codex
          .terminalResize({ id: termId, cols: entry.term.cols, rows: entry.term.rows })
          .catch(() => {});
      }
    }, 30);
    return () => clearTimeout(timer);
  }, [activeKey, tabs.length, visible]);

  useEffect(() => {
    const host = activeKey == null ? null : hostsRef.current.get(activeKey);
    if (!host) return;
    const resize = () => {
      const entry = activeKey == null ? null : xtermsRef.current.get(activeKey);
      if (!entry) return;
      try {
        entry.fit.fit();
      } catch {
        return;
      }
      const termId = termIdsRef.current.get(activeKey as number);
      if (termId) {
        window.codex
          .terminalResize({ id: termId, cols: entry.term.cols, rows: entry.term.rows })
          .catch(() => {});
      }
    };
    const observer = new ResizeObserver(resize);
    observer.observe(host);
    window.addEventListener('resize', resize);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', resize);
    };
  }, [activeKey, tabs.length]);

  const loadBackground = useCallback(async () => {
    if (!threadId) {
      setBackgroundTasks([]);
      return;
    }
    setBackgroundBusy(true);
    try {
      const response = await window.codex.request('thread/backgroundTerminals/list', {
        threadId,
        limit: 50,
      });
      setBackgroundTasks(response?.data || []);
      setBackgroundError(null);
    } catch (error: any) {
      setBackgroundError(error?.message || String(error));
    } finally {
      setBackgroundBusy(false);
    }
  }, [threadId]);

  useEffect(() => {
    if (!showBackground) return;
    void loadBackground();
    const timer = window.setInterval(() => {
      void loadBackground();
    }, 5000);
    return () => window.clearInterval(timer);
  }, [loadBackground, showBackground]);

  useEffect(() => {
    setBackgroundTasks([]);
    setBackgroundError(null);
  }, [threadId]);

  const terminateBackground = async (task: any) => {
    if (!threadId || !task?.processId) return;
    try {
      await window.codex.request('thread/backgroundTerminals/terminate', {
        threadId,
        processId: task.processId,
      });
      await loadBackground();
    } catch (error: any) {
      setBackgroundError(error?.message || String(error));
    }
  };

  const cleanBackground = async () => {
    if (!threadId) return;
    try {
      await window.codex.request('thread/backgroundTerminals/clean', { threadId });
      await loadBackground();
    } catch (error: any) {
      setBackgroundError(error?.message || String(error));
    }
  };

  return (
    <section className="terminal-dock" style={visible ? undefined : { display: 'none' }}>
      <header className="terminal-tabs">
        <div className="terminal-tab-list">
          {tabs.map((tab) => (
            <div
              key={tab.key}
              className={`terminal-tab ${activeKey === tab.key ? 'active' : ''}`}
              onClick={() => setActiveKey(tab.key)}
            >
              <TerminalIcon size={12} />
              <span>{tab.title}</span>
              <span className={`terminal-tab-state ${tab.status}`} />
              <button
                className="terminal-tab-close"
                aria-label="关闭终端"
                onClick={(event) => {
                  event.stopPropagation();
                  closeTab(tab.key);
                }}
                title="关闭终端"
              >
                <X size={11} />
              </button>
            </div>
          ))}
          <button
            className="terminal-tab-add"
            onClick={addTab}
            title="新建终端"
            aria-label="新建终端"
          >
            <Plus size={13} />
          </button>
        </div>
        <button
          className={`terminal-bg-toggle ${showBackground ? 'active' : ''}`}
          onClick={() => setShowBackground((previous) => !previous)}
          title="后台终端"
          aria-label="后台终端"
          aria-pressed={showBackground}
        >
          <Activity size={12} />
          <span>后台</span>
          {backgroundTasks.length > 0 ? <em>{backgroundTasks.length}</em> : null}
        </button>
        <button
          className="terminal-dock-close"
          onClick={onClose}
          title="收起终端"
          aria-label="收起终端"
        >
          <X size={14} />
        </button>
      </header>
      {showBackground ? (
        <div className="terminal-bg-panel">
          <div className="terminal-bg-head">
            <span>后台终端</span>
            <button onClick={() => void loadBackground()} disabled={backgroundBusy}>
              刷新
            </button>
            <button onClick={() => void cleanBackground()} disabled={!threadId}>
              清理已结束
            </button>
          </div>
          {backgroundError ? <div className="terminal-bg-error">{backgroundError}</div> : null}
          {!threadId ? (
            <div className="terminal-bg-empty">打开会话后可查看代理启动的后台命令</div>
          ) : backgroundTasks.length === 0 ? (
            <div className="terminal-bg-empty">
              {backgroundBusy ? '读取中…' : '没有后台任务'}
            </div>
          ) : (
            backgroundTasks.map((task: any) => (
              <div
                className="terminal-bg-row"
                key={task.processId || task.itemId || task.command}
              >
                <code title={task.command}>{task.command}</code>
                <span>PID {task.osPid ?? '-'}</span>
                <span>CPU {task.cpuPercent != null ? `${task.cpuPercent.toFixed(1)}%` : '-'}</span>
                <span>{task.rssKb ? `${Math.round(task.rssKb / 1024)} MB` : ''}</span>
                <button onClick={() => void terminateBackground(task)}>终止</button>
              </div>
            ))
          )}
        </div>
      ) : null}
      <div className="terminal-panes">
        {tabs.map((tab) => (
          <div
            key={tab.key}
            className={`terminal-pane ${activeKey === tab.key ? 'active' : ''}`}
            ref={setHost(tab.key)}
          />
        ))}
      </div>
    </section>
  );
}
