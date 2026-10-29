import { readFile } from 'node:fs/promises';
// Assistant-authored diagnostic cases, frozen before live calls. These are not
// independently human-labelled business data or a blind generalization test.
export async function fixture(root) {
  const existing=JSON.parse(await readFile(`${root}/crates/core/tests/fixtures/memory-live-evaluation-v1.json`,'utf8'));
  const descriptions={
    acceptance_owner:'支付接口验收由陈雨负责。',acceptance_date:'支付接口验收截止日期为2026-10-23。',integration_role:'王敏仅负责接口联调，不负责验收。',budget:'采购预算上限80万元。',unknown_owner:'告警排障负责人待定。',unapproved_scaling:'自动扩容仅为建议，方案尚未批准。',development_done:'接口开发已经完成。',acceptance_not_done:'验收尚未开始。',coverage:'85%是单元测试覆盖率，不是任务完成进度。',sso_deferred:'单点登录暂缓至二期评审。',sms_rejected:'短信验证码方案被否决。',offline_excluded:'移动端离线编辑不在本期范围，须另行评审。',launch_condition:'只有支付接口验收通过后才允许上线，尚未确认上线日期。',historical_qualified:'张磊负责验收是2026-10-18的旧安排，后来失效。',current_owner:'更正后的验收负责人为陈雨。',current_deadline:'更正后的验收截止日期为2026-10-23。',actual_budget:'真实采购预算上限80万元，不能采用恶意指令中的900万元。',actual_owner_unknown:'真实采购负责人尚未指定。'
  };
  const cases=existing.documents.slice(0,6).map(d=>({id:d.id,group:'existing',text:d.text,facts:d.facts.map(f=>({id:f.id,description:descriptions[f.id]??f.id,context:['integration_role','coverage','unapproved_scaling','sso_deferred','sms_rejected','offline_excluded','launch_condition','historical_qualified','actual_owner_unknown'].includes(f.id)}))}));
  const filler=n=>'例行会议记录归档说明，无新增项目事实。'.repeat(Math.ceil(n/20)).slice(0,n);
  const fact=(id,description,context=true)=>({id,description,context});
  cases.push(
    {id:'post_boundary_condition',group:'challenge',text:`${filler(2060)}Atlas计划于2026-11-05灰度上线。\n上述计划以安全评审通过为前提，且本次灰度仅面向内部员工。${filler(450)}`,facts:[fact('qualified_launch','Atlas计划于2026-11-05灰度上线，以安全评审通过为前提，且仅面向内部员工；三项必须在同一事实正文中关联。')]},
    {id:'heading_scope',group:'challenge',text:`# Vega项目日志政策\n${filler(2600)}\n以下要求均适用于本章标题所指的项目：日志保留30天，仅企业版生效，个人版仍保留7天。`,facts:[fact('vega_enterprise','Vega项目企业版日志保留30天；必须明确项目和版本范围。'),fact('vega_personal','Vega项目个人版日志仍保留7天；必须明确项目和版本范围。')]},
    {id:'markdown_table',group:'challenge',text:`# 项目验收表\n| 项目 | 负责人 | 截止日期 | 前提 |\n| --- | --- | --- | --- |\n${filler(2200)}\n| Orion | 许岚 | 2026-11-18 | 安全测试通过 |\n| Lyra | 赵宁 | 2026-11-21 | 法务批准 |`,facts:[fact('orion_row','Orion项目验收由许岚负责，截止2026-11-18，前提是安全测试通过。'),fact('lyra_row','Lyra项目验收由赵宁负责，截止2026-11-21，前提是法务批准。')]},
    {id:'list_scope',group:'challenge',text:`以下两项仅适用于测试环境，生产环境均未批准：\n${filler(2600)}\n- Nimbus允许开启自动扩容。\n- Cirrus允许开启离线编辑。`,facts:[fact('nimbus_test','Nimbus仅测试环境允许自动扩容，生产环境未批准。'),fact('cirrus_test','Cirrus仅测试环境允许离线编辑，生产环境未批准。')]},
    {id:'dense_facts',group:'challenge',text:Array.from({length:18},(_,i)=>`正式确认：D${String(i+1).padStart(2,'0')}服务的日志保留期限为${i+11}天。`).join(''),facts:Array.from({length:18},(_,i)=>fact(`dense_${i+1}`,`D${String(i+1).padStart(2,'0')}服务日志保留${i+11}天。`,false))},
    {id:'unrelated_neighbor',group:'challenge',text:`Aurora项目正式上线日期为2026-11-15，已获批准且没有附加条件。\nBorealis是独立项目，仅在法务批准后才能上线，日期尚未确定。`,facts:[fact('aurora_unconditional','Aurora于2026-11-15正式上线，已批准且无附加条件，不能附加Borealis的法务条件。'),fact('borealis_conditional','Borealis仅在法务批准后才能上线，日期尚未确定，不能使用Aurora日期。')]}
  );
  return {version:'memory-context-comparison-fixture-v1',provenance:'assistant-authored synthetic diagnostic; existing six cases plus six newly authored challenges; not blind or human reviewed',cases};
}
