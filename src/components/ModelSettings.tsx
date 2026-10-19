import { useEffect, useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { Check, CircleAlert, Globe2, Monitor, PlugZap, ShieldCheck } from 'lucide-react';
import { asError, execute } from '../api';
import type { AiSettings } from '../types';
import { Dialog, Spinner } from './ui';

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
  const [busy, setBusy] = useState<'load' | 'save' | 'test' | ''>('load');
  const [error, setError] = useState('');
  const [result, setResult] = useState('');
  const [tested, setTested] = useState(false);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setBusy('load'); setError('');
    execute<AiSettings>('get_ai_settings').then((settings) => {
      if (!cancelled) { setSaved(settings); setForm(settings); }
    }).catch((caught) => { if (!cancelled) setError(asError(caught).message); })
      .finally(() => { if (!cancelled) setBusy(''); });
    return () => { cancelled = true; };
  }, [reload]);

  const target = endpointInfo(form?.baseUrl ?? '');
  const dirty = useMemo(() => !!form && !!saved && (JSON.stringify(form) !== JSON.stringify(saved) || !!key || clearKey), [form, saved, key, clearKey]);
  const sameEndpoint = form?.provider === saved?.provider && form?.baseUrl.replace(/\/+$/, '') === saved?.baseUrl.replace(/\/+$/, '');
  const canTest = !!saved?.baseUrl.trim() && !!saved.model.trim() && (saved.provider === 'ollama' || endpointInfo(saved.baseUrl).local || saved.hasApiKey);
  const patch = (value: Partial<AiSettings>) => {
    setForm((current) => current ? { ...current, ...value } : current);
    setResult(''); setError(''); setTested(false);
  };
  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!form) return;
    setBusy('save'); setError(''); setResult('');
    try {
      const next = await execute<AiSettings>('save_ai_settings', {
        provider: form.provider, baseUrl: form.baseUrl.trim(), model: form.model.trim(),
        outputFormat: form.outputFormat, timeoutSeconds: form.timeoutSeconds,
        autoExtract: form.autoExtract, remoteConsent: form.remoteConsent,
        ...(clearKey ? { apiKey: '' } : key.trim() ? { apiKey: key.trim() } : {}),
      });
      setSaved(next); setForm(next); setKey(''); setClearKey(false); setTested(false);
      setResult('设置已保存，可测试连接。');
      await onSaved();
    } catch (caught) { setError(asError(caught).message); }
    finally { setBusy(''); }
  };
  const test = async () => {
    setBusy('test'); setError(''); setResult(''); setTested(false);
    try {
      const response = await execute<{ ok: true; message: string; models: string[] }>('test_ai_connection');
      setResult(response.message || '连接测试通过，模型与结构化输出可用。'); setTested(true);
    } catch (caught) { setError(asError(caught).message); }
    finally { setBusy(''); }
  };

  return <Dialog title="模型设置" subtitle="连接 AI 模型，从资料中提取待确认内容。" close={close} busy={!!busy} wide>
    {busy === 'load' ? <div className="dialog-body settings-loading"><Spinner />正在读取本机设置…</div> : !form ? <div className="dialog-body"><div className="form-error" role="alert"><CircleAlert size={17} /><p>{error || '设置暂时无法读取。'}</p></div><button className="button secondary settings-reload" onClick={() => setReload((value) => value + 1)}>重新读取设置</button></div> : <form onSubmit={save}>
      <div className="dialog-body model-settings-body">
        <div className="settings-status"><span className={`settings-status-dot ${saved?.configured ? 'ready' : ''}`} /><span>{saved?.configured ? '配置已保存' : '待配置'}</span><span>{tested ? '连接测试通过' : '保存后可测试连接'}</span></div>
        <label className="field-label" htmlFor="ai-provider">服务类型</label>
        <select id="ai-provider" value={form.provider} disabled={!!busy} onChange={(event) => {
          if (event.target.value === 'ollama') patch({ provider: 'ollama', baseUrl: 'http://127.0.0.1:11434', model: '', outputFormat: 'json_object', remoteConsent: false });
          else patch({ provider: 'openai_compatible', baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', outputFormat: 'json_object', remoteConsent: false });
          setKey(''); setClearKey(false);
        }}><option value="openai_compatible">OpenAI 兼容服务（如 DeepSeek）</option><option value="ollama">本机 Ollama</option></select>
        <div className="field-label-row"><label className="field-label" htmlFor="ai-base-url">服务地址</label>{form.provider === 'openai_compatible' && <button type="button" className="text-button tiny" disabled={!!busy} onClick={() => patch({ baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', outputFormat: 'json_object', remoteConsent: false })}>使用 DeepSeek 默认值</button>}</div>
        <input id="ai-base-url" type="url" value={form.baseUrl} placeholder={form.provider === 'ollama' ? 'http://127.0.0.1:11434' : 'https://api.deepseek.com'} onChange={(event) => patch({ baseUrl: event.target.value, remoteConsent: false })} required disabled={!!busy} spellCheck={false} />
        <label className="field-label spaced" htmlFor="ai-model">模型名称</label><input id="ai-model" value={form.model} onChange={(event) => patch({ model: event.target.value })} placeholder={form.provider === 'ollama' ? '填写本机已安装的模型名称' : 'deepseek-flash'} required disabled={!!busy} spellCheck={false} />
        {form.provider === 'openai_compatible' && <><label className="field-label spaced" htmlFor="ai-api-key">API 密钥 <span>{saved?.hasApiKey && sameEndpoint ? '本机已保存' : '不随备份导出'}</span></label><input id="ai-api-key" type="password" value={key} onChange={(event) => { setKey(event.target.value); setResult(''); setTested(false); }} placeholder={saved?.hasApiKey && sameEndpoint ? '留空保留已保存的密钥' : '输入此服务的 API 密钥'} autoComplete="new-password" spellCheck={false} disabled={!!busy || clearKey} />{saved?.hasApiKey && !sameEndpoint && <p className="field-hint">服务地址已变更。保存后旧密钥会清除，请填写新服务的密钥。</p>}{saved?.hasApiKey && sameEndpoint && <label className="settings-check clear-key-check"><input type="checkbox" checked={clearKey} disabled={!!busy} onChange={(event) => { setClearKey(event.target.checked); setKey(''); setResult(''); setTested(false); }} /><span>清除本机已保存的密钥</span></label>}</>}
        <details className="advanced-settings"><summary>高级设置 <Chevron /></summary><div className="settings-columns"><label><span className="field-label">输出格式</span><select aria-label="结构化输出格式" value={form.outputFormat} onChange={(event) => patch({ outputFormat: event.target.value as AiSettings['outputFormat'] })} disabled={!!busy}><option value="json_object">JSON 对象</option><option value="json_schema">JSON Schema</option></select></label><label><span className="field-label">请求超时（秒）</span><input aria-label="请求超时秒数" type="number" min={5} max={300} value={form.timeoutSeconds} onChange={(event) => patch({ timeoutSeconds: Number(event.target.value) })} disabled={!!busy} required /></label></div><p className="field-hint">更改模型配置会取消正在进行的提取任务。</p></details>
        <div className="model-data-notice">{target.local ? <Monitor size={18} /> : <Globe2 size={18} />}<div><strong>{target.local ? '使用本机模型' : '使用远程模型'}</strong><p>原文段落与位置将发送至 <b>{target.host}</b>，提取结果由你确认。</p>{!target.local && <label className="settings-check"><input type="checkbox" checked={form.remoteConsent} onChange={(event) => patch({ remoteConsent: event.target.checked })} disabled={!!busy} /><span>允许将资料发送至此服务</span></label>}{form.provider === 'ollama' && !target.local && <p className="settings-inline-error">Ollama 仅支持本机地址，请修改服务地址。</p>}</div></div>
        <label className="settings-check auto-extract-setting"><input type="checkbox" checked={form.autoExtract} onChange={(event) => patch({ autoExtract: event.target.checked })} disabled={!!busy} /><span><strong>导入后自动提取</strong><small>对新导入的资料生效；已有资料可手动提取。</small></span></label>
        {error && <div className="form-error" role="alert"><CircleAlert size={17} /><p>{error}</p></div>}
        {result && <div className="settings-result" role="status">{tested ? <ShieldCheck size={17} /> : <Check size={17} />}<p>{result}</p></div>}
        {busy === 'test' && <p className="connection-progress" role="status"><Spinner />正在验证连接和输出格式…</p>}
      </div>
      <div className="dialog-footer settings-footer"><div className="settings-test"><button type="button" className="button secondary" disabled={!!busy || dirty || !canTest} onClick={test}>{busy === 'test' ? <Spinner /> : <PlugZap size={15} />}测试连接</button><span>{dirty ? '请先保存修改' : '仅发送测试样本'}</span></div><button className="button primary" disabled={!!busy || !form.baseUrl.trim() || !form.model.trim() || (form.autoExtract && !target.local && !form.remoteConsent) || (form.provider === 'ollama' && !target.local)}>{busy === 'save' ? <Spinner /> : <Check size={15} />}保存设置</button></div>
    </form>}
  </Dialog>;
}

function Chevron() { return <span aria-hidden="true">⌄</span>; }
