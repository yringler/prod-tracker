// The ONE sanctioned place an email-shaped string is composed. Everything upstream
// (dao, cron/escalate, routes, index) only produces the channel-neutral
// NotificationPayload; this turns it into a subject + plain-text body.

import type { NotificationPayload } from '../../contract';

export interface RenderedEmail {
  subject: string;
  text: string;
}

export function renderEmail(payload: NotificationPayload): RenderedEmail {
  return {
    subject: payload.title,
    text: `${payload.body}\n\n${payload.deepLink}`,
  };
}
