// Real end-to-end DeepSeek (`deepseek-flash`) evaluation of the refactored Memory + User Habit systems.
// Routes all requests through a loopback usage-recording proxy so DEEPSEEK_API_KEY never touches disk.
//
// Covers 4 live end-to-end tracks through production `pm-host.exe` + `pi-copilot-agent.ts`:
//   Track A: Grounded Memory QA with Chinese Jieba + Custom Entity Aliases + Abstention (8 Q)
//   Track B: Real Extraction -> Sleep-Time Conflict Audit -> Resolution -> Grounded QA
//   Track C: PRELUDE Writing Habit Learning -> `polish_report` A/B Adherence (4 fresh drafts × 2)
//   Track D: PAHF Copilot Workflow Learning -> Habit Adherence -> Preference Drift -> Fact Separation
import http from 'node:http';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { createPmCopilotAgent } from '../../src/components/shell/pi-copilot-agent.ts';

const apiKey = process.env.DEEPSEEK_API_KEY;
if (!apiKey) throw new Error('DEEPSEEK_API_KEY is required.');
const model = process.env.LIVE_EVAL_MODEL || 'deepseek-flash';
const maxRequests = 120;
const root = path.resolve(import.meta.dirname, '../..');
const binary = path.resolve(process.env.PM_HOST_BINARY || path.join(root, 'target/debug', process.platform === 'win32' ? 'pm-host.exe' : 'pm-host'));
const outputPath = path.resolve(process.env.LIVE_E2E_OUT || path.join(root, 'output/live-deepseek-20261125/results.json'));
const enabledTracks = new Set(
  (process.env.TRACKS || 'A,B,C,D')
    .split(',')
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean),
);

const receipts = [];
const proxyToken = randomUUID();
let activeTag = 'init';

const proxy = http.createServer(async (req, res) => {
  if (req.headers.authorization !== `Bearer ${proxyToken}` || req.method !== 'POST' || !req.url?.endsWith('/chat/completions')) {
    res.writeHead(403).end();
    return;
  }
  if (receipts.length >= maxRequests) {
    res.writeHead(429, { 'Content-Type': 'application/json' }).end('{"error":"maxRequests reached"}');
    return;
  }
  const t0 = performance.now();
  const receipt = { index: receipts.length + 1, tag: activeTag, startedAt: new Date().toISOString() };
  receipts.push(receipt);
  try {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    body.thinking = { type: 'disabled' };
    receipt.model = body.model;
    const upstream = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(95_000),
    });
    const raw = await upstream.text();
    receipt.httpStatus = upstream.status;
    receipt.elapsedMs = +(performance.now() - t0).toFixed(1);
    try {
      const parsed = JSON.parse(raw);
      receipt.actualModel = parsed.model;
      receipt.usage = parsed.usage ?? null;
      receipt.finishReason = parsed.choices?.[0]?.finish_reason ?? null;
    } catch {}
    res.writeHead(upstream.status, { 'Content-Type': 'application/json' }).end(raw);
  } catch (err) {
    receipt.error = String(err.message).replaceAll(apiKey, '[REDACTED]');
    receipt.elapsedMs = +(performance.now() - t0).toFixed(1);
    res.writeHead(502, { 'Content-Type': 'application/json' }).end('{"error":{"message":"upstream failed"}}');
  }
});

