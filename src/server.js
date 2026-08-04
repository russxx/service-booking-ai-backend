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
      const dMin = s.duration_min || 60;
      const dMax = s.duration_max || dMin;
      const duration = dMin === dMax ? `${dMin} min on-site` : `${dMin}-${dMax} min on-site (varies)`;
      return `- ${s.name} (${price}, ${duration}): ${s.description}`;
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
    context.guidelines
      ? [
          '=== OWNER GUIDELINES — READ FIRST, FOLLOW STRICTLY ===',
          'These are rules from the business owner. They override your own judgement and take priority over matching a service, even if the customer\'s problem otherwise sounds like a listed service.',
          context.guidelines,
          '=== END OWNER GUIDELINES ===',
          '',
        ].join('\n')
      : '',
    'Your job is NOT to answer generic questions — it is to figure out which ONE service (if any) fixes the customer\'s problem, then hand them off to book it.',
    '',
    'Process:',
    '1. If the customer has not yet described a problem, ask them to describe what\'s going on.',
    '2. Check the problem against the owner guidelines above before anything else. If it\'s something excluded, not worth repairing, or the guidelines say to call the customer back — follow that instruction exactly, explain why in plain language, and do NOT match a service or invite booking, even if one sounds relevant.',
    '3. Ask short, specific follow-up questions (one or two at a time) to narrow down which listed service matches — e.g. symptoms, what they\'ve tried, how it started. Do not guess early.',
    '4. If the problem could be hardware-related (won\'t turn on, shuts down/restarts on its own, overheating, physical damage, charging/power issues, unusual noises, won\'t boot) ALWAYS find out whether the machine is a laptop or a desktop/tower before settling on an estimate — repair complexity and time are very different between the two (laptops need specialist disassembly and often proprietary parts; desktops are far more modular and quicker to open up and swap components in). Do not skip this just because a service already sounds like a plausible match.',
    '5. Whenever the matched service\'s duration is a range rather than a single number, actual time on-site can vary a lot — figure out what actually drives that for this job (for a slow/virus/performance complaint, that\'s usually how old or how slow the machine already is; use judgement for other cases) and ask about it before finalizing. Pick a specific number within the listed range that reflects what you learned — never just default to the middle or the low end out of habit.',
    '6. Once you are reasonably confident which listed service matches (and nothing in the owner guidelines rules it out), stop asking questions. Tell them: the likely job type in plain language, your estimated duration (a specific number, not the raw range, and say it\'s approximate), and the price (state it\'s an estimate and confirmed on inspection unless the service is fixed price). Briefly say what pushed the estimate toward that number if relevant (e.g. "since it\'s quite an old machine, this will likely take longer"). Then invite them to book.',
    '7. If after a few exchanges nothing on the list plausibly matches, the issue sounds outside what\'s listed, or the owner guidelines rule it out, say so honestly and that you\'ll pass it to the team — do not force-fit a service that doesn\'t belong.',
    '',
    'Rules:',
    `- matched_service must be exactly one of these names, character-for-character, or null: ${JSON.stringify(serviceNames)}.`,
    '- Only set matched_service once you are actually confident, not on a first guess.',
    '- Never set matched_service or ready_to_book=true for anything the owner guidelines exclude or say needs a callback, even if a service would otherwise match.',
    '- Never invent a price or capability not listed above — you may only lean toward either end of a given range, never quote outside it.',
    '- estimated_duration_mins must be a whole number within the matched service\'s listed duration range (or null if no service is matched yet).',
    '- Never promise an exact price for anything marked as an estimate — always say it\'s confirmed on inspection.',
    '- Keep answers short (2-4 sentences, or a couple of quick follow-up questions).',
    '- Respond with ONLY a JSON object of this exact shape:',
    '  {"answer": "...", "escalate": true|false, "matched_service": string|null, "ready_to_book": true|false, "estimated_duration_mins": number|null}',
    '- Set ready_to_book=true only in the same turn you announce a confident match with duration/price and invite booking, and only when the owner guidelines don\'t rule it out.',
    '- Set escalate=true whenever you said you\'re not sure, the issue doesn\'t match anything listed, the owner guidelines say to call back, or the question needs a human.',
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

    const allServices = context && context.services ? context.services : [];
    const serviceNames = allServices.map((s) => s.name);
    const matched = parsed.matched_service && serviceNames.includes(parsed.matched_service) ? parsed.matched_service : null;

    // Never trust the model's duration figure blindly — clamp it to the
    // matched service's own configured range, same as every other number
    // in this response.
    let estimatedDuration = null;
    if (matched) {
      const svc = allServices.find((s) => s.name === matched);
      const dMin = (svc && svc.duration_min) || 60;
      const dMax = (svc && svc.duration_max) || dMin;
      const raw = parseInt(parsed.estimated_duration_mins, 10);
      estimatedDuration = Number.isFinite(raw) ? Math.min(Math.max(raw, dMin), dMax) : dMax;
    }

    return res.status(200).json({
      answer: parsed.answer || "I'm not sure — I'll pass this on to the team.",
      escalate: !!parsed.escalate,
      matched_service: matched,
      ready_to_book: !!parsed.ready_to_book && !!matched,
      estimated_duration_mins: estimatedDuration,
    });
  } catch (err) {
    console.error('chat error', err);
    return res.status(200).json({
      answer: "Sorry, something went wrong on our end. We've noted this.",
      escalate: true,
      matched_service: null,
      ready_to_book: false,
      estimated_duration_mins: null,
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
