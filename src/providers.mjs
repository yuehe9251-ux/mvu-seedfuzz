/**
 * mvu-seedfuzz · Zero-dependency LLM API clients (OpenAI-compatible & Google Gemini REST)
 * Supports latency & multi-provider prefix-cache telemetry for A/B endpoint auditing.
 */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function normalizeUsage(rawUsage, isGeminiNative) {
  const u = rawUsage && typeof rawUsage === 'object' ? rawUsage : {};
  if (isGeminiNative) {
    return {
      promptTokens: Number(u.promptTokenCount || 0),
      completionTokens: Number(u.candidatesTokenCount || 0),
      cacheHitTokens: Number(u.cachedContentTokenCount || 0),
    };
  }
  const cacheHit = Number(
    u.prompt_cache_hit_tokens
    ?? u.prompt_tokens_details?.cached_tokens
    ?? u.cache_read_input_tokens
    ?? u.cached_tokens
    ?? 0,
  );
  return {
    promptTokens: Number(u.prompt_tokens || u.input_tokens || 0),
    completionTokens: Number(u.completion_tokens || u.output_tokens || 0),
    cacheHitTokens: Number.isFinite(cacheHit) ? cacheHit : 0,
  };
}

/**
 * Call an OpenAI-compatible Chat Completions endpoint or Google Gemini generateContent endpoint,
 * returning `{ content, elapsedMs, usage, rawUsage }`.
 */
export async function callLLMWithMeta({ apiUrl, apiKey, model, prompt, temperature = 0.2, retries = 2 }) {
  if (!apiUrl) throw new Error('Missing apiUrl (--api-url or FUZZ_API_URL)');
  const isGeminiNative = /generativelanguage\.googleapis\.com/i.test(apiUrl) && /generateContent/i.test(apiUrl);

  let lastErr = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const t0 = Date.now();
      if (isGeminiNative) {
        const sep = apiUrl.includes('?') ? '&' : '?';
        const url = apiKey && !apiUrl.includes('key=') ? `${apiUrl}${sep}key=${encodeURIComponent(apiKey)}` : apiUrl;
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
            generationConfig: { temperature },
          }),
        });
        if (!res.ok) throw new Error(`Gemini API ${res.status}: ${(await res.text().catch(() => '')).slice(0, 300)}`);
        const data = await res.json();
        const parts = data?.candidates?.[0]?.content?.parts || [];
        return {
          content: parts.map((p) => p.text || '').join(''),
          elapsedMs: Date.now() - t0,
          usage: normalizeUsage(data?.usageMetadata, true),
          rawUsage: data?.usageMetadata || {},
        };
      }

      if (!model) throw new Error('Missing model (--model or FUZZ_MODEL)');
      const res = await fetch(apiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify({
          model,
          temperature,
          messages: [{ role: 'user', content: prompt }],
        }),
      });
      if (!res.ok) throw new Error(`API ${res.status}: ${(await res.text().catch(() => '')).slice(0, 300)}`);
      const data = await res.json();
      return {
        content: data?.choices?.[0]?.message?.content || '',
        elapsedMs: Date.now() - t0,
        usage: normalizeUsage(data?.usage, false),
        rawUsage: data?.usage || {},
      };
    } catch (err) {
      lastErr = err;
      if (attempt < retries) await sleep(800 * (attempt + 1));
    }
  }
  throw lastErr;
}

/** Backwards-compatible wrapper returning only the text content string. */
export async function callLLM(opts) {
  const { content } = await callLLMWithMeta(opts);
  return content;
}
