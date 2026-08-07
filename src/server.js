const express = require('express');
const OpenAI = require('openai');
const Stripe = require('stripe');
const usageTracker = require('./usage');
const licenses = require('./licenses');
const updates = require('./updates');

const app = express();

function getStripe() {
  if (!process.env.STRIPE_SECRET_KEY) return null;
  return new Stripe(process.env.STRIPE_SECRET_KEY);
}

// Stripe webhook signature verification needs the exact raw request body, so
// this route (and its own raw-body parser) must be registered before the
// general express.json() below ever gets a chance to consume it.
app.post('/webhook', express.raw({ type: 'application/json' }), (req, res) => {
  const stripe = getStripe();
  if (!stripe || !process.env.STRIPE_WEBHOOK_SECRET) {
    return res.status(503).json({ error: 'not_configured' });
  }

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('webhook signature verification failed', err.message);
    return res.status(400).json({ error: 'invalid_signature' });
  }

  (async () => {
    try {
      if (event.type === 'checkout.session.completed') {
        const session = event.data.object;
        // Retried deliveries must be a no-op — a license is a one-time,
        // naturally idempotent grant, unlike the additive credit top-ups
        // Magpie's webhook has to guard against, so a simple "does a
        // license for this session already exist" check is enough here.
        if (!licenses.getLicenseBySession(session.id)) {
          const key = licenses.createLicense({
            email: session.customer_details?.email || session.customer_email || null,
            stripeCustomerId: typeof session.customer === 'string' ? session.customer : session.customer?.id || null,
            stripeSessionId: session.id,
          });
          console.log('license created', key, 'for session', session.id);
        }
      } else if (event.type === 'charge.refunded' || event.type === 'charge.dispute.created') {
        // A refund/dispute arrives keyed by charge, not checkout session, so
        // look the session back up via its payment intent before we can
        // find which license it minted.
        const charge = event.data.object;
        const paymentIntentId = typeof charge.payment_intent === 'string' ? charge.payment_intent : charge.payment_intent?.id;
        if (paymentIntentId) {
          const sessions = await stripe.checkout.sessions.list({ payment_intent: paymentIntentId, limit: 1 });
          const session = sessions.data[0];
          const key = session ? licenses.getLicenseKeyBySession(session.id) : null;
          if (key) {
            licenses.revokeLicense(key);
            console.log('license revoked', key, 'due to', event.type);
          }
        }
      }
    } catch (err) {
      console.error('webhook handling error', err);
    }
  })();

  return res.status(200).json({ received: true });
});

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
        : `estimated £${s.price_min}-£${s.price_max} (priced by the appointment time reserved, not the exact minutes worked)`;
      const dMin = s.duration_min || 60;
      const dMax = s.duration_max || dMin;
      const duration = dMin === dMax ? `${dMin} min on-site` : `${dMin}-${dMax} min on-site (varies)`;
      const parts = s.parts_may_apply ? ' Parts, if this job needs any, are charged separately.' : ' This job never needs parts — the price is the full cost.';
      return `- ${s.name} (${price}, ${duration}): ${s.description}${parts}`;
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
    '6. Once you are reasonably confident which listed service matches (and nothing in the owner guidelines rules it out), stop asking questions. Tell them: the likely job type in plain language, your estimated duration (a specific number, not the raw range, and say it\'s approximate), and the price (unless fixed price, state it as a range based on the appointment time reserved, not the exact minutes worked — it can only rise if more time turns out to be needed, never fall for finishing early). Briefly say what pushed the estimate toward that number if relevant (e.g. "since it\'s quite an old machine, this will likely take longer"). Then invite them to book.',
    '7. If after a few exchanges nothing more specific on the list matches, but the problem is still clearly something this business handles (a device, software, setup or connectivity issue) and a general "Diagnostic / Assessment Visit" (or similarly-named catch-all) service is listed, match that instead of escalating — the customer still gets a real, bookable visit, and the engineer can figure out specifics on site. Only escalate when there is no such fallback service listed, the request is not something this business does at all (not a device/software/setup problem), or the owner guidelines say to call back instead.',
    '',
    'Rules:',
    `- matched_service must be exactly one of these names, character-for-character, or null: ${JSON.stringify(serviceNames)}.`,
    '- Only set matched_service once you are actually confident, not on a first guess.',
    '- Never set matched_service or ready_to_book=true for anything the owner guidelines exclude or say needs a callback, even if a service would otherwise match.',
    '- Never invent a price or capability not listed above — you may only lean toward either end of a given range, never quote outside it. Lean toward the low end for a duration near the bottom of the service\'s range, and the high end for a duration near the top — the range reflects appointment-time brackets, not literal minutes worked, so it does not shrink just because a job might finish quickly.',
    '- estimated_duration_mins must be a whole number within the matched service\'s listed duration range (or null if no service is matched yet).',
    '- Never promise an exact price for anything marked as an estimate — say it\'s based on the time booked, and it can only go up (never down) if the job ends up needing more time than expected.',
    '- Every time you state a price for a service marked above as needing parts charged separately, add "(parts excluded)". Never add it for a service marked as never needing parts (e.g. a pure software/account/device setup) — don\'t mention parts at all for those, it would just be confusing.',
    '- You do not know real-time appointment availability and can never confirm, deny, or promise a specific time yourself. If the customer mentions a preferred time or day, do not treat that as something needing a human — proceed exactly as normal (matched_service + ready_to_book=true once you\'re confident), and mention in your answer that they\'ll pick their exact time next from what\'s actually free, which will include their preferred slot if it\'s open. Only escalate for reasons unrelated to timing.',
    '- Keep answers short (2-4 sentences, or a couple of quick follow-up questions).',
    '- Respond with ONLY a JSON object of this exact shape:',
    '  {"answer": "...", "escalate": true|false, "matched_service": string|null, "ready_to_book": true|false, "estimated_duration_mins": number|null}',
    '- Set ready_to_book=true only in the same turn you announce a confident match with duration/price and invite booking, and only when the owner guidelines don\'t rule it out.',
    '- Set escalate=true whenever you said you\'re not sure, the issue doesn\'t match anything listed, the owner guidelines say to call back, or the question needs a human.',
    '- Whenever you set escalate=true, end your answer by telling the customer a short form will appear below to leave their name and phone or email so the team can call them back — never just say "we\'ll pass it on" without pointing them to that.',
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

    if (completion.usage) {
      usageTracker.logUsage(MODEL, completion.usage.prompt_tokens || 0, completion.usage.completion_tokens || 0);
    }

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
    const matchedSvc = matched ? allServices.find((s) => s.name === matched) : null;

    // Never trust the model's duration figure blindly — clamp it to the
    // matched service's own configured range, same as every other number
    // in this response.
    let estimatedDuration = null;
    if (matchedSvc) {
      const dMin = matchedSvc.duration_min || 60;
      const dMax = matchedSvc.duration_max || dMin;
      const raw = parseInt(parsed.estimated_duration_mins, 10);
      estimatedDuration = Number.isFinite(raw) ? Math.min(Math.max(raw, dMin), dMax) : dMax;
    }

    let answer = parsed.answer || "I'm not sure — I'll pass this on to the team.";

    // Rare, but the model has occasionally named a different service in its
    // own prose than the one it actually matched (e.g. saying "Laptop
    // Hardware Repair" while matched_service is "Desktop/Tower Hardware
    // Repair"). The booking itself is unaffected either way — it's driven by
    // matched_service, not the sentence — but a customer reading the
    // contradiction is confusing, so straighten out any other known service
    // name mentioned in the text to match what was actually matched.
    if (matched) {
      serviceNames.forEach((name) => {
        if (name !== matched && answer.includes(name)) {
          answer = answer.split(name).join(matched);
        }
      });
    }

    // The model doesn't reliably remember to mention this every time it
    // quotes a price — enforced here instead of trusting free-text
    // compliance, same reasoning as why escalation contact-capture is a
    // real form rather than something we just told the model to ask for.
    if (matchedSvc && matchedSvc.parts_may_apply && parsed.ready_to_book && !/parts/i.test(answer)) {
      answer = answer.trim() + ' Parts, if this job needs any, are charged separately.';
    }

    return res.status(200).json({
      answer,
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

    if (completion.usage) {
      usageTracker.logUsage(MODEL, completion.usage.prompt_tokens || 0, completion.usage.completion_tokens || 0);
    }

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

app.get('/usage', (req, res) => {
  const { site_key } = req.query || {};
  if (!site_key) {
    return res.status(400).json({ error: 'Bad request.' });
  }
  return res.status(200).json(usageTracker.getSummary());
});

app.post('/usage/reset', (req, res) => {
  const { site_key } = req.body || {};
  if (!site_key) {
    return res.status(400).json({ error: 'Bad request.' });
  }
  usageTracker.reset();
  return res.status(200).json({ ok: true });
});

// Plain-link version of /license/checkout — lets the static landing page use
// a normal <a href> "Buy now" button with no JavaScript, since a form POST
// isn't worth the markup for a single link.
app.get('/buy', async (req, res) => {
  const stripe = getStripe();
  if (!stripe || !process.env.STRIPE_PRICE_SBA) {
    return res.status(503).send('Checkout is not available right now — try again shortly or contact support@bluebootapps.com.');
  }

  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: [{ price: process.env.STRIPE_PRICE_SBA, quantity: 1 }],
      allow_promotion_codes: true,
      success_url: `${process.env.APP_URL}/license/thank-you?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.SITE_URL || process.env.APP_URL}/?canceled=1`,
    });
    return res.redirect(303, session.url);
  } catch (err) {
    console.error('buy redirect error', err);
    return res.status(502).send('Checkout is not available right now — try again shortly or contact support@bluebootapps.com.');
  }
});

