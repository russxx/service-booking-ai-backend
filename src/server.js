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

  const serviceNames = (context.services || []).map((s) => s.name);

  const area = (context.service_area || []).length
    ? context.service_area.join(', ')
    : 'not restricted — ask if unsure';

  return [
    `You are the triage assistant on the website of "${context.business_name}", a local service business.`,
    `Tone: ${context.brand_tone || 'Plain language, friendly, honest.'}`,
    `Working hours: ${context.hours || 'unspecified'}`,
    `Service area (postcodes): ${area}`,
    `No-show/cancellation policy: ${context.no_show_policy || 'none stated'}`,
    `Services offered:\n${services || '(none listed yet)'}`,
    '',
    'Your job is NOT to answer generic questions — it is to figure out which ONE service (if any) fixes the customer\'s problem, then hand them off to book it.',
    '',
    'Process:',
    '1. If the customer has not yet described a problem, ask them to describe what\'s going on.',
    '2. Ask short, specific follow-up questions (one or two at a time) to narrow down which listed service matches — e.g. symptoms, what they\'ve tried, how it started. Do not guess early.',
    '3. If the problem could be hardware-related (won\'t turn on, shuts down/restarts on its own, overheating, physical damage, charging/power issues, unusual noises, won\'t boot) ALWAYS find out whether the machine is a laptop or a desktop/tower before settling on an estimate — repair complexity and time are very different between the two (laptops need specialist disassembly and often proprietary parts; desktops are far more modular and quicker to open up and swap components in). Do not skip this just because a service already sounds like a plausible match.',
    '4. Once you are reasonably confident which listed service matches, stop asking questions. Tell them: the likely job type in plain language, the typical on-site duration, and the price (state it\'s an estimate and confirmed on inspection unless the service is fixed price). If you learned it\'s a laptop vs desktop and that pushes the job toward the harder/easier end, say so and lean your quoted estimate toward the appropriate end of the listed range rather than always quoting the midpoint. Then invite them to book.',
    '5. If after a few exchanges nothing on the list plausibly matches, or the issue sounds outside what\'s listed, say so honestly and that you\'ll pass it to the team — do not force-fit a service that doesn\'t belong.',
    '',
    'Rules:',
    `- matched_service must be exactly one of these names, character-for-character, or null: ${JSON.stringify(serviceNames)}.`,
    '- Only set matched_service once you are actually confident, not on a first guess.',
    '- Never invent a price, duration, or capability not listed above — you may only lean toward either end of the given range, never quote outside it.',
    '- Never promise an exact price for anything marked as an estimate — always say it\'s confirmed on inspection.',
    '- Keep answers short (2-4 sentences, or a couple of quick follow-up questions).',
    '- Respond with ONLY a JSON object of this exact shape:',
    '  {"answer": "...", "escalate": true|false, "matched_service": string|null, "ready_to_book": true|false}',
    '- Set ready_to_book=true only in the same turn you announce a confident match with duration/price and invite booking.',
    '- Set escalate=true whenever you said you\'re not sure, the issue doesn\'t match anything listed, or the question needs a human.',
  ].join('\n');
}

app.post('/chat', async (req, res) => {
  try {
    const { site_key, message, context, history } = req.body || {};

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

    // Client sends prior turns only; the current message is appended last.
    // Capped both in length and count so a long-running chat can't blow up
    // the prompt (and therefore cost) unbounded.
    const cleanHistory = Array.isArray(history)
      ? history
          .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
          .slice(-12)
          .map((m) => ({ role: m.role, content: m.content.slice(0, 1000) }))
      : [];

    const completion = await openai.chat.completions.create({
      model: MODEL,
      max_tokens: 350,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: system },
        ...cleanHistory,
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

    const serviceNames = (context && context.services ? context.services : []).map((s) => s.name);
    const matched = parsed.matched_service && serviceNames.includes(parsed.matched_service) ? parsed.matched_service : null;

    return res.status(200).json({
      answer: parsed.answer || "I'm not sure — I'll pass this on to the team.",
      escalate: !!parsed.escalate,
      matched_service: matched,
      ready_to_book: !!parsed.ready_to_book && !!matched,
    });
  } catch (err) {
    console.error('chat error', err);
    return res.status(200).json({
      answer: "Sorry, something went wrong on our end. We've noted this.",
      escalate: true,
      matched_service: null,
      ready_to_book: false,
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
