const express = require('express');
const OpenAI = require('openai');

const app = express();
app.use(express.json({ limit: '300kb' }));

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const MODEL = process.env.SBA_MODEL || 'gpt-4o-mini';

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

    const completion = await openai.chat.completions.create({
      model: MODEL,
      max_tokens: 300,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: message },
      ],
    });

    const raw = completion.choices?.[0]?.message?.content || '';
    let parsed;
    try {
      parsed = JSON.parse(raw);
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

function buildExtractPrompt(pages, existingServiceNames) {
  const pageText = pages
    .map((p) => `--- PAGE: ${p.title || '(untitled)'} ---\n${p.content}`)
    .join('\n\n')
    .slice(0, 40000);

  const existing = existingServiceNames.length
    ? `Already listed, don't repeat: ${existingServiceNames.join(', ')}.`
    : '';

  return [
    'You are helping a local service business set up their website chatbot by reading their own existing site content and pulling out structured facts.',
    'Below is text scraped from their own published pages. Extract ONLY what is actually stated — never invent prices, hours, or services that aren\'t mentioned.',
    existing,
    '',
    'Return ONLY a JSON object of this exact shape:',
    '{',
    '  "business_name": string or null,',
    '  "hours_guess": string or null (e.g. "09:00-17:00", only if explicitly stated),',
    '  "service_area_guess": string[] (postcodes/towns/areas explicitly mentioned, empty array if none),',
    '  "services": [',
    '    { "name": string, "description": string (1-2 plain sentences), "price_min": number or null, "price_max": number or null, "fixed_price": boolean, "duration_mins": number or null }',
    '  ]',
    '}',
    '',
    'Only include a service if the site clearly describes it as something the business offers. If no price is mentioned anywhere for a service, leave price_min/price_max null rather than guessing.',
    '',
    pageText,
  ].join('\n');
}

app.post('/extract-business-info', async (req, res) => {
  try {
    const { site_key, pages, existing_service_names } = req.body || {};

    if (!site_key || !Array.isArray(pages) || !pages.length) {
      return res.status(400).json({ error: 'Bad request.' });
    }
    if (!withinLimit(site_key + ':scan')) {
      return res.status(429).json({ error: 'Scan already run recently — please wait a bit before trying again.' });
    }

    const prompt = buildExtractPrompt(pages, existing_service_names || []);

    const completion = await openai.chat.completions.create({
      model: MODEL,
      max_tokens: 2000,
      response_format: { type: 'json_object' },
      messages: [{ role: 'user', content: prompt }],
    });

    const raw = completion.choices?.[0]?.message?.content || '{}';
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      return res.status(200).json({ business_name: null, hours_guess: null, service_area_guess: [], services: [] });
    }

    return res.status(200).json({
      business_name: parsed.business_name || null,
      hours_guess: parsed.hours_guess || null,
      service_area_guess: Array.isArray(parsed.service_area_guess) ? parsed.service_area_guess : [],
      services: Array.isArray(parsed.services) ? parsed.services : [],
    });
  } catch (err) {
    console.error('extract error', err);
    return res.status(500).json({ error: 'Scan failed, please try again.' });
  }
});

app.get('/health', (req, res) => res.json({ ok: true }));

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`service-booking-ai-backend listening on ${port}`));
