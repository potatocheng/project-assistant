import { invoke } from '@tauri-apps/api/core';
import type { FileInput } from './types';

const bridgeValue = import.meta.env.VITE_QA_BRIDGE_URL as string | undefined;
const bridge = bridgeValue?.replace(/\/$/, '');

export class AppError extends Error {
  code: string;
  constructor(message: string, code = 'UNKNOWN') { super(message); this.name = 'AppError'; this.code = code; }
}

function humanizeMessage(raw: string, code = 'UNKNOWN'): string {
  const trimmed = raw.trim();
  if (!trimmed) return '操作未完成，请重试。';
  if (/failed to fetch|networkerror|load failed|err_connection|econnrefused/i.test(trimmed)) {
    return '暂时无法连接本机服务，请稍候重试或重启应用。';
  }
  if (/unexpected token|is not valid json|json\.parse/i.test(trimmed)) {
    return '本地服务返回格式异常，请刷新后重试。';
  }
  if (/aborterror|aborted/i.test(trimmed)) {
    return '操作已取消。';
  }
  if (/quotaexceeded|storage.*full/i.test(trimmed)) {
    return '本地缓存空间不足，请清理后重试。';
  }
  if (/clipboard|writeText/i.test(trimmed) && /[a-z]{4,}/i.test(trimmed)) {
    return '未能自动写入剪贴板，请手动选中复制。';
  }
  if (/database is locked|sqlite/i.test(trimmed)) {
    return '本机工作区正忙，请稍候重试。';
  }
  if (/permission denied/i.test(trimmed)) {
    return '没有文件读写权限，请检查目录权限或更换保存位置。';
  }
  if (/no such file or directory/i.test(trimmed)) {
    return '找不到目标文件，请确认文件未被移动或删除。';
  }
  if (code === 'HOST_UNAVAILABLE' || /rust host exited/i.test(trimmed)) {
    return '本机核心服务已断开，请刷新页面或重启应用。';
  }
  return trimmed;
}

export function asError(error: unknown): AppError {
  if (error instanceof AppError) return new AppError(humanizeMessage(error.message, error.code), error.code);
  if (error instanceof Error) {
    const msg = error.message.trim();
    if (msg.startsWith('{') && msg.endsWith('}')) {
      try { return asError(JSON.parse(msg)); } catch {}
    }
    return new AppError(humanizeMessage(msg));
  }
  if (typeof error === 'string') {
    const msg = error.trim();
    if (msg.startsWith('{')) {
      try { return asError(JSON.parse(msg)); } catch {}
    }
    return new AppError(humanizeMessage(msg));
  }
  if (typeof error === 'object' && error !== null && 'message' in error) {
    const value = error as { message: unknown; code?: unknown };
    const code = String(value.code ?? 'UNKNOWN');
    return new AppError(humanizeMessage(String(value.message), code), code);
  }
  return new AppError('操作未完成，请重试。');
}

async function parseJsonResponse(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new AppError(response.ok ? '本地服务返回格式异常，请刷新后重试。' : '本地服务暂时不可用，请稍后重试。', 'INVALID_RESPONSE');
  }
}

export async function openExternalUrl(url: string): Promise<void> {
  if (!/^https:\/\//i.test(url)) return;
  try {
    if ('__TAURI_INTERNALS__' in window) {
      await invoke('open_external_url', { url });
      return;
    }
    window.open(url, '_blank', 'noopener,noreferrer');
  } catch (error) {
    throw asError(error);
  }
}

function checkedBridge(): string {
  if (!bridge) throw new AppError('未配置本地开发连接。', 'NO_BRIDGE');
  const url = new URL(bridge);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
    throw new AppError('开发连接仅允许使用本机地址。', 'INVALID_BRIDGE');
  }
  return bridge;
}

export async function execute<T>(command: string, payload: Record<string, unknown> = {}): Promise<T> {
  try {
    if ('__TAURI_INTERNALS__' in window) {
      return await invoke<T>('execute', { request: { command, payload } });
    }
    if (import.meta.env.DEV && bridge) {
      const response = await fetch(`${checkedBridge()}/execute`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ command, payload }),
      });
      const data: unknown = await parseJsonResponse(response);
      if (!response.ok) throw asError(data);
      return data as T;
    }
    throw new AppError('请从桌面应用打开工作区。', 'DESKTOP_REQUIRED');
  } catch (error) { throw asError(error); }
}

export async function readFile(file: File, limitMB = 10): Promise<FileInput> {
  if (file.size > limitMB * 1024 * 1024) throw new AppError(`文件超过 ${limitMB} MB，请选择较小的文件。`, 'FILE_TOO_LARGE');
  if (!file.size) throw new AppError('文件为空，请重新选择。', 'EMPTY_FILE');
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new AppError('无法读取所选文件，请重新选择。', 'FILE_READ_FAILED'));
    reader.onload = () => {
      const result = String(reader.result);
      resolve({ filename: file.name, contentBase64: result.slice(result.indexOf(',') + 1) });
    };
    reader.readAsDataURL(file);
  });
}

