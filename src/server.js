const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
app.use(express.json({ limit: '100kb' }));

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = process.env.SBA_MODEL || 'claude-haiku-4-5';

// In-memory per-site daily counters. Resets on restart/redeploy — fine for
// single-instance MVP; move to a shared store (Redis) before scaling to
// multiple backend instances.
const usage = new Map();
const DAILY_LIMIT = parseInt(process.env.SBA_DAILY_LIMIT_PER_SITE || '300', 10);

function withinLimit(siteKey) {
  const today = new Date().toISOString().slice(0, 10);
  const bucketKey = siteKey + ':' + today;
  const count = usage.get(bucketKey) || 0;
  if (count >= DAILY_LIMIT) return false;
  usage.set(bucketKey, count + 1);
  return true;
}

function buildSystemPrompt(context) {
  const services = (context.services || [])
    .map((s) => {
      const price = s.fixed_price
        ? `fixed price £${s.price_min}`
        : `estimated £${s.price_min}-£${s.price_max}, confirmed on inspection`;
      return `- ${s.name} (${price}, ~${s.duration || 60} min on-site): ${s.description}`;
    })
    .join('\n');

  const area = (context.service_area || []).length
    ? context.service_area.join(', ')
    : 'not restricted — ask if unsure';

  return [
    `You are the AI assistant on the website of "${context.business_name}", a local service business.`,
    `Tone: ${context.brand_tone || 'Plain language, friendly, honest.'}`,
    `Working hours: ${context.hours || 'unspecified'}`,
    `Service area (postcodes): ${area}`,
    `No-show/cancellation policy: ${context.no_show_policy || 'none stated'}`,
    `Services offered:\n${services || '(none listed yet)'}`,
    '',
    'Rules:',
    '- Only answer using the information above. Do not invent prices, availability, or capabilities not listed.',
    '- If the customer asks something you cannot answer confidently from the information above (a specific technical diagnosis, a price for something not listed, anything about a job in progress), say you\'re not sure and that you\'ll pass it to the team.',
    '- Never promise an exact price for anything marked as an estimate — always say it\'s confirmed on inspection.',
    '- Keep answers short (2-4 sentences).',
    '- Respond with ONLY a JSON object: {"answer": "...", "escalate": true|false}. Set escalate=true whenever you said you\'re not sure or the question needs a human.',
  ].join('\n');
}

app.post('/chat', async (req, res) => {
  try {
    const { site_key, message, context } = req.body || {};

    if (!site_key || !message || typeof message !== 'string') {
      return res.status(400).json({ answer: 'Bad request.', escalate: true });
    }
    if (message.length > 2000) {
      return res.status(400).json({ answer: 'Message too long.', escalate: true });
    }
    if (!withinLimit(site_key)) {
      return res.status(200).json({
        answer: "We're handling a lot of questions right now — please try again later or contact us directly.",
        escalate: true,
      });
    }

    const system = buildSystemPrompt(context || {});

    const completion = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 300,
      system,
      messages: [{ role: 'user', content: message }],
    });

    const raw = completion.content?.[0]?.text || '';
    let parsed;
    try {
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      parsed = JSON.parse(jsonMatch ? jsonMatch[0] : raw);
    } catch (e) {
      parsed = { answer: raw || "I'm not sure — I'll pass this on to the team.", escalate: true };
    }

    return res.status(200).json({
      answer: parsed.answer || "I'm not sure — I'll pass this on to the team.",
      escalate: !!parsed.escalate,
    });
  } catch (err) {
    console.error('chat error', err);
    return res.status(200).json({
      answer: "Sorry, something went wrong on our end. We've noted this.",
      escalate: true,
    });
  }
});

app.get('/health', (req, res) => res.json({ ok: true }));

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`service-booking-ai-backend listening on ${port}`));
