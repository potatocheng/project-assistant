import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent, KeyboardEvent } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Check, CircleAlert, Copy, ExternalLink, Link2, MessageCircle, Plus, RefreshCw, Send, Trash2, Unplug } from 'lucide-react';
import { asError, execute } from '../api';
import type { FeishuBinding, FeishuEditableSettings, FeishuStatus, Project, ProjectAnswer } from '../types';
import { Dialog, Spinner } from './ui';

type Tab = 'connection' | 'bindings' | 'history' | 'preview';
const AUTH_LABELS = { disconnected: '未连接账号', authorizing: '等待授权', connected: '账号已连接', expired: '授权已过期' };
const MESSAGE_LABELS: Record<string, string> = {
  pending: '等待处理', processing: '正在生成', answering: '正在生成', sending: '正在发送',
  replied: '已回复', sent: '已回复', succeeded: '已回复', failed: '失败', skipped: '已跳过', ignored: '已跳过',
  unknown: '发送结果待核对', send_unknown: '发送结果待核对', deferred: '稍后重试', rejected: '未发送',
};

function navigateTabs(event: KeyboardEvent<HTMLDivElement>) {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  const tabs = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
  const index = tabs.indexOf(event.target as HTMLButtonElement);
  if (index < 0) return;
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1
    : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
  event.preventDefault();
  tabs[next].focus();
  tabs[next].click();
}

function editable(settings: FeishuStatus['settings']): FeishuEditableSettings {
  return { appId: settings.appId, enabled: settings.enabled, pollIntervalSeconds: settings.pollIntervalSeconds, replyPrefix: settings.replyPrefix, bindings: settings.bindings };
}
function displayTime(value: string | null) {
  if (!value) return '尚未检查';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
}
function authorizationUrl(value: string | null | undefined) {
  if (!value) return '';
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'accounts.feishu.cn' && !url.username && !url.password ? url.href : '';
  } catch { return ''; }
}

