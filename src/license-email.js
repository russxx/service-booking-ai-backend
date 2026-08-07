const nodemailer = require('nodemailer');
const licenses = require('./licenses');

// Mirrors Magpie's lib/license-email.ts — same claim/complete/release
// delivery-tracking reasoning (a Stripe webhook retry must not send a
// second email for one purchase), same "just don't send if unconfigured"
// fallback so a missing SMTP setup never breaks checkout itself.

function isConfigured() {
  return !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASSWORD && process.env.EMAIL_FROM);
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[c]));
}

/**
 * @param {{licenseKey: string, email: string}} args
 */
async function sendLicenseEmailOnce({ licenseKey, email }) {
  if (!isConfigured()) {
    console.info('[license-email] SMTP is not configured; the thank-you page remains the only delivery path');
    return;
  }
  if (!email) {
    console.info('[license-email] no email on this purchase — skipping (buyer still has the thank-you page)');
    return;
  }

  const claimed = licenses.claimEmailDelivery(licenseKey);
  if (!claimed) {
    return; // already sent, or another delivery attempt is currently in flight
  }

  const port = parseInt(process.env.SMTP_PORT || '465', 10);
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    secure: port === 465,
    requireTLS: port !== 465,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD },
    // Some container networks resolve the mail host to an IPv6 address with
    // no outbound IPv6 route, which hangs until connectionTimeout instead of
    // falling back to IPv4 — force IPv4 so that dead-end never gets tried.
    family: 4,
    connectionTimeout: 8000,
    greetingTimeout: 8000,
    socketTimeout: 15000,
  });

  const appUrl = process.env.APP_URL || '';
  const downloadUrl = `${appUrl}/license/download?license_key=${encodeURIComponent(licenseKey)}`;
  const safeKey = escapeHtml(licenseKey);

  try {
    await transporter.sendMail({
      from: `Blueboot Apps <${process.env.EMAIL_FROM}>`,
      replyTo: 'support@bluebootapps.com',
      to: email,
      subject: 'Your Service Booking AI license key',
      text: [
        'Service Booking AI is ready to install.',
        '',
        `License key: ${licenseKey}`,
        `Download: ${downloadUrl}`,
        '',
        'To install:',
        '1. Download the zip from the link above.',
        '2. In WordPress: Plugins → Add New → Upload Plugin, then activate it.',
        '3. Go to Service Booking AI → Settings and paste in your license key — it activates automatically when you save.',
        '',
        'This license works on one WordPress site at a time. Support: support@bluebootapps.com',
      ].join('\n'),
      html: `
        <div style="margin:0;background:#f8fbff;padding:32px 16px;font-family:Inter,Arial,sans-serif;color:#07111f">
          <div style="max-width:600px;margin:0 auto;background:#fff;border:1px solid #dbe4f0;border-radius:18px;overflow:hidden">
            <div style="padding:24px 28px;background:#f8fbff;border-bottom:1px solid #dbe4f0;font-weight:800;font-size:18px">Blueboot <span style="color:#2563eb">Apps</span></div>
            <div style="padding:32px 28px">
              <p style="margin:0 0 8px;color:#2563eb;font-size:12px;font-weight:800;letter-spacing:.08em;text-transform:uppercase">Payment confirmed</p>
              <h1 style="margin:0 0 12px;font-size:28px;line-height:1.2">Service Booking AI is ready.</h1>
              <div style="padding:18px;background:#07111f;border-radius:10px;color:#fff">
                <div style="margin-bottom:7px;color:#93a4bb;font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase">License key</div>
                <code style="font-size:15px;word-break:break-all">${safeKey}</code>
              </div>
              <a href="${downloadUrl}" style="display:inline-block;margin-top:20px;padding:12px 22px;background:#2563eb;color:#fff;border-radius:10px;font-weight:700;text-decoration:none;">Download Service Booking AI</a>
              <h2 style="margin:28px 0 10px;font-size:17px">Install it</h2>
              <ol style="margin:0;padding-left:20px;color:#526176;line-height:1.7">
                <li>In WordPress: <strong>Plugins → Add New → Upload Plugin</strong>, then activate it.</li>
                <li>Go to <strong>Service Booking AI → Settings</strong> and paste in your license key — it activates automatically when you save.</li>
              </ol>
              <p style="margin:24px 0 0;color:#6b7890;font-size:13px;line-height:1.6">This license works on one WordPress site at a time. Need help? Reply to this email or contact <a href="mailto:support@bluebootapps.com" style="color:#2563eb">support@bluebootapps.com</a>.</p>
            </div>
          </div>
        </div>`,
    });
    licenses.completeEmailDelivery(licenseKey);
  } catch (err) {
    licenses.releaseEmailDelivery(licenseKey);
    console.error('[license-email] delivery failed', err);
  }
}

module.exports = { sendLicenseEmailOnce, isConfigured };
