// Counterfactual free-text tasks. Each pair differs only in a confirmed preference.
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { openEvaluationHost } from './copilot-evaluation-host.mjs';

const [moduleFile, output, endpoint, model, embeddingUrl, embeddingModel] = process.argv.slice(2);
const { createPmCopilotAgent } = await import(pathToFileURL(path.resolve(moduleFile)).href);
const host = await openEvaluationHost(endpoint, model, embeddingUrl, embeddingModel);
const tasks = [
  ['交付文件', '设计评审结束了，我应该到哪里领取最终稿？给我一句话的建议。',
    '定稿后交付原型文件，默认存到', '松果资料柜', '潮汐资料柜'],
  ['故障联络', '服务突然掉线，需要叫我介入，用哪个渠道找我？请直接答复。',
    '遇到线上异常需要我响应，请通过', '星桥热线', '白杨值班群'],
  ['采购签核', '设备报价出来了，我去哪里办理批准手续？请给一句建议。',
    '如果要我签核采购，请在下列入口流转申请：', '云杉窗口', '远帆窗口'],
  ['离岗交接', '我明天换班，剩下没干完的活该放在哪里让接班人查到？',
    '交接遗留事项时，请统一登记到', '灯塔交接簿', '岩雀交接簿'],
];
const distractors = ['会议纪要先记结论', '日报采用条列式', '周会定在下午', '月末汇总费用',
  '汇报用短标题', '风险摘要分级', '需求评审要附示意图', '开票后归档凭证',
  '排期用工作日', '演示使用大字号', '测试清单含回归项', '评审提前发议程',
  '发布公告保留版本号', '看板按负责人分组', '复盘先讨论影响', '资料索引使用编号'];
const habit = (instruction, id, projectId = null) => ({ id, title:'已确认习惯', instruction,
  projectId, status:'active', category:'workflow', rule:{}, confidence:.9, utilityScore:.5, updatedAt:'2026-10-20' });
const rows = [];
try {
  for (const [task, stem, prefix, left, right] of tasks) {
    for (const mode of ['left', 'right', 'override']) {
      const stored = mode === 'right' ? right : left;
      const expected = mode === 'override' ? right : stored;
      const forbidden = expected === left ? right : left;
      const question = mode === 'override' ? stem + ' 这一次我明确指定用' + right + '。' : stem;
      const habits = [...distractors.map((s,i) => habit(s, 'n'+i)), habit(prefix+stored+'。','target'),
        habit(prefix+'外部项目入口。','foreign','different-project')];
      const state = { projects:[], tasks:[], aiSettings:{model,provider:'openai_compatible',baseUrl:endpoint} };
      const picks = [];
      let modelCalls = 0, targetShown = false;
      const agent = createPmCopilotAgent({ getState:()=>state, getProjectId:()=>'', getDate:()=>'2026-10-20',
        getContextLabel:()=>'工作台', getHabits:()=>habits, onMutated:async()=>{}, requestApproval:async()=>false,
        executor:async(command,payload)=>{
          if (command === 'select_copilot_habits' || command === 'rank_copilot_habits') {
            const result = await host.call(command,payload);
            picks.push(result);
            return result;
          }
          if (command === 'copilot_agent_turn') {
            targetShown ||= payload.messages[0].content.includes(prefix+stored);
            if (++modelCalls > 5) throw new Error('Tool loop exceeded the evaluation limit');
          }
          return host.call(command,payload);
        } });
      await agent.prompt(question);
      const last = agent.state.messages.at(-1);
      assert.equal(last?.role, 'assistant');
      const text = last.content.filter(part=>part.type==='text').map(part=>part.text).join('\n');
      rows.push({ task,mode,expected,forbidden,text,picks,targetShown,modelCalls,error:last.errorMessage,
        correct:last.stopReason === 'stop' && text.includes(expected) && !text.includes(forbidden) && !text.includes('外部项目入口') });
    }
  }
} finally { await host.close(); }
await writeFile(output,JSON.stringify(rows,null,2),{flag:'wx'});
console.log(rows.filter(r=>r.correct).length+'/'+rows.length);
