export type RhythmPhase = 'morning' | 'midday' | 'evening';

export function detectRhythmPhase(hour: number): RhythmPhase {
  if (hour >= 5 && hour < 12) return 'morning';
  if (hour >= 12 && hour < 17) return 'midday';
  return 'evening';
}

export interface SimpleProject {
  id: string;
  name: string;
}

export interface SimpleTask {
  id: string;
  projectId: string;
  title: string;
  description: string;
  category: 'action' | 'follow_up';
  assignee: string | null;
  priority: 'low' | 'medium' | 'high';
  status: 'todo' | 'in_progress' | 'blocked' | 'done' | 'cancelled';
  progress: number;
  dueDate: string | null;
  plannedDate: string | null;
  version: number;
}

export type CopilotActionPlan =
  | {
      kind: 'create_task';
      summary: string;
      projectId: string;
      title: string;
      assignee: string;
      priority: 'low' | 'medium' | 'high';
      dueDate: string | null;
      plannedDate: string | null;
      sourceInput: string;
    }
  | {
      kind: 'reschedule_task';
      summary: string;
      task: SimpleTask;
      newDueDate: string;
      sourceInput: string;
    }
  | {
      kind: 'complete_task';
      summary: string;
      task: SimpleTask;
      sourceInput: string;
    }
  | {
      kind: 'create_governance';
      summary: string;
      projectId: string;
      govKind: 'risk' | 'decision';
      title: string;
      severity: 'low' | 'medium' | 'high';
      dueDate: string | null;
      sourceInput: string;
    }
  | {
      kind: 'generate_report';
      summary: string;
      projectId: string;
      date: string;
      sourceInput: string;
    };

