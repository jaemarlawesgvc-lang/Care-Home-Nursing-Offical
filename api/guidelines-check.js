/**
 * Vercel Serverless Function: Weekly Guideline Pulse
 * Asks Gemini for the most current NICE/BNF/CQC updates relevant to UK care home nursing.
 */
module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'GEMINI_API_KEY not configured.' });
  }

  const today = new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });

  const prompt = `You are a Senior Clinical Pharmacist and UK care home regulatory expert. Today's date is ${today}.

Provide a structured JSON response listing the 6 most clinically important, current pieces of guidance or regulatory updates relevant to UK care home nursing staff. Focus on:
- Recent NICE guideline updates or new guidelines (with guideline number where known)
- Recent BNF / MHRA drug safety updates or new warnings
- CQC regulatory updates relevant to care homes
- NHS England / NHSE care home guidance updates

Respond ONLY with a valid JSON array of objects. Each object must have these fields:
- "title": short headline (max 12 words)
- "body": 2-3 sentence clinical summary for a nurse
- "source": the source name e.g. "NICE NG185", "MHRA Drug Safety Update", "CQC"
- "category": one of "NICE Guideline", "Drug Safety", "CQC/Regulatory", "NHS Guidance"
- "priority": one of "High", "Medium", "Low"

Return ONLY the JSON array, no markdown, no commentary, no code fences.`;

  const models = [
    { name: 'gemini-2.5-flash', version: 'v1beta' },
    { name: 'gemini-2.0-flash', version: 'v1' }
  ];

  for (const model of models) {
    try {
      const url = `https://generativelanguage.googleapis.com/${model.version}/models/${model.name}:generateContent?key=${apiKey}`;
      const apiRes = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
      });

      if (!apiRes.ok) continue;

      const data = await apiRes.json();
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';

      let updates;
      try {
        updates = JSON.parse(text.trim());
      } catch {
        // Strip any accidental markdown fences
        const cleaned = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
        updates = JSON.parse(cleaned);
      }

      if (!Array.isArray(updates)) throw new Error('Not an array');

      return res.status(200).json({ updates, checkedAt: new Date().toISOString() });
    } catch (err) {
      continue;
    }
  }

  return res.status(500).json({ error: 'Unable to fetch guideline updates.' });
};
