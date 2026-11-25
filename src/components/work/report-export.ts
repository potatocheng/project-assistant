import { exportDocument } from '../../api';
import { TASK_CATEGORY, TASK_PRIORITY, TASK_STATUS } from '../../types';
import type { Project, Task } from '../../types';

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function inlineMarkdownToHtml(text: string): string {
  return escapeHtml(text)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code style="background:#f0f2f4;color:#1d2733;padding:1px 4px;border-radius:3px;">$1</code>');
}

export function markdownToCleanHtml(title: string, subtitle: string, markdown: string): string {
  const lines = markdown.split(/\r?\n/);
  const parts: string[] = [];
  let inList = false;
  let inTable = false;

  const closeList = () => {
    if (inList) {
      parts.push('</ul>');
      inList = false;
    }
  };
  const closeTable = () => {
    if (inTable) {
      parts.push('</tbody></table>');
      inTable = false;
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed) {
      closeList();
      closeTable();
      continue;
    }
    if (trimmed.includes('|') && i + 1 < lines.length && /^\|?[\s:|-]+\|[\s:|-]*$/.test(lines[i + 1].trim())) {
      closeList();
      const headers = trimmed.replace(/^\||\|$/g, '').split('|').map(c => c.trim());
      parts.push('<table style="border-collapse:collapse;width:100%;margin:10px 0;font-size:13px;"><thead><tr>');
      headers.forEach(h => {
        parts.push(`<th style="border:1px solid #d5dade;background:#e1e6ec;padding:6px 10px;text-align:left;color:#1d2733;">${inlineMarkdownToHtml(h)}</th>`);
      });
      parts.push('</tr></thead><tbody>');
      inTable = true;
      i += 1;
      continue;
    }
    if (inTable && trimmed.includes('|')) {
      const cells = trimmed.replace(/^\||\|$/g, '').split('|').map(c => c.trim());
      parts.push('<tr>');
      cells.forEach(c => {
        parts.push(`<td style="border:1px solid #d5dade;padding:6px 10px;color:#161a1e;">${inlineMarkdownToHtml(c)}</td>`);
      });
      parts.push('</tr>');
      continue;
    }
    closeTable();

    if (trimmed.startsWith('### ')) {
      closeList();
      parts.push(`<h3 style="margin:14px 0 6px;font-size:15px;color:#161a1e;">${inlineMarkdownToHtml(trimmed.slice(4))}</h3>`);
    } else if (trimmed.startsWith('## ')) {
      closeList();
      parts.push(`<h2 style="margin:18px 0 8px;font-size:17px;color:#1d2733;border-bottom:1px solid #d5dade;padding-bottom:4px;">${inlineMarkdownToHtml(trimmed.slice(3))}</h2>`);
    } else if (trimmed.startsWith('# ')) {
      closeList();
      parts.push(`<h1 style="margin:20px 0 10px;font-size:20px;color:#161a1e;">${inlineMarkdownToHtml(trimmed.slice(2))}</h1>`);
    } else if (trimmed.startsWith('- ') || trimmed.startsWith('* ')) {
      if (!inList) {
        parts.push('<ul style="margin:6px 0;padding-left:20px;">');
        inList = true;
      }
      parts.push(`<li style="margin:4px 0;line-height:1.6;">${inlineMarkdownToHtml(trimmed.slice(2))}</li>`);
    } else if (trimmed.startsWith('> ')) {
      closeList();
      parts.push(`<blockquote style="margin:8px 0;padding:6px 12px;border-left:3px solid #c23a22;color:#3b434a;background:#f0f2f4;">${inlineMarkdownToHtml(trimmed.slice(2))}</blockquote>`);
    } else {
      closeList();
      parts.push(`<p style="margin:6px 0;line-height:1.65;color:#161a1e;">${inlineMarkdownToHtml(trimmed)}</p>`);
    }
  }
  closeList();
  closeTable();

  return `<div style="font-family:'PingFang SC','Microsoft YaHei',sans-serif;color:#161a1e;font-size:14px;">
    <h1 style="margin:0 0 4px;font-size:21px;color:#1d2733;">${escapeHtml(title)}</h1>
    <p style="margin:0 0 16px;font-size:13px;color:#59626a;">${escapeHtml(subtitle)}</p>
    ${parts.join('\n')}
  </div>`;
}

export async function copyRichMarkdown(title: string, subtitle: string, markdown: string): Promise<'rich' | 'plain'> {
  const html = markdownToCleanHtml(title, subtitle, markdown);
  if (typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
    try {
      const item = new ClipboardItem({
        'text/html': new Blob([html], { type: 'text/html' }),
        'text/plain': new Blob([markdown], { type: 'text/plain' }),
      });
      await navigator.clipboard.write([item]);
      return 'rich';
    } catch {
      // Fall back to plain text clipboard.
    }
  }
  await navigator.clipboard.writeText(markdown);
  return 'plain';
}