export function FeishuSettingsDialog({ projects, close, onSaved }: {
  projects: Project[]; close: () => void; onSaved?: () => Promise<unknown>;
}) {
  const [status, setStatus] = useState<FeishuStatus | null>(null);
  const [form, setForm] = useState<FeishuEditableSettings | null>(null);
  const [secret, setSecret] = useState('');
  const [busy, setBusy] = useState('load');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [tab, setTab] = useState<Tab>('connection');
  const [authUrl, setAuthUrl] = useState('');
  const [chats, setChats] = useState<Array<{ chatId: string; name: string }>>([]);
  const [previewProjectId, setPreviewProjectId] = useState(projects[0]?.id ?? '');
  const [question, setQuestion] = useState('');
  const [preview, setPreview] = useState<ProjectAnswer | null>(null);
  const alive = useRef(true);
  const refreshing = useRef(false);
  const savedSettings = useRef<FeishuEditableSettings | null>(null);
  const settingsEpoch = useRef(0);

  const refresh = useCallback(async () => {
    const epoch = settingsEpoch.current;
    const next = await execute<FeishuStatus>('get_feishu_status');
    if (alive.current && epoch === settingsEpoch.current) {
      const previous = savedSettings.current;
      const currentSettings = editable(next.settings);
      savedSettings.current = currentSettings;
      setStatus(next);
      setForm((current) => !current || (previous && JSON.stringify(current) === JSON.stringify(previous)) ? currentSettings : current);
      if (next.authorization.status !== 'authorizing') setAuthUrl('');
      else if (next.authorization.authorizationUrl) setAuthUrl(authorizationUrl(next.authorization.authorizationUrl));
    }
    return next;
  }, []);

  useEffect(() => {
    alive.current = true;
    refresh().catch((caught) => { if (alive.current) setError(asError(caught).message); })
      .finally(() => { if (alive.current) setBusy(''); });
    const timer = window.setInterval(() => {
      if (refreshing.current) return;
      refreshing.current = true;
      refresh().catch((caught) => { if (alive.current) setError(asError(caught).message); })
        .finally(() => { refreshing.current = false; });
    }, 5000);
    return () => { alive.current = false; window.clearInterval(timer); };
  }, [refresh]);

  const dirty = useMemo(() => !!form && !!status && (JSON.stringify(form) !== JSON.stringify(editable(status.settings)) || !!secret.trim()), [form, status, secret]);
  const appChanged = !!form && !!status && form.appId.trim() !== status.settings.appId;
  const needsNewSecret = appChanged && !!form?.appId.trim() && !secret.trim();
  const bindingError = form?.bindings.some((binding) => !binding.chatId.trim() || !projects.some((project) => project.id === binding.projectId))
    ? '每个群都需要填写群 ID 并选择项目。'
    : form && new Set(form.bindings.map((binding) => binding.chatId.trim())).size !== form.bindings.length ? '同一个群只能绑定一个项目。' : '';
  const intervalValid = !!form && Number.isInteger(form.pollIntervalSeconds) && form.pollIntervalSeconds >= 30 && form.pollIntervalSeconds <= 3600;
  const connected = status?.authorization.status === 'connected';
  const savedBindings = status?.settings.bindings.filter((binding) => binding.enabled).length ?? 0;
  const patch = (value: Partial<FeishuEditableSettings>) => { setForm((current) => current ? { ...current, ...value } : current); setError(''); setNotice(''); };
  const updateBinding = (index: number, value: Partial<FeishuBinding>) => {
    if (form) patch({ bindings: form.bindings.map((binding, position) => position === index ? { ...binding, ...value } : binding) });
  };
  const action = async (name: string, operation: () => Promise<void>) => {
    if (busy) return;
    setBusy(name); setError(''); setNotice('');
    try { await operation(); }
    catch (caught) { if (alive.current) setError(asError(caught).message); }
    finally { if (alive.current) setBusy(''); }
  };
  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!form || bindingError || !intervalValid || needsNewSecret) return;
    await action('save', async () => {
      const next = await execute<FeishuStatus>('save_feishu_settings', {
        ...form, appId: form.appId.trim(), bindings: form.bindings.map((binding) => ({ ...binding, chatId: binding.chatId.trim() })),
        ...(secret.trim() ? { appSecret: secret.trim() } : {}),
      });
      if (!alive.current) return;
      settingsEpoch.current += 1;
      savedSettings.current = editable(next.settings);
      setStatus(next); setForm(editable(next.settings)); setSecret(''); setNotice('飞书设置已保存。');
      await onSaved?.();
    });
  };
  const openAuthorization = async (url: string) => {
    const checked = authorizationUrl(url);
    if (!checked) throw new Error('授权地址无效，请重新发起授权。');
    if ('__TAURI_INTERNALS__' in window) await invoke('open_feishu_authorization', { url: checked });
    else {
      const opened = window.open(checked, '_blank', 'noopener,noreferrer');
      if (!opened) setNotice('请复制下方授权链接，在浏览器中打开。');
    }
  };
  const authorize = () => action('authorize', async () => {
    const result = await execute<{ authorizationUrl: string; redirectUri: string; expiresAt: string }>('begin_feishu_authorization');
    const checked = authorizationUrl(result.authorizationUrl);
    if (!checked) throw new Error('飞书返回的授权地址无效。');
    setAuthUrl(checked);
    await openAuthorization(checked);
    await refresh();
  });
  const copy = (value: string) => action('copy', async () => {
    await navigator.clipboard.writeText(value); setNotice('已复制。');
  });
  const checkNow = () => action('poll', async () => {
    await execute('poll_feishu_now'); await refresh(); setNotice('正在检查新消息，结果会自动更新。');
  });
  const testAnswer = () => action('preview', async () => {
    setPreview(null);
    const result = await execute<ProjectAnswer>('ask_project', { projectId: previewProjectId, question: question.trim() });
    if (alive.current) setPreview(result);
  });

  return <Dialog title="飞书个人助理" subtitle="在指定群中，根据项目记忆替你回复 @提问。" close={close} busy={!!busy} wide>
    {busy === 'load' ? <div className="dialog-body settings-loading"><Spinner />正在读取飞书连接…</div> : !form || !status ? <div className="dialog-body"><div className="form-error" role="alert"><CircleAlert size={17} /><p>{error || '暂时无法读取飞书设置。'}</p></div><button className="button secondary settings-reload" onClick={() => void action('reload', async () => { await refresh(); })}>{busy ? <Spinner /> : <RefreshCw size={15} />}重新读取</button></div> : <form onSubmit={save}>
      <div className="feishu-overview"><div className="feishu-identity"><span className={`settings-status-dot ${connected ? 'ready' : ''}`} /><strong>{AUTH_LABELS[status.authorization.status]}</strong>{status.authorization.user && <span>{status.authorization.user.name || status.authorization.user.openId}</span>}</div><span className="feishu-run-status">{status.runtime.polling ? <><Spinner />正在检查消息</> : !status.settings.enabled ? '自动回复已关闭' : !connected ? '等待账号授权' : !savedBindings ? '等待绑定群' : '自动回复已开启'}</span></div>
      <div className="feishu-tabs" role="tablist" aria-label="飞书个人助理设置" onKeyDown={navigateTabs}>{([
        ['connection', '连接账号'], ['bindings', '自动回复'], ['history', '回复记录'], ['preview', '回答预览'],
      ] as const).map(([value, label]) => <button type="button" key={value} role="tab" tabIndex={tab === value ? 0 : -1} aria-selected={tab === value} aria-controls={`feishu-panel-${value}`} id={`feishu-tab-${value}`} className={tab === value ? 'selected' : ''} onClick={() => setTab(value)}>{label}</button>)}</div>
      <div className="dialog-body feishu-body" role="tabpanel" id={`feishu-panel-${tab}`} aria-labelledby={`feishu-tab-${tab}`}>
        {tab === 'connection' && <>
          <div className="feishu-section-heading"><h3>1. 填写应用凭据</h3><a href="https://open.feishu.cn/app" target="_blank" rel="noreferrer">飞书开放平台 <ExternalLink size={12} /></a></div>
          <p className="field-hint">创建企业自建应用，配置重定向地址和用户身份权限后发布。</p>
          <label className="field-label spaced" htmlFor="feishu-app-id">App ID</label><input id="feishu-app-id" value={form.appId} onChange={(event) => patch({ appId: event.target.value })} placeholder="cli_…" spellCheck={false} autoComplete="off" disabled={!!busy} />
          <label className="field-label spaced" htmlFor="feishu-app-secret">App Secret <span>{status.settings.hasAppSecret && !appChanged ? '本机已保存' : '不随备份导出'}</span></label><input id="feishu-app-secret" type="password" value={secret} onChange={(event) => { setSecret(event.target.value); setError(''); setNotice(''); }} placeholder={status.settings.hasAppSecret && !appChanged ? '留空保留已保存的密钥' : '输入应用密钥'} autoComplete="new-password" spellCheck={false} disabled={!!busy} />
          {appChanged && <p className="field-hint">保存后会清除旧密钥与授权，请填写新密钥并重新授权。</p>}
          <label className="field-label spaced" htmlFor="feishu-redirect-uri">重定向地址</label><div className="feishu-copy-field"><input id="feishu-redirect-uri" readOnly value={status.settings.redirectUri} onFocus={(event) => event.target.select()} /><button type="button" className="icon-button" aria-label="复制重定向地址" title="复制重定向地址" disabled={!!busy} onClick={() => void copy(status.settings.redirectUri)}><Copy size={15} /></button></div>
          <p className="field-hint">复制到飞书应用的「安全设置 → 重定向 URL」。授权时保持本应用运行。</p>
          <details className="feishu-permissions"><summary>所需用户身份权限</summary><p><code>offline_access</code> 刷新个人授权</p><p><code>search:message</code> 搜索 @你的消息</p><p><code>im:message.group_msg:get_as_user</code> 读取用户所在群的消息</p><p><code>im:message</code> 读取消息与上下文</p><p><code>im:message.send_as_user</code> 以你的身份回复</p><p><code>im:chat:read</code> 读取可选群列表</p><p>权限变更需要重新发布应用，并重新完成个人授权。</p></details>
          <div className="feishu-section-heading feishu-section-spaced"><h3>2. 连接个人账号</h3></div>
          <div className="feishu-authorization-actions"><button type="button" className="button secondary" disabled={!!busy || dirty || !status.settings.appId || !status.settings.hasAppSecret} onClick={() => void authorize()}>{busy === 'authorize' ? <Spinner /> : <Link2 size={15} />}{connected ? '重新授权' : '连接我的飞书账号'}</button>{status.authorization.status !== 'disconnected' && <button type="button" className="text-button" disabled={!!busy} onClick={() => void action('disconnect', async () => { await execute('disconnect_feishu'); setAuthUrl(''); await refresh(); setNotice('个人授权已断开，自动回复已停止。'); })}><Unplug size={13} />断开授权</button>}</div>
          {dirty && <p className="field-hint">请先保存设置，再连接个人账号。</p>}
          {authUrl && <div className="feishu-authorization-link"><label className="field-label" htmlFor="feishu-authorization-url">等待浏览器授权</label><div className="feishu-copy-field"><input id="feishu-authorization-url" readOnly value={authUrl} onFocus={(event) => event.target.select()} /><button type="button" className="icon-button" title="复制授权链接" aria-label="复制授权链接" disabled={!!busy} onClick={() => void copy(authUrl)}><Copy size={15} /></button></div><button type="button" className="text-button tiny" disabled={!!busy} onClick={() => void action('open', () => openAuthorization(authUrl))}>重新打开授权页面 <ExternalLink size={12} /></button><p className="field-hint">授权完成后，账号状态会自动更新。</p></div>}
        </>}
        {tab === 'bindings' && <>
          <div className="feishu-section-heading"><h3>选择回复的群与项目</h3><button type="button" className="text-button tiny" disabled={!!busy || !connected} onClick={() => void action('chats', async () => { const result = await execute<{ chats: Array<{ chatId: string; name: string }> }>('list_feishu_chats'); setChats(result.chats); setNotice(result.chats.length ? '已读取群列表，可选择或输入群 ID。' : '没有找到可用群，可手动输入群 ID。'); })}>{busy === 'chats' ? <Spinner /> : <RefreshCw size={12} />}读取群列表</button></div>
          <p className="field-hint">仅回复启用后，指定群中 @你的新消息。项目中全部已确认记忆都可能用于回答，请选择可与群成员分享的项目。</p>
          <datalist id="feishu-chat-options">{chats.map((chat) => <option key={chat.chatId} value={chat.chatId}>{chat.name}</option>)}</datalist>
          <div className="feishu-bindings">{form.bindings.length === 0 && <div className="feishu-empty"><MessageCircle size={25} strokeWidth={1.5} /><p>还没有绑定群</p><span>添加群并选择项目，助理就能按项目记忆回答。</span></div>}{form.bindings.map((binding, index) => <div className="feishu-binding" key={index}>
            <div className="feishu-binding-fields"><label><span className="field-label">群 ID{chats.find((chat) => chat.chatId === binding.chatId)?.name && <span>{chats.find((chat) => chat.chatId === binding.chatId)?.name}</span>}</span><input aria-label={`第 ${index + 1} 个群 ID`} list="feishu-chat-options" value={binding.chatId} placeholder="oc_…（可手动填写）" onChange={(event) => updateBinding(index, { chatId: event.target.value })} disabled={!!busy} spellCheck={false} /></label><label><span className="field-label">项目</span><select aria-label={`第 ${index + 1} 个群绑定的项目`} value={binding.projectId} onChange={(event) => updateBinding(index, { projectId: event.target.value })} disabled={!!busy}><option value="">选择项目</option>{projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label></div>
            <div className="feishu-binding-actions"><label className="settings-check"><input type="checkbox" checked={binding.enabled} onChange={(event) => updateBinding(index, { enabled: event.target.checked })} disabled={!!busy} /><span>在此群回复</span></label><button type="button" className="icon-button small" title="移除群绑定" aria-label={`移除第 ${index + 1} 个群绑定`} disabled={!!busy} onClick={() => patch({ bindings: form.bindings.filter((_, position) => position !== index) })}><Trash2 size={14} /></button></div>
          </div>)}</div>
          <button type="button" className="button secondary compact" disabled={!!busy || !projects.length} onClick={() => patch({ bindings: [...form.bindings, { chatId: '', projectId: projects[0]?.id ?? '', enabled: true }] })}><Plus size={14} />添加群</button>
          {!projects.length && <p className="field-hint">请先在工作区创建项目并确认记忆。</p>}
          {bindingError && <p className="settings-inline-error field-hint">{bindingError}</p>}
          <div className="feishu-section-heading feishu-section-spaced"><h3>自动回复</h3></div>
          <label className="settings-check feishu-enable"><input type="checkbox" checked={form.enabled} onChange={(event) => patch({ enabled: event.target.checked })} disabled={!!busy} /><span><strong>用我的账号自动回复</strong><small>保存后生效，需保持应用运行和账号授权。受飞书消息索引影响，回复可能延迟。</small></span></label>
          <details className="advanced-settings" open={!intervalValid}><summary>回复设置</summary><div className="settings-columns"><label><span className="field-label">检查间隔（秒）</span><input type="number" aria-label="检查间隔秒数" min={30} max={3600} step={1} value={Number.isFinite(form.pollIntervalSeconds) ? form.pollIntervalSeconds : ''} onChange={(event) => patch({ pollIntervalSeconds: Number(event.target.value) })} disabled={!!busy} required /></label><label><span className="field-label">回复前缀 <span>可选</span></span><input aria-label="回复前缀" value={form.replyPrefix} maxLength={200} onChange={(event) => patch({ replyPrefix: event.target.value })} placeholder="例如：助理代答：" disabled={!!busy} /></label></div></details>
          {!intervalValid && <p className="field-hint settings-inline-error">检查间隔需要是 30～3600 秒之间的整数。</p>}
          <p className="field-hint feishu-model-note">问题与相关记忆会发送至已配置的模型服务，回答将发给群成员。建议先在「回答预览」中试问。</p>
        </>}
        {tab === 'history' && <>
          <div className="feishu-section-heading"><h3>最近处理的提问</h3><button type="button" className="button secondary compact" disabled={!!busy || !connected || !savedBindings || status.runtime.polling || dirty} onClick={() => void checkNow()}>{busy === 'poll' || status.runtime.polling ? <Spinner /> : <RefreshCw size={14} />}立即检查</button></div>
          <p className="field-hint">上次检查：{displayTime(status.runtime.lastPollAt)} · {dirty ? '请先保存修改' : '自动更新'}</p>
          {status.runtime.lastError && <div className="form-error" role="alert"><CircleAlert size={17} /><p>{status.runtime.lastError}</p></div>}
          <div className="feishu-history">{status.recentMessages.length ? status.recentMessages.map((message) => <article className="feishu-message" key={message.id}>
            <div className="feishu-message-meta"><span className={message.status === 'failed' ? 'text-error' : ''}>{MESSAGE_LABELS[message.status] ?? message.status}</span><span>{projects.find((project) => project.id === message.projectId)?.name ?? '未绑定项目'}</span><time>{displayTime(message.createdAt)}</time></div>
            <p className="feishu-question">{message.question || '无可用的文本提问'}</p>{message.answer && <p className="feishu-answer">{message.answer}</p>}{message.error && <p className="settings-inline-error">{message.error}</p>}<small className="feishu-message-chat">群：{chats.find((chat) => chat.chatId === message.chatId)?.name ?? message.chatId}</small>
          </article>) : <div className="feishu-empty"><MessageCircle size={25} strokeWidth={1.5} /><p>还没有处理记录</p><span>完成授权并启用群绑定后，新的 @你消息会显示在这里。</span></div>}</div>
        </>}
        {tab === 'preview' && <>
          <div className="feishu-section-heading"><h3>试问一个项目问题</h3></div><p className="field-hint">使用与自动回复相同的项目记忆生成回答，预览结果仅在此显示。</p>
          <label className="field-label spaced" htmlFor="feishu-preview-project">项目</label><select id="feishu-preview-project" value={previewProjectId} onChange={(event) => { setPreviewProjectId(event.target.value); setPreview(null); }} disabled={!!busy}><option value="">选择项目</option>{projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select>
          <label className="field-label spaced" htmlFor="feishu-preview-question">问题</label><textarea id="feishu-preview-question" value={question} onChange={(event) => { setQuestion(event.target.value); setPreview(null); }} rows={3} maxLength={4000} placeholder="例如：项目一期有哪些验收要求？" disabled={!!busy} />
          <button type="button" className="button secondary feishu-preview-button" disabled={!!busy || !previewProjectId || !question.trim()} onClick={() => void testAnswer()}>{busy === 'preview' ? <Spinner /> : <Send size={14} />}预览回答</button>
          {preview && <div className="feishu-preview-result"><div className="feishu-section-heading"><h3>回复预览</h3><span className="field-hint">{preview.grounded ? `${preview.citations.length} 条记忆依据` : '未找到足够依据'}</span></div><p>{preview.answer}</p>{preview.citations.length > 0 && <details><summary>查看引用的记忆与原文</summary>{preview.citations.map((citation) => <div className="feishu-citation" key={`${citation.memoryId}-${citation.revision}`}><strong>{citation.sourceTitle} · 记忆 v{citation.revision}</strong><p>{citation.content}</p>{citation.evidence.map((evidence) => <blockquote key={evidence.segmentId}><span>{evidence.sourceTitle} · {evidence.locator}</span>{evidence.text}</blockquote>)}</div>)}</details>}</div>}
        </>}
        {error && <div className="form-error" role="alert"><CircleAlert size={17} /><p>{error}</p></div>}
        {notice && <div className="settings-result" role="status"><Check size={17} /><p>{notice}</p></div>}
      </div>
      <div className="dialog-footer settings-footer"><span className="footer-note">{dirty ? '有未保存的修改' : `${savedBindings} 个群已启用`}</span><button type="button" className="button secondary" disabled={!!busy} onClick={close}>关闭</button><button type="submit" className="button primary" disabled={!!busy || !dirty || !!bindingError || !intervalValid || needsNewSecret}>{busy === 'save' ? <Spinner /> : <Check size={15} />}保存设置</button></div>
    </form>}
  </Dialog>;
}
