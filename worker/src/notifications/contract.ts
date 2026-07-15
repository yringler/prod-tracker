// Worker-internal notification contract. These types describe DELIVERY and the
// adapter interface — they are server-only and are deliberately NOT in shared/
// (that would needlessly widen the isomorphic surface).
//
// INVARIANT: the app worker never composes a vendor-shaped string. It hands the
// adapter a channel-neutral NotificationPayload; the adapter (and only the
// adapter) renders vendor content. `describe()` and `beginSetup()` stay split:
// describe() is static/cacheable, beginSetup() mints live time-boxed state.

import type {
  NotifierDescriptor,
  SetupInstructions,
  LinkStatus,
} from '@shared/notifications';

export interface NotificationPayload {
  title: string;
  body: string;
  deepLink: string;
  urgency: 'normal' | 'high';
  // channel-neutral. NO vendor markdown, NO vendor formatting.
}

export interface DeliverRequest {
  userId: string;
  payload: NotificationPayload;
  idempotencyKey: string;
}

export type DeliverResult =
  | { status: 'delivered' }
  | { status: 'not_linked' } // fall through to the next channel
  | { status: 'failed'; retryable: boolean };

export interface NotifierAdapter {
  describe(): Promise<NotifierDescriptor>;
  beginSetup(userId: string): Promise<SetupInstructions>;
  getStatus(userId: string): Promise<LinkStatus>;
  deliver(req: DeliverRequest): Promise<DeliverResult>;
  unlink(userId: string): Promise<void>;
}
