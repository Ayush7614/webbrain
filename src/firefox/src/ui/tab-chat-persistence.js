export const TAB_CHAT_PREFIX = 'tabChat:';
export const TAB_CHAT_PERSIST_BUDGET = 7 * 1024 * 1024;
const TAB_CHAT_QUOTA_RETRY_BUDGET = 256 * 1024;
export const TRANSPARENT_PIXEL_PNG_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

export function stripImagePayloadsForPersist(html) {
  return String(html || '').replace(
    /data:image\/[a-z0-9.+-]+(?:;[^,]*)?;base64,[a-z0-9+/=]+/gi,
    TRANSPARENT_PIXEL_PNG_DATA_URL,
  );
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export function compactTabChatForPersist(html, budget = TAB_CHAT_PERSIST_BUDGET) {
  const boundedBudget = Math.max(1024, Math.floor(Number(budget) || TAB_CHAT_PERSIST_BUDGET));
  const stripped = stripImagePayloadsForPersist(html);
  if (stripped.length <= boundedBudget) return stripped;

  // This is the last-resort stored copy only. Keep recent readable text in
  // valid markup instead of slicing arbitrary HTML and potentially restoring
  // a broken DOM. The live in-memory transcript remains untouched.
  const plainText = stripped
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const marker = '[Earlier persisted chat content omitted to fit browser session storage.] ';
  // Entity escaping can expand a character to five bytes, so reserve a
  // conservative sixth of the available character budget for source text.
  const textBudget = Math.max(0, Math.floor((boundedBudget - 160) / 6));
  const recentText = plainText.slice(-textBudget);
  const fallback = `<div class="message system"><div class="message-text">${escapeHtml(marker + recentText)}</div></div>`;
  return fallback.slice(0, boundedBudget);
}

export async function persistTabChatToSession(storageArea, key, html, warn = console.warn) {
  const source = String(html || '');
  const initialValue = source.length > TAB_CHAT_PERSIST_BUDGET
    ? compactTabChatForPersist(source)
    : source;

  try {
    await storageArea.set({ [key]: initialValue });
    return { ok: true, degraded: initialValue !== source, recoveredFromQuota: false };
  } catch (initialError) {
    const retryValue = compactTabChatForPersist(source, TAB_CHAT_QUOTA_RETRY_BUDGET);
    let retryError = initialError;
    try {
      // The quota is shared across keys, so an individually-small chat can
      // still fail. First retry this write with a tightly bounded stored copy.
      await storageArea.set({ [key]: retryValue });
      return { ok: true, degraded: true, recoveredFromQuota: true };
    } catch (error) {
      retryError = error;
    }

    try {
      // Older per-tab chats can consume nearly the entire shared quota. Free
      // the largest stored chats one at a time and retry after each removal.
      // Removal is intentionally used instead of rewriting a stale get(null)
      // snapshot: a concurrent clear remains cleared rather than being
      // resurrected by quota recovery in another panel context.
      const stored = await storageArea.get(null);
      const candidates = Object.entries(stored || {})
        .filter(([storedKey, value]) => (
          storedKey !== key
          && storedKey.startsWith(TAB_CHAT_PREFIX)
          && typeof value === 'string'
        ))
        .sort((a, b) => b[1].length - a[1].length);
      const evictedKeys = [];

      for (const [storedKey] of candidates) {
        try {
          await storageArea.remove(storedKey);
          evictedKeys.push(storedKey);
        } catch {
          continue;
        }
        try {
          await storageArea.set({ [key]: retryValue });
          return {
            ok: true,
            degraded: true,
            recoveredFromQuota: true,
            evictedKeys,
          };
        } catch (error) {
          retryError = error;
        }
      }
    } catch (error) {
      retryError = error;
    }

    try {
      warn(
        '[WebBrain] persistTabChat: session storage write failed after compacting the stored copy; chat may not survive a panel reopen:',
        retryError?.message || retryError || initialError?.message || initialError,
      );
      return { ok: false, error: retryError || initialError };
    } catch {
      return { ok: false, error: retryError || initialError };
    }
  }
}
