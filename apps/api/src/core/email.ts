import { env } from '../config/env.js';

/**
 * Transactional email.
 *
 * Provider-agnostic over HTTP so no SMTP dependency is needed, and so a shop can
 * use whichever service they can actually buy locally. Used for password resets
 * and customer receipts — both of which are useless if they cannot be delivered.
 *
 * Failure is reported, never thrown: a receipt that does not send must not undo
 * a sale, and a reset that does not send must not leak that the address exists.
 */

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
  replyTo?: string;
}

export interface EmailResult {
  sent: boolean;
  provider: string;
  id?: string;
  error?: string;
}

export function emailConfigured(): boolean {
  return Boolean(env.EMAIL_PROVIDER && env.EMAIL_API_KEY && env.EMAIL_FROM);
}

export async function sendEmail(message: EmailMessage): Promise<EmailResult> {
  const provider = env.EMAIL_PROVIDER;
  if (!emailConfigured() || !provider) {
    return { sent: false, provider: 'none', error: 'email is not configured' };
  }

  try {
    switch (provider) {
      case 'resend':
        return await viaResend(message);
      case 'sendgrid':
        return await viaSendgrid(message);
      case 'mailgun':
        return await viaMailgun(message);
      case 'webhook':
        return await viaWebhook(message);
      default:
        return { sent: false, provider, error: 'unknown provider' };
    }
  } catch (err) {
    return { sent: false, provider, error: err instanceof Error ? err.message : 'send failed' };
  }
}

async function viaResend(message: EmailMessage): Promise<EmailResult> {
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.EMAIL_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: env.EMAIL_FROM,
      to: [message.to],
      subject: message.subject,
      text: message.text,
      ...(message.html ? { html: message.html } : {}),
      ...(message.replyTo ? { reply_to: message.replyTo } : {}),
    }),
    signal: AbortSignal.timeout(15_000),
  });
  const body = (await response.json().catch(() => ({}))) as { id?: string; message?: string };
  return response.ok
    ? { sent: true, provider: 'resend', id: body.id }
    : { sent: false, provider: 'resend', error: body.message ?? `HTTP ${response.status}` };
}

async function viaSendgrid(message: EmailMessage): Promise<EmailResult> {
  const response = await fetch('https://api.sendgrid.com/v3/mail/send', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.EMAIL_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      personalizations: [{ to: [{ email: message.to }] }],
      from: { email: env.EMAIL_FROM },
      subject: message.subject,
      content: [
        { type: 'text/plain', value: message.text },
        ...(message.html ? [{ type: 'text/html', value: message.html }] : []),
      ],
    }),
    signal: AbortSignal.timeout(15_000),
  });
  // SendGrid returns 202 with an empty body on success.
  return response.ok
    ? { sent: true, provider: 'sendgrid', id: response.headers.get('x-message-id') ?? undefined }
    : { sent: false, provider: 'sendgrid', error: `HTTP ${response.status}` };
}

async function viaMailgun(message: EmailMessage): Promise<EmailResult> {
  if (!env.EMAIL_MAILGUN_DOMAIN) return { sent: false, provider: 'mailgun', error: 'EMAIL_MAILGUN_DOMAIN is not set' };

  const form = new URLSearchParams({
    from: env.EMAIL_FROM as string,
    to: message.to,
    subject: message.subject,
    text: message.text,
    ...(message.html ? { html: message.html } : {}),
  });

  const response = await fetch(`https://api.mailgun.net/v3/${env.EMAIL_MAILGUN_DOMAIN}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`api:${env.EMAIL_API_KEY}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: form.toString(),
    signal: AbortSignal.timeout(15_000),
  });
  const body = (await response.json().catch(() => ({}))) as { id?: string; message?: string };
  return response.ok
    ? { sent: true, provider: 'mailgun', id: body.id }
    : { sent: false, provider: 'mailgun', error: body.message ?? `HTTP ${response.status}` };
}

/** Escape hatch for a self-hosted relay or a local provider with its own API. */
async function viaWebhook(message: EmailMessage): Promise<EmailResult> {
  if (!env.EMAIL_WEBHOOK_URL) return { sent: false, provider: 'webhook', error: 'EMAIL_WEBHOOK_URL is not set' };
  const response = await fetch(env.EMAIL_WEBHOOK_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.EMAIL_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: env.EMAIL_FROM, ...message }),
    signal: AbortSignal.timeout(15_000),
  });
  return response.ok
    ? { sent: true, provider: 'webhook' }
    : { sent: false, provider: 'webhook', error: `HTTP ${response.status}` };
}
