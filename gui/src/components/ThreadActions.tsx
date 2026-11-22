import type { ThreadSummary } from '../types';

type Section = { id: string; name: string };

export function ThreadActions({
  className,
  thread,
  active,
  archivedView,
  running,
  canRevert,
  canMarkUnread,
  pinnedSectionId,
  sections,
  moveOpen,
  showMove,
  onToggleMove,
  onMove,
  onTogglePin,
  onRename,
  onCompact,
  onRevert,
  onFork,
  onArchive,
  onUnarchive,
  onMarkUnread,
  onDelete,
  onClose,
}: {
  className: string;
  thread: ThreadSummary;
  active: boolean;
  archivedView: boolean;
  running: boolean;
  canRevert: boolean;
  canMarkUnread: boolean;
  pinnedSectionId: string | null;
  sections: Section[];
  moveOpen: boolean;
  showMove: boolean;
  onToggleMove: () => void;
  onMove: (sectionId: string | null) => void;
  onTogglePin: () => void;
  onRename: () => void;
  onCompact: () => void;
  onRevert: () => void;
  onFork: () => void;
  onArchive: () => void;
  onUnarchive: () => void;
  onMarkUnread: () => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const act = (action: () => void) => () => {
    action();
    onClose();
  };
  const pinned = Boolean(pinnedSectionId && thread.section?.id === pinnedSectionId);

  return (
    <div className={className}>
      {pinnedSectionId ? (
        <button onClick={act(onTogglePin)}>{pinned ? '取消置顶' : '置顶'}</button>
      ) : null}
      {showMove ? (
        <>
          <button onClick={onToggleMove}>移动到分区…</button>
          {moveOpen ? (
            <div className="thread-submenu">
              <button onClick={act(() => onMove(null))}>无分区</button>
              {sections
                .filter((section) => section.id !== pinnedSectionId)
                .map((section) => (
                  <button key={section.id} onClick={act(() => onMove(section.id))}>
                    {section.name}
                  </button>
                ))}
              {sections.filter((section) => section.id !== pinnedSectionId).length === 0 ? (
                <span className="thread-submenu-empty">还没有分区</span>
              ) : null}
            </div>
          ) : null}
        </>
      ) : null}
      <button onClick={act(onRename)}>重命名</button>
      {active ? (
        <button disabled={running} onClick={act(onCompact)}>
          压缩上下文
        </button>
      ) : null}
      {canRevert ? <button onClick={act(onRevert)}>回退最后一轮</button> : null}
      <button onClick={act(onFork)}>分叉会话</button>
      {archivedView ? (
        <button onClick={act(onUnarchive)}>恢复</button>
      ) : (
        <button onClick={act(onArchive)}>归档</button>
      )}
      {canMarkUnread ? <button onClick={act(onMarkUnread)}>标记为未读</button> : null}
      <button className="danger" onClick={act(onDelete)}>
        删除
      </button>
    </div>
  );
}
