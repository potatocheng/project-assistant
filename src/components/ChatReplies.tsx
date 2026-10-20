import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CircleAlert, MessageCircle, RefreshCw, Search, Settings2 } from 'lucide-react';
import { asError, execute } from '../api';
import type { FeishuMessage, FeishuStatus, Project } from '../types';
import { Spinner } from './ui';
import { formatMoment } from './work/shared';
import './chat-replies.css';

const MESSAGE_LABELS: Record<string, string> = {
  pending: '等待处理', processing: '正在生成', generating: '正在生成', answering: '正在生成', sending: '正在发送',
  replied: '已回复', sent: '已回复', succeeded: '已回复', failed: '失败', skipped: '已跳过', ignored: '已跳过',
  unknown: '发送结果待核对', send_unknown: '发送结果待核对', deferred: '稍后重试', rejected: '未发送', cancelled: '已取消',
};
const SENT = new Set(['replied', 'sent', 'succeeded']);
const ATTENTION = new Set(['failed', 'unknown', 'send_unknown', 'rejected']);
const WAITING = new Set(['pending', 'processing', 'generating', 'answering', 'sending', 'deferred']);

function outcome(message: FeishuMessage) {
  if (SENT.has(message.status)) return 'sent';
  if (ATTENTION.has(message.status)) return 'attention';
  if (WAITING.has(message.status)) return 'waiting';
  return 'skipped';
}

