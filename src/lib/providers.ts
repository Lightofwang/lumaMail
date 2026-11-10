import type { ProviderId } from '@/types';

export interface ProviderPreset {
  id: ProviderId;
  label: string;
  imapHost: string;
  imapPort: string;
  smtpHost: string;
  smtpPort: string;
  /** SMTP transport security. IMAP is always implicit TLS on port 993. */
  smtpSecurity: 'ssl' | 'starttls';
  /** Hint shown under the credential field. */
  hint?: string;
}

/** Server parameters verified in `.qoder/brief-imap-impl.md`. */
export const PROVIDERS: ProviderPreset[] = [
  {
    id: 'gmail',
    label: 'Gmail',
    imapHost: 'imap.gmail.com',
    imapPort: '993',
    smtpHost: 'smtp.gmail.com',
    smtpPort: '587',
    smtpSecurity: 'starttls',
    hint: 'Gmail 需要开启两步验证后生成「应用专用密码」，不能直接使用登录密码。',
  },
  {
    id: '126',
    label: '126 邮箱',
    imapHost: 'imap.126.com',
    imapPort: '993',
    smtpHost: 'smtp.126.com',
    smtpPort: '465',
    smtpSecurity: 'ssl',
    hint: '126 邮箱需在网页版设置中开启 IMAP/SMTP 并使用授权码。',
  },
  {
    id: '163',
    label: '163 邮箱',
    imapHost: 'imap.163.com',
    imapPort: '993',
    smtpHost: 'smtp.163.com',
    smtpPort: '465',
    smtpSecurity: 'ssl',
    hint: '163 邮箱需在网页版设置中开启 IMAP/SMTP 并使用授权码。',
  },
  {
    id: 'qq',
    label: 'QQ 邮箱',
    imapHost: 'imap.qq.com',
    imapPort: '993',
    smtpHost: 'smtp.qq.com',
    smtpPort: '465',
    smtpSecurity: 'ssl',
    hint: 'QQ 邮箱需在网页版设置中开启 IMAP/SMTP 并使用授权码。',
  },
  {
    id: 'exmail',
    label: '腾讯企业邮',
    imapHost: 'imap.exmail.qq.com',
    imapPort: '993',
    smtpHost: 'smtp.exmail.qq.com',
    smtpPort: '465',
    smtpSecurity: 'ssl',
  },
  {
    id: 'aliyun',
    label: '阿里云企业邮',
    imapHost: 'imap.qiye.aliyun.com',
    imapPort: '993',
    smtpHost: 'smtp.qiye.aliyun.com',
    smtpPort: '465',
    smtpSecurity: 'ssl',
  },
  {
    id: 'custom',
    label: '自定义 IMAP / SMTP',
    imapHost: '',
    imapPort: '993',
    smtpHost: '',
    smtpPort: '465',
    smtpSecurity: 'ssl',
  },
];

export function providerPreset(id: ProviderId): ProviderPreset {
  return PROVIDERS.find(p => p.id === id) ?? PROVIDERS[PROVIDERS.length - 1];
}

export function providerLabel(id: string): string {
  return PROVIDERS.find(p => p.id === id)?.label ?? id;
}
