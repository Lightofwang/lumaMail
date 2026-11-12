import { format, isToday, isYesterday, isThisWeek, parseISO } from 'date-fns';
import { zhCN } from 'date-fns/locale';

export function formatMessageTime(timestamp: string): string {
  const date = parseISO(timestamp);
  if (isToday(date)) {
    return format(date, 'HH:mm');
  }
  if (isYesterday(date)) {
    return '昨天';
  }
  if (isThisWeek(date)) {
    return format(date, 'EEE', { locale: zhCN });
  }
  return format(date, 'MM/dd');
}

export function formatDateGroup(timestamp: string): string {
  const date = parseISO(timestamp);
  if (isToday(date)) return '今天';
  if (isYesterday(date)) return '昨天';
  if (isThisWeek(date)) return '本周';
  return '更早';
}

export function formatFullDate(timestamp: string): string {
  const date = parseISO(timestamp);
  return format(date, 'yyyy年MM月dd日 HH:mm', { locale: zhCN });
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function getInitials(name: string): string {
  if (!name) return '?';
  // For Chinese names, take the last character
  if (/[\u4e00-\u9fa5]/.test(name)) {
    return name.slice(-1);
  }
  // For English names, take first letters of first two words
  const parts = name.split(/\s+/);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }
  return name.slice(0, 2).toUpperCase();
}

export function stripHtml(html: string): string {
  return html.replace(/<[^>]*>/g, '').replace(/&[^;]+;/g, ' ').trim();
}

export function truncate(str: string, len: number): string {
  if (str.length <= len) return str;
  return str.slice(0, len) + '...';
}

export function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}