function formatYmd(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function addDays(baseYmd: string, days: number): string {
  const base = new Date(`${baseYmd}T12:00:00`);
  if (Number.isNaN(base.getTime())) return baseYmd;
  base.setDate(base.getDate() + days);
  return formatYmd(base);
}

const WEEKDAY_MAP: Record<string, number> = {
  日: 0, 天: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6,
};

export function parseRelativeDate(input: string, todayYmd: string): string | null {
  const iso = input.match(/\b(20\d{2})-(\d{1,2})-(\d{1,2})\b/);
  if (iso) {
    return `${iso[1]}-${iso[2].padStart(2, '0')}-${iso[3].padStart(2, '0')}`;
  }

  const cnDate = input.match(/(\d{1,2})月(\d{1,2})[日号]?/);
  if (cnDate) {
    const year = todayYmd.slice(0, 4);
    return `${year}-${cnDate[1].padStart(2, '0')}-${cnDate[2].padStart(2, '0')}`;
  }

  if (/大后天/.test(input)) return addDays(todayYmd, 3);
  if (/后天/.test(input)) return addDays(todayYmd, 2);
  if (/明天|明日/.test(input)) return addDays(todayYmd, 1);
  if (/今天|今日|今晚/.test(input)) return todayYmd;

  const weekdayMatch = input.match(/(下周|本周|这周|周|星期)([一二三四五六日天])/);
  if (weekdayMatch) {
    const prefix = weekdayMatch[1];
    const targetDay = WEEKDAY_MAP[weekdayMatch[2]];
    const base = new Date(`${todayYmd}T12:00:00`);
    if (!Number.isNaN(base.getTime()) && targetDay !== undefined) {
      const currentDay = base.getDay();
      let delta = targetDay - currentDay;
      if (prefix === '下周') {
        const daysToNextMon = ((8 - currentDay) % 7) || 7;
        const offsetFromMon = targetDay === 0 ? 6 : targetDay - 1;
        delta = daysToNextMon + offsetFromMon;
      } else if (delta <= 0) {
        delta += 7;
      }
      return addDays(todayYmd, delta);
    }
  }

  return null;
}

function findMatchingProject(
  input: string,
  projects: SimpleProject[],
  currentProjectId: string,
): string {
  const matched = projects.find(p => p.name && input.includes(p.name));
  if (matched) return matched.id;
  if (currentProjectId && projects.some(p => p.id === currentProjectId)) return currentProjectId;
  return projects[0]?.id ?? '';
}

function findMatchingTask(
  input: string,
  tasks: SimpleTask[],
  currentProjectId: string,
): SimpleTask | null {
  const active = tasks.filter(t => t.status !== 'done' && t.status !== 'cancelled');
  const scoped = currentProjectId ? active.filter(t => t.projectId === currentProjectId) : active;
  const candidates = scoped.length ? scoped : active;

  // 1. Direct substring match (prefer longest title match)
  const direct = candidates
    .filter(t => t.title.length >= 2 && input.includes(t.title))
    .sort((a, b) => b.title.length - a.title.length);
  if (direct[0]) return direct[0];

  // 2. Fuzzy character bigram overlap for short phrases like "把联调任务延到周五"
  const cleaned = input.replace(/(把|将|任务|延到|延期到|推迟到|改到|顺延到|标记为|标记|完成|已完成|今天|明天|后天|下周.|周.|星期.|\d{4}-\d{1,2}-\d{1,2}|\d{1,2}月\d{1,2}[日号]?|[，。！？：:\s])/g, '');
  if (cleaned.length < 2) return null;

  let best: { task: SimpleTask; score: number } | null = null;
  for (const task of candidates) {
    let score = 0;
    for (let i = 0; i < cleaned.length - 1; i++) {
      const gram = cleaned.slice(i, i + 2);
      if (task.title.includes(gram)) score += 2;
    }
    if (score >= 2 && (!best || score > best.score)) {
      best = { task, score };
    }
  }
  return best?.task ?? null;
}

export function planCopilotAction(
  rawInput: string,
  context: {
    projects: SimpleProject[];
    tasks: SimpleTask[];
    currentProjectId: string;
    date: string;
  },
): CopilotActionPlan | null {
  const input = rawInput.trim();
  if (!input || !context.projects.length) return null;

  // 1. Generate daily report
  if (/(生成|写|起草|整理|导出).{0,6}(日报|工作日报)/.test(input)) {
    const projectId = findMatchingProject(input, context.projects, context.currentProjectId);
    return {
      kind: 'generate_report',
      summary: `生成 ${context.date} 的工作日报草稿`,
      projectId: context.currentProjectId || '',
      date: context.date,
      sourceInput: input,
    };
  }

  // 2. Reschedule an existing task
  if (/(延到|延期到|推迟到|顺延到|改期到|截止日期?改到|改到)/.test(input)) {
    const newDueDate = parseRelativeDate(input, context.date);
    const task = findMatchingTask(input, context.tasks, context.currentProjectId);
    if (task && newDueDate) {
      return {
        kind: 'reschedule_task',
        summary: `将「${task.title}」截止日期调整为 ${newDueDate}`,
        task,
        newDueDate,
        sourceInput: input,
      };
    }
  }

  // 3. Complete an existing task
  if (/^(把|将)?.*(标记为?已完成|标为完成|已完成|完成了)|^(完成|做完了)/.test(input)) {
    const task = findMatchingTask(input, context.tasks, context.currentProjectId);
    if (task) {
      return {
        kind: 'complete_task',
        summary: `将「${task.title}」标记为已完成（100%）`,
        task,
        sourceInput: input,
      };
    }
  }

  // 4. Record governance risk or pending decision
  const govMatch = input.match(/^(记录|新增|添加|创建|提一个|建一个)?(项目)?(风险|阻塞风险|待决策|决策|拍板)[：:\s]*(.+)$/);
  if (govMatch) {
    const isDecision = /决策|拍板/.test(govMatch[3]);
    const title = govMatch[4].trim();
    if (title.length >= 2) {
      const projectId = findMatchingProject(input, context.projects, context.currentProjectId);
      const dueDate = parseRelativeDate(title, context.date);
      const severity: 'low' | 'medium' | 'high' = /(严重|紧急|阻塞|高风险)/.test(input) ? 'high' : 'medium';
      return {
        kind: 'create_governance',
        summary: `在项目中新增${isDecision ? '待决策' : '风险'}：「${title.slice(0, 40)}」`,
        projectId,
        govKind: isDecision ? 'decision' : 'risk',
        title: title.slice(0, 200),
        severity,
        dueDate,
        sourceInput: input,
      };
    }
  }

  // 5. Create a new task
  const taskMatch = input.match(/^(帮我)?(新建|创建|添加|加一个|建一个|安排)(一个|一条)?(今日)?(任务|待办)[：:\s]*(.+)$/);
  if (taskMatch) {
    const body = taskMatch[6].trim();
    if (body.length >= 2) {
      const projectId = findMatchingProject(input, context.projects, context.currentProjectId);
      const parsedDate = parseRelativeDate(body, context.date);
      const assigneeMatch = body.match(/(?:负责人|指派给|交给|由)[：:\s]?([\u4e00-\u9fa5A-Za-z0-9_-]{2,12})/);
      const priority: 'low' | 'medium' | 'high' = /(紧急|高优|高优先级|立刻|马上)/.test(body)
        ? 'high'
        : /(低优|不急)/.test(body)
          ? 'low'
          : 'medium';
      const cleanedTitle = body
        .replace(/[，,]?\s*(?:负责人|指派给|交给|由)[：:\s]?[\u4e00-\u9fa5A-Za-z0-9_-]{2,12}/g, '')
        .trim();
      const title = (cleanedTitle || body).slice(0, 180);
      return {
        kind: 'create_task',
        summary: `新建任务「${title}」${parsedDate ? `（截止 ${parsedDate}）` : ''}`,
        projectId,
        title,
        assignee: assigneeMatch?.[1] ?? '',
        priority,
        dueDate: parsedDate,
        plannedDate: /今日|今天/.test(input) ? context.date : parsedDate,
        sourceInput: input,
      };
    }
  }

  return null;
}
