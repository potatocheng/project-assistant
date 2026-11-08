import { Selector } from '@astryxdesign/core/Selector';
import { TextInput } from '@astryxdesign/core/TextInput';
import { CheckboxInput } from '@astryxdesign/core/CheckboxInput';
import { FormDialog } from './astryx/FormDialog';
import { Button } from '@astryxdesign/core/Button';
import { useEffect, useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { Check, CircleAlert, Globe2, Monitor, PlugZap, ShieldCheck } from 'lucide-react';
import { asError, execute } from '../api';
import type { AiSettings } from '../types';
import { Spinner } from './ui';

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
    if (!form || busy || !form.baseUrl.trim() || !form.model.trim() || (form.autoExtract && !target.local && !form.remoteConsent) || (form.provider === 'ollama' && !target.local)) return;
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

  return <FormDialog title="模型设置" subtitle="连接 AI 模型，从资料中提取待确认内容。" close={close} busy={!!busy} wide>
    {busy === 'load' ? <div className="dialog-body settings-loading"><Spinner />正在读取本机设置…</div> : !form ? <div className="dialog-body"><div className="form-error" role="alert"><CircleAlert size={17} /><p>{error || '设置暂时无法读取。'}</p></div><Button label="重新读取设置" onClick={() => setReload((value) => value + 1)} className="settings-reload" variant="secondary" /></div> : <form onSubmit={save}>
      <div className="dialog-body model-settings-body astryx-form-fields">
        <div className="settings-status"><span className={`settings-status-dot ${saved?.configured ? 'ready' : ''}`} /><span>{saved?.configured ? '配置已保存' : '待配置'}</span><span>{tested ? '连接测试通过' : '保存后可测试连接'}</span></div>
        <Selector id="ai-provider" label="服务类型" value={form.provider} isDisabled={!!busy} onChange={value => {
          if (value === 'ollama') patch({ provider: 'ollama', baseUrl: 'http://127.0.0.1:11434', model: '', outputFormat: 'json_object', remoteConsent: false });
          else patch({ provider: 'openai_compatible', baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', outputFormat: 'json_object', remoteConsent: false });
          setKey(''); setClearKey(false);
        }} options={[{ value: 'openai_compatible', label: 'OpenAI 兼容服务（如 DeepSeek）' }, { value: 'ollama', label: '本机 Ollama' }]} />
        <TextInput id="ai-base-url" label="服务地址" type="url" value={form.baseUrl} placeholder={form.provider === 'ollama' ? 'http://127.0.0.1:11434' : 'https://api.deepseek.com'}
          onChange={value => patch({ baseUrl: value, remoteConsent: false })} isRequired isDisabled={!!busy} hasSpellCheck={false} />
        {form.provider === 'openai_compatible' && <Button label="使用 DeepSeek 默认值" type="button" variant="ghost" size="sm" className="astryx-inline-action astryx-field-action" isDisabled={!!busy}
          onClick={() => patch({ baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', outputFormat: 'json_object', remoteConsent: false })} />}
        <TextInput id="ai-model" label="模型名称" value={form.model} onChange={value => patch({ model: value })} placeholder={form.provider === 'ollama' ? '填写本机已安装的模型名称' : 'deepseek-flash'}
          isRequired isDisabled={!!busy} hasSpellCheck={false} />
        {form.provider === 'openai_compatible' && <>
          <TextInput id="ai-api-key" label="API 密钥" description={saved?.hasApiKey && sameEndpoint ? '本机已保存' : '不随备份导出'} type="password" value={key}
            onChange={value => { setKey(value); setResult(''); setTested(false); }} placeholder={saved?.hasApiKey && sameEndpoint ? '留空保留已保存的密钥' : '输入此服务的 API 密钥'}
            autoComplete="new-password" hasSpellCheck={false} isDisabled={!!busy || clearKey} />
          {saved?.hasApiKey && !sameEndpoint && <p className="field-hint">服务地址已变更。保存后旧密钥会清除，请填写新服务的密钥。</p>}
          {saved?.hasApiKey && sameEndpoint && <CheckboxInput label="清除本机已保存的密钥" value={clearKey} isDisabled={!!busy}
            onChange={value => { setClearKey(value); setKey(''); setResult(''); setTested(false); }} />}
        </>}
        <details className="advanced-settings"><summary>高级设置 <Chevron /></summary><div className="settings-columns"><Selector label="结构化输出格式" value={form.outputFormat} onChange={value => patch({ outputFormat: value as AiSettings['outputFormat'] })} isDisabled={!!busy}
          options={[{ value: 'json_object', label: 'JSON 对象' }, { value: 'json_schema', label: 'JSON Schema' }]} /><label><span className="field-label">请求超时（秒）</span><input aria-label="请求超时秒数" type="number" min={5} max={300} value={form.timeoutSeconds} onChange={(event) => patch({ timeoutSeconds: Number(event.target.value) })} disabled={!!busy} required /></label></div><p className="field-hint">更改模型配置会取消正在进行的提取任务。</p></details>
        <div className="model-data-notice">{target.local ? <Monitor size={18} /> : <Globe2 size={18} />}<div><strong>{target.local ? '使用本机模型' : '使用远程模型'}</strong><p>原文段落与位置将发送至 <b>{target.host}</b>，提取结果由你确认。</p>{!target.local && <CheckboxInput label="允许将资料发送至此服务" value={form.remoteConsent} onChange={value => patch({ remoteConsent: value })} isDisabled={!!busy} className="astryx-setting-check" />}{form.provider === 'ollama' && !target.local && <p className="settings-inline-error">Ollama 仅支持本机地址，请修改服务地址。</p>}</div></div>
        <CheckboxInput label="导入后自动提取" description="对新导入的资料生效；已有资料可手动提取。" value={form.autoExtract} onChange={value => patch({ autoExtract: value })} isDisabled={!!busy} />
        {error && <div className="form-error" role="alert"><CircleAlert size={17} /><p>{error}</p></div>}
        {result && <div className="settings-result" role="status">{tested ? <ShieldCheck size={17} /> : <Check size={17} />}<p>{result}</p></div>}
        {busy === 'test' && <p className="connection-progress" role="status"><Spinner />正在验证连接和输出格式…</p>}
      </div>
      <div className="dialog-footer settings-footer"><div className="settings-test"><Button label="测试连接" type="button" isDisabled={!!busy || dirty || !canTest} onClick={test} variant="secondary" icon={busy === 'test' ? <Spinner /> : <PlugZap size={15} />} /><span>{dirty ? '请先保存修改' : '仅发送测试样本'}</span></div><Button label="保存设置" isDisabled={!!busy || !form.baseUrl.trim() || !form.model.trim() || (form.autoExtract && !target.local && !form.remoteConsent) || (form.provider === 'ollama' && !target.local)} type="submit" variant="primary" icon={busy === 'save' ? <Spinner /> : <Check size={15} />} /></div>
    </form>}
  </FormDialog>;
}

function Chevron() { return <span aria-hidden="true">⌄</span>; }
