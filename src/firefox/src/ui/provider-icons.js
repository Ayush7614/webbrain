/**
 * Provider brand icons for settings + sidepanel.
 *
 * Assets live in icons/providers/ (Lobe Icons MIT subset + a few official
 * marks for brands Lobe does not ship). See icons/providers/SOURCES.md.
 * Unknown ids return empty so we never invent monograms.
 */

export const PROVIDER_ICON_FILES = {
  webbrain_cloud: 'webbrain_cloud.png',
  llamacpp: 'llamacpp.svg',
  ollama: 'ollama.svg',
  lmstudio: 'lmstudio.svg',
  jan: 'jan.png',
  vllm: 'vllm.svg',
  sglang: 'sglang.png',
  localai: 'localai.png',
  azure_openai: 'azure_openai.svg',
  aws_bedrock: 'aws_bedrock.svg',
  openai: 'openai.svg',
  anthropic: 'anthropic.svg',
  gemini: 'gemini.svg',
  cloudflare: 'cloudflare.svg',
  mistral: 'mistral.svg',
  deepseek: 'deepseek.svg',
  xai: 'xai.svg',
  nvidia: 'nvidia.svg',
  groq: 'groq.svg',
  minimax: 'minimax.svg',
  kimi: 'kimi.svg',
  alibaba: 'alibaba.svg',
  together: 'together.svg',
  openrouter: 'openrouter.svg',
  huggingface: 'huggingface.svg',
  fireworks: 'fireworks.svg',
};

export function providerIconUrl(id) {
  const file = PROVIDER_ICON_FILES[id];
  if (!file) return '';
  try {
    if (typeof chrome !== 'undefined' && chrome.runtime?.getURL) {
      return chrome.runtime.getURL(`icons/providers/${file}`);
    }
  } catch { /* fall through */ }
  return `../../icons/providers/${file}`;
}

export function providerIconHtml(id, label, className = 'provider-icon') {
  const src = providerIconUrl(id);
  if (!src) return '';
  const safeSrc = String(src).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  const safeAlt = String(label || id || '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;');
  const safeClass = String(className || 'provider-icon').replace(/[^a-zA-Z0-9 _-]/g, '');
  return `<img class="${safeClass}" src="${safeSrc}" alt="${safeAlt}" width="20" height="20" decoding="async" draggable="false">`;
}

/** Short display name for a known provider id (sniff hints, menus). */
export const PROVIDER_SHORT_LABELS = {
  webbrain_cloud: 'WebBrain Cloud',
  llamacpp: 'llama.cpp',
  ollama: 'Ollama',
  lmstudio: 'LM Studio',
  jan: 'Jan',
  vllm: 'vLLM',
  sglang: 'SGLang',
  localai: 'LocalAI',
  azure_openai: 'Azure OpenAI',
  aws_bedrock: 'AWS Bedrock',
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  gemini: 'Gemini',
  cloudflare: 'Cloudflare',
  mistral: 'Mistral',
  deepseek: 'DeepSeek',
  xai: 'xAI',
  nvidia: 'NVIDIA',
  groq: 'Groq',
  minimax: 'MiniMax',
  kimi: 'Kimi',
  alibaba: 'Qwen',
  together: 'Together',
  openrouter: 'OpenRouter',
  huggingface: 'Hugging Face',
  fireworks: 'Fireworks',
};

/**
 * Best-effort provider id from an OpenAI-compatible base URL.
 * Used by Multimodal settings to show a brand mark when the user pastes
 * a known endpoint — not a security boundary, just a UX hint.
 */
export function sniffProviderIdFromBaseUrl(baseUrl) {
  const raw = String(baseUrl || '').trim().toLowerCase();
  if (!raw) return '';
  let host = '';
  let port = '';
  try {
    const u = new URL(raw.includes('://') ? raw : `http://${raw}`);
    host = u.hostname || '';
    port = u.port || '';
  } catch {
    // Fall through with substring matching on the raw string.
  }
  const hay = `${host} ${raw}`;

  if (host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0' || host.endsWith('.local')) {
    if (port === '11434' || hay.includes(':11434')) return 'ollama';
    if (port === '1234' || hay.includes(':1234')) return 'lmstudio';
    if (port === '1337' || hay.includes(':1337')) return 'jan';
    if (port === '30000' || hay.includes(':30000')) return 'sglang';
    if (port === '8000' || hay.includes(':8000')) return 'vllm';
    if (port === '8080' || hay.includes(':8080')) return 'llamacpp';
    return '';
  }

  if (hay.includes('openrouter.ai')) return 'openrouter';
  if (hay.includes('api.openai.com') || host === 'openai.com' || host.endsWith('.openai.com')) return 'openai';
  if (hay.includes('anthropic.com')) return 'anthropic';
  if (hay.includes('generativelanguage.googleapis') || (hay.includes('googleapis.com') && hay.includes('gemini'))) return 'gemini';
  if (hay.includes('api.x.ai') || host === 'x.ai' || host.endsWith('.x.ai')) return 'xai';
  if (hay.includes('groq.com')) return 'groq';
  if (hay.includes('mistral.ai')) return 'mistral';
  if (hay.includes('deepseek.com')) return 'deepseek';
  if (hay.includes('fireworks.ai')) return 'fireworks';
  if (hay.includes('together.xyz') || hay.includes('together.ai')) return 'together';
  if (hay.includes('huggingface.co') || hay.includes('hf.co')) return 'huggingface';
  if (hay.includes('cloudflare.com') || hay.includes('workers.dev')) return 'cloudflare';
  if (hay.includes('nvidia.com') || hay.includes('integrate.api.nvidia')) return 'nvidia';
  if (hay.includes('openai.azure.com') || (hay.includes('azure.com') && hay.includes('openai'))) return 'azure_openai';
  if (hay.includes('amazonaws.com') || hay.includes('bedrock')) return 'aws_bedrock';
  if (hay.includes('moonshot') || hay.includes('kimi.ai') || hay.includes('kimi.com')) return 'kimi';
  if (hay.includes('dashscope') || hay.includes('aliyuncs.com')) return 'alibaba';
  if (hay.includes('minimax')) return 'minimax';
  if (hay.includes('api.webbrain') || hay.includes('webbrain.one')) return 'webbrain_cloud';
  return '';
}
