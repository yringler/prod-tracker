import type {
  PushSubscriptionRequest,
  VapidPublicKeyResponse,
} from '@shared/contracts';
import type { Env } from '../env';
import { type AuthedCtx, error, json, readJson } from '../http';

export function vapidPublicKey(env: Env): Response {
  const body: VapidPublicKeyResponse = { publicKey: env.VAPID_PUBLIC_KEY };
  return json(body);
}

export async function subscribe(req: Request, ctx: AuthedCtx): Promise<Response> {
  const body = await readJson<PushSubscriptionRequest>(req);
  if (!body?.endpoint || !body.keys?.p256dh || !body.keys?.auth) {
    return error(400, 'invalid subscription');
  }
  await ctx.dao.saveSubscription(ctx.accountId, body.endpoint, body.keys.p256dh, body.keys.auth);
  return json({ ok: true });
}
