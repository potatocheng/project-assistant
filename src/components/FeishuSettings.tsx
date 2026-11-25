import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent, KeyboardEvent } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Check, CircleAlert, Copy, ExternalLink, Link2, MessageCircle, Plus, RefreshCw, Send, ShieldCheck, Trash2, Unplug, X } from 'lucide-react';
import { asError, execute, openExternalUrl } from '../api';
import type { FeishuBinding, FeishuCapabilityId, FeishuCapabilityState, FeishuPrivateChat, FeishuEditableSettings, FeishuStatus, Project } from '../types';
import type { AssistantAnswer } from './delivery/types';
import { CITATION_KIND, PROJECT_QUESTIONS } from '../assistant-labels';
import { Dialog, Spinner } from './ui';

type Tab = 'connection' | 'bindings' | 'preview';
const AUTH_LABELS = { disconnected: '未连接账号', authorizing: '等待授权', connected: '账号已连接', expired: '授权已过期' };
const CAP_STATE_LABELS: Record<FeishuCapabilityState, string> = {
  enabled: '已开启',
  ready_to_confirm: '已获批 · 待确认',
  pending_approval: '待管理员审批',
  unavailable: '未开启',
};

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
  const sawPermissionsStage = useRef(false);

  const refresh = useCallback(async () => {
    const epoch = settingsEpoch.current;
    const next = await execute<FeishuStatus>('get_feishu_status');
    if (alive.current && epoch === settingsEpoch.current) {
      const previous = savedSettings.current;
      const currentSettings = editable(next.settings);
      savedSettings.current = currentSettings;
      setStatus(next);
      setForm((current) => !current || (previous && JSON.stringify(current) === JSON.stringify(previous)) ? currentSettings : current);
      if (next.authorization.status !== 'authorizing') {
        setAuthUrl('');
        sawPermissionsStage.current = false;
      } else {
        if (next.authorization.stage === 'permissions') sawPermissionsStage.current = true;
        if (next.authorization.authorizationUrl) {
          const checked = authorizationUrl(next.authorization.authorizationUrl);
          if (!sawPermissionsStage.current && !openedAuthorization.current) {
            openedAuthorization.current = checked;
          }
          setAuthUrl(checked);
        }
      }
    }
    return next;
  }, []);

  useEffect(() => {
    alive.current = true;
    refresh().catch((caught) => { if (alive.current) setError(asError(caught).message); })
      .finally(() => { if (alive.current) setBusy(''); });
    const timer = window.setInterval(() => {
      if (document.hidden || refreshing.current) return;
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
  const permissions = status?.permissions;
  const capabilities = permissions?.capabilities ?? [];
  const cap = (id: FeishuCapabilityId) => capabilities.find((item) => item.id === id);
  const enabledCapCount = capabilities.filter((item) => item.status === 'enabled').length;
  const readyCapCount = capabilities.filter((item) => item.status === 'ready_to_confirm').length;
  const pendingApprovalCount = capabilities.filter((item) => item.status === 'pending_approval').length;
  const groupReplyCap = cap('group_reply');
  const p2pReplyCap = cap('p2p_reply');
  const chatListCap = cap('chat_list');
  const notifications = permissions?.notifications ?? [];
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
    sawPermissionsStage.current = !accountOnly;
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
  const checkPermissions = () => action('check-permissions', async () => {
    if (dirty) await saveSettings();
    if (!alive.current) return;
    const next = await execute<FeishuStatus>('check_feishu_permissions');
    if (!alive.current) return;
    setStatus(next);
    const ready = (next.permissions?.capabilities ?? []).filter((item) => item.status === 'ready_to_confirm');
    setNotice(ready.length ? `检测到 ${ready.length} 项功能已获批，点击「确认已获批权限」即可开启。` : '已同步飞书最新审批状态。');
  });
  const dismissNotification = (id: string) => action(`dismiss-${id}`, async () => {
    const next = await execute<FeishuStatus>('dismiss_feishu_notification', { id });
    if (alive.current) setStatus(next);
  });

  useEffect(() => {
    // App permission confirmation completes in the backend, even if this dialog
    // was closed. Open the personal consent page when that next stage is ready.
    if (!sawPermissionsStage.current || !authUrl || status?.authorization.stage !== 'account' || openedAuthorization.current === authUrl) return;
    openedAuthorization.current = authUrl;
    sawPermissionsStage.current = false;
    void openAuthorization(authUrl).catch((caught) => { if (alive.current) setError(asError(caught).message); });
  }, [authUrl, status?.authorization.stage]);

  const hasSavedCreds = Boolean(status?.settings.appId && status?.settings.hasAppSecret && !appChanged);
  const showCredsInline = !hasSavedCreds;
  const credsBlock = status && form ? <>
    <label className="field-label spaced" htmlFor="feishu-app-id">App ID</label><input id="feishu-app-id" value={form.appId} onChange={(event) => patch({ appId: event.target.value })} placeholder="cli_…" spellCheck={false} autoComplete="off" disabled={!!busy} />
    <label className="field-label spaced" htmlFor="feishu-app-secret">App Secret <span>{status.settings.hasAppSecret && !appChanged ? '本机已保存' : '不随备份导出'}</span></label><input id="feishu-app-secret" type="password" value={secret} onChange={(event) => { setSecret(event.target.value); setError(''); setNotice(''); }} placeholder={status.settings.hasAppSecret && !appChanged ? '留空保留已保存的密钥' : '输入应用密钥'} autoComplete="new-password" spellCheck={false} disabled={!!busy} />
    {appChanged && <p className="field-hint">保存后会清除旧密钥与授权，请填写新密钥并重新授权。</p>}
    <label className="field-label spaced" htmlFor="feishu-redirect-uri">回调地址</label><div className="feishu-copy-field"><input id="feishu-redirect-uri" readOnly value={status.settings.redirectUri} onFocus={(event) => event.target.select()} /><button type="button" className="icon-button" aria-label="复制回调地址" title="复制回调地址" disabled={!!busy} onClick={() => void copy(status.settings.redirectUri)}><Copy size={15} /></button></div>
    <p className="field-hint">复制到飞书应用的「安全设置 → 重定向 URL」。授权时保持本应用运行。</p>
  </> : null;

  return <Dialog title="飞书个人助理" subtitle="根据项目记录，替你回复群内 @提问和指定同事的私聊。" close={close} busy={!!busy} dirty={dirty} wide>
    {busy === 'load' ? <div className="dialog-body settings-loading"><Spinner />正在读取飞书连接…</div> : !form || !status ? <div className="dialog-body"><div className="form-error" role="alert"><CircleAlert size={17} /><p>{error || '暂时无法读取飞书设置。'}</p></div><button className="button secondary settings-reload" onClick={() => void action('reload', async () => { await refresh(); })}>{busy ? <Spinner /> : <RefreshCw size={15} />}重新读取</button></div> : <form onSubmit={save}>
      <div className="feishu-overview"><div className="feishu-identity"><span className={`settings-status-dot ${connected ? 'ready' : ''}`} /><strong>{AUTH_LABELS[status.authorization.status]}</strong>{status.authorization.user && <span>{status.authorization.user.name || status.authorization.user.openId}</span>}{connected && capabilities.length > 0 && <span>· 已开启 {enabledCapCount}/{capabilities.length} 项能力</span>}</div><span className="feishu-run-status">{status.runtime.polling ? <><Spinner />正在检查消息</> : readyCapCount > 0 ? `${readyCapCount} 项新权限已获批待确认` : !status.settings.enabled ? '自动回复已关闭' : !connected ? '等待账号授权' : !savedBindings ? '等待绑定会话' : '自动回复已开启'}</span></div>
      <div className="feishu-tabs" role="tablist" aria-label="飞书个人助理设置" onKeyDown={navigateTabs}>{([
        ['connection', '连接账号'], ['bindings', '自动回复'], ['preview', '回答预览'],
      ] as const).map(([value, label]) => <button type="button" key={value} role="tab" tabIndex={tab === value ? 0 : -1} aria-selected={tab === value} aria-controls={`feishu-panel-${value}`} id={`feishu-tab-${value}`} className={tab === value ? 'selected' : ''} onClick={() => setTab(value)}>{label}</button>)}</div>
      <div className="dialog-body feishu-body" role="tabpanel" id={`feishu-panel-${tab}`} aria-labelledby={`feishu-tab-${tab}`}>
        {notifications.map((item) => <div key={item.id} className={`feishu-permission-notice ${item.kind === 'approval_ready' ? 'is-ready' : 'is-unlocked'}`} role="status">
          <div className="feishu-permission-notice-body"><strong>{item.title}</strong><span>{item.message}</span></div>
          <div className="feishu-permission-notice-actions">
            {item.kind === 'approval_ready' && <button type="button" className="button primary compact" disabled={!!busy} onClick={() => void authorize(true)}>一键确认</button>}
            <button type="button" className="icon-button small" aria-label="关闭通知" disabled={!!busy} onClick={() => void dismissNotification(item.id)}><X size={14} /></button>
          </div>
        </div>)}
        {tab === 'connection' && <>
          <div className="feishu-section-heading"><h3>1. 填写应用凭据</h3><button type="button" className="text-button tiny" onClick={() => void openExternalUrl('https://open.feishu.cn/app')}>飞书开放平台 <ExternalLink size={12} /></button></div>
          <p className="field-hint">首次连接会申请所需权限并按实际审批进度逐项开启；企业审批中功能会先暂缓，获批后自动提醒启用。</p>
          {showCredsInline ? credsBlock : (
            <details className="advanced-settings">
              <summary>应用凭据与回调地址（已配置）</summary>
              <div>{credsBlock}</div>
            </details>
          )}
          <details className="feishu-permissions"><summary>将申请哪些权限（按已获批项分级开启）</summary><p>包含群消息与私聊读取、群列表读取、以你的身份回复以及读取关联文档，按应用当前已获批范围授权，不会因单项还在审批而卡住整体连接。</p><p>应用后台会每分钟检查审批进度，有新权限获批后会立刻提醒你一键确认。</p><button type="button" className="text-button tiny" disabled={!!busy || dirty || !status.settings.appId || !status.settings.hasAppSecret || status.authorization.stage === 'permissions'} onClick={() => void authorize(true)}>仅按当前已获批权限进行个人授权</button></details>
          <div className="feishu-section-heading feishu-section-spaced"><h3>2. 连接个人账号</h3></div>
          <p className="field-hint">点击连接后在飞书页面确认授权；已获批的能力立即生效，待审批能力获批后再一键启用。</p>
          <div className="feishu-authorization-actions">{readyCapCount > 0 && <button type="button" className="button primary" disabled={!!busy || !form.appId.trim() || (!secret.trim() && (!status.settings.hasAppSecret || appChanged))} onClick={() => void authorize(true)}>{busy === 'authorize' ? <Spinner /> : <ShieldCheck size={15} />}确认已获批权限并开启（{readyCapCount} 项）</button>}<button type="button" className="button secondary" disabled={!!busy || !form.appId.trim() || (!secret.trim() && (!status.settings.hasAppSecret || appChanged)) || !!bindingError || !intervalValid} onClick={() => void authorize()}>{busy === 'authorize' ? <Spinner /> : <Link2 size={15} />}{status.authorization.status === 'authorizing' ? '继续飞书授权' : connected ? (pendingApprovalCount > 0 ? '重新申请待批权限并连接' : '补充权限并重新连接') : '自动申请全部权限并连接'}</button>{status.authorization.status !== 'disconnected' && <button type="button" className="text-button" disabled={!!busy} onClick={() => void action('disconnect', async () => { await execute('disconnect_feishu'); setAuthUrl(''); await refresh(); setNotice('个人授权已断开，自动回复已停止。'); })}><Unplug size={13} />断开授权</button>}</div>
          {dirty && <p className="field-hint">点击连接会先保存当前设置。</p>}
          {status.authorization.stage === 'permissions' && <p className="field-hint" role="status">等待飞书权限确认，完成后会自动打开个人授权页面。</p>}
          {status.runtime.lastError && <div className="form-error" role="alert"><CircleAlert size={17} /><p>{status.runtime.lastError}</p></div>}
          {authUrl && <div className="feishu-authorization-link"><label className="field-label" htmlFor="feishu-authorization-url">等待浏览器授权</label><div className="feishu-copy-field"><input id="feishu-authorization-url" readOnly value={authUrl} onFocus={(event) => event.target.select()} /><button type="button" className="icon-button" title="复制授权链接" aria-label="复制授权链接" disabled={!!busy} onClick={() => void copy(authUrl)}><Copy size={15} /></button></div><button type="button" className="text-button tiny" disabled={!!busy} onClick={() => void action('open', () => openAuthorization(authUrl))}>重新打开授权页面 <ExternalLink size={12} /></button><p className="field-hint">授权完成后，账号状态和已开启功能会自动更新。</p></div>}
          {capabilities.length > 0 && (
            <details className="advanced-settings" open={!connected || readyCapCount > 0 || pendingApprovalCount > 0}>
              <summary>功能权限状态（已开启 {enabledCapCount}/{capabilities.length} 项）</summary>
              <div>
                <div className="feishu-section-heading feishu-section-spaced"><span className="field-hint">{permissions?.lastCheckedAt ? `上次检查：${displayTime(permissions.lastCheckedAt)}` : '点击右侧同步最新审批进度'}{permissions?.lastCheckError ? `（上次查询失败：${permissions.lastCheckError}）` : ''}</span><button type="button" className="text-button tiny" disabled={!!busy || !form.appId.trim() || (!secret.trim() && (!status.settings.hasAppSecret || appChanged))} onClick={() => void checkPermissions()}>{busy === 'check-permissions' ? <Spinner /> : <RefreshCw size={12} />}检查审批状态</button></div>
                <div className="feishu-cap-list">{capabilities.map((item) => <div key={item.id} className="feishu-cap-item">
                  <div className="feishu-cap-info">
                    <strong>{item.label}</strong>
                    <p>{item.description}</p>
                    {item.status === 'pending_approval' && item.pendingApprovalScopes.length > 0 && <p>等待企业审批：<code>{item.pendingApprovalScopes.join(', ')}</code></p>}
                    {item.status === 'ready_to_confirm' && <p>应用侧已获批，点击上方「确认已获批权限并开启」后立即可用。</p>}
                    {item.status === 'unavailable' && item.missingScopes.length > 0 && <p>尚需权限：<code>{item.missingScopes.join(', ')}</code></p>}
                  </div>
                  <span className={`feishu-cap-badge ${item.status}`}>{CAP_STATE_LABELS[item.status]}</span>
                </div>)}</div>
              </div>
            </details>
          )}
        </>}
        {tab === 'bindings' && <>
          <div className="feishu-section-heading"><h3>选择回复的群与项目</h3><button type="button" className="text-button tiny" disabled={!!busy || !connected || (chatListCap && chatListCap.status !== 'enabled')} onClick={() => void action('chats', async () => { const result = await execute<{ chats: Array<{ chatId: string; name: string }> }>('list_feishu_chats'); setChats(result.chats); setNotice(result.chats.length ? '已读取群列表，可直接选择群或填写群编号。' : '没有找到可用群，可手动填写群编号。'); })}>{busy === 'chats' ? <Spinner /> : <RefreshCw size={12} />}读取群列表</button></div>
          {connected && groupReplyCap && groupReplyCap.status !== 'enabled' && <div className="feishu-permission-notice" role="status">
            <div className="feishu-permission-notice-body"><strong>群聊自动代答暂未开启（{CAP_STATE_LABELS[groupReplyCap.status]}）</strong><span>缺少权限：{groupReplyCap.missingScopes.join('、')}。你可以先配置并勾选群绑定，权限获批并确认后会自动恢复运行。</span></div>
            <div className="feishu-permission-notice-actions">{groupReplyCap.status === 'ready_to_confirm' ? <button type="button" className="button primary compact" disabled={!!busy} onClick={() => void authorize(true)}>一键确认</button> : <button type="button" className="text-button tiny" onClick={() => setTab('connection')}>查看权限</button>}</div>
          </div>}
          {connected && chatListCap && chatListCap.status !== 'enabled' && <p className="field-hint">尚未获得读取群列表权限，暂无法自动拉取列表，可直接填写群编号（oc_…）。</p>}
          <p className="field-hint">仅回复启用后，指定群中 @你的新消息。项目中全部已确认记忆都可能用于回答，请选择可与群成员分享的项目。</p>
          <datalist id="feishu-chat-options">{chats.map((chat) => <option key={chat.chatId} value={chat.chatId}>{chat.name}</option>)}</datalist>
          <div className="feishu-bindings">{form.bindings.filter((binding) => binding.chatType !== 'p2p').length === 0 && <div className="feishu-empty"><MessageCircle size={25} strokeWidth={1.5} /><p>还没有绑定群</p><span>添加群并选择项目，助理就能根据任务、进展、风险和项目记忆回答。</span></div>}{form.bindings.map((binding, index) => binding.chatType !== 'p2p' && <div className="feishu-binding" key={index}>
            <div className="feishu-binding-fields"><label><span className="field-label">群编号 / 名称{chats.find((chat) => chat.chatId === binding.chatId)?.name && <span> · {chats.find((chat) => chat.chatId === binding.chatId)?.name}</span>}</span><input aria-label={`第 ${index + 1} 个群 ID`} list="feishu-chat-options" value={binding.chatId} placeholder="输入群编号 oc_… 或从列表选择" onChange={(event) => updateBinding(index, { chatId: event.target.value })} disabled={!!busy} spellCheck={false} /></label><label><span className="field-label">项目</span><select aria-label={`第 ${index + 1} 个群绑定的项目`} value={binding.projectId} onChange={(event) => updateBinding(index, { projectId: event.target.value })} disabled={!!busy}><option value="">选择项目</option>{projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label></div>
            <div className="feishu-binding-actions"><label className="settings-check"><input type="checkbox" checked={binding.enabled} onChange={(event) => updateBinding(index, { enabled: event.target.checked })} disabled={!!busy} /><span>在此群回复</span></label><button type="button" className="icon-button small" title="移除群绑定" aria-label={`移除第 ${index + 1} 个群绑定`} disabled={!!busy} onClick={() => patch({ bindings: form.bindings.filter((_, position) => position !== index) })}><Trash2 size={14} /></button></div>
          </div>)}</div>
          <button type="button" className="button secondary compact" disabled={!!busy || !projects.length} onClick={() => patch({ bindings: [...form.bindings, { chatId: '', projectId: projects[0]?.id ?? '', enabled: true }] })}><Plus size={14} />添加群</button>
          <div className="feishu-section-heading feishu-section-spaced"><h3>自动回复同事私聊</h3><button type="button" className="text-button tiny" disabled={!!busy || !connected || appChanged || !!secret.trim() || (p2pReplyCap && p2pReplyCap.status !== 'enabled')} onClick={() => void action('private-chats', async () => {
            const result = await execute<{ chats: FeishuPrivateChat[]; hasMore: boolean }>('list_feishu_private_chats');
            setPrivateChats(result.chats);
            setNotice(result.chats.length ? `已读取 ${result.chats.length} 个最近私聊。${result.hasMore ? '仅展示最近 500 条消息涉及的会话，也可手动填写。' : ''}` : '最近 30 天没有可读取的私聊，可手动填写会话 ID 和同事 Open ID。');
          })}>{busy === 'private-chats' ? <Spinner /> : <RefreshCw size={12} />}读取最近私聊</button></div>
          {connected && p2pReplyCap && p2pReplyCap.status !== 'enabled' && <div className="feishu-permission-notice" role="status">
            <div className="feishu-permission-notice-body"><strong>同事私聊自动代答暂未开启（{CAP_STATE_LABELS[p2pReplyCap.status]}）</strong><span>缺少权限：{p2pReplyCap.missingScopes.join('、')}。不影响已开启的群聊代答或文档同步，权限获批并确认后会自动恢复。</span></div>
            <div className="feishu-permission-notice-actions">{p2pReplyCap.status === 'ready_to_confirm' ? <button type="button" className="button primary compact" disabled={!!busy} onClick={() => void authorize(true)}>一键确认</button> : <button type="button" className="text-button tiny" onClick={() => setTab('connection')}>查看权限</button>}</div>
          </div>}
          <p className="field-hint">仅回复已启用同事发来的新文字、富文本消息，无需 @你。每个私聊绑定一个项目，该项目的任务、进展、风险和已确认记忆都可能用于回答。首次使用请等待私聊读取权限获批并确认授权。</p>
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