export function printMarkdownAsPdf(title: string, subtitle: string, markdown: string): void {
  const html = markdownToCleanHtml(title, subtitle, markdown);
  const existing = document.getElementById('pa-print-frame') as HTMLIFrameElement | null;
  if (existing) existing.remove();

  const iframe = document.createElement('iframe');
  iframe.id = 'pa-print-frame';
  iframe.style.position = 'fixed';
  iframe.style.right = '0';
  iframe.style.bottom = '0';
  iframe.style.width = '0';
  iframe.style.height = '0';
  iframe.style.border = '0';
  document.body.appendChild(iframe);

  const doc = iframe.contentDocument;
  if (!doc) {
    window.print();
    return;
  }
  doc.open();
  doc.write(`<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<title>${escapeHtml(title)}</title>
<style>
  @page { margin: 18mm 16mm; }
  body { margin: 0; color: #111827; font-family: -apple-system, BlinkMacSystemFont, 'PingFang SC', 'Microsoft YaHei', sans-serif; }
</style>
</head>
<body>${html}</body>
</html>`);
  doc.close();
  window.setTimeout(() => {
    iframe.contentWindow?.focus();
    iframe.contentWindow?.print();
    window.setTimeout(() => iframe.remove(), 2000);
  }, 150);
}

interface CardLine {
  kind: 'h1' | 'h2' | 'bullet' | 'quote' | 'text' | 'space';
  text: string;
}

