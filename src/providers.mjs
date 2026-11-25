/**
 * mvu-seedfuzz · Zero-dependency LLM API clients (OpenAI-compatible & Google Gemini REST)
 */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Call an OpenAI-compatible Chat Completions endpoint or Google Gemini generateContent endpoint.
 * Auto-detects Gemini native endpoint when URL includes `generativelanguage.googleapis.com` and `generateContent`.
 */
export async function callLLM({ apiUrl, apiKey, model, prompt, temperature = 0.2, retries = 2 }) {
  if (!apiUrl) throw new Error('Missing apiUrl (--api-url or FUZZ_API_URL)');
  const isGeminiNative = /generativelanguage\.googleapis\.com/i.test(apiUrl) && /generateContent/i.test(apiUrl);

  let lastErr = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
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
        return parts.map((p) => p.text || '').join('');
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
      return data?.choices?.[0]?.message?.content || '';
    } catch (err) {
      lastErr = err;
      if (attempt < retries) await sleep(800 * (attempt + 1));
    }
  }
  throw lastErr;
}
