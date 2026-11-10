import DOMPurify from 'dompurify';

export interface SanitizeOptions {
  /** When false (default) remote images are stripped and reported. */
  allowRemoteImages?: boolean;
}

export interface SanitizedMail {
  html: string;
  /** Number of remote images that were withheld. */
  blockedImages: number;
}

const REMOTE_PROTOCOL = /^(https?:)?\/\//i;
const ALLOWED_IMAGE_PROTOCOL = /^(data:image\/|cid:|blob:)/i;

/**
 * Sanitizes untrusted e-mail HTML. Scripts, frames, forms and event handlers
 * are removed by DOMPurify; remote images are withheld until the user opts in
 * so opening a message cannot leak a read receipt to the sender.
 */
export function sanitizeMailHtml(raw: string, options: SanitizeOptions = {}): SanitizedMail {
  const allowRemoteImages = options.allowRemoteImages === true;
  if (!raw) return { html: '', blockedImages: 0 };

  const clean = DOMPurify.sanitize(raw, {
    USE_PROFILES: { html: true },
    FORBID_TAGS: [
      'script',
      'style',
      'iframe',
      'frame',
      'object',
      'embed',
      'form',
      'input',
      'button',
      'textarea',
      'select',
      'link',
      'meta',
      'base',
      'video',
      'audio',
      'source',
      'track',
    ],
    FORBID_ATTR: ['srcset', 'formaction', 'action', 'ping', 'background', 'lowsrc'],
    ALLOW_DATA_ATTR: false,
  });

  // DOMPurify removed the dangerous markup, so re-parsing the result is safe.
  const template = document.createElement('template');
  template.innerHTML = clean;

  let blockedImages = 0;

  // Legacy fetch-capable attributes (table/td `background`, img `lowsrc`) can
  // still trigger a remote request. Strip them even if the sanitizer profile
  // decided to keep them.
  template.content.querySelectorAll('[background], [lowsrc]').forEach(el => {
    el.removeAttribute('background');
    el.removeAttribute('lowsrc');
  });

  template.content.querySelectorAll('img').forEach(img => {
    const src = img.getAttribute('src') ?? '';
    if (!src) {
      img.remove();
      return;
    }

    if (REMOTE_PROTOCOL.test(src) || !ALLOWED_IMAGE_PROTOCOL.test(src)) {
      if (!allowRemoteImages) {
        // Keep no live URL that the browser could fetch. The original source is
        // deliberately not preserved anywhere.
        img.removeAttribute('src');
        img.removeAttribute('data-blocked-src');
        img.setAttribute('alt', img.getAttribute('alt') || '已阻止加载的远程图片');
        img.setAttribute('data-remote-blocked', '1');
        blockedImages += 1;
      }
    }
  });

  if (!allowRemoteImages) {
    // Any CSS resource reference can phone home (background-image,
    // list-style-image, cursor, border-image, …): drop those declarations.
    template.content.querySelectorAll<HTMLElement>('[style]').forEach(el => {
      const style = el.getAttribute('style') ?? '';
      if (!/url\s*\(/i.test(style)) return;
      const cleaned = style
        .split(';')
        .filter(declaration => !/url\s*\(/i.test(declaration))
        .join(';')
        .trim();
      if (cleaned) {
        el.setAttribute('style', cleaned);
      } else {
        el.removeAttribute('style');
      }
    });
  }

  template.content.querySelectorAll('a').forEach(anchor => {
    anchor.setAttribute('target', '_blank');
    anchor.setAttribute('rel', 'noopener noreferrer nofollow');
  });

  return { html: template.innerHTML, blockedImages };
}

/** Sanitizer for content that is copied into the compose editor. */
export function sanitizeComposeHtml(raw: string): string {
  return sanitizeMailHtml(raw, { allowRemoteImages: false }).html;
}