function parseCardLines(markdown: string): CardLine[] {
  const result: CardLine[] = [];
  for (const raw of markdown.split(/\r?\n/)) {
    const t = raw.trim();
    if (!t) {
      result.push({ kind: 'space', text: '' });
      continue;
    }
    const stripped = t.replace(/\*\*(.+?)\*\*/g, '$1').replace(/`([^`]+)`/g, '$1');
    if (stripped.startsWith('### ') || stripped.startsWith('## ')) {
      result.push({ kind: 'h2', text: stripped.replace(/^#{2,3}\s+/, '') });
    } else if (stripped.startsWith('# ')) {
      result.push({ kind: 'h1', text: stripped.slice(2) });
    } else if (stripped.startsWith('- ') || stripped.startsWith('* ')) {
      result.push({ kind: 'bullet', text: `•  ${stripped.slice(2)}` });
    } else if (stripped.startsWith('> ')) {
      result.push({ kind: 'quote', text: stripped.slice(2) });
    } else if (stripped.startsWith('|')) {
      if (!/^\|?[\s:|-]+\|[\s:|-]*$/.test(stripped)) {
        const row = stripped.replace(/^\||\|$/g, '').split('|').map(c => c.trim()).join('  ·  ');
        result.push({ kind: 'text', text: row });
      }
    } else {
      result.push({ kind: 'text', text: stripped });
    }
  }
  return result;
}

function wrapTextLines(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const lines: string[] = [];
  let current = '';
  for (const ch of text) {
    const test = current + ch;
    if (ctx.measureText(test).width > maxWidth && current) {
      lines.push(current);
      current = ch;
    } else {
      current = test;
    }
  }
  if (current) lines.push(current);
  return lines.length ? lines : [''];
}

export async function exportReportCardPng(opts: {
  title: string;
  subtitle: string;
  markdown: string;
  filename: string;
}): Promise<boolean> {
  const width = 840;
  const padX = 48;
  const contentWidth = width - padX * 2;
  const dpr = 2;

  const measureCanvas = document.createElement('canvas');
  const mctx = measureCanvas.getContext('2d');
  if (!mctx) throw new Error('当前环境不支持生成汇报图片。');

  const parsed = parseCardLines(opts.markdown);
  const renderList: Array<{ kind: CardLine['kind']; text: string; y: number }> = [];
  let y = 166;
  // Cap only near browser 2D canvas max height (~16000px at 2x DPR = 32000px)
  const maxContentY = 14000;

  for (const item of parsed) {
    if (y > maxContentY) break;
    if (item.kind === 'space') {
      y += 8;
      continue;
    }
    if (item.kind === 'h1' || item.kind === 'h2') {
      y += 10;
      mctx.font = item.kind === 'h1' ? '600 18px "PingFang SC","Microsoft YaHei",sans-serif' : '600 16px "PingFang SC","Microsoft YaHei",sans-serif';
      for (const line of wrapTextLines(mctx, item.text, contentWidth)) {
        renderList.push({ kind: item.kind, text: line, y });
        y += 28;
      }
      y += 2;
    } else {
      mctx.font = '400 14px "PingFang SC","Microsoft YaHei",sans-serif';
      const indent = item.kind === 'bullet' || item.kind === 'quote' ? 14 : 0;
      for (const line of wrapTextLines(mctx, item.text, contentWidth - indent)) {
        renderList.push({ kind: item.kind, text: line, y });
        y += 23;
      }
    }
  }

  const totalHeight = Math.max(380, y + 44);
  const canvas = document.createElement('canvas');
  canvas.width = width * dpr;
  canvas.height = totalHeight * dpr;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('无法初始化图片画布。');
  ctx.scale(dpr, dpr);

  // Outer mineral stone canvas
  ctx.fillStyle = '#e9ecee';
  ctx.fillRect(0, 0, width, totalHeight);

  // Main paper card
  ctx.fillStyle = '#f7f8f9';
  ctx.strokeStyle = '#d5dade';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.roundRect(20, 20, width - 40, totalHeight - 40, 12);
  ctx.fill();
  ctx.stroke();

  // Ink header banner with subtle vermilion seal hairline
  ctx.fillStyle = '#1d2733';
  ctx.beginPath();
  ctx.roundRect(20, 20, width - 40, 108, [12, 12, 0, 0]);
  ctx.fill();

  ctx.fillStyle = '#c23a22';
  ctx.fillRect(20, 126, width - 40, 3);

  ctx.fillStyle = '#f7f8f9';
  ctx.font = '700 22px "PingFang SC","Microsoft YaHei",sans-serif';
  ctx.fillText(opts.title.slice(0, 40), padX, 70);

  ctx.fillStyle = 'rgba(247,248,249,0.78)';
  ctx.font = '400 13px "PingFang SC","Microsoft YaHei",sans-serif';
  ctx.fillText(opts.subtitle.slice(0, 64), padX, 100);

  // Body lines
  for (const line of renderList) {
    if (line.kind === 'h1') {
      ctx.fillStyle = '#161a1e';
      ctx.font = '700 18px "PingFang SC","Microsoft YaHei",sans-serif';
      ctx.fillText(line.text, padX, line.y);
    } else if (line.kind === 'h2') {
      ctx.fillStyle = '#1d2733';
      ctx.font = '600 16px "PingFang SC","Microsoft YaHei",sans-serif';
      ctx.fillText(line.text, padX, line.y);
    } else if (line.kind === 'quote') {
      ctx.fillStyle = '#c23a22';
      ctx.fillRect(padX, line.y - 13, 3, 17);
      ctx.fillStyle = '#3b434a';
      ctx.font = '400 14px "PingFang SC","Microsoft YaHei",sans-serif';
      ctx.fillText(line.text, padX + 12, line.y);
    } else if (line.kind === 'bullet') {
      ctx.fillStyle = '#161a1e';
      ctx.font = '400 14px "PingFang SC","Microsoft YaHei",sans-serif';
      ctx.fillText(line.text, padX + 8, line.y);
    } else {
      ctx.fillStyle = '#3b434a';
      ctx.font = '400 14px "PingFang SC","Microsoft YaHei",sans-serif';
      ctx.fillText(line.text, padX, line.y);
    }
  }

  const dataUrl = canvas.toDataURL('image/png');
  return exportDocument({
    title: opts.title,
    content: dataUrl,
    format: 'png_base64',
    filename: opts.filename,
  });
}

function csvCell(val: string | number | null | undefined): string {
  const raw = val == null ? '' : String(val);
  // Prevent spreadsheet formula injection on opening in Excel/WPS
  const s = /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw;
  if (/[",\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

export function buildTasksCsv(tasks: Task[], projects: Project[]): string {
  const projectMap = new Map(projects.map(p => [p.id, p.name]));
  const header = ['项目', '任务标题', '状态', '优先级', '执行方式', '负责人', '进度(%)', '计划日期', '截止日期', '任务说明'];
  const rows = [header.map(csvCell).join(',')];
  for (const t of tasks) {
    rows.push(
      [
        projectMap.get(t.projectId) ?? '',
        t.title,
        TASK_STATUS[t.status] ?? t.status,
        TASK_PRIORITY[t.priority] ?? t.priority,
        TASK_CATEGORY[t.category] ?? t.category,
        t.assignee ?? '',
        t.progress,
        t.plannedDate ?? '',
        t.dueDate ?? '',
        t.description.replace(/\r?\n/g, ' '),
      ]
        .map(csvCell)
        .join(','),
    );
  }
  return `\uFEFF${rows.join('\r\n')}`;
}
