import { useState } from 'react';
import {
  ArrowRight, Check, CheckCircle2, FileText, FolderKanban, History, Layers3,
  MessageCircle, Settings2, Sparkles, Wand2,
} from 'lucide-react';
import { asError, execute } from '../../api';
import type { AiSettings, ImportResult, Project } from '../../types';
import { Spinner } from '../ui';
import { BrandMark } from './BrandMark';
import { applyProjectTemplate, PROJECT_TEMPLATES, seedDemoWorkspace } from './demo-seed';

interface Props {
  aiSettings?: AiSettings;
  onOpenModelSettings: () => void;
  onOpenFeishu: () => void;
  onRestore: () => void;
  onComplete: (projectId: string) => Promise<void>;
}

export function OnboardingWizard({
  aiSettings,
  onOpenModelSettings,
  onOpenFeishu,
  onRestore,
  onComplete,
}: Props) {
  const [step, setStep] = useState<1 | 2 | 3>(aiSettings?.configured ? 2 : 1);
  const [mode, setMode] = useState<'paste' | 'template' | 'sample' | 'feishu'>('paste');
  const [templateId, setTemplateId] = useState(PROJECT_TEMPLATES[0].id);
  const [projectName, setProjectName] = useState('');
  const [sourceTitle, setSourceTitle] = useState('');
  const [sourceText, setSourceText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [createdId, setCreatedId] = useState('');
  const [createdTitle, setCreatedTitle] = useState('');

  const modelReady = !!aiSettings?.configured;
  const activeTemplate = PROJECT_TEMPLATES.find(t => t.id === templateId) ?? PROJECT_TEMPLATES[0];

  const handleCreateAndImport = async () => {
    if (busy) return;
    setError('');
    setBusy(true);
    try {
      if (mode === 'sample') {
        const demoProjectId = await seedDemoWorkspace();
        setCreatedId(demoProjectId);
        setCreatedTitle('客户服务平台一期（示例）等 2 个项目');
        setStep(3);
      } else if (mode === 'template') {
        const name = projectName.trim() || `${activeTemplate.name}项目`;
        const project = await execute<Project>('create_project', {
          name,
          description: activeTemplate.description,
        });
        await applyProjectTemplate(project.id, activeTemplate.id);
        setCreatedId(project.id);
        setCreatedTitle(`「${project.name}」`);
        setStep(3);
      } else if (mode === 'feishu') {
        const name = projectName.trim() || '我的首个项目';
        const project = await execute<Project>('create_project', {
          name,
          description: '通过飞书群聊与文档持续同步进展。',
        });
        setCreatedId(project.id);
        setCreatedTitle(`「${project.name}」`);
        await onComplete(project.id);
        onOpenFeishu();
        return;
      } else {
        const name = projectName.trim() || '新项目';
        const project = await execute<Project>('create_project', {
          name,
          description: '',
        });
        if (sourceText.trim()) {
          await execute<ImportResult>('import_text', {
            projectId: project.id,
            title: sourceTitle.trim() || `${name} · 初始资料`,
            text: sourceText.trim(),
          });
        }
        setCreatedId(project.id);
        setCreatedTitle(`「${project.name}」`);
        setStep(3);
      }
    } catch (caught) {
      setError(asError(caught).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="onboarding-shell" aria-label="首次使用引导">
      <div className="onboarding-card">
        <div className="onboarding-top">
          <div className="onboarding-brand">
            <BrandMark size={26} />
            <span>循序 · Cadence</span>
          </div>
          <ol className="onboarding-stepper" aria-label="引导步骤">
            <li className={step === 1 ? 'is-current' : step > 1 ? 'is-done' : ''}>
              <span>{step > 1 ? <Check size={12} /> : '1'}</span>
              <strong>连接模型</strong>
            </li>
            <li className={step === 2 ? 'is-current' : step > 2 ? 'is-done' : ''}>
              <span>{step > 2 ? <Check size={12} /> : '2'}</span>
              <strong>接入首个项目</strong>
            </li>
            <li className={step === 3 ? 'is-current' : ''}>
              <span>3</span>
              <strong>开始推进</strong>
            </li>
          </ol>
        </div>

        {step === 1 && (
          <div className="onboarding-body">
            <div className="onboarding-badge"><Sparkles size={13} />循序 Cadence · 本地 AI 交付工作台</div>
            <h1>让 AI 帮你盯进度、理风险、备好汇报</h1>
            <p className="onboarding-lead">
              先连接你的 AI 模型（支持 DeepSeek / 通义千问 / 豆包 / Kimi / 本机 Ollama），进入工作台后即可自动提取会议待办、识别延期风险并一键生成各版本周报。
            </p>
            <div className={`onboarding-status-box ${modelReady ? 'is-ready' : ''}`}>
              <div>
                <strong>{modelReady ? 'AI 模型已就绪' : '尚未配置 AI 模型'}</strong>
                <p>
                  {modelReady
                    ? `当前使用 ${aiSettings?.model || '已配置模型'}，可直接开始分析项目资料。`
                    : '暂不配置也能使用示例体验、看板管理、甘特时间轴与本地日报。'}
                </p>
              </div>
              <button className="button secondary compact" onClick={onOpenModelSettings}>
                <Settings2 size={14} />
                {modelReady ? '修改模型' : '立即配置模型'}
              </button>
            </div>
            <div className="onboarding-actions">
              <button className="button primary" onClick={() => setStep(2)}>
                {modelReady ? '下一步：接入项目' : '先跳过，先体验工作台'}
                <ArrowRight size={15} />
              </button>
              <button className="text-button" onClick={onRestore}>
                <History size={14} />
                从已有备份恢复工作区
              </button>
            </div>
          </div>
        )}

        {step === 2 && (
          <div className="onboarding-body">
            <div className="onboarding-badge"><Layers3 size={13} />第 2 步 · 接入项目信息</div>
            <h1>选择一个最快的方式开始</h1>
            <p className="onboarding-lead">
              贴一段微信群聊或会议纪要、套用行业模板，或者直接生成完整示例工作区体验全套流程。
            </p>

            <div className="onboarding-mode-grid is-four" role="radiogroup" aria-label="接入方式">
              <button
                type="button"
                className={`onboarding-mode-card ${mode === 'paste' ? 'is-selected' : ''}`}
                onClick={() => setMode('paste')}
              >
                <FileText size={17} />
                <strong>粘贴纪要 / 群聊</strong>
                <span>最快上手，支持微信/企微/纪要</span>
              </button>
              <button
                type="button"
                className={`onboarding-mode-card ${mode === 'template' ? 'is-selected' : ''}`}
                onClick={() => setMode('template')}
              >
                <FolderKanban size={17} />
                <strong>行业模板开局</strong>
                <span>预置里程碑、任务与典型风险</span>
              </button>
              <button
                type="button"
                className={`onboarding-mode-card ${mode === 'sample' ? 'is-selected' : ''}`}
                onClick={() => setMode('sample')}
              >
                <Wand2 size={17} />
                <strong>一键体验示例</strong>
                <span>3 秒生成完整双项目与行动流</span>
              </button>
              <button
                type="button"
                className={`onboarding-mode-card ${mode === 'feishu' ? 'is-selected' : ''}`}
                onClick={() => setMode('feishu')}
              >
                <MessageCircle size={17} />
                <strong>连接飞书（进阶）</strong>
                <span>自动同步群聊并辅助代答</span>
              </button>
            </div>

            {mode === 'paste' && (
              <div className="onboarding-form">
                <div className="onboarding-form-row">
                  <label>
                    <span className="field-label">项目名称</span>
                    <input
                      value={projectName}
                      onChange={e => setProjectName(e.target.value)}
                      placeholder="例如：客户服务平台一期"
                      maxLength={120}
                      disabled={busy}
                    />
                  </label>
                  <label>
                    <span className="field-label">资料标题 <span>可选</span></span>
                    <input
                      value={sourceTitle}
                      onChange={e => setSourceTitle(e.target.value)}
                      placeholder="例如：本周评审纪要"
                      maxLength={240}
                      disabled={busy}
                    />
                  </label>
                </div>
                <label>
                  <span className="field-label">粘贴会议纪要、微信/钉钉群聊记录或项目目标 <span>可选，进去也能拖入 Excel/Word/PPT</span></span>
                  <textarea
                    rows={4}
                    value={sourceText}
                    onChange={e => setSourceText(e.target.value)}
                    placeholder="直接贴入文字，助理会自动整理出待办、负责人与风险…"
                    disabled={busy}
                  />
                </label>
              </div>
            )}

            {mode === 'template' && (
              <div className="onboarding-form">
                <label>
                  <span className="field-label">选择实战项目模板</span>
                  <select
                    value={templateId}
                    onChange={e => setTemplateId(e.target.value)}
                    disabled={busy}
                  >
                    {PROJECT_TEMPLATES.map(tpl => (
                      <option key={tpl.id} value={tpl.id}>
                        {tpl.name} · {tpl.tagline}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="onboarding-sample-preview">
                  <strong>{activeTemplate.name}</strong>
                  <p>{activeTemplate.description} 将自动生成 {activeTemplate.milestones.length} 个里程碑、{activeTemplate.tasks.length} 项关键任务及标准目标。</p>
                </div>
                <label>
                  <span className="field-label">项目名称 <span>可选，留空自动命名</span></span>
                  <input
                    value={projectName}
                    onChange={e => setProjectName(e.target.value)}
                    placeholder={`例如：${activeTemplate.name} · Q4`}
                    maxLength={120}
                    disabled={busy}
                  />
                </label>
              </div>
            )}

            {mode === 'sample' && (
              <div className="onboarding-sample-preview">
                <strong>将自动创建「客户服务平台一期」与「数据看板迁移」两个完整示范项目</strong>
                <p>包含逾期/阻塞/进行中/已完成任务、3 个里程碑时间轴、高危风险与待拍板决策、会议纪要待确认卡片与工作日报草稿。无需模型密钥即可立即完整体验，进入后可随时一键归档清空示例。</p>
              </div>
            )}

            {mode === 'feishu' && (
              <div className="onboarding-form">
                <label>
                  <span className="field-label">首个项目名称</span>
                  <input
                    value={projectName}
                    onChange={e => setProjectName(e.target.value)}
                    placeholder="例如：核心交付项目"
                    maxLength={120}
                    disabled={busy}
                  />
                </label>
                <p className="field-hint">创建项目后将自动打开飞书连接配置（需要飞书开放平台应用与审批权限；普通用户更推荐直接粘贴群聊或拖入文件）。</p>
              </div>
            )}

            {error && <div className="form-error" role="alert">{error}</div>}

            <div className="onboarding-actions">
              <button className="button secondary" type="button" onClick={() => setStep(1)} disabled={busy}>
                上一步
              </button>
              <button
                className="button primary"
                type="button"
                disabled={busy || (mode === 'paste' && !projectName.trim() && !sourceText.trim())}
                onClick={() => void handleCreateAndImport()}
              >
                {busy ? <Spinner /> : null}
                {mode === 'sample'
                  ? '生成完整示例工作台'
                  : mode === 'template'
                    ? '按模板创建项目'
                    : mode === 'feishu'
                      ? '创建并连接飞书'
                      : '创建项目并开始整理'}
                <ArrowRight size={15} />
              </button>
            </div>
          </div>
        )}

        {step === 3 && createdId && (
          <div className="onboarding-body is-centered">
            <div className="onboarding-done-icon"><CheckCircle2 size={36} strokeWidth={1.6} /></div>
            <h1>工作台已就绪</h1>
            <p className="onboarding-lead">
              {createdTitle} 已就绪，今日行动流、任务看板、里程碑时间轴与日报草稿已为你准备好。
            </p>
            <div className="onboarding-actions">
              <button
                className="button primary"
                onClick={() => void onComplete(createdId)}
              >
                进入今日行动流
                <ArrowRight size={15} />
              </button>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
