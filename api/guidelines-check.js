/**
 * Vercel Serverless Function: Daily Guideline Pulse
 *
 * Flow:
 *  1. Check Vercel KV for a cached result less than 24 hours old
 *     → If fresh: return immediately (no Gemini call, costs nothing)
 *  2. If stale/missing: call Gemini 2.0 Flash with Google Search grounding
 *     so it actually browses current NICE / MHRA / CQC pages
 *  3. Store result in KV → all nurses on all devices see the same update
 *  4. If Gemini fails: return stale KV data rather than an error
 */

const { kv } = require('@vercel/kv');

const KV_KEY      = 'nhub-guideline-pulse';
const ONE_DAY_MS  = 24 * 60 * 60 * 1000;

module.exports = async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'GEMINI_API_KEY not configured.' });
  }

  // ── 1. Check shared KV cache ────────────────────────────────────────────
  try {
    const cached = await kv.get(KV_KEY);
    if (cached?.checkedAt) {
      const ageMs = Date.now() - new Date(cached.checkedAt).getTime();
      if (ageMs < ONE_DAY_MS) {
        res.setHeader('X-Cache', 'HIT');
        return res.status(200).json(cached);
      }
    }
  } catch (e) {
    // KV unavailable — fall through to Gemini
  }

  // ── 2. Call Gemini with Google Search grounding ─────────────────────────
  const today = new Date().toLocaleDateString('en-GB', {
    day: 'numeric', month: 'long', year: 'numeric'
  });

  const prompt =
`Use Google Search to find the 6 most clinically important guideline or regulatory updates \
relevant to UK care home nursing staff, published or updated recently. Today is ${today}.

Search for recent updates from:
- NICE (nice.org.uk) — new or revised guidelines
- MHRA (gov.uk/mhra) — drug safety updates, yellow card alerts
- CQC (cqc.org.uk) — new regulatory guidance for care homes
- NHS England (england.nhs.uk) — care home nursing guidance

Respond ONLY with a valid JSON array of exactly 6 objects. Each object must have:
- "title": short headline (max 12 words)
- "body": 2–3 sentence clinical summary written for a care home nurse
- "source": specific source e.g. "NICE NG185", "MHRA Drug Safety Update May 2026", "CQC"
- "category": exactly one of "NICE Guideline", "Drug Safety", "CQC/Regulatory", "NHS Guidance"
- "priority": exactly one of "High", "Medium", "Low"

Return ONLY the JSON array. No markdown. No code fences. No commentary.`;

  // Use models that support Google Search grounding
  const models = [
    { name: 'gemini-2.0-flash', version: 'v1beta' },
    { name: 'gemini-2.5-flash', version: 'v1beta' },
  ];

  for (const model of models) {
    try {
      const url = `https://generativelanguage.googleapis.com/${model.version}/models/${model.name}:generateContent?key=${apiKey}`;

      const apiRes = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          tools: [{ google_search: {} }]   // ← live web search grounding
        })
      });

      if (!apiRes.ok) continue;

      const data   = await apiRes.json();
      const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
      if (!rawText) continue;

      // Parse JSON — strip accidental markdown fences if present
      let updates;
      try {
        updates = JSON.parse(rawText.trim());
      } catch {
        const match = rawText.replace(/```json|```/g, '').match(/\[[\s\S]*\]/);
        if (!match) continue;
        updates = JSON.parse(match[0]);
      }

      if (!Array.isArray(updates) || updates.length === 0) continue;

      const result = {
        updates:    updates.slice(0, 6),
        checkedAt:  new Date().toISOString(),
        model:      model.name
      };

      // ── 3. Store in shared KV (all nurses see this immediately) ──────────
      try {
        await kv.set(KV_KEY, result);
      } catch (e) {
        // KV write failed — still return the result to this user
      }

      res.setHeader('X-Cache', 'MISS');
      return res.status(200).json(result);

    } catch (e) {
      continue;
    }
  }

  // ── 4. All models failed — serve stale KV data rather than an error ─────
  try {
    const stale = await kv.get(KV_KEY);
    if (stale) {
      res.setHeader('X-Cache', 'STALE');
      return res.status(200).json({ ...stale, stale: true });
    }
  } catch {}

  return res.status(500).json({ error: 'Unable to fetch guideline updates. Please try again later.' });
};