export async function exportBackup(backupId: string, filename: string, password?: string): Promise<boolean> {
  try {
    if ('__TAURI_INTERNALS__' in window) {
      const result = await invoke<{ cancelled?: boolean }>('export_backup', { backupId, password: password || null });
      return !result.cancelled;
    }
    if (password) throw new AppError('请在桌面应用中加密导出。');
    if (import.meta.env.DEV && bridge) {
      const response = await fetch(`${checkedBridge()}/backups/${encodeURIComponent(backupId)}/download`);
      if (!response.ok) throw asError(await parseJsonResponse(response));
      const objectUrl = URL.createObjectURL(await response.blob());
      const anchor = document.createElement('a');
      anchor.href = objectUrl; anchor.download = filename; anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
      return true;
    }
    throw new AppError('请从桌面应用打开备份中心进行导出。', 'DESKTOP_REQUIRED');
  } catch (error) { throw asError(error); }
}

export async function exportReport(reportId: string, filename: string): Promise<boolean> {
  try {
    if ('__TAURI_INTERNALS__' in window) {
      const result = await invoke<{ cancelled?: boolean }>('export_report', { reportId });
      return !result.cancelled;
    }
    if (import.meta.env.DEV && bridge) {
      const response = await fetch(`${checkedBridge()}/reports/${encodeURIComponent(reportId)}/download`);
      if (!response.ok) throw asError(await parseJsonResponse(response));
      const objectUrl = URL.createObjectURL(await response.blob());
      const anchor = document.createElement('a'); anchor.href = objectUrl; anchor.download = filename; anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000); return true;
    }
    throw new AppError('请在桌面应用中导出日报。', 'DESKTOP_REQUIRED');
  } catch (error) { throw asError(error); }
}

export async function copyReport(reportId: string, content: string): Promise<void> {
  try {
    if ('__TAURI_INTERNALS__' in window) { await invoke('copy_report', { reportId }); return; }
    if (import.meta.env.DEV && bridge) { await navigator.clipboard.writeText(content); return; }
    throw new AppError('请在桌面应用中复制日报。', 'DESKTOP_REQUIRED');
  } catch (error) { throw asError(error); }
}

export async function exportCoordinationReport(reportId: string, version: number, filename: string): Promise<boolean> {
  try {
    if ('__TAURI_INTERNALS__' in window) {
      const result = await invoke<{ cancelled?: boolean }>('export_coordination_report', { reportId, version });
      return !result.cancelled;
    }
    if (import.meta.env.DEV && bridge) {
      const report = await execute<{ content: string }>('coordination_get_report', { reportId, version });
      const url = URL.createObjectURL(new Blob([report.content], { type: 'text/markdown;charset=utf-8' }));
      const anchor = document.createElement('a'); anchor.href = url; anchor.download = filename; anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000); return true;
    }
    throw new AppError('请从桌面应用导出周报。', 'DESKTOP_REQUIRED');
  } catch (error) { throw asError(error); }
}

export async function copyCoordinationReport(reportId: string, version: number, content: string): Promise<void> {
  try {
    if ('__TAURI_INTERNALS__' in window) { await invoke('copy_coordination_report', { reportId, version }); return; }
    if (import.meta.env.DEV && bridge) { await navigator.clipboard.writeText(content); return; }
    throw new AppError('请从桌面应用复制周报。', 'DESKTOP_REQUIRED');
  } catch (error) { throw asError(error); }
}

export type ExportDocumentFormat = 'docx' | 'csv' | 'json' | 'md' | 'html' | 'png_base64';

export async function exportDocument(params: {
  title: string;
  content: string;
  format: ExportDocumentFormat;
  filename: string;
}): Promise<boolean> {
  try {
    if ('__TAURI_INTERNALS__' in window) {
      const result = await invoke<{ cancelled?: boolean }>('export_document', {
        title: params.title,
        content: params.content,
        format: params.format,
        suggestedFilename: params.filename,
      });
      return !result.cancelled;
    }
    let blob: Blob;
    if (params.format === 'png_base64') {
      const raw = params.content.includes(',') ? params.content.split(',').pop() || '' : params.content;
      const bin = atob(raw);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      blob = new Blob([bytes], { type: 'image/png' });
    } else if (params.format === 'docx') {
      throw new AppError('原生 Word (.docx) 导出请在桌面端应用中使用，或在当前界面使用「复制富文本 / 存 PDF」。', 'DESKTOP_REQUIRED');
    } else if (params.format === 'csv') {
      const payload = params.content.startsWith('\uFEFF') ? params.content : `\uFEFF${params.content}`;
      blob = new Blob([payload], { type: 'text/csv;charset=utf-8' });
    } else if (params.format === 'json') {
      blob = new Blob([params.content], { type: 'application/json;charset=utf-8' });
    } else if (params.format === 'html') {
      blob = new Blob([params.content], { type: 'text/html;charset=utf-8' });
    } else {
      blob = new Blob([params.content], { type: 'text/markdown;charset=utf-8' });
    }
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = params.filename;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    return true;
  } catch (error) {
    throw asError(error);
  }
}
