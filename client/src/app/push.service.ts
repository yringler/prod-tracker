import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { ApiService } from './api.service';

// Registers the push service worker, asks permission, and stores the
// subscription server-side so the cron poller can notify this device.
@Injectable({ providedIn: 'root' })
export class PushService {
  private api = inject(ApiService);

  async enable(): Promise<'granted' | 'denied' | 'unsupported'> {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) return 'unsupported';

    const reg = await navigator.serviceWorker.register('/sw-push.js');
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') return 'denied';

    const { publicKey } = await firstValueFrom(this.api.vapidPublicKey());
    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey),
    });

    const json = sub.toJSON();
    const keys = json.keys ?? {};
    await firstValueFrom(
      this.api.subscribePush({
        endpoint: json.endpoint ?? '',
        keys: { p256dh: keys['p256dh'] ?? '', auth: keys['auth'] ?? '' },
      }),
    );
    return 'granted';
  }
}

function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}