app.post('/license/checkout', async (req, res) => {
  const stripe = getStripe();
  if (!stripe || !process.env.STRIPE_PRICE_SBA) {
    return res.status(503).json({ error: 'not_configured' });
  }

  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: [{ price: process.env.STRIPE_PRICE_SBA, quantity: 1 }],
      allow_promotion_codes: true,
      success_url: `${process.env.APP_URL}/license/thank-you?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.SITE_URL || process.env.APP_URL}/?canceled=1`,
    });
    return res.status(200).json({ url: session.url });
  } catch (err) {
    console.error('checkout error', err);
    return res.status(502).json({ error: 'checkout_unavailable' });
  }
});

// Simple confirmation page after a successful purchase — looks the license
// up by the Stripe session id Checkout redirected back with, so the buyer
// sees their key immediately instead of only via email.
app.get('/license/thank-you', async (req, res) => {
  const stripe = getStripe();
  const sessionId = req.query.session_id;
  res.set('Content-Type', 'text/html; charset=utf-8');

  if (!stripe || !sessionId) {
    return res.status(400).send('<p>Missing session.</p>');
  }

  let key = licenses.getLicenseKeyBySession(sessionId);
  let paid = !!key;

  // The webhook usually wins the race, but if this page loads first, confirm
  // the payment directly with Stripe and mint the license here instead of
  // making the buyer wait on a redelivery. This lookup is also what stops
  // an unpaid or tampered-with session id from ever claiming "payment
  // received" below — nothing here trusts the URL alone.
  if (!key) {
    try {
      const session = await stripe.checkout.sessions.retrieve(sessionId);
      paid = session.payment_status === 'paid';
      if (paid && !licenses.getLicenseBySession(session.id)) {
        key = licenses.createLicense({
          email: session.customer_details?.email || session.customer_email || null,
          stripeCustomerId: typeof session.customer === 'string' ? session.customer : session.customer?.id || null,
          stripeSessionId: session.id,
        });
      }
    } catch (err) {
      console.error('thank-you page session lookup failed', err);
      return res.status(404).send('<p>We could not find that order. If you believe this is an error, contact support@bluebootapps.com.</p>');
    }
  }

  if (!paid) {
    return res.status(200).send('<p>This order has not been completed. If you were charged and see this message, contact support@bluebootapps.com.</p>');
  }

  if (!key) {
    return res.status(200).send('<p>Payment received — your license key is on its way. If it does not arrive shortly, contact support@bluebootapps.com.</p>');
  }

  return res.status(200).send(
    `<p>Thanks for your purchase. Your license key:</p><p style="font-size:20px;font-weight:700;">${key}</p><p>Paste this into Service Booking AI's Settings page on your WordPress site.</p>`
  );
});

