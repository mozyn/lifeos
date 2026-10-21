/**
 * Browser notifications on this device (product brief 8 §6, ADR-80): whether the browser can take
 * them, and turning them on (permission, a Web Push subscription with the server's public key,
 * handed to the API) or off. The service worker shows them (`public/push-sw.js`).
 */
import { api } from './api';

export type PushState = 'on' | 'off' | 'denied' | 'insecure' | 'unsupported';

const supported = () => typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

async function registration(): Promise<ServiceWorkerRegistration | null> {
  if (!supported()) return null;
  const reg = await navigator.serviceWorker.getRegistration();
  return reg ?? null;
}

export async function pushState(): Promise<PushState> {
  if (!window.isSecureContext) return 'insecure';
  if (!supported()) return 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  const reg = await registration();
  if (!reg) return 'unsupported';
  const sub = await reg.pushManager.getSubscription().catch(() => null);
  return sub && Notification.permission === 'granted' ? 'on' : 'off';
}

const fromB64url = (s: string): Uint8Array => {
  const b = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
};

/** A short name for this device in the list ("Chrome on Android"). */
function deviceLabel(): string {
  const ua = navigator.userAgent;
  const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'A browser';
  const os = /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Mac OS X/.test(ua) ? 'macOS' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : '';
  return os ? `${browser} on ${os}` : browser;
}

/** Ask for permission, subscribe with the server's key and register this device. */
export async function enablePush(): Promise<PushState> {
  const st = await pushState();
  if (st === 'insecure' || st === 'unsupported' || st === 'denied') return st;
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return permission === 'denied' ? 'denied' : 'off';
  const reg = await registration();
  if (!reg) return 'unsupported';
  const { publicKey } = await api<{ publicKey: string }>('api/push');
  let sub = await reg.pushManager.getSubscription();
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: fromB64url(publicKey) as BufferSource });
  await api('api/push/subscribe', { method: 'POST', json: { subscription: sub.toJSON(), label: deviceLabel() } });
  return 'on';
}

/** Forget this device on the server and drop its subscription. */
export async function disablePush(): Promise<PushState> {
  const reg = await registration();
  const sub = await reg?.pushManager.getSubscription().catch(() => null);
  if (sub) {
    await api('api/push/unsubscribe', { method: 'POST', json: { endpoint: sub.endpoint } }).catch(() => undefined);
    await sub.unsubscribe().catch(() => undefined);
  }
  return pushState();
}

/** On Settings: a device whose browser still holds a subscription is registered again (idempotent). */
export async function refreshPush(): Promise<void> {
  const reg = await registration();
  const sub = await reg?.pushManager.getSubscription().catch(() => null);
  if (sub && Notification.permission === 'granted') await api('api/push/subscribe', { method: 'POST', json: { subscription: sub.toJSON(), label: deviceLabel() } }).catch(() => undefined);
}

export async function testPush(): Promise<{ sent: number; failed: number }> {
  const reg = await registration();
  const sub = await reg?.pushManager.getSubscription().catch(() => null);
  return api('api/push/test', { method: 'POST', json: sub ? { endpoint: sub.endpoint } : {} });
}
