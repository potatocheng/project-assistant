import type { AssistantCitation } from './components/delivery/types';

export const PROJECT_QUESTIONS = ['今天先跟进谁？', '本周卡在哪里？', '哪些交付可能延期？', '有哪些待决策事项？', '需求变更审批情况？', '交付验收情况？', '最近有哪些周报？', '有哪些会议准备？'];

export const CITATION_KIND: Record<AssistantCitation['kind'], string> = {
  governance: '风险与决策', change: '需求变更', deliverable: '交付验收', meeting: '会议记录',
  meeting_action: '会议行动项', weekly_report: '周报', task: '任务', memory: '项目记忆',
  source_passage: '原文段落', milestone: '里程碑', project: '项目目标', report: '日报',
  relation: '依赖关系', plan: '每日排期', follow_up: '跟进记录',
};