app.post('/license/activate', (req, res) => {
  const { license_key, site_url } = req.body || {};
  if (!license_key || !site_url) {
    return res.status(400).json({ allowed: false, reason: 'bad_request' });
  }
  return res.status(200).json(licenses.activateSite(license_key, site_url));
});

app.post('/license/validate', (req, res) => {
  const { license_key, site_url } = req.body || {};
  if (!license_key || !site_url) {
    return res.status(400).json({ valid: false, reason: 'bad_request' });
  }
  return res.status(200).json(licenses.validateSite(license_key, site_url));
});

app.post('/license/deactivate', (req, res) => {
  const { license_key, site_url } = req.body || {};
  if (!license_key || !site_url) {
    return res.status(400).json({ ok: false, reason: 'bad_request' });
  }
  return res.status(200).json(licenses.deactivateSite(license_key, site_url));
});

// Publishing a new version: raw zip bytes in the body, version/changelog in
// headers rather than multipart form fields — avoids pulling in a multipart
// parser dependency for what's a one-person, occasional operation.
app.post('/admin/publish-update', express.raw({ type: 'application/zip', limit: '20mb' }), (req, res) => {
  const secret = process.env.UPDATE_ADMIN_SECRET;
  if (!secret || req.headers.authorization !== `Bearer ${secret}`) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const version = req.headers['x-version'];
  if (!version || !Buffer.isBuffer(req.body) || !req.body.length) {
    return res.status(400).json({ error: 'bad_request' });
  }

  let changelog = '';
  try {
    changelog = Buffer.from(req.headers['x-changelog-base64'] || '', 'base64').toString('utf8');
  } catch (e) {
    // Malformed changelog header — publish still proceeds with an empty changelog rather than failing the whole release over cosmetic text.
  }

  updates.publish({ version, changelog, zipBuffer: req.body });
  return res.status(200).json({ ok: true, version });
});

