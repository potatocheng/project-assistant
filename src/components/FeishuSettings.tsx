import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent, KeyboardEvent } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Check, CircleAlert, Copy, ExternalLink, Link2, MessageCircle, Plus, RefreshCw, Send, Trash2, Unplug } from 'lucide-react';
import { asError, execute } from '../api';
import type { FeishuBinding, FeishuPrivateChat, FeishuEditableSettings, FeishuStatus, Project } from '../types';
import type { AssistantAnswer } from './delivery/types';
import { CITATION_KIND, PROJECT_QUESTIONS } from '../assistant-labels';
import { Dialog, Spinner } from './ui';

type Tab = 'connection' | 'bindings' | 'preview';
const AUTH_LABELS = { disconnected: '未连接账号', authorizing: '等待授权', connected: '账号已连接', expired: '授权已过期' };

function displayTime(value: string | null | undefined) {
  if (!value) return '未记录';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN');
}

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
function authorizationUrl(value: string | null | undefined) {
  if (!value) return '';
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'accounts.feishu.cn' && !url.port && !url.username && !url.password ? url.href : '';
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
  const [privateChats, setPrivateChats] = useState<FeishuPrivateChat[]>([]);
  const [previewProjectId, setPreviewProjectId] = useState(projects[0]?.id ?? '');
  const [question, setQuestion] = useState('');
  const [preview, setPreview] = useState<AssistantAnswer | null>(null);
  const alive = useRef(true);
  const refreshing = useRef(false);
  const savedSettings = useRef<FeishuEditableSettings | null>(null);
  const settingsEpoch = useRef(0);
  const openedAuthorization = useRef('');

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
    ? '每个会话都需要填写会话 ID 并选择项目。'
    : form && new Set(form.bindings.map((binding) => binding.chatId.trim())).size !== form.bindings.length ? '同一个会话只能绑定一个项目。'
    : form?.bindings.some((binding) => binding.chatType === 'p2p' && !/^ou[_-][A-Za-z0-9_-]+$/.test(binding.peerId ?? '')) ? '每个私聊都需要选择同事或填写有效的同事 Open ID。' : '';
  const intervalValid = !!form && Number.isInteger(form.pollIntervalSeconds) && form.pollIntervalSeconds >= 30 && form.pollIntervalSeconds <= 3600;
  const connected = status?.authorization.status === 'connected';
  const savedBindings = status?.settings.bindings.filter((binding) => binding.enabled).length ?? 0;
  const savedGroups = status?.settings.bindings.filter((binding) => binding.enabled && binding.chatType !== 'p2p').length ?? 0;
  const savedPrivateChats = savedBindings - savedGroups;
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
  const saveSettings = async () => {
    if (!form) return;
    const next = await execute<FeishuStatus>('save_feishu_settings', {
      ...form, appId: form.appId.trim(), bindings: form.bindings.map((binding) => ({ ...binding, chatId: binding.chatId.trim(), peerId: binding.peerId?.trim() })),
      ...(secret.trim() ? { appSecret: secret.trim() } : {}),
    });
    if (!alive.current) return;
    settingsEpoch.current += 1;
    savedSettings.current = editable(next.settings);
    setStatus(next); setForm(editable(next.settings)); setSecret(''); setNotice('飞书设置已保存。');
    await onSaved?.();
  };
  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!form || bindingError || !intervalValid || needsNewSecret) return;
    await action('save', saveSettings);
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
  const authorize = (accountOnly = false) => action('authorize', async () => {
    if (dirty) await saveSettings();
    if (!alive.current) return;
    const result = await execute<{ authorizationUrl: string }>(accountOnly ? 'begin_feishu_authorization' : 'begin_feishu_connection');
    const checked = authorizationUrl(result.authorizationUrl);
    if (!checked) throw new Error('飞书返回的授权地址无效。');
    setAuthUrl(checked);
    openedAuthorization.current = checked;
    await openAuthorization(checked);
    await refresh();
  });
  const copy = (value: string) => action('copy', async () => {
    await navigator.clipboard.writeText(value); setNotice('已复制。');
  });
  const testAnswer = () => action('preview', async () => {
    setPreview(null);
    const result = await execute<AssistantAnswer>('ask_project_question', { projectId: previewProjectId, question: question.trim() });
    if (alive.current) setPreview(result);
  });

  useEffect(() => {
    // App permission confirmation completes in the backend, even if this dialog
    // was closed. Open the personal consent page when that next stage is ready.
    if (!authUrl || status?.authorization.stage !== 'account' || openedAuthorization.current === authUrl) return;
    openedAuthorization.current = authUrl;
    void openAuthorization(authUrl).catch((caught) => { if (alive.current) setError(asError(caught).message); });
  }, [authUrl, status?.authorization.stage]);

  return <Dialog title="飞书个人助理" subtitle="根据项目记录，替你回复群内 @提问和指定同事的私聊。" close={close} busy={!!busy} wide>
    {busy === 'load' ? <div className="dialog-body settings-loading"><Spinner />正在读取飞书连接…</div> : !form || !status ? <div className="dialog-body"><div className="form-error" role="alert"><CircleAlert size={17} /><p>{error || '暂时无法读取飞书设置。'}</p></div><button className="button secondary settings-reload" onClick={() => void action('reload', async () => { await refresh(); })}>{busy ? <Spinner /> : <RefreshCw size={15} />}重新读取</button></div> : <form onSubmit={save}>
      <div className="feishu-overview"><div className="feishu-identity"><span className={`settings-status-dot ${connected ? 'ready' : ''}`} /><strong>{AUTH_LABELS[status.authorization.status]}</strong>{status.authorization.user && <span>{status.authorization.user.name || status.authorization.user.openId}</span>}</div><span className="feishu-run-status">{status.runtime.polling ? <><Spinner />正在检查消息</> : !status.settings.enabled ? '自动回复已关闭' : !connected ? '等待账号授权' : !savedBindings ? '等待绑定会话' : '自动回复已开启'}</span></div>
      <div className="feishu-tabs" role="tablist" aria-label="飞书个人助理设置" onKeyDown={navigateTabs}>{([
        ['connection', '连接账号'], ['bindings', '自动回复'], ['preview', '回答预览'],
      ] as const).map(([value, label]) => <button type="button" key={value} role="tab" tabIndex={tab === value ? 0 : -1} aria-selected={tab === value} aria-controls={`feishu-panel-${value}`} id={`feishu-tab-${value}`} className={tab === value ? 'selected' : ''} onClick={() => setTab(value)}>{label}</button>)}</div>
      <div className="dialog-body feishu-body" role="tabpanel" id={`feishu-panel-${tab}`} aria-labelledby={`feishu-tab-${tab}`}>
        {tab === 'connection' && <>
          <div className="feishu-section-heading"><h3>1. 填写应用凭据</h3><a href="https://open.feishu.cn/app" target="_blank" rel="noreferrer">飞书开放平台 <ExternalLink size={12} /></a></div>
          <p className="field-hint">首次连接需提供企业自建应用凭据并配置下方回调地址。所需权限由项目自动申请，无需在后台逐项查找或勾选。</p>
          <label className="field-label spaced" htmlFor="feishu-app-id">App ID</label><input id="feishu-app-id" value={form.appId} onChange={(event) => patch({ appId: event.target.value })} placeholder="cli_…" spellCheck={false} autoComplete="off" disabled={!!busy} />
          <label className="field-label spaced" htmlFor="feishu-app-secret">App Secret <span>{status.settings.hasAppSecret && !appChanged ? '本机已保存' : '不随备份导出'}</span></label><input id="feishu-app-secret" type="password" value={secret} onChange={(event) => { setSecret(event.target.value); setError(''); setNotice(''); }} placeholder={status.settings.hasAppSecret && !appChanged ? '留空保留已保存的密钥' : '输入应用密钥'} autoComplete="new-password" spellCheck={false} disabled={!!busy} />
          {appChanged && <p className="field-hint">保存后会清除旧密钥与授权，请填写新密钥并重新授权。</p>}
          <label className="field-label spaced" htmlFor="feishu-redirect-uri">重定向地址</label><div className="feishu-copy-field"><input id="feishu-redirect-uri" readOnly value={status.settings.redirectUri} onFocus={(event) => event.target.select()} /><button type="button" className="icon-button" aria-label="复制重定向地址" title="复制重定向地址" disabled={!!busy} onClick={() => void copy(status.settings.redirectUri)}><Copy size={15} /></button></div>
          <p className="field-hint">复制到飞书应用的「安全设置 → 重定向 URL」。授权时保持本应用运行。</p>
          <details className="feishu-permissions"><summary>将申请哪些权限</summary><p>搜索和读取群消息及私聊消息、读取群列表、以你的身份回复、读取文档与知识库，以及刷新个人授权。权限范围由项目维护，飞书确认页会展示本次申请。</p><p>涉及企业审批时，需由有权限的管理员确认。</p><button type="button" className="text-button tiny" disabled={!!busy || dirty || !status.settings.appId || !status.settings.hasAppSecret || status.authorization.stage === 'permissions'} onClick={() => void authorize(true)}>应用权限已开通，仅重新确认个人授权</button></details>
          <div className="feishu-section-heading feishu-section-spaced"><h3>2. 连接个人账号</h3></div>
          <p className="field-hint">点击连接后，在飞书确认应用权限；项目会自动继续个人账号授权，你只需选择同意或取消。授权时保持本应用运行。</p>
          <div className="feishu-authorization-actions"><button type="button" className="button secondary" disabled={!!busy || !form.appId.trim() || (!secret.trim() && (!status.settings.hasAppSecret || appChanged)) || !!bindingError || !intervalValid} onClick={() => void authorize()}>{busy === 'authorize' ? <Spinner /> : <Link2 size={15} />}{status.authorization.status === 'authorizing' ? '继续飞书授权' : connected ? '补充权限并重新连接' : '自动申请权限并连接'}</button>{status.authorization.status !== 'disconnected' && <button type="button" className="text-button" disabled={!!busy} onClick={() => void action('disconnect', async () => { await execute('disconnect_feishu'); setAuthUrl(''); await refresh(); setNotice('个人授权已断开，自动回复已停止。'); })}><Unplug size={13} />断开授权</button>}</div>
          {dirty && <p className="field-hint">点击连接会先保存当前设置。</p>}
          {status.authorization.stage === 'permissions' && <p className="field-hint" role="status">等待飞书权限确认，完成后会自动打开个人授权页面。</p>}
          {status.runtime.lastError && <div className="form-error" role="alert"><CircleAlert size={17} /><p>{status.runtime.lastError}</p></div>}
          {authUrl && <div className="feishu-authorization-link"><label className="field-label" htmlFor="feishu-authorization-url">等待浏览器授权</label><div className="feishu-copy-field"><input id="feishu-authorization-url" readOnly value={authUrl} onFocus={(event) => event.target.select()} /><button type="button" className="icon-button" title="复制授权链接" aria-label="复制授权链接" disabled={!!busy} onClick={() => void copy(authUrl)}><Copy size={15} /></button></div><button type="button" className="text-button tiny" disabled={!!busy} onClick={() => void action('open', () => openAuthorization(authUrl))}>重新打开授权页面 <ExternalLink size={12} /></button><p className="field-hint">授权完成后，账号状态会自动更新。</p></div>}
        </>}
        {tab === 'bindings' && <>
          <div className="feishu-section-heading"><h3>选择回复的群与项目</h3><button type="button" className="text-button tiny" disabled={!!busy || !connected} onClick={() => void action('chats', async () => { const result = await execute<{ chats: Array<{ chatId: string; name: string }> }>('list_feishu_chats'); setChats(result.chats); setNotice(result.chats.length ? '已读取群列表，可选择或输入群 ID。' : '没有找到可用群，可手动输入群 ID。'); })}>{busy === 'chats' ? <Spinner /> : <RefreshCw size={12} />}读取群列表</button></div>
          <p className="field-hint">仅回复启用后，指定群中 @你的新消息。项目中全部已确认记忆都可能用于回答，请选择可与群成员分享的项目。</p>
          <datalist id="feishu-chat-options">{chats.map((chat) => <option key={chat.chatId} value={chat.chatId}>{chat.name}</option>)}</datalist>
          <div className="feishu-bindings">{form.bindings.filter((binding) => binding.chatType !== 'p2p').length === 0 && <div className="feishu-empty"><MessageCircle size={25} strokeWidth={1.5} /><p>还没有绑定群</p><span>添加群并选择项目，助理就能根据任务、进展、风险和项目记忆回答。</span></div>}{form.bindings.map((binding, index) => binding.chatType !== 'p2p' && <div className="feishu-binding" key={index}>
            <div className="feishu-binding-fields"><label><span className="field-label">群 ID{chats.find((chat) => chat.chatId === binding.chatId)?.name && <span>{chats.find((chat) => chat.chatId === binding.chatId)?.name}</span>}</span><input aria-label={`第 ${index + 1} 个群 ID`} list="feishu-chat-options" value={binding.chatId} placeholder="oc_…（可手动填写）" onChange={(event) => updateBinding(index, { chatId: event.target.value })} disabled={!!busy} spellCheck={false} /></label><label><span className="field-label">项目</span><select aria-label={`第 ${index + 1} 个群绑定的项目`} value={binding.projectId} onChange={(event) => updateBinding(index, { projectId: event.target.value })} disabled={!!busy}><option value="">选择项目</option>{projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label></div>
            <div className="feishu-binding-actions"><label className="settings-check"><input type="checkbox" checked={binding.enabled} onChange={(event) => updateBinding(index, { enabled: event.target.checked })} disabled={!!busy} /><span>在此群回复</span></label><button type="button" className="icon-button small" title="移除群绑定" aria-label={`移除第 ${index + 1} 个群绑定`} disabled={!!busy} onClick={() => patch({ bindings: form.bindings.filter((_, position) => position !== index) })}><Trash2 size={14} /></button></div>
          </div>)}</div>
          <button type="button" className="button secondary compact" disabled={!!busy || !projects.length} onClick={() => patch({ bindings: [...form.bindings, { chatId: '', projectId: projects[0]?.id ?? '', enabled: true }] })}><Plus size={14} />添加群</button>
          <div className="feishu-section-heading feishu-section-spaced"><h3>自动回复同事私聊</h3><button type="button" className="text-button tiny" disabled={!!busy || !connected || appChanged || !!secret.trim()} onClick={() => void action('private-chats', async () => {
            const result = await execute<{ chats: FeishuPrivateChat[]; hasMore: boolean }>('list_feishu_private_chats');
            setPrivateChats(result.chats);
            setNotice(result.chats.length ? `已读取 ${result.chats.length} 个最近私聊。${result.hasMore ? '仅展示最近 500 条消息涉及的会话，也可手动填写。' : ''}` : '最近 30 天没有可读取的私聊，可手动填写会话 ID 和同事 Open ID。');
          })}>{busy === 'private-chats' ? <Spinner /> : <RefreshCw size={12} />}读取最近私聊</button></div>
          <p className="field-hint">仅回复已启用同事发来的新文字、富文本消息，无需 @你。每个私聊绑定一个项目，该项目的任务、进展、风险和已确认记忆都可能用于回答。首次使用请增加私聊读取权限并重新授权。</p>
          {(appChanged || !!secret.trim()) && <p className="field-hint">先保存应用凭据，再读取最近私聊。</p>}
          <div className="feishu-bindings">{!form.bindings.some((binding) => binding.chatType === 'p2p') && <div className="feishu-empty"><MessageCircle size={25} strokeWidth={1.5} /><p>还没有绑定同事私聊</p><span>添加同事并选择可用于回答的项目。</span></div>}{form.bindings.map((binding, index) => binding.chatType === 'p2p' && <div className="feishu-binding" key={index}>
            <div className="feishu-binding-fields"><label><span className="field-label">同事（最近 30 天的私聊）</span><select aria-label={`第 ${index + 1} 个私聊同事`} value={privateChats.some((chat) => chat.chatId === binding.chatId) ? binding.chatId : ''} disabled={!!busy} onChange={(event) => {
              const chat = privateChats.find((item) => item.chatId === event.target.value);
              if (chat) updateBinding(index, { chatId: chat.chatId, peerId: chat.peerId, name: chat.name });
            }}><option value="">{binding.chatId ? binding.name || binding.peerId || '已绑定私聊' : '先读取最近私聊，或手动填写'}</option>{privateChats.map((chat) => <option key={chat.chatId} value={chat.chatId}>{chat.name} · {chat.peerId}</option>)}</select></label><label><span className="field-label">允许回答的项目</span><select aria-label={`第 ${index + 1} 个私聊绑定的项目`} value={binding.projectId} onChange={(event) => updateBinding(index, { projectId: event.target.value })} disabled={!!busy}><option value="">选择项目</option>{projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label></div>
            <details className="advanced-settings" open={!binding.chatId || !binding.peerId}><summary>手动填写私聊信息</summary><div className="settings-columns"><label><span className="field-label">私聊会话 ID</span><input aria-label={`第 ${index + 1} 个私聊会话 ID`} value={binding.chatId} onChange={(event) => updateBinding(index, { chatId: event.target.value })} placeholder="oc_…" spellCheck={false} disabled={!!busy} /></label><label><span className="field-label">同事 Open ID</span><input aria-label={`第 ${index + 1} 个同事 Open ID`} value={binding.peerId ?? ''} onChange={(event) => updateBinding(index, { peerId: event.target.value, name: '' })} placeholder="ou_…" spellCheck={false} disabled={!!busy} /></label></div></details>
            <div className="feishu-binding-actions"><label className="settings-check"><input type="checkbox" checked={binding.enabled} onChange={(event) => updateBinding(index, { enabled: event.target.checked })} disabled={!!busy} /><span>回复此同事私聊</span></label><button type="button" className="icon-button small" aria-label={`移除第 ${index + 1} 个私聊绑定`} title="移除私聊绑定" disabled={!!busy} onClick={() => patch({ bindings: form.bindings.filter((_, position) => position !== index) })}><Trash2 size={14} /></button></div>
          </div>)}</div>
          <button type="button" className="button secondary compact" disabled={!!busy || !projects.length} onClick={() => patch({ bindings: [...form.bindings, { chatType: 'p2p', chatId: '', peerId: '', name: '', projectId: projects[0]?.id ?? '', enabled: true }] })}><Plus size={14} />添加同事私聊</button>
          {!projects.length && <p className="field-hint">请先在工作区创建项目并确认记忆。</p>}
          {bindingError && <p className="settings-inline-error field-hint">{bindingError}</p>}
          <div className="feishu-section-heading feishu-section-spaced"><h3>自动回复</h3></div>
          <label className="settings-check feishu-enable"><input type="checkbox" checked={form.enabled} onChange={(event) => patch({ enabled: event.target.checked })} disabled={!!busy} /><span><strong>用我的账号自动回复</strong><small>保存后生效，需保持应用运行和账号授权。受飞书消息索引影响，回复可能延迟。</small></span></label>
          <details className="advanced-settings" open={!intervalValid}><summary>回复设置</summary><div className="settings-columns"><label><span className="field-label">检查间隔（秒）</span><input type="number" aria-label="检查间隔秒数" min={30} max={3600} step={1} value={Number.isFinite(form.pollIntervalSeconds) ? form.pollIntervalSeconds : ''} onChange={(event) => patch({ pollIntervalSeconds: Number(event.target.value) })} disabled={!!busy} required /></label><label><span className="field-label">回复前缀 <span>可选</span></span><input aria-label="回复前缀" value={form.replyPrefix} maxLength={200} onChange={(event) => patch({ replyPrefix: event.target.value })} placeholder="例如：助理代答：" disabled={!!busy} /></label></div></details>
          {!intervalValid && <p className="field-hint settings-inline-error">检查间隔需要是 30～3600 秒之间的整数。</p>}
          <p className="field-hint feishu-model-note">问题及绑定项目的相关任务、进展、风险、里程碑、报告和记忆会发送至已配置的模型服务，回答将发给绑定群成员或指定私聊同事。建议先在「回答预览」中核对范围。</p>
        </>}
        {tab === 'preview' && <>
          <div className="feishu-section-heading"><h3>试问一个项目问题</h3></div><p className="field-hint">与桌面项目问答共用检索和回答逻辑，自动回复只读取会话绑定的项目。预览不会发送消息。</p>
          <label className="field-label spaced" htmlFor="feishu-preview-project">项目</label><select id="feishu-preview-project" value={previewProjectId} onChange={(event) => { setPreviewProjectId(event.target.value); setPreview(null); }} disabled={!!busy}><option value="">选择项目</option>{projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select>
          <label className="field-label spaced" htmlFor="feishu-preview-question">问题</label><textarea id="feishu-preview-question" value={question} onChange={(event) => { setQuestion(event.target.value); setPreview(null); }} rows={3} maxLength={2000} placeholder="例如：哪些交付可能延期？依据是什么？" disabled={!!busy} />
          <div className="assistant-suggestions">{PROJECT_QUESTIONS.slice(0, 4).map(text => <button type="button" key={text} className="button secondary compact" disabled={!!busy} onClick={() => { setQuestion(text); setPreview(null); }}>{text}</button>)}</div>
          <button type="button" className="button secondary feishu-preview-button" disabled={!!busy || !previewProjectId || !question.trim()} onClick={() => void testAnswer()}>{busy === 'preview' ? <Spinner /> : <Send size={14} />}预览回答</button>
          {preview && <div className="feishu-preview-result"><div className="feishu-section-heading"><h3>回复预览</h3><span className="field-hint">{preview.status === 'partial' ? '部分回答 · ' : ''}{preview.grounded ? `${preview.citations.length} 条引用依据` : '未找到足够依据，不会自动回复'}</span></div><p>{preview.answer}</p>{preview.limitations?.length > 0 && <details><summary>回答范围</summary>{preview.limitations.map((text, index) => <p key={index}>{text}</p>)}</details>}{preview.citations.length > 0 && <details><summary>查看引用记录与原文</summary>{preview.citations.map((citation) => <div className="feishu-citation" key={citation.id}><strong>{CITATION_KIND[citation.kind]} · {citation.title}</strong>{citation.updatedAt && <small>更新于 {displayTime(citation.updatedAt)}</small>}<p>{citation.content}</p>{citation.evidence?.map((evidence) => <blockquote key={evidence.segmentId}><span>{evidence.sourceTitle} · {evidence.locator}</span>{evidence.text}</blockquote>)}</div>)}</details>}</div>}
        </>}
        {status.runtime.lastError && <div className="form-error" role="alert"><CircleAlert size={17} /><p>{status.runtime.lastError}</p></div>}
        {error && <div className="form-error" role="alert"><CircleAlert size={17} /><p>{error}</p></div>}
        {notice && <div className="settings-result" role="status"><Check size={17} /><p>{notice}</p></div>}
      </div>
      <div className="dialog-footer settings-footer"><span className="footer-note">{dirty ? '有未保存的修改' : `${savedGroups} 个群、${savedPrivateChats} 个私聊已启用`}</span><button type="button" className="button secondary" disabled={!!busy} onClick={close}>关闭</button><button type="submit" className="button primary" disabled={!!busy || !dirty || !!bindingError || !intervalValid || needsNewSecret}>{busy === 'save' ? <Spinner /> : <Check size={15} />}保存设置</button></div>
    </form>}
  </Dialog>;
}
