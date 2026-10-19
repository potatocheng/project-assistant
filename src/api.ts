import { invoke } from '@tauri-apps/api/core';
import type { FileInput } from './types';

const bridgeValue = import.meta.env.VITE_QA_BRIDGE_URL as string | undefined;
const bridge = bridgeValue?.replace(/\/$/, '');

export class AppError extends Error {
  code: string;
  constructor(message: string, code = 'UNKNOWN') { super(message); this.name = 'AppError'; this.code = code; }
}

export function asError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  if (error instanceof Error) return new AppError(error.message);
  if (typeof error === 'string') {
    try { return asError(JSON.parse(error)); } catch { return new AppError(error); }
  }
  if (typeof error === 'object' && error !== null && 'message' in error) {
    const value = error as { message: unknown; code?: unknown };
    return new AppError(String(value.message), String(value.code ?? 'UNKNOWN'));
  }
  return new AppError('操作未完成，请重试。');
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
      const data: unknown = await response.json();
      if (!response.ok) throw asError(data);
      return data as T;
    }
    throw new AppError('请从桌面应用打开工作区。浏览器预览需要连接本机开发适配器。', 'DESKTOP_REQUIRED');
  } catch (error) { throw asError(error); }
}

export async function readFile(file: File, limitMiB = 10): Promise<FileInput> {
  if (file.size > limitMiB * 1024 * 1024) throw new AppError(`文件超过 ${limitMiB} MiB，请选择较小的文件。`, 'FILE_TOO_LARGE');
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

export async function exportBackup(backupId: string, filename: string): Promise<boolean> {
  try {
    if ('__TAURI_INTERNALS__' in window) {
      const result = await invoke<{ cancelled?: boolean }>('export_backup', { backupId });
      return !result.cancelled;
    }
    if (import.meta.env.DEV && bridge) {
      const response = await fetch(`${checkedBridge()}/backups/${encodeURIComponent(backupId)}/download`);
      if (!response.ok) throw asError(await response.json());
      const objectUrl = URL.createObjectURL(await response.blob());
      const anchor = document.createElement('a');
      anchor.href = objectUrl; anchor.download = filename; anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
      return true;
    }
    throw new AppError('请从桌面应用打开备份中心。浏览器导出仅在本机开发预览中可用。', 'DESKTOP_REQUIRED');
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
      if (!response.ok) throw asError(await response.json());
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
