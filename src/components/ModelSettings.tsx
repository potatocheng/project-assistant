import { Selector } from '@astryxdesign/core/Selector';
import { TextInput } from '@astryxdesign/core/TextInput';
import { CheckboxInput } from '@astryxdesign/core/CheckboxInput';
import { FormDialog } from './astryx/FormDialog';
import { Button } from '@astryxdesign/core/Button';
import { useEffect, useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { Check, CircleAlert, ExternalLink, Globe2, Monitor, PlugZap, ShieldCheck, Sparkles } from 'lucide-react';
import { asError, execute, openExternalUrl } from '../api';
import type { AiSettings, SemanticSearchSettings, SemanticSearchStatus } from '../types';
import { Spinner } from './ui';

interface ModelPreset {
  id: string;
  label: string;
  provider: 'openai_compatible' | 'ollama';
  baseUrl: string;
  model: string;
  tip: string;
  keyUrl?: string;
}

const MODEL_PRESETS: ModelPreset[] = [
  {
    id: 'deepseek',
    label: 'DeepSeek',
    provider: 'openai_compatible',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-chat',
    tip: '性价比极高，中文理解强，新用户通常有体验额度（日常仅需几分钱/天）。',
    keyUrl: 'https://platform.deepseek.com/api_keys',
  },
  {
    id: 'qwen',
    label: '通义千问（百炼）',
    provider: 'openai_compatible',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen-plus',
    tip: '阿里云百炼 OpenAI 兼容接口，开通即送百万级免费试用额度。',
    keyUrl: 'https://bailian.console.aliyun.com/',
  },
  {
    id: 'doubao',
    label: '豆包（火山方舟）',
    provider: 'openai_compatible',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    model: 'doubao-seed-1-6-250615',
    tip: '字节火山方舟接入，也可填自己在控制台创建的推理接入点 ID（ep-xxx）。',
    keyUrl: 'https://console.volcengine.com/ark',
  },
  {
    id: 'kimi',
    label: 'Kimi',
    provider: 'openai_compatible',
    baseUrl: 'https://api.moonshot.cn/v1',
    model: 'moonshot-v1-8k',
    tip: '月之暗面长文本能力强，适合处理长篇项目会议纪要与周报整理。',
    keyUrl: 'https://platform.moonshot.cn/console/api-keys',
  },
  {
    id: 'glm',
    label: '智谱 GLM',
    provider: 'openai_compatible',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    model: 'glm-4-flash',
    tip: 'glm-4-flash 官方长期免费或极低资费，适合日常高频提取与问答。',
    keyUrl: 'https://open.bigmodel.cn/usercenter/apikeys',
  },
  {
    id: 'siliconflow',
    label: '硅基流动',
    provider: 'openai_compatible',
    baseUrl: 'https://api.siliconflow.cn/v1',
    model: 'deepseek-ai/DeepSeek-V3',
    tip: '聚合多种开源大模型，注册通常赠送免费额度。',
    keyUrl: 'https://cloud.siliconflow.cn/account/ak',
  },
  {
    id: 'openai',
    label: 'OpenAI',
    provider: 'openai_compatible',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    tip: '需本机网络可直接访问 OpenAI API。',
    keyUrl: 'https://platform.openai.com/api-keys',
  },
  {
    id: 'ollama',
    label: '本机 Ollama（零外发）',
    provider: 'ollama',
    baseUrl: 'http://127.0.0.1:11434',
    model: 'qwen2.5:7b',
    tip: '100% 本地离线运行，不花钱且任何项目文字都不离开本机电脑。',
    keyUrl: 'https://ollama.com/download',
  },
];

export function endpointInfo(baseUrl: string) {
  try {
    const url = new URL(baseUrl);
    return { host: url.host, local: ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) };
  } catch { return { host: baseUrl || '尚未填写服务地址', local: false }; }
}

