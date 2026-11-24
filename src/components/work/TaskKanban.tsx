import { useState } from 'react';
import { AlertCircle, CheckCircle2, Clock3, Play, User } from 'lucide-react';
import { asError, execute } from '../../api';
import { TASK_CATEGORY, type Project, type Task, type TaskStatus } from '../../types';
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
  notify: (message: string, error?: boolean) => void;
}) {
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dragOverCol, setDragOverCol] = useState<TaskStatus | null>(null);
  const [busyId, setBusyId] = useState<string>('');

  const projectMap = new Map(projects.map(p => [p.id, p.name]));

  const transitionTask = async (task: Task, nextStatus: TaskStatus) => {
    if (busyId || task.status === nextStatus) return;
    setBusyId(task.id);
    try {
      await execute('update_task', {
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
        note: `在看板中流转为「${COLUMNS.find(c => c.status === nextStatus)?.label ?? nextStatus}」`,
        clientRequestId: crypto.randomUUID(),
      });
      await onChanged();
      notify(`已将「${task.title}」移至${COLUMNS.find(c => c.status === nextStatus)?.label ?? nextStatus}。`);
    } catch (caught) {
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
            onDragLeave={() => {
              if (dragOverCol === col.status) setDragOverCol(null);
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
              <span className="kanban-count">{colTasks.length}</span>
            </header>
            <div className="kanban-column-body">
              {colTasks.length === 0 ? (
                <div className="kanban-empty">拖拽卡片到此列</div>
              ) : (
                colTasks.map(task => {
                  const overdue = !!task.dueDate && task.dueDate < day && col.status !== 'done';
                  const selected = selectedId === task.id;
                  const busy = busyId === task.id;
                  return (
                    <article
                      key={task.id}
                      draggable={!busy}
                      onDragStart={e => {
                        setDraggingId(task.id);
                        e.dataTransfer.setData('text/plain', task.id);
                      }}
                      onDragEnd={() => {
                        setDraggingId(null);
                        setDragOverCol(null);
                      }}
                      className={`kanban-card ${selected ? 'is-selected' : ''} ${draggingId === task.id ? 'is-dragging' : ''}`}
                      onClick={() => onSelect(task.id)}
                    >
                      <div className="kanban-card-top">
                        <div className="kanban-card-badges">
                          {task.priority === 'high' && <span className="priority-high">高优</span>}
                          <span className="kanban-project-tag">{projectMap.get(task.projectId) ?? '项目'}</span>
                        </div>
                        <span className="kanban-category">{TASK_CATEGORY[task.category]}</span>
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