export function ChatReplies({ projects, projectId, onProjectChange, openSettings, refreshKey }: {
  projects: Project[]; projectId: string; onProjectChange: (value: string) => void;
  openSettings: () => void; refreshKey: number;
}) {
  const [status, setStatus] = useState<FeishuStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [channel, setChannel] = useState('all');
  const [result, setResult] = useState('all');
  const [query, setQuery] = useState('');
  const alive = useRef(true);
  const inFlight = useRef(false);

  const refresh = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const next = await execute<FeishuStatus>('get_feishu_status');
      if (alive.current) { setStatus(next); setError(''); }
    } catch (caught) {
      if (alive.current) setError(asError(caught).message);
    } finally {
      inFlight.current = false;
      if (alive.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    void refresh();
    const timer = window.setInterval(() => { void refresh(); }, 5000);
    return () => { alive.current = false; window.clearInterval(timer); };
  }, [refresh, refreshKey]);

  const messages = useMemo(() => {
    const search = query.trim().toLocaleLowerCase();
    return (status?.recentMessages ?? []).filter((message) => {
      const project = projects.find((item) => item.id === message.projectId);
      return (!projectId || message.projectId === projectId)
        && (channel === 'all' || (message.chatType === 'p2p' ? 'p2p' : 'group') === channel)
        && (result === 'all' || outcome(message) === result)
        && (!search || [message.question, message.answer, message.peerName, message.peerId,
          message.chatId, project?.name].some((value) => value?.toLocaleLowerCase().includes(search)));
    });
  }, [status, projects, projectId, channel, result, query]);

  const connected = status?.authorization.status === 'connected';
  const enabledBindings = status?.settings.bindings.some((binding) => binding.enabled);
  const canCheck = connected && status?.settings.enabled && enabledBindings;
  const checkNow = async () => {
    if (checking || status?.runtime.polling || !canCheck) return;
    setChecking(true); setError(''); setNotice('');
    try {
      await execute('poll_feishu_now');
      if (alive.current) setNotice('已安排检查新消息，处理结果会自动更新。');
      await refresh();
    } catch (caught) {
      if (alive.current) setError(asError(caught).message);
    } finally {
      if (alive.current) setChecking(false);
    }
  };

  const connectionLabel = !status ? '正在读取状态' : !connected ? '等待账号授权'
    : !status.settings.enabled ? '自动回复已关闭' : !enabledBindings ? '等待绑定会话' : '自动回复已开启';

  return <section className="chat-replies" aria-label="聊天回复记录">
    <div className="chat-replies-toolbar">
      <div className="chat-replies-connection">
        <span className={`settings-status-dot ${canCheck ? 'ready' : ''}`} />
        <strong>{connectionLabel}</strong>
        {status?.authorization.user && <span>{status.authorization.user.name || status.authorization.user.openId}</span>}
      </div>
      <div className="chat-replies-actions">
        <button className="text-button" onClick={openSettings}><Settings2 size={15} />飞书设置</button>
        <button className="button secondary compact" disabled={!canCheck || checking || status?.runtime.polling} onClick={() => void checkNow()}>
          {checking || status?.runtime.polling ? <Spinner /> : <RefreshCw size={14} />}立即检查
        </button>
      </div>
    </div>
    <div className="chat-replies-filters">
      <select aria-label="聊天回复项目" value={projectId} onChange={(event) => onProjectChange(event.target.value)}>
        <option value="">全部项目</option>{projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
      </select>
      <select aria-label="聊天类型" value={channel} onChange={(event) => setChannel(event.target.value)}>
        <option value="all">全部会话</option><option value="p2p">同事私聊</option><option value="group">群聊 @提问</option>
      </select>
      <select aria-label="回复状态" value={result} onChange={(event) => setResult(event.target.value)}>
        <option value="all">全部状态</option><option value="sent">已回复</option><option value="waiting">待处理</option>
        <option value="skipped">跳过或取消</option><option value="attention">失败或待核对</option>
      </select>
      <label className="chat-replies-search"><Search size={15} /><input aria-label="搜索聊天回复" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索提问、回复或同事…" /></label>
    </div>
    <div className="chat-replies-caption"><span>{messages.length} 条记录 · 在最近 50 条处理记录内筛选</span>
      <span>{status?.runtime.polling ? '正在检查消息' : `上次检查：${status?.runtime.lastPollAt ? formatMoment(status.runtime.lastPollAt) : '尚未检查'}`}</span>
    </div>
    {(error || status?.runtime.lastError) && <div className="chat-replies-error" role="alert"><CircleAlert size={17} /><p>{error || status?.runtime.lastError}</p><button className="text-button" onClick={() => void refresh()}>重新读取</button></div>}
    {notice && <p className="chat-replies-notice" role="status">{notice}</p>}
    <div className="chat-replies-list">
      {loading ? <div className="loading-view"><Spinner /><span>正在读取聊天回复…</span></div>
        : !status ? <div className="work-empty"><h3>暂时无法读取聊天回复</h3><button className="button secondary" onClick={() => void refresh()}>重新读取</button></div>
          : !messages.length ? <div className="chat-replies-empty"><MessageCircle size={30} strokeWidth={1.4} />
            <h2>{status.recentMessages.length ? '没有匹配的聊天回复' : '还没有聊天回复记录'}</h2>
            <p>{status.recentMessages.length ? '调整项目、会话、状态或搜索条件。' : '启用自动回复后，同事私聊与群内 @提问的处理结果会显示在这里。'}</p>
            {status.recentMessages.length ? <button className="button secondary" onClick={() => { onProjectChange(''); setChannel('all'); setResult('all'); setQuery(''); }}>清除筛选</button>
              : <button className="button secondary" onClick={openSettings}>配置飞书自动回复</button>}
          </div> : messages.map((message) => <article className="chat-reply" key={message.id} aria-label={`${message.chatType === 'p2p' ? '私聊' : '群聊'}：${message.question || '无文本提问'}`}>
            <header className="chat-reply-heading">
              <div><span className="chat-reply-channel">{message.chatType === 'p2p' ? '私聊' : '群聊'}</span>
                <strong>{message.chatType === 'p2p' ? message.peerName || message.peerId || message.chatId : message.chatId}</strong>
                <span>{projects.find((project) => project.id === message.projectId)?.name ?? '项目已移除'}</span>
              </div>
              <div><span className={`chat-reply-outcome chat-reply-${outcome(message)}`}>{MESSAGE_LABELS[message.status] ?? message.status}</span>
                <time dateTime={message.createdAt} title={`更新时间：${formatMoment(message.updatedAt)}`}>{formatMoment(message.createdAt)}</time></div>
            </header>
            <div className="chat-reply-content">
              <div className="chat-reply-question"><span>同事提问</span><p>{message.question || '无可用的文本提问'}</p></div>
              <div className="chat-reply-answer"><span>{SENT.has(message.status) ? '助理回复' : message.answer ? '已生成内容' : '处理结果'}</span>
                {message.answer ? <p>{message.answer}</p> : <p className="chat-reply-placeholder">{WAITING.has(message.status) ? (message.status === 'pending' || message.status === 'deferred' ? '等待处理，结果会自动更新。' : '正在处理，结果会自动更新。') : message.error || '未发送回复。'}</p>}
                {message.answer && !SENT.has(message.status) && <small>{message.status === 'unknown' || message.status === 'send_unknown' ? '发送结果未知，请到飞书核对。' : '尚未确认发送成功。'}</small>}
                {message.answer && message.error && <p className="chat-reply-reason">{message.error}</p>}
              </div>
            </div>
          </article>)}
    </div>
  </section>;
}