async function openHost(label, baseUrl) {
  await mkdir(path.join(root, '.local-data'), { recursive: true });
  const runRoot = await mkdtemp(path.join(root, '.local-data', `live-e2e-${label}-`));
  const ws = path.join(runRoot, 'workspace');
  const child = spawn(binary, [ws], { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] });
  const pending = new Map();
  let seq = 0;
  const rl = createInterface({ input: child.stdout });
  rl.on('line', (line) => {
    if (!line.trim()) return;
    const reply = JSON.parse(line);
    const req = pending.get(reply.id);
    if (!req) return;
    clearTimeout(req.timer);
    pending.delete(reply.id);
    if (reply.ok) req.resolve(reply.data);
    else req.reject(Object.assign(new Error(`${reply.error.code}: ${reply.error.message}`), { code: reply.error.code }));
  });
  let stderr = '';
  child.stderr.on('data', (b) => { stderr += b.toString('utf8'); });
  child.on('exit', (code) => {
    for (const req of pending.values()) { clearTimeout(req.timer); req.reject(new Error(`pm-host exited (${code}): ${stderr.slice(-500)}`)); }
    pending.clear();
  });
  const call = (command, payload = {}) => new Promise((resolve, reject) => {
    const id = ++seq;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Timeout: ${command}`)); }, 130_000);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(`${JSON.stringify({ id, command, payload })}\n`);
  });
  const waitSourceReady = async (sourceId) => {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const st = await call('get_state', {});
      const s = st.sources.find((x) => x.id === sourceId);
      if (s?.status === 'ready') return;
      if (s?.status === 'failed') throw new Error(`source failed: ${s.error}`);
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error('source ready timeout');
  };
  const waitJobDone = async (jobId) => {
    if (!jobId) throw new Error('missing jobId from start_extraction');
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      const st = await call('get_state', {});
      const j = st.jobs.find((x) => x.id === jobId);
      if (j && ['succeeded', 'failed', 'cancelled'].includes(j.status)) return j;
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error(`job timeout: ${jobId}`);
  };
  const importAndConfirm = async (projectId, title, text, content, kind = 'fact') => {
    const imp = await call('import_text', { projectId, title, text });
    await waitSourceReady(imp.sourceId);
    const detail = await call('get_source', { sourceId: imp.sourceId });
    const segId = detail.segments[0].id;
    const prop = await call('create_proposal', { projectId, sourceId: imp.sourceId, kind, content, segmentIds: [segId] });
    const mem = await call('confirm_proposal', { proposalId: prop.id });
    return { sourceId: imp.sourceId, segmentId: segId, memoryId: mem.id };
  };

  await call('save_ai_settings', {
    provider: 'openai_compatible',
    baseUrl,
    model,
    outputFormat: 'json_object',
    timeoutSeconds: 90,
    autoExtract: false,
    remoteConsent: false,
    apiKey: proxyToken,
  });

  const close = async () => {
    const exited = once(child, 'exit');
    child.stdin.end();
    await exited;
    rl.close();
    await rm(runRoot, { recursive: true, force: true }).catch(() => {});
  };
  return { call, waitSourceReady, waitJobDone, importAndConfirm, close };
}

function hasPercentage(text) {
  return /\d\s*[%％]/.test(text);
}
function firstPos(text, markers) {
  let best = Infinity;
  for (const m of markers) {
    const i = text.indexOf(m);
    if (i >= 0 && i < best) best = i;
  }
  return best === Infinity ? null : best;
}
function risksBeforeProgress(text) {
  const r = firstPos(text, ['风险', '阻塞', '卡点', '待拍板', '待决策', '需协调', '待确认', '需关注']);
  const p = firstPos(text, ['进展', '完成', '推进中', '本期完成', '今日完成']);
  return r !== null && p !== null && r < p;
}
function softenedWording(text) {
  const hasHard = text.includes('风险') || text.includes('阻塞');
  const hasSoft = text.includes('需协调') || text.includes('待确认') || text.includes('需关注');
  return !hasHard && hasSoft;
}
function bulletCount(text) {
  return text.split('\n').filter((l) => /^\s*[-*•·]\s+/.test(l)).length;
}

proxy.listen(0, '127.0.0.1');
await once(proxy, 'listening');
const baseUrl = `http://127.0.0.1:${proxy.address().port}`;

let trackAResult = null;
let trackBResult = null;
let trackCResult = null;
let trackDResult = null;

try {
  // =========================================================================
  // TRACK A: Grounded Memory QA with Chinese Aliases + Abstention (8 Q)
  // =========================================================================
  if (enabledTracks.has('A')) {
    console.log('=== Track A: Live Grounded Memory QA with Chinese Aliases ===');
    const hostA = await openHost('trackA', baseUrl);
    const trackAResults = [];
    try {
      const p1 = await hostA.call('create_project', { name: '支付重构二期' });
      const p2 = await hostA.call('create_project', { name: '隔离秘密项目' });
      const pid = p1.id;

      const facts = [
        '支付重构核心交易路由模块由王明负责，预计 2026-12-05 完成联调。',
        '压力测试与全链路回归验证由张敏负责，峰值目标为 5000 TPS。',
        '风险控制引擎实时拦截延迟上限为 35 毫秒，超时自动降级放行。',
        '支付重构灰度切流首批放量比例为 5%，观察 48 小时无异常后再扩量。',
        '短信验证码方案已否决，二期登录仅保留硬件安全密钥和邮箱验证码。',
        '清结算网关主库升级至 MySQL 8.0，需在上线前 7 天冻结 DDL。',
      ];
      for (let i = 0; i < facts.length; i++) {
        await hostA.importAndConfirm(pid, `纪要${i + 1}`, facts[i], facts[i]);
      }
      const arch = await hostA.importAndConfirm(pid, '废止纪要', '支付重构旧版路由采用明文转发，由赵强临时托管。', '支付重构旧版路由采用明文转发，由赵强临时托管。');
      const impact = await hostA.call('lifecycle_impact', { kind: 'source', id: arch.sourceId });
      await hostA.call('set_lifecycle', { kind: 'source', id: arch.sourceId, archived: true, reason: '废止', baseVersion: 0, fingerprint: impact.fingerprint });
      await hostA.importAndConfirm(p2.id, '秘密资料', '老王在隔离项目中负责绝密口令 SECRET_TOKEN_42。', '老王在隔离项目中负责绝密口令 SECRET_TOKEN_42。');

      for (const a of [
        { canonical: '王明', aliases: ['老王', '后端王哥'], kind: 'person' },
        { canonical: '张敏', aliases: ['敏姐'], kind: 'person' },
        { canonical: '支付重构', aliases: ['二期', '支付二期'], kind: 'project' },
        { canonical: '风险控制引擎', aliases: ['风控', 'RC'], kind: 'term' },
        { canonical: '清结算网关', aliases: ['清算'], kind: 'project' },
      ]) {
        await hostA.call('save_entity_alias', { projectId: pid, ...a });
      }

      const qaCases = [
        { id: 'alias_person', q: '老王负责哪个模块，预计哪天完成联调？', answerable: true, mustMatch: [/王明/, /路由/, /12-05|12月5/] },
        { id: 'alias_term', q: 'RC 实时拦截超时阈值是多少，超时怎么处理？', answerable: true, mustMatch: [/35/, /降级|放行/] },
        { id: 'alias_project', q: '二期首批灰度放量比例是多少，需要观察多久？', answerable: true, mustMatch: [/5%/, /48/] },
        { id: 'alias_multi', q: '敏姐负责的压测峰值目标是多少 TPS，清算主库升级前要冻结什么？', answerable: true, mustMatch: [/5000/, /DDL/i] },
        { id: 'negation_decision', q: '二期登录还支持短信验证码吗？', answerable: true, mustMatch: [/否决|不支持|不采用|不保留/] },
        { id: 'archived_abstention', q: '支付重构旧版路由是谁临时托管的，是否明文转发？', answerable: false, forbid: [/赵强/, /明文/] },
        { id: 'cross_project_abstention', q: '老王负责的绝密口令是什么？', answerable: false, forbid: [/SECRET_TOKEN_42/] },
        { id: 'unknown_abstention', q: '支付重构二期的生产 Redis 集群部署在哪个机房？', answerable: false, forbid: [/北京|上海|深圳|阿里云|腾讯云/] },
      ];

      for (const tc of qaCases) {
        activeTag = `trackA:${tc.id}`;
        const t0 = performance.now();
        const ans = await hostA.call('ask_assistant', { projectId: pid, question: tc.q, date: '2026-11-24', useModel: true });
        const elapsedMs = +(performance.now() - t0).toFixed(1);
        const text = ans.answer || '';
        const passed = tc.answerable
          ? ans.grounded === true && ['answered', 'partial'].includes(ans.status) && tc.mustMatch.every((re) => re.test(text))
          : (ans.status === 'unknown' || ans.grounded === false) && (tc.forbid || []).every((re) => !re.test(text));
        console.log(`  [${tc.id}] status=${ans.status} grounded=${ans.grounded} pass=${passed} (${elapsedMs}ms)`);
        trackAResults.push({
          id: tc.id, question: tc.q, answerable: tc.answerable,
          status: ans.status, grounded: ans.grounded, citations: (ans.citations || []).length,
          elapsedMs, passed, answerPreview: text.slice(0, 220),
        });
      }
      const pos = trackAResults.filter((r) => r.answerable);
      const neg = trackAResults.filter((r) => !r.answerable);
      trackAResult = {
        answerablePassed: `${pos.filter((r) => r.passed).length}/${pos.length}`,
        abstentionPassed: `${neg.filter((r) => r.passed).length}/${neg.length}`,
        cases: trackAResults,
      };
    } catch (err) {
      console.error('  Track A failed:', err.message);
      trackAResult = { error: String(err.message).replaceAll(apiKey, '[REDACTED]'), cases: trackAResults };
    } finally {
      await hostA.close();
    }
  }

  // =========================================================================
  // TRACK B: Real DeepSeek Extraction -> Sleep-Time Conflict Audit -> Resolve -> QA
  // =========================================================================
  if (enabledTracks.has('B')) {
    console.log('=== Track B: Real Extraction -> Sleep-Time Conflict Audit -> Resolve -> QA ===');
    const hostB = await openHost('trackB', baseUrl);
    try {
      const p = await hostB.call('create_project', { name: '海外清结算上线' });
      const pid = p.id;
      const doc1 = '【11月周会纪要】海外清结算网关灰度上线日期确定为 2026-12-01。风控对账校验模块由王明负责。';
      const doc2 = '【11月24日排期变更通知】因银行联调顺延，海外清结算网关灰度上线日期确定为 2026-12-10。风控对账校验模块改由李静负责。';

      const s1 = await hostB.call('import_text', { projectId: pid, title: '11月周会纪要', text: doc1 });
      await hostB.waitSourceReady(s1.sourceId);
      activeTag = 'trackB:extract_doc1';
      const j1 = await hostB.call('start_extraction', { sourceId: s1.sourceId });
      const j1Done = await hostB.waitJobDone(j1.id ?? j1.jobId ?? j1.job?.id);

      const s2 = await hostB.call('import_text', { projectId: pid, title: '排期变更通知', text: doc2 });
      await hostB.waitSourceReady(s2.sourceId);
      activeTag = 'trackB:extract_doc2';
      const j2 = await hostB.call('start_extraction', { sourceId: s2.sourceId });
      const j2Done = await hostB.waitJobDone(j2.id ?? j2.jobId ?? j2.job?.id);

      const st = await hostB.call('get_state', {});
      const pendingProps = st.proposals.filter((x) => x.projectId === pid && x.status === 'pending');
      const confirmedMems = [];
      const skippedProposals = [];
      for (const prop of pendingProps) {
        try {
          const m = await hostB.call('confirm_proposal', { proposalId: prop.id });
          confirmedMems.push({ id: m.id, content: m.content });
        } catch (err) {
          skippedProposals.push({ id: prop.id, code: err.code || 'ERROR', message: err.message });
        }
      }

      const audit = await hostB.call('run_memory_audit', { projectId: pid });
      const auditKinds = audit.audits.map((a) => a.kind);
      let resolvedAudits = 0;
      for (const item of audit.audits) {
        const keepA = item.memoryA.content.includes('12-10') || item.memoryA.content.includes('李静');
        const keepB = item.memoryB.content.includes('12-10') || item.memoryB.content.includes('李静');
        if (keepA || keepB) {
          await hostB.call('resolve_memory_audit', { auditId: item.id, action: keepA ? 'keep_a' : 'keep_b', reason: '采用最新11月24日变更通知' });
          resolvedAudits++;
        }
      }

      activeTag = 'trackB:qa_after_resolve';
      const qaDate = await hostB.call('ask_assistant', { projectId: pid, question: '海外清结算网关灰度上线日期是哪天？', date: '2026-11-24', useModel: true });
      const qaOwner = await hostB.call('ask_assistant', { projectId: pid, question: '风控对账校验模块现在由谁负责？', date: '2026-11-24', useModel: true });

      trackBResult = {
        job1Status: j1Done.status,
        job2Status: j2Done.status,
        pendingProposalsSeen: pendingProps.length,
        extractedAndConfirmedCount: confirmedMems.length,
        skippedConfirmCount: skippedProposals.length,
        skippedProposals,
        confirmedContents: confirmedMems.map((m) => m.content),
        detectedAuditCount: audit.openCount,
        detectedAuditKinds: auditKinds,
        resolvedAudits,
        qaDate: {
          status: qaDate.status, grounded: qaDate.grounded,
          hasNewDate: /12-10|12月10/.test(qaDate.answer || ''),
          leakedOldDate: /12-01|12月1/.test(qaDate.answer || ''),
          answerPreview: (qaDate.answer || '').slice(0, 200),
        },
        qaOwner: {
          status: qaOwner.status, grounded: qaOwner.grounded,
          hasNewOwner: /李静/.test(qaOwner.answer || ''),
          leakedOldOwner: /王明/.test(qaOwner.answer || ''),
          answerPreview: (qaOwner.answer || '').slice(0, 200),
        },
      };
      console.log('  Track B:', JSON.stringify({
        extracted: confirmedMems.length, skipped: skippedProposals.length,
        audits: auditKinds, resolvedAudits,
        qaDateOk: trackBResult.qaDate.hasNewDate && !trackBResult.qaDate.leakedOldDate,
        qaOwnerOk: trackBResult.qaOwner.hasNewOwner && !trackBResult.qaOwner.leakedOldOwner,
      }));
    } catch (err) {
      console.error('  Track B failed:', err.message);
      trackBResult = { error: String(err.message).replaceAll(apiKey, '[REDACTED]') };
    } finally {
      await hostB.close();
    }
  }

  // =========================================================================
  // TRACK C: PRELUDE Habit Learning -> `polish_report` A/B Adherence (4 drafts × 2)
  // =========================================================================
  if (enabledTracks.has('C')) {
    console.log('=== Track C: PRELUDE Writing Habits -> Live DeepSeek `polish_report` A/B ===');
    const hostC = await openHost('trackC', baseUrl);
    trackCResult = { baseline: [], withHabits: [] };
    try {
      const p = await hostC.call('create_project', { name: '核心交易重构' });
      const pid = p.id;
      const drafts = [
        {
          id: 'd1',
          facts: ['王明', '12月5日', '测试证书'],
          text: '今日完成：支付接口联调进度 75%，王明已完成路由改造 80%，预计 12月5日 提测。当前阻塞与风险：运维尚未下发测试证书，导致联调环境阻塞。',
        },
        {
          id: 'd2',
          facts: ['张敏', '5000 TPS', '压测账号'],
          text: '本期进展：张敏推进全链路压测准备 60%，目标是 5000 TPS，脚本编写完成 90%。风险项：供应商压测账号审批阻塞，存在延期风险。',
        },
        {
          id: 'd3',
          facts: ['陈伟', 'MySQL 8.0', 'DDL'],
          text: '推进情况：清结算网关 MySQL 8.0 升级演练完成 55%，陈伟正在核对迁移脚本 70%。阻塞与风险：业务方尚未确认 DDL 冻结窗口，存在上线风险。',
        },
        {
          id: 'd4',
          facts: ['李静', '48小时', '灰度名单'],
          text: '今日进展：李静完成灰度监控配置 85%，计划首批放量后观察 48小时。当前风险：产品尚未拍板首批灰度名单，导致切流阻塞。',
        },
      ];

      const evalDrafts = async (label) => {
        const rows = [];
        for (const d of drafts) {
          activeTag = `trackC:${label}:${d.id}`;
          const t0 = performance.now();
          const res = await hostC.call('polish_report', {
            projectId: pid,
            content: d.text,
            reportType: 'daily',
            style: 'team',
            projectName: '核心交易重构',
            dateLabel: '2026-11-24',
          });
          const out = res.polished || res.content || JSON.stringify(res);
          rows.push({
            id: d.id,
            elapsedMs: +(performance.now() - t0).toFixed(1),
            omitsPercentages: !hasPercentage(out),
            risksFirst: risksBeforeProgress(out),
            softenedWording: softenedWording(out),
            hasBullets: bulletCount(out) >= 3,
            factsPreserved: d.facts.every((f) => out.includes(f)),
            missingFacts: d.facts.filter((f) => !out.includes(f)),
            preview: out.slice(0, 260),
          });
        }
        return rows;
      };

      trackCResult.baseline = await evalDrafts('baseline');

      for (let step = 1; step <= 3; step++) {
        const day = `2026-11-${String(20 + step).padStart(2, '0')}`;
        const gen = await hostC.call('generate_daily_report', { clientRequestId: randomUUID(), date: day, projectId: pid });
        const s1 = await hostC.call('save_daily_report', {
          clientRequestId: randomUUID(), reportId: gen.id, baseVersion: gen.version,
          content: '今日完成：接口联调进度 65%，测试用例进度 40%。存在风险：测试环境不稳定导致验收阻塞。',
        });
        await hostC.call('save_daily_report', {
          clientRequestId: randomUUID(), reportId: s1.id, baseVersion: s1.version,
          content: '## 需协调与待确认事项\n- 需协调：测试环境稳定性排查\n- 待确认：验收窗口排期\n\n## 今日进展\n- 接口联调按计划推进中\n- 测试用例持续补齐中',
        });
      }
      const center = await hostC.call('get_habits_center', { projectId: pid });
      const confirmedHabitKeys = [];
      for (const prop of center.proposals) {
        await hostC.call('resolve_habit_proposal', { proposalId: prop.id, action: 'confirm' });
        confirmedHabitKeys.push(prop.patternKey);
      }

      trackCResult.learnedAndConfirmedHabits = confirmedHabitKeys;
      trackCResult.withHabits = await evalDrafts('withHabits');

      const summarizeC = (rows) => ({
        n: rows.length,
        omitPercentagesRate: +(rows.filter((r) => r.omitsPercentages).length / rows.length).toFixed(2),
        risksFirstRate: +(rows.filter((r) => r.risksFirst).length / rows.length).toFixed(2),
        softenedWordingRate: +(rows.filter((r) => r.softenedWording).length / rows.length).toFixed(2),
        bulletStyleRate: +(rows.filter((r) => r.hasBullets).length / rows.length).toFixed(2),
        factsPreservedRate: +(rows.filter((r) => r.factsPreserved).length / rows.length).toFixed(2),
      });
      trackCResult.summary = {
        baseline: summarizeC(trackCResult.baseline),
        withHabits: summarizeC(trackCResult.withHabits),
      };
      console.log('  Track C Baseline:', trackCResult.summary.baseline);
      console.log('  Track C WithHabits:', trackCResult.summary.withHabits);
    } catch (err) {
      console.error('  Track C failed:', err.message);
      trackCResult.error = String(err.message).replaceAll(apiKey, '[REDACTED]');
    } finally {
      await hostC.close();
    }
  }

  // =========================================================================
  // TRACK D: PAHF Copilot Workflow Learning -> Adherence -> Drift -> Fact Safety
  // =========================================================================
  if (enabledTracks.has('D')) {
    console.log('=== Track D: Live DeepSeek Copilot PAHF Habit Loop + Drift + Fact Safety ===');
    const hostD = await openHost('trackD', baseUrl);
    trackDResult = {};
    try {
      const p = await hostD.call('create_project', { name: '支付重构二期' });
      const pid = p.id;
      await hostD.importAndConfirm(pid, '核心分工', '支付重构核心交易路由模块由陈雨负责，王明仅负责外围压测脚本。', '支付重构核心交易路由模块由陈雨负责，王明仅负责外围压测脚本。');

      const runCopilotTurn = async (tag, userPrompt, approvalFn) => {
        activeTag = `trackD:${tag}`;
        const state = await hostD.call('get_state', {});
        const habits = (await hostD.call('get_habits_center', { projectId: pid })).habits;
        const aliases = (await hostD.call('list_entity_aliases', { projectId: pid })).aliases;
        const capturedToolCalls = [];

        const agent = createPmCopilotAgent({
          executor: async (cmd, payload) => {
            if (cmd === 'create_task') {
              return await hostD.call('create_task', { ...payload, clientRequestId: payload.clientRequestId || randomUUID() });
            }
            return await hostD.call(cmd, payload);
          },
          getState: () => state,
          getDate: () => '2026-11-24',
          getProjectId: () => pid,
          getContextLabel: () => '项目工作台',
          getHabits: () => habits,
          getAliases: () => aliases,
          onMutated: async () => {},
          requestApproval: async (req) => {
            capturedToolCalls.push({ toolName: req.toolName, proposedArgs: { ...req.args } });
            return await approvalFn(req);
          },
        });
        await agent.prompt(userPrompt);
        await agent.waitForIdle();
        await new Promise((r) => setTimeout(r, 80));
        const messages = agent.state?.messages ?? [];
        const lastMsg = messages.filter((m) => m.role === 'assistant').at(-1);
        const replyText = Array.isArray(lastMsg?.content)
          ? lastMsg.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n')
          : String(lastMsg?.content || '');
        const usedTools = messages
          .filter((m) => m.role === 'assistant' && Array.isArray(m.content))
          .flatMap((m) => m.content.filter((c) => c.type === 'toolCall').map((c) => c.name));
        return { capturedToolCalls, usedTools, replyText: replyText.slice(0, 300) };
      };

      const s1 = await runCopilotTurn(
        'stage1_cold_start',
        '帮我给支付重构二期项目新建一个任务，标题是「补齐压测报告」，其他按默认即可。',
        async () => ({ approved: true, overrideArgs: { priority: 'high', assignee: '王明' }, rememberAsHabit: true }),
      );
      const habitsAfterS1 = (await hostD.call('get_habits_center', { projectId: pid })).habits;

      const s2 = await runCopilotTurn(
        'stage2_adherence',
        '再帮我给支付重构二期项目新建一个任务，标题是「核对灰度回滚脚本」，直接发起创建。',
        async () => ({ approved: true }),
      );

      await runCopilotTurn(
        'stage3_shift',
        '再给支付重构二期新建一个任务，标题是「清理历史测试数据」，直接发起创建。',
        async () => ({ approved: true, overrideArgs: { priority: 'low' }, rememberAsHabit: true }),
      );
      const habitsAfterShift = (await hostD.call('get_habits_center', { projectId: pid })).habits;

      const s3Verify = await runCopilotTurn(
        'stage3_verify',
        '再给支付重构二期新建一个任务，标题是「整理上线验收清单」，直接发起创建。',
        async () => ({ approved: true }),
      );

      const s4Safety = await runCopilotTurn(
        'stage4_fact_safety',
        '支付重构核心交易路由模块是谁负责的？请先核实项目记忆再回答。',
        async () => ({ approved: false }),
      );

      const s2Proposed = s2.capturedToolCalls[0]?.proposedArgs || {};
      const s3VerifyProposed = s3Verify.capturedToolCalls[0]?.proposedArgs || {};
      trackDResult.stage1_coldStart = {
        proposedArgs: s1.capturedToolCalls[0]?.proposedArgs || null,
        activeHabitsCreated: habitsAfterS1.filter((h) => h.status === 'active').map((h) => h.patternKey),
      };
      trackDResult.stage2_adherence = {
        proposedArgs: s2Proposed,
        followedPriorityHigh: s2Proposed.priority === 'high',
        followedAssigneeWangMing: s2Proposed.assignee === '王明',
      };
      trackDResult.stage3_preferenceShift = {
        activeHabitsAfterShift: habitsAfterShift.filter((h) => h.status === 'active').map((h) => h.patternKey),
        pausedHabitsAfterShift: habitsAfterShift.filter((h) => h.status === 'paused').map((h) => h.patternKey),
        nextTaskProposedArgs: s3VerifyProposed,
        adaptedToPriorityLow: s3VerifyProposed.priority === 'low',
        preservedAssigneeWangMing: s3VerifyProposed.assignee === '王明',
      };
      trackDResult.stage4_factSafety = {
        usedMemoryTool: s4Safety.usedTools.some((t) => t === 'ask_verified_memory' || t === 'search_project_memory'),
        usedTools: s4Safety.usedTools,
        answeredChenYu: /陈雨/.test(s4Safety.replyText),
        replyPreview: s4Safety.replyText,
      };
      console.log('  Track D:', JSON.stringify(trackDResult, null, 2));
    } catch (err) {
      console.error('  Track D failed:', err.message);
      trackDResult.error = String(err.message).replaceAll(apiKey, '[REDACTED]');
    } finally {
      await hostD.close();
    }
  }

  const totalTokens = receipts.reduce((s, r) => s + (r.usage?.total_tokens || 0), 0);
  const promptTokens = receipts.reduce((s, r) => s + (r.usage?.prompt_tokens || 0), 0);
  const completionTokens = receipts.reduce((s, r) => s + (r.usage?.completion_tokens || 0), 0);

  const report = {
    recordedAt: new Date().toISOString(),
    model,
    binary,
    totalApiRequests: receipts.length,
    usage: { promptTokens, completionTokens, totalTokens },
    trackA_groundedAliasQA: trackAResult,
    trackB_extractionAuditResolveQA: trackBResult,
    trackC_preludeReportPolishAB: trackCResult,
    trackD_pahfCopilotLoop: trackDResult,
    receiptsSummary: receipts.map((r) => ({ index: r.index, tag: r.tag, status: r.httpStatus, ms: r.elapsedMs, tokens: r.usage?.total_tokens ?? null })),
  };
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, JSON.stringify(report, null, 2), 'utf8');
  console.log('\nSaved live E2E DeepSeek report:', outputPath);
  console.log(`Total DeepSeek requests: ${receipts.length}, total tokens: ${totalTokens}`);
} finally {
  proxy.close();
}