// Requires a valid, activated license for this site — updates are part of
// what an active license pays for, same as the AI chat itself.
app.get('/updates/check', (req, res) => {
  const { license_key, site_url, current_version } = req.query || {};
  if (!license_key || !site_url || !current_version) {
    return res.status(400).json({ error: 'bad_request' });
  }

  const check = licenses.validateSite(license_key, site_url);
  if (!check.valid) {
    return res.status(200).json({ update_available: false, reason: check.reason });
  }

  const latest = updates.getLatest();
  if (!latest || !updates.isNewer(latest.version, current_version)) {
    return res.status(200).json({ update_available: false });
  }

  return res.status(200).json({
    update_available: true,
    version: latest.version,
    changelog: latest.changelog,
    download_url: `${process.env.APP_URL}/updates/download?license_key=${encodeURIComponent(license_key)}&site_url=${encodeURIComponent(site_url)}`,
  });
});

// WordPress's core upgrader downloads this URL directly with a plain GET
// (no custom headers it would send along), so the license/site check has to
// happen via query params baked into the download_url above rather than an
// Authorization header.
app.get('/updates/download', (req, res) => {
  const { license_key, site_url } = req.query || {};
  if (!license_key || !site_url) {
    return res.status(400).send('Bad request.');
  }

  const check = licenses.validateSite(license_key, site_url);
  if (!check.valid) {
    return res.status(403).send('License not valid for this site.');
  }

  const latest = updates.getLatest();
  const zipPath = latest ? updates.getZipPath(latest.version) : null;
  if (!zipPath) {
    return res.status(404).send('No update available.');
  }

  return res.download(zipPath, `service-booking-ai-standalone-${latest.version}.zip`);
});

app.get('/health', (req, res) => res.json({ ok: true }));

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`service-booking-ai-backend listening on ${port}`));