export function ModelSettingsDialog({ close, onSaved }: { close: () => void; onSaved: () => Promise<unknown> }) {
  const [saved, setSaved] = useState<AiSettings | null>(null);
  const [form, setForm] = useState<AiSettings | null>(null);
  const [key, setKey] = useState('');
  const [clearKey, setClearKey] = useState(false);
  const [busy, setBusy] = useState<'load' | 'save' | 'test' | 'save-test' | ''>('load');
  const [error, setError] = useState('');
  const [result, setResult] = useState('');
  const [tested, setTested] = useState(false);
  const [reload, setReload] = useState(0);
  const [customEndpoint, setCustomEndpoint] = useState(false);
  const [usage, setUsage] = useState<{ todayCalls: number; totalCalls: number; totalTokens: number } | null>(null);
  const [semantic, setSemantic] = useState<SemanticSearchStatus | null>(null);
  const [semanticForm, setSemanticForm] = useState<SemanticSearchSettings | null>(null);
  const [semanticKey, setSemanticKey] = useState('');
  const [semanticBusy, setSemanticBusy] = useState<'' | 'save' | 'test' | 'rebuild'>('');
  const [semanticError, setSemanticError] = useState('');
  const [semanticResult, setSemanticResult] = useState('');

  useEffect(() => {
    let cancelled = false;
    setBusy('load'); setError('');
    Promise.all([
      execute<AiSettings>('get_ai_settings'),
      execute<{ todayCalls: number; totalCalls: number; totalTokens: number }>('get_usage_summary').catch(() => null),
      execute<SemanticSearchStatus>('get_semantic_search_status').catch(() => null),
    ]).then(([settings, summary, sem]) => {
      if (!cancelled) {
        setSaved(settings);
        setForm(settings);
        const matchesPreset = MODEL_PRESETS.some(p => p.provider === settings.provider && settings.baseUrl.replace(/\/+$/, '') === p.baseUrl);
        setCustomEndpoint(!matchesPreset && !!settings.baseUrl.trim());
        setUsage(summary);
        if (sem) {
          setSemantic(sem);
          setSemanticForm(sem.settings);
        }
      }
    }).catch((caught) => { if (!cancelled) setError(asError(caught).message); })
      .finally(() => { if (!cancelled) setBusy(''); });
    return () => { cancelled = true; };
  }, [reload]);

  const target = endpointInfo(form?.baseUrl ?? '');
  const dirty = useMemo(() => !!form && !!saved && (JSON.stringify(form) !== JSON.stringify(saved) || !!key || clearKey), [form, saved, key, clearKey]);
  const semanticDirty = useMemo(() => !!semanticForm && !!semantic && (JSON.stringify(semanticForm) !== JSON.stringify(semantic.settings) || !!semanticKey.trim()), [semanticForm, semantic, semanticKey]);
  const sameEndpoint = form?.provider === saved?.provider && form?.baseUrl.replace(/\/+$/, '') === saved?.baseUrl.replace(/\/+$/, '');
  const canTest = !!form?.baseUrl.trim() && !!form.model.trim() && (form.provider === 'ollama' || target.local || Boolean(key.trim()) || (sameEndpoint && !!saved?.hasApiKey && !clearKey));
  const formValid = !!form && !!form.baseUrl.trim() && !!form.model.trim() && (!form.autoExtract || target.local || form.remoteConsent) && (form.provider !== 'ollama' || target.local);
  const activePreset = MODEL_PRESETS.find(p => form && p.provider === form.provider && form.baseUrl.replace(/\/+$/, '') === p.baseUrl);
  const patch = (value: Partial<AiSettings>) => {
    setForm((current) => current ? { ...current, ...value } : current);
    setResult(''); setError(''); setTested(false);
  };
  const applyPreset = (preset: ModelPreset) => {
    setCustomEndpoint(false);
    const isSavedEndpoint = preset.provider === saved?.provider && preset.baseUrl === saved?.baseUrl.replace(/\/+$/, '');
    patch({
      provider: preset.provider,
      baseUrl: preset.baseUrl,
      model: preset.model,
      outputFormat: 'json_object',
      remoteConsent: preset.provider === 'ollama' ? false : (isSavedEndpoint ? saved.remoteConsent : false),
    });
    if (preset.provider === 'ollama') {
      setKey('');
      setClearKey(false);
    }
  };
  const persistSettings = async () => {
    if (!form) return null;
    const next = await execute<AiSettings>('save_ai_settings', {
      provider: form.provider, baseUrl: form.baseUrl.trim(), model: form.model.trim(),
      outputFormat: form.outputFormat, timeoutSeconds: form.timeoutSeconds,
      autoExtract: form.autoExtract, remoteConsent: form.remoteConsent,
      ...(clearKey ? { apiKey: '' } : key.trim() ? { apiKey: key.trim() } : {}),
    });
    setSaved(next); setForm(next); setKey(''); setClearKey(false);
    await onSaved();
    return next;
  };
  const testPayload = () => form ? {
    provider: form.provider,
    baseUrl: form.baseUrl.trim(),
    model: form.model.trim(),
    outputFormat: form.outputFormat,
    timeoutSeconds: form.timeoutSeconds,
    ...(key.trim() ? { apiKey: key.trim() } : {}),
  } : {};
  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!formValid || busy) return;
    setBusy('save'); setError(''); setResult(''); setTested(false);
    try {
      await persistSettings();
      setResult('设置已保存，可点击「测试连接」验证。');
    } catch (caught) { setError(asError(caught).message); }
    finally { setBusy(''); }
  };
  const saveAndTest = async () => {
    if (!formValid || busy) return;
    setBusy('save-test'); setError(''); setResult(''); setTested(false);
    try {
      await persistSettings();
      const response = await execute<{ ok: true; message: string; models: string[] }>('test_ai_connection');
      setResult(response.message || '设置已保存且连接测试通过，模型与结构化输出可用。');
      setTested(true);
    } catch (caught) { setError(asError(caught).message); }
    finally { setBusy(''); }
  };
  const test = async () => {
    if (!canTest || busy) return;
    setBusy('test'); setError(''); setResult(''); setTested(false);
    try {
      const response = await execute<{ ok: true; message: string; models: string[] }>('test_ai_connection', testPayload());
      setResult(response.message || '连接测试通过，模型与结构化输出可用。'); setTested(true);
    } catch (caught) { setError(asError(caught).message); }
    finally { setBusy(''); }
  };
  const semanticTarget = endpointInfo(semanticForm?.baseUrl ?? '');
  const patchSemantic = (patchValue: Partial<SemanticSearchSettings>) => {
    setSemanticForm((cur) => cur ? { ...cur, ...patchValue } : cur);
    setSemanticError(''); setSemanticResult('');
  };
  const saveSemantic = async () => {
    if (!semanticForm || semanticBusy) return;
    setSemanticBusy('save'); setSemanticError(''); setSemanticResult('');
    try {
      const next = await execute<SemanticSearchStatus>('save_semantic_search_settings', {
        enabled: semanticForm.enabled,
        provider: semanticForm.provider,
        baseUrl: semanticForm.baseUrl.trim(),
        model: semanticForm.model.trim(),
        timeoutSeconds: semanticForm.timeoutSeconds,
        remoteConsent: semanticForm.remoteConsent,
        ...(semanticKey.trim() ? { apiKey: semanticKey.trim() } : {}),
      });
      setSemantic(next);
      setSemanticForm(next.settings);
      setSemanticKey('');
      setSemanticResult(next.settings.enabled ? '智能语义检索配置已保存。' : '已关闭智能语义检索，继续使用关键词与术语别名匹配。');
    } catch (caught) {
      setSemanticError(asError(caught).message);
    } finally {
      setSemanticBusy('');
    }
  };
  const testSemantic = async () => {
    if (semanticBusy) return;
    setSemanticBusy('test'); setSemanticError(''); setSemanticResult('');
    try {
      const res = await execute<{ message: string }>('test_embedding_connection');
      setSemanticResult(res.message || '向量连接测试通过。');
    } catch (caught) {
      setSemanticError(asError(caught).message);
    } finally {
      setSemanticBusy('');
    }
  };
  const rebuildSemantic = async () => {
    if (semanticBusy) return;
    setSemanticBusy('rebuild'); setSemanticError(''); setSemanticResult('');
    try {
      const res = await execute<{ indexed: number; skipped: number; pruned: number; dimensions?: number | null }>('rebuild_semantic_index');
      const refreshed = await execute<SemanticSearchStatus>('get_semantic_search_status').catch(() => null);
      if (refreshed) {
        setSemantic(refreshed);
        setSemanticForm(refreshed.settings);
      }
      setSemanticResult(`本机语义索引已更新：新增 ${res.indexed} 条，复用 ${res.skipped} 条，清理 ${res.pruned} 条。`);
    } catch (caught) {
      setSemanticError(asError(caught).message);
    } finally {
      setSemanticBusy('');
    }
  };

  const showEndpointFields = customEndpoint || !activePreset;
  const endpointControls = form ? <>
    <Selector id="ai-provider" label="服务类型" value={form.provider} isDisabled={!!busy} onChange={value => {
      if (value === 'ollama') patch({ provider: 'ollama', baseUrl: 'http://127.0.0.1:11434', model: 'qwen2.5:7b', outputFormat: 'json_object', remoteConsent: false });
      else patch({ provider: 'openai_compatible', baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat', outputFormat: 'json_object', remoteConsent: false });
      setKey(''); setClearKey(false);
    }} options={[{ value: 'openai_compatible', label: 'OpenAI 兼容服务（DeepSeek / 千问 / 豆包 / Kimi 等）' }, { value: 'ollama', label: '本机 Ollama（离线零外发）' }]} />
    <TextInput id="ai-base-url" label="服务地址" type="url" value={form.baseUrl} placeholder={form.provider === 'ollama' ? 'http://127.0.0.1:11434' : 'https://api.deepseek.com'}
      onChange={value => patch({ baseUrl: value, remoteConsent: false })} isRequired isDisabled={!!busy} hasSpellCheck={false} />
    {form.provider === 'openai_compatible' && <Button label="使用 DeepSeek 默认值" type="button" variant="ghost" size="sm" className="astryx-inline-action astryx-field-action" isDisabled={!!busy}
      onClick={() => { setCustomEndpoint(false); patch({ baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat', outputFormat: 'json_object', remoteConsent: false }); }} />}
  </> : null;

  return <FormDialog title="模型设置" subtitle="自带模型账号，从资料提取任务、回答项目问题并一键润色汇报。" close={close} busy={!!busy} dirty={dirty || semanticDirty} wide>
    {busy === 'load' ? <div className="dialog-body settings-loading"><Spinner />正在读取本机设置…</div> : !form ? <div className="dialog-body"><div className="form-error" role="alert"><CircleAlert size={17} /><p>{error || '设置暂时无法读取。'}</p></div><Button label="重新读取设置" onClick={() => setReload((value) => value + 1)} className="settings-reload" variant="secondary" /></div> : <form onSubmit={save}>
      <div className="dialog-body model-settings-body astryx-form-fields">
        <div className="settings-status"><span className={`settings-status-dot ${saved?.configured ? 'ready' : ''}`} /><span>{saved?.configured ? '配置已保存' : '待配置'}</span><span>{tested ? '连接测试通过' : dirty ? '有未保存的调整' : '已可测试或直接保存'}</span>{usage && <span style={{ marginLeft: 'auto', fontSize: 13 }}>累计 {usage.totalCalls} 次 · {usage.totalTokens.toLocaleString()} tokens</span>}</div>

        <div className="model-preset-block">
          <span className="field-label"><Sparkles size={13} style={{ display: 'inline', verticalAlign: '-2px', marginRight: 5 }} />常用模型一键预设</span>
          <div className="model-preset-pills" role="group" aria-label="常用模型服务预设">
            {MODEL_PRESETS.map(preset => {
              const selected = !customEndpoint && activePreset?.id === preset.id;
              return (
                <button
                  key={preset.id}
                  type="button"
                  disabled={!!busy}
                  className={`model-preset-pill ${selected ? 'is-selected' : ''}`}
                  onClick={() => applyPreset(preset)}
                >
                  {preset.label}
                </button>
              );
            })}
            <button
              type="button"
              disabled={!!busy}
              className={`model-preset-pill ${showEndpointFields ? 'is-selected' : ''}`}
              onClick={() => setCustomEndpoint(true)}
            >
              自定义接口
            </button>
          </div>
          {!customEndpoint && activePreset && (
            <div className="model-preset-tip">
              <span>{activePreset.tip}</span>
              {activePreset.keyUrl && (
                <button type="button" className="text-button tiny" onClick={() => void openExternalUrl(activePreset.keyUrl!)}>
                  1 分钟获取 API Key / 下载 <ExternalLink size={12} />
                </button>
              )}
            </div>
          )}
        </div>

        {showEndpointFields ? endpointControls : (
          <details className="advanced-settings">
            <summary>高级连接参数（协议类型与接口地址） <Chevron /></summary>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 10 }}>{endpointControls}</div>
          </details>
        )}
        <TextInput id="ai-model" label="模型名称" value={form.model} onChange={value => patch({ model: value })} placeholder={form.provider === 'ollama' ? '填写本机已安装的模型名称，如 qwen2.5:7b' : 'deepseek-chat'}
          isRequired isDisabled={!!busy} hasSpellCheck={false} />
        {form.provider === 'openai_compatible' && <>
          <TextInput id="ai-api-key" label="API 密钥" description={saved?.hasApiKey && sameEndpoint ? '本机已保存（绝不上传或进入备份）' : '仅保存于本机凭据区，不进入项目备份'} type="password" value={key}
            onChange={value => { setKey(value); setResult(''); setTested(false); }} placeholder={saved?.hasApiKey && sameEndpoint ? '留空保留已保存的密钥' : '粘贴 sk-... 密钥'}
            autoComplete="new-password" hasSpellCheck={false} isDisabled={!!busy || clearKey} />
          {saved?.hasApiKey && !sameEndpoint && <p className="field-hint">服务地址已变更。保存后旧密钥会清除，请填写新服务的密钥。</p>}
          {saved?.hasApiKey && sameEndpoint && <CheckboxInput label="清除本机已保存的密钥" value={clearKey} isDisabled={!!busy}
            onChange={value => { setClearKey(value); setKey(''); setResult(''); setTested(false); }} />}
        </>}
        <details className="advanced-settings"><summary>高级设置 <Chevron /></summary><div className="settings-columns"><Selector label="结构化输出格式" value={form.outputFormat} onChange={value => patch({ outputFormat: value as AiSettings['outputFormat'] })} isDisabled={!!busy}
          options={[{ value: 'json_object', label: '标准 JSON 格式' }, { value: 'json_schema', label: '严格 Schema 约束' }]} /><label><span className="field-label">请求超时（秒）</span><input aria-label="请求超时秒数" type="number" min={5} max={300} value={form.timeoutSeconds} onChange={(event) => patch({ timeoutSeconds: Number(event.target.value) })} disabled={!!busy} required /></label></div><p className="field-hint">更改模型配置会取消正在进行的提取任务。</p></details>
        <div className="model-data-notice">{target.local ? <Monitor size={18} /> : <Globe2 size={18} />}<div><strong>{target.local ? '使用本机模型' : '使用远程模型'}</strong><p>原文段落与位置将发送至 <b>{target.host}</b>，提取结果由你确认。</p>{!target.local && <CheckboxInput label="允许将资料发送至此服务" value={form.remoteConsent} onChange={value => patch({ remoteConsent: value })} isDisabled={!!busy} className="astryx-setting-check" />}{form.provider === 'ollama' && !target.local && <p className="settings-inline-error">Ollama 仅支持本机地址，请修改服务地址。</p>}</div></div>
        <CheckboxInput label="导入后自动提取" description="对新导入的资料生效；已有资料可手动提取。" value={form.autoExtract} onChange={value => patch({ autoExtract: value })} isDisabled={!!busy} />
        {semanticForm && (
          <details className="advanced-settings">
            <summary>
              智能语义检索（按含义匹配记忆 · {semanticForm.enabled ? '已开启' : '未开启'}） <Chevron />
            </summary>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 12 }}>
              <p className="field-hint">
                默认按关键词与术语别名精确匹配记忆；开启后可理解同义词与口语提问，扩大相关记忆召回范围。检索索引完全保存在本机，已归档或过期记忆仍会被严格过滤。
              </p>
              <p className="field-hint">
                当前索引进度：{semantic?.index.indexedCount ?? 0} / {semantic?.activeMemoryCount ?? 0} 条活跃记忆
              </p>
              <CheckboxInput
                label="启用智能语义检索（按意思匹配相关记忆）"
                value={semanticForm.enabled}
                isDisabled={!!semanticBusy}
                onChange={(value) => patchSemantic({ enabled: value })}
              />
              <Selector
                id="embedding-provider"
                label="向量服务类型"
                value={semanticForm.provider}
                isDisabled={!!semanticBusy}
                onChange={(value) => {
                  if (value === 'ollama') {
                    patchSemantic({ provider: 'ollama', baseUrl: 'http://127.0.0.1:11434', model: 'bge-m3', remoteConsent: false });
                  } else {
                    patchSemantic({ provider: 'openai_compatible', baseUrl: 'https://api.siliconflow.cn/v1', model: 'BAAI/bge-m3', remoteConsent: false });
                  }
                  setSemanticKey('');
                }}
                options={[
                  { value: 'ollama', label: '本机 Ollama（完全离线，推荐 bge-m3）' },
                  { value: 'openai_compatible', label: 'OpenAI 兼容向量接口（硅基流动 / 百炼 / OpenAI）' },
                ]}
              />
              <TextInput
                id="embedding-base-url"
                label="向量服务地址"
                type="url"
                value={semanticForm.baseUrl}
                isDisabled={!!semanticBusy}
                hasSpellCheck={false}
                onChange={(value) => patchSemantic({ baseUrl: value, remoteConsent: false })}
              />
              <TextInput
                id="embedding-model"
                label="向量模型名称"
                value={semanticForm.model}
                placeholder={semanticForm.provider === 'ollama' ? 'bge-m3' : 'BAAI/bge-m3'}
                isDisabled={!!semanticBusy}
                hasSpellCheck={false}
                onChange={(value) => patchSemantic({ model: value })}
              />
              {semanticForm.provider === 'openai_compatible' && (
                <>
                  <TextInput
                    id="embedding-api-key"
                    label="向量 API 密钥（可选）"
                    description={semanticForm.usingSharedAiKey ? '已自动复用同地址模型密钥' : semanticForm.hasApiKey ? '本机已保存独立密钥' : '与上方同服务地址时可留空自动复用'}
                    type="password"
                    value={semanticKey}
                    placeholder="留空保持当前配置或复用同地址密钥"
                    isDisabled={!!semanticBusy}
                    hasSpellCheck={false}
                    onChange={(value) => { setSemanticKey(value); setSemanticError(''); setSemanticResult(''); }}
                  />
                  {!semanticTarget.local && (
                    <CheckboxInput
                      label={`允许将活跃记忆正文发送至 ${semanticTarget.host} 生成语义索引`}
                      value={semanticForm.remoteConsent}
                      isDisabled={!!semanticBusy}
                      onChange={(value) => patchSemantic({ remoteConsent: value })}
                    />
                  )}
                </>
              )}
              {semanticError && <div className="form-error" role="alert"><CircleAlert size={15} /><p>{semanticError}</p></div>}
              {semanticResult && <div className="settings-result" role="status"><Check size={15} /><p>{semanticResult}</p></div>}
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                <Button label="保存向量配置" type="button" variant="primary" size="sm" isDisabled={!!semanticBusy} onClick={() => void saveSemantic()} />
                <Button label="测试向量连接" type="button" variant="secondary" size="sm" isDisabled={!!semanticBusy} onClick={() => void testSemantic()} />
                <Button label="更新本机索引" type="button" variant="secondary" size="sm" isDisabled={!!semanticBusy || !semantic?.settings.enabled} onClick={() => void rebuildSemantic()} />
              </div>
            </div>
          </details>
        )}
        {error && <div className="form-error" role="alert"><CircleAlert size={17} /><p>{error}</p></div>}
        {result && <div className="settings-result" role="status">{tested ? <ShieldCheck size={17} /> : <Check size={17} />}<p>{result}</p></div>}
        {(busy === 'test' || busy === 'save-test') && <p className="connection-progress" role="status"><Spinner />正在验证连接和输出格式…</p>}
      </div>
      <div className="dialog-footer settings-footer">
        <div className="settings-test">
          <Button label="测试连接" type="button" isDisabled={!!busy || !canTest} onClick={() => void test()} variant="secondary" icon={busy === 'test' ? <Spinner /> : <PlugZap size={15} />} />
          <span>支持未保存参数直接测试（仅发轻量样本）</span>
        </div>
        <Button label="仅保存" isDisabled={!!busy || !formValid} type="submit" variant="secondary" icon={busy === 'save' ? <Spinner /> : <Check size={15} />} />
        <Button label="保存并测试连接" type="button" isDisabled={!!busy || !formValid || !canTest} onClick={() => void saveAndTest()} variant="primary" icon={busy === 'save-test' ? <Spinner /> : <ShieldCheck size={15} />} />
      </div>
    </form>}
  </FormDialog>;
}

function Chevron() { return <span aria-hidden="true">⌄</span>; }
