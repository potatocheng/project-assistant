import { useRef, useState, type FormEvent } from 'react';
import {
  ArrowRight, Check, FileText, FolderKanban, History, Settings2, Wand2,
} from 'lucide-react';
import { asError, execute } from '../../api';
import type { AiSettings, ImportResult, Project } from '../../types';
import { Spinner } from '../ui';
import { BrandMark } from './BrandMark';
import { applyProjectTemplate, PROJECT_TEMPLATES, seedDemoWorkspace } from './demo-seed';
import './onboarding.css';

interface Props {
  aiSettings?: AiSettings;
  workspaceKey?: string;
  onOpenModelSettings: () => void;
  onRestore: () => void;
  onComplete: (projectId: string) => Promise<void>;
}

function deriveProjectTitle(sourceTitle: string, sourceText: string): string {
  if (sourceTitle.trim()) return sourceTitle.trim().slice(0, 60);
  const firstLine = sourceText
    .split(/\r?\n/)
    .map(line => line.trim())
    .find(Boolean);
  if (firstLine) return firstLine.slice(0, 24);
  return '我的首个项目';
}

export function OnboardingWizard({
  aiSettings,
  workspaceKey,
  onOpenModelSettings,
  onRestore,
  onComplete,
}: Props) {
  const [mode, setMode] = useState<'paste' | 'template' | 'sample'>('template');
  const [templateId, setTemplateId] = useState(PROJECT_TEMPLATES[0].id);
  const [projectName, setProjectName] = useState('');
  const [sourceTitle, setSourceTitle] = useState('');
  const [sourceText, setSourceText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const createdRef = useRef<{ signature: string; projectId: string; hydrated: boolean } | null>(null);

  const modelReady = !!aiSettings?.configured;
  const activeTemplate = PROJECT_TEMPLATES.find(t => t.id === templateId) ?? PROJECT_TEMPLATES[0];

  const handleCreateAndImport = async (event?: FormEvent) => {
    event?.preventDefault();
    if (busy) return;
    setError('');
    setBusy(true);
    const signature = mode === 'sample'
      ? `sample:${workspaceKey ?? ''}`
      : mode === 'template'
        ? `template:${templateId}:${projectName.trim()}`
        : `paste:${projectName.trim()}:${sourceTitle.trim()}:${sourceText.trim().slice(0, 80)}`;
    try {
      if (mode === 'sample') {
        if (createdRef.current?.signature === signature && createdRef.current.hydrated) {
          await onComplete(createdRef.current.projectId);
          return;
        }
        const demoProjectId = await seedDemoWorkspace(workspaceKey);
        createdRef.current = { signature, projectId: demoProjectId, hydrated: true };
        await onComplete(demoProjectId);
        return;
      }

      if (mode === 'template') {
        let projectId = createdRef.current?.signature === signature ? createdRef.current.projectId : '';
        if (!projectId) {
          const name = projectName.trim() || `${activeTemplate.name}项目`;
          const project = await execute<Project>('create_project', {
            name,
            description: activeTemplate.description,
          });
          projectId = project.id;
          createdRef.current = { signature, projectId, hydrated: false };
        }
        if (!createdRef.current?.hydrated) {
          await applyProjectTemplate(projectId, activeTemplate.id);
          createdRef.current = { signature, projectId, hydrated: true };
        }
        await onComplete(projectId);
        return;
      }

      const name = projectName.trim() || deriveProjectTitle(sourceTitle, sourceText);
      let projectId = createdRef.current?.signature === signature ? createdRef.current.projectId : '';
      if (!projectId) {
        const project = await execute<Project>('create_project', {
          name,
          description: '',
        });
        projectId = project.id;
        createdRef.current = { signature, projectId, hydrated: !sourceText.trim() };
      }
      if (sourceText.trim() && !createdRef.current?.hydrated) {
        await execute<ImportResult>('import_text', {
          projectId,
          title: sourceTitle.trim() || `${name} · 初始资料`,
          text: sourceText.trim(),
        });
        createdRef.current = { signature, projectId, hydrated: true };
      }
      await onComplete(projectId);
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
          <div className="onboarding-header-actions">
            <button type="button" className="text-button" onClick={onOpenModelSettings} disabled={busy}>
              <Settings2 size={14} />
              {modelReady ? `模型已就绪 (${aiSettings?.model || '已配置'})` : '配置 AI 模型（可选）'}
            </button>
            <button type="button" className="text-button" onClick={onRestore} disabled={busy}>
              <History size={14} />
              从备份恢复
            </button>
          </div>
        </div>

        <form className="onboarding-body" onSubmit={handleCreateAndImport}>
          <h1>从一个项目开始，理清每日待办与交付风险</h1>
          <p className="onboarding-lead">
            选个模板、贴段群聊或会议纪要，或一键生成示例工作区直接上手。无需先配模型，看板、排期、时间轴与本机日报立即可用。
          </p>

          <div className="onboarding-mode-grid" role="group" aria-label="接入方式">
            <button
              type="button"
              className={`onboarding-mode-card ${mode === 'template' ? 'is-selected' : ''}`}
              aria-pressed={mode === 'template'}
              onClick={() => setMode('template')}
            >
              <FolderKanban size={17} />
              <strong>按行业模板开局</strong>
              <span>预置里程碑、当日待办与典型风险</span>
            </button>
            <button
              type="button"
              className={`onboarding-mode-card ${mode === 'paste' ? 'is-selected' : ''}`}
              aria-pressed={mode === 'paste'}
              onClick={() => setMode('paste')}
            >
              <FileText size={17} />
              <strong>粘贴纪要 / 新建空白</strong>
              <span>贴入群聊或直接建立空白项目</span>
            </button>
            <button
              type="button"
              className={`onboarding-mode-card ${mode === 'sample' ? 'is-selected' : ''}`}
              aria-pressed={mode === 'sample'}
              onClick={() => setMode('sample')}
            >
              <Wand2 size={17} />
              <strong>载入示例项目体验</strong>
              <span>一键体验双项目、行动流与周报，随时可清理</span>
            </button>
          </div>

          {mode === 'template' && (
            <div key="template" className="onboarding-form onboarding-mode-panel">
              <div className="onboarding-template-grid" role="radiogroup" aria-label="选择项目模板">
                {PROJECT_TEMPLATES.map(tpl => {
                  const selected = tpl.id === templateId;
                  return (
                    <button
                      key={tpl.id}
                      type="button"
                      className={`onboarding-mode-card ${selected ? 'is-selected' : ''}`}
                      aria-pressed={selected}
                      onClick={() => setTemplateId(tpl.id)}
                      disabled={busy}
                    >
                      <strong>{selected ? <Check size={13} /> : null} {tpl.name}</strong>
                      <span>{tpl.tagline}</span>
                    </button>
                  );
                })}
              </div>
              <div className="onboarding-sample-preview">
                <strong>{activeTemplate.name}</strong>
                <p>{activeTemplate.description} 将自动生成 {activeTemplate.milestones.length} 个里程碑、{activeTemplate.tasks.length} 项关键任务及标准目标。</p>
              </div>
              <label>
                <span className="field-label">项目名称 <span>可选，留空自动命名为「{activeTemplate.name}项目」</span></span>
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

          {mode === 'paste' && (
            <div key="paste" className="onboarding-form onboarding-mode-panel">
              <div className="onboarding-form-row">
                <label>
                  <span className="field-label">项目名称 <span>可选，留空自动从正文提取</span></span>
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
                <span className="field-label">粘贴会议纪要、微信/企微群聊记录或目标 <span>可选，留空即创建空白项目</span></span>
                <textarea
                  rows={4}
                  value={sourceText}
                  onChange={e => setSourceText(e.target.value)}
                  placeholder="可直接粘贴会议或群聊内容，也可留空先进入工作区再随时拖入 Word/Excel/PPT/PDF…"
                  disabled={busy}
                  onKeyDown={e => {
                    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                      e.preventDefault();
                      void handleCreateAndImport();
                    }
                  }}
                />
              </label>
            </div>
          )}

          {mode === 'sample' && (
            <div key="sample" className="onboarding-sample-preview onboarding-mode-panel">
              <strong>将创建「客户服务平台一期」与「数据看板迁移」两个完整示范项目</strong>
              <p>内含今日行动流任务、3 个里程碑时间轴、高危风险与待拍板决策、纪要待确认卡片与综合工作日报草稿。体验完成后可随时一键归档清空示例。</p>
            </div>
          )}

          {error && <div className="form-error" role="alert">{error}</div>}

          <div className="onboarding-actions">
            <span className="field-hint">所有数据保存在本机，后续可随时新建项目或接入模型。</span>
            <button
              className="button primary"
              type="submit"
              disabled={busy}
            >
              {busy ? <Spinner /> : null}
              {busy
                ? mode === 'sample'
                  ? '正在创建示例…'
                  : '正在创建项目…'
                : mode === 'sample'
                  ? '生成示例并进入工作台'
                  : mode === 'template'
                    ? '按模板创建并进入'
                    : sourceText.trim()
                      ? '创建项目并导入资料'
                      : '创建项目并进入'}
              {!busy && <ArrowRight size={15} />}
            </button>
          </div>
        </form>
      </div>
    </section>
  );
}
