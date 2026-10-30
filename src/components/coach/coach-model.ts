import type { Task, TaskStatus } from '../../types';

export const TERMS = {
  '里程碑': { plain: '项目中需要特别检查的关键节点。', example: '例如“测试版可以交给业务方试用”，比“开发进行中”更容易判断是否达到。', action: '写清这个节点要交付什么、何时检查、由谁确认。' },
  '验收标准': { plain: '事先约定做到什么，才算完成。', example: '例如登录功能：正确验证码能登录，错误验证码有提示，由业务方实际试用确认。', action: '和接收成果的人一起列出能逐条检查的条件。' },
  '交付物': { plain: '做完后实际交给对方的成果。', example: '可以是一份方案、一个可用版本，或一份经过确认的数据。', action: '确认交给谁、交什么，以及对方怎样检查。' },
  '联调': { plain: '把不同人做的部分连起来，检查能不能一起正常工作。', example: '例如页面和登录接口一起运行，验证用户能真正登录。', action: '先确认双方负责人、可测试版本和一起检查的时间。' },
  '接口': { plain: '两个系统或模块交换信息的约定。', example: '例如登录页面把验证码交给后台，后台返回登录结果。', action: '确认谁提供、谁使用、需要传什么，以及何时能一起测试。' },
  'API': { plain: '程序之间按约定调用能力的接口。', example: '例如页面通过登录 API 请求后台验证用户。', action: '找提供方和使用方确认接口说明、测试环境和可用时间。' },
  'UAT': { plain: '让实际使用的人，按真实业务场景检查成果是否满足需要。', example: '例如客服人员亲自走一遍客户提交问题和处理问题的流程。', action: '约定参与人、测试场景、问题记录方式和通过条件。' },
  '灰度': { plain: '先让一小部分用户使用新版本，观察后再逐步扩大。', example: '例如先给一个业务组使用，确认稳定后再开放给其他组。', action: '确认试用范围、观察指标，以及出现问题时怎样恢复。' },
  '阻塞': { plain: '有一个具体问题，导致下一步暂时做不了。', example: '例如测试需要的账号还没开通，所以无法开始测试。', action: '写清缺什么、找谁解决，以及最晚何时需要。' },
  '依赖': { plain: '这件事需要等另一件事达到条件后才能继续。', example: '例如接口能使用后，页面才能开始联调。', action: '确认前置事项、交付人和可用时间，检查会影响哪些后续工作。' },
  '关键路径': { plain: '一组相互依赖、会直接影响整体完成时间的工作。', example: '例如开发、联调、验收必须依次完成，某一步延后可能影响上线。', action: '先核实前后依赖和预计耗时，再判断哪些延迟会影响最终日期。' },
  '基准日期': { plain: '最初确认的计划日期，用来和现在的预计日期比较。', example: '原约定周五完成，现在预计下周二完成，就需要解释变化和影响。', action: '保留原定日期，另行记录当前预计日期和调整原因。' },
} as const;
export type Term = keyof typeof TERMS;
export const BLOCKERS = {
  reply: { label: '等别人回复', next: '先核实对方目前的进展，以及何时能给出明确答复。', why: '未回复的原因还需要确认。先说明你需要的结果和时间，再询问是否需要协调。', question: '你现在在等谁给出什么结果？', draft: '想和你确认一下「{title}」目前的进展。方便告知何时能回复一个可确认的结果吗？如果有需要协调的地方，请告诉我。' },
  scope: { label: '没说清怎样算做好', next: '先和接收成果的人约定三条能逐项检查的完成条件。', why: '先对齐要交付的结果，再讨论日期，能减少反复修改。', question: '这件事最终由谁检查并确认完成？', draft: '我们把「{title}」要交付的内容确认一下：交什么、怎样检查、由谁确认？我先整理成清单，请你补充后一起确认。' },
  resource: { label: '缺人手或条件', next: '写清缺少的具体条件、受影响的工作和最晚需要时间，再找能协调的人。', why: '需要协调资源时，具体缺口和影响比笼统催促更有帮助。', question: '现在最缺少的一个条件是什么？', draft: '「{title}」目前缺少【具体条件，待补充】，影响【后续工作，待确认】。希望在【时间，待确认】前协调解决。请帮忙确认可行的安排，或一起讨论调整范围和顺序。' },
  decision: { label: '等人拍板', next: '把需要决定的问题、可选方案和影响发给有决定权的人。', why: '先确认由谁决定；建议方案和决定结果要分别记录。', question: '谁能决定这件事下一步怎么做？', draft: '「{title}」需要确认【待决定的问题】。目前可选方案是【方案与影响，待补充】。请帮忙确认采用哪种方案，以及何时能做决定。' },
  unknown: { label: '我也不确定', next: '先把正在等待的结果说清楚。', why: '不需要先判断问题类型，确认这一点后再选择合适的行动。', question: '现在等谁给出什么结果？', draft: '想对一下「{title}」：现在正在等谁给出什么结果？我先把这个信息确认下来，再一起安排下一步。' },
} as const;
export type Blocker = keyof typeof BLOCKERS;
export const OUTCOMES = { note: '先记下情况', progress: '有了实际进展', blocked: '仍有问题卡住', done: '已交付并确认完成' } as const;
export type Outcome = keyof typeof OUTCOMES;

// A promise or unanswered message never implies completion or a changed deadline.
export function outcomeUpdate(task: Task, outcome: Outcome) {
  if (outcome === 'note') return undefined;
  const status: TaskStatus = outcome === 'done' ? 'done' : outcome === 'blocked' ? 'blocked' : 'in_progress';
  return { baseVersion: task.version, status };
}
export function followUpNote(outcome: Outcome, note: string, contact: string, commitment: string) {
  return [`${OUTCOMES[outcome]}：${note.trim()}`, contact.trim() && `本次沟通对象：${contact.trim()}`, commitment && `对方承诺交付日期：${commitment}（实际交付待核实）`].filter(Boolean).join('\n');
}
