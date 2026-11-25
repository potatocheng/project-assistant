import { useLayoutEffect, useRef, useState } from 'react';
import { AlertCircle, CheckCircle2, Clock3, Play, User } from 'lucide-react';
import { asError, execute } from '../../api';
import { EASING, MOTION, prefersReducedMotion } from '../../design/motion';
import { TASK_CATEGORY, type Project, type Task, type TaskStatus } from '../../types';
import { CountPulse, type ToastAction } from '../interaction';
import { Spinner } from '../ui';

const COLUMNS: Array<{ status: TaskStatus; label: string; tone: string }> = [
  { status: 'todo', label: '待办', tone: 'is-todo' },
  { status: 'in_progress', label: '进行中', tone: 'is-progress' },
  { status: 'blocked', label: '阻塞', tone: 'is-blocked' },
  { status: 'done', label: '已完成', tone: 'is-done' },
];

export function TaskKanban({
  tasks,
  projects,
  day,
  selectedId,
  onSelect,
  onChanged,
  notify,
}: {
  tasks: Task[];
  projects: Project[];
  day: string;
  selectedId: string | null;
  onSelect: (taskId: string) => void;
  onChanged: () => Promise<unknown>;
  notify: (message: string, error?: boolean, action?: ToastAction) => void;
}) {
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dragOverCol, setDragOverCol] = useState<TaskStatus | null>(null);
  const [busyId, setBusyId] = useState<string>('');
  const [justMovedId, setJustMovedId] = useState<string | null>(null);

  const cardRefs = useRef<Map<string, HTMLElement>>(new Map());
  const prevRectsRef = useRef<Map<string, DOMRect>>(new Map());
  const movingTaskIdRef = useRef<string | null>(null);

  const projectMap = new Map(projects.map(p => [p.id, p.name]));

  const snapshotCardRects = (targetId: string) => {
    const rects = new Map<string, DOMRect>();
    for (const [id, node] of cardRefs.current.entries()) {
      rects.set(id, node.getBoundingClientRect());
    }
    prevRectsRef.current = rects;
    movingTaskIdRef.current = targetId;
  };

  const taskSignature = tasks.map(t => `${t.id}:${t.status}:${t.version}`).join(',');
  useLayoutEffect(() => {
    const movedId = movingTaskIdRef.current;
    if (!movedId) return;
    const oldRect = prevRectsRef.current.get(movedId);
    const node = cardRefs.current.get(movedId);
    if (!oldRect || !node) return;
    const newRect = node.getBoundingClientRect();
    const dx = oldRect.left - newRect.left;
    const dy = oldRect.top - newRect.top;
    if (Math.abs(dx) < 2 && Math.abs(dy) < 2) return;

    movingTaskIdRef.current = null;
    prevRectsRef.current.clear();

    if (!prefersReducedMotion()) {
      node.animate(
        [
          { transform: `translate3d(${dx}px, ${dy}px, 0)` },
          { transform: 'translate3d(0, 0, 0)' },
        ],
        { duration: MOTION.slow, easing: EASING.out },
      );
    }
    setJustMovedId(movedId);
    const timer = window.setTimeout(() => {
      setJustMovedId(curr => (curr === movedId ? null : curr));
    }, 380);
    return () => window.clearTimeout(timer);
  }, [taskSignature]);

  const transitionTask = async (task: Task, nextStatus: TaskStatus) => {
    if (busyId || task.status === nextStatus) return;
    const prevStatus = task.status;
    const prevProgress = task.progress;
    const targetLabel = COLUMNS.find(c => c.status === nextStatus)?.label ?? nextStatus;
    snapshotCardRects(task.id);
    setBusyId(task.id);
    try {
      const updated = await execute<Task>('update_task', {
        taskId: task.id,
        baseVersion: task.version,
        title: task.title,
        description: task.description,
        category: task.category,
        assignee: task.assignee,
        priority: task.priority,
        status: nextStatus,
        progress: nextStatus === 'done' ? 100 : nextStatus === 'todo' ? 0 : Math.max(task.progress, 20),
        dueDate: task.dueDate,
        plannedDate: task.plannedDate,
        workDate: day,
        note: `在看板中流转为「${targetLabel}」`,
        clientRequestId: crypto.randomUUID(),
      });
      await onChanged();
      notify(`已将「${task.title}」移至${targetLabel}。`, false, {
        label: '撤销',
        onClick: async () => {
          snapshotCardRects(task.id);
          await execute('update_task', {
            taskId: updated.id,
            baseVersion: updated.version,
            title: updated.title,
            description: updated.description,
            category: updated.category,
            assignee: updated.assignee,
            priority: updated.priority,
            status: prevStatus,
            progress: prevProgress,
            dueDate: updated.dueDate,
            plannedDate: updated.plannedDate,
            workDate: day,
            note: '撤销在看板中的状态调整',
            clientRequestId: crypto.randomUUID(),
          });
          await onChanged();
          notify(`已恢复「${task.title}」原状态。`);
        },
      });
    } catch (caught) {
      movingTaskIdRef.current = null;
      notify(asError(caught).message, true);
    } finally {
      setBusyId('');
    }
  };

  return (
    <div className="kanban-board" role="region" aria-label="任务看板视图">
      {COLUMNS.map(col => {
        const colTasks = tasks.filter(t => t.status === col.status);
        return (
          <section
            key={col.status}
            className={`kanban-column ${col.tone} ${dragOverCol === col.status ? 'is-drag-over' : ''}`}
            aria-label={col.label}
            onDragOver={e => {
              if (!draggingId) return;
              e.preventDefault();
              setDragOverCol(col.status);
            }}
            onDragLeave={e => {
              if (dragOverCol === col.status && !e.currentTarget.contains(e.relatedTarget as Node | null)) {
                setDragOverCol(null);
              }
            }}
            onDrop={e => {
              e.preventDefault();
              setDragOverCol(null);
              const id = draggingId || e.dataTransfer.getData('text/plain');
              setDraggingId(null);
              const target = tasks.find(t => t.id === id);
              if (target && target.status !== col.status) {
                void transitionTask(target, col.status);
              }
            }}
          >
            <header className="kanban-column-head">
              <div className="kanban-column-title">
                <span className={`kanban-dot ${col.tone}`} />
                <strong>{col.label}</strong>
              </div>
              <span className="kanban-count"><CountPulse value={colTasks.length} /></span>
            </header>
            <div className="kanban-column-body">
              {colTasks.length === 0 ? (
                <div className="kanban-empty">暂无事项，可拖入或流转至此</div>
              ) : (
                colTasks.map(task => {
                  const overdue = !!task.dueDate && task.dueDate < day && col.status !== 'done';
                  const selected = selectedId === task.id;
                  const busy = busyId === task.id;
                  return (
                    <article
                      key={task.id}
                      ref={node => {
                        if (node) cardRefs.current.set(task.id, node);
                        else cardRefs.current.delete(task.id);
                      }}
                      tabIndex={0}
                      role="button"
                      aria-pressed={selected}
                      draggable={!busy}
                      onDragStart={e => {
                        setDraggingId(task.id);
                        e.dataTransfer.setData('text/plain', task.id);
                      }}
                      onDragEnd={() => {
                        setDraggingId(null);
                        setDragOverCol(null);
                      }}
                      onKeyDown={e => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          if ((e.target as HTMLElement)?.closest('select, button')) return;
                          e.preventDefault();
                          onSelect(task.id);
                        }
                      }}
                      className={`kanban-card ${selected ? 'is-selected' : ''} ${draggingId === task.id ? 'is-dragging' : ''} ${busy ? 'is-busy' : ''} ${justMovedId === task.id ? 'is-just-moved' : ''}`}
                      onClick={() => onSelect(task.id)}
                    >
                      <div className="kanban-card-top">
                        <div className="kanban-card-badges">
                          {task.priority === 'high' && <span className="priority-high">高优</span>}
                          <span className="kanban-project-tag">{projectMap.get(task.projectId) ?? '项目'}</span>
                        </div>
                        {busy ? <Spinner /> : <span className="kanban-category">{TASK_CATEGORY[task.category]}</span>}
                      </div>
                      <h4 className="kanban-card-title">{task.title}</h4>
                      <div className="kanban-progress-track">
                        <i style={{ width: `${Math.min(100, Math.max(0, task.progress))}%` }} />
                      </div>
                      <div className="kanban-card-footer">
                        <span className="kanban-assignee">
                          <User size={11} />
                          {task.assignee || '待定'}
                        </span>
                        <span className={`kanban-due ${overdue ? 'is-overdue' : ''}`}>
                          {overdue ? <AlertCircle size={11} /> : <Clock3 size={11} />}
                          {task.dueDate || '无截止日'}
                        </span>
                      </div>
                      <div className="kanban-card-quick" onClick={e => e.stopPropagation()}>
                        {col.status === 'todo' && (
                          <button
                            type="button"
                            className="text-button tiny"
                            disabled={busy}
                            onClick={() => void transitionTask(task, 'in_progress')}
                          >
                            {busy ? <Spinner /> : <Play size={11} />}开始推进
                          </button>
                        )}
                        {(col.status === 'todo' || col.status === 'in_progress' || col.status === 'blocked') && (
                          <button
                            type="button"
                            className="text-button tiny"
                            disabled={busy}
                            onClick={() => void transitionTask(task, 'done')}
                          >
                            {busy ? <Spinner /> : <CheckCircle2 size={11} />}标记完成
                          </button>
                        )}
                        <select
                          aria-label={`${task.title} 流转到`}
                          className="kanban-status-select"
                          value={task.status}
                          disabled={busy}
                          onChange={e => void transitionTask(task, e.target.value as TaskStatus)}
                        >
                          {COLUMNS.map(c => (
                            <option key={c.status} value={c.status}>{c.label}</option>
                          ))}
                        </select>
                      </div>
                    </article>
                  );
                })
              )}
            </div>
          </section>
        );
      })}
    </div>
  );
}
