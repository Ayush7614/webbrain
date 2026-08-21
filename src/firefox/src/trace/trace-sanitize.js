/**
 * Trace sanitization — redact secrets before persisting to IndexedDB.
 *
 * The trace recorder is opt-in but, when enabled, persists user messages,
 * tool arguments, and tool results verbatim into IndexedDB. Those payloads
 * can contain credentials the user typed (passwords, API keys, tokens) or
 * page-derived secrets that the model echoed. The privacy contract promises
 * that traces are local-only, but a stolen device or a shared trace export
 * should not leak the raw secret.
 *
 * This module is pure JS (no chrome.*) so it can be unit-tested under Node
 * and shared between Chrome and Firefox builds. It redacts conservatively:
 * false positives hide a value behind [REDACTED]; false negatives leak a
 * secret. We tune for recall over precision.
 */

const SENSITIVE_KEY_RE = /password|passwd|pwd|secret|token|api[-_\s]?key|otp|2fa|mfa|credential|private[-_\s]?key|seed[-_\s]?phrase|passphrase|authorization|bearer|session|cookie/i;

// Token-shaped values that should be redacted even without a sensitive key.
const TOKEN_VALUE_RE = new RegExp(
  [
    'sk-[A-Za-z0-9]{20,}',
    'sk-proj-[A-Za-z0-9\\-_]{20,}',
    'ghp_[A-Za-z0-9]{30,}',
    'gho_[A-Za-z0-9]{30,}',
    'github_pat_[A-Za-z0-9_]{80,}',
    'AKIA[A-Z0-9]{16}',
    'eyJ[A-Za-z0-9\\-_]+\\.[A-Za-z0-9\\-_]+\\.[A-Za-z0-9\\-_\\.]+',
    'Bearer\\s+[A-Za-z0-9\\-_\\.\\=]{20,}',
  ].join('|'),
  'gi',
);

const LONG_SECRET_RE = /\b[A-Za-z0-9_\-]{32,}\b/g;

function scrubString(value) {
  if (typeof value !== 'string') return value;
  let out = value;
  out = out.replace(TOKEN_VALUE_RE, '[REDACTED]');
  // Redact long random-looking tokens that are likely secrets but not caught
  // by the specific patterns above. Only when the string is short enough to
  // be a token, not when it is a full accessibility tree.
  if (out.length < 500 && LONG_SECRET_RE.test(out)) {
    // Re-test to find the actual long token candidates
    LONG_SECRET_RE.lastIndex = 0;
    const matches = [...out.matchAll(LONG_SECRET_RE)];
    for (const m of matches) {
      const candidate = m[0];
      // Heuristic: high entropy (mix of upper/lower/digit) and not plain English.
      const hasUpper = /[A-Z]/.test(candidate);
      const hasLower = /[a-z]/.test(candidate);
      const hasDigit = /[0-9]/.test(candidate);
      if ((hasUpper && hasLower && hasDigit) || candidate.length >= 40) {
        out = out.split(candidate).join('[REDACTED]');
      }
    }
  }
  return out;
}

function isSensitiveKey(key) {
  return SENSITIVE_KEY_RE.test(String(key || ''));
}

export function scrubTraceValue(value, depth = 0) {
  if (depth > 6) return '[truncated]';
  if (value == null) return value;
  if (typeof value === 'string') {
    return scrubString(value);
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) {
    return value.slice(0, 50).map(entry => scrubTraceValue(entry, depth + 1));
  }
  if (typeof value === 'object') {
    const out = {};
    for (const [key, val] of Object.entries(value).slice(0, 50)) {
      if (isSensitiveKey(key)) {
        out[key] = '[REDACTED]';
      } else if (typeof val === 'string' && isSensitiveKey(key)) {
        out[key] = '[REDACTED]';
      } else {
        out[key] = scrubTraceValue(val, depth + 1);
      }
    }
    return out;
  }
  return value;
}

export function scrubTraceString(value) {
  if (value == null) return value;
  return scrubString(String(value));
}
