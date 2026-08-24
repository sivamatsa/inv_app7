/* Web Push subscribe/unsubscribe (023_web_push.sql). The public VAPID key
   is meant to be public (same status as the Supabase anon key) - the
   matching private key lives only in the send-web-push Edge Function's
   secrets, never here. Generated once for this build (see README) via a
   short Python script (cryptography package) since this machine has no
   Node - not a placeholder, a real P-256 key pair. */
window.App = window.App || {};

App.push = (function () {
  const VAPID_PUBLIC_KEY = 'BOomucASX8r5R122VlqGSyB5QG5H3PlyqVgRQxOzgBRwi7Cggt0WzQyWZh8JWxqQ2bzlw2LpwxO_A4RSeMxKeR8';

  function urlBase64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
    const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    const rawData = window.atob(base64);
    const outputArray = new Uint8Array(rawData.length);
    for (let i = 0; i < rawData.length; ++i) outputArray[i] = rawData.charCodeAt(i);
    return outputArray;
  }

  function isSupported() {
    return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  }

  async function getSubscription() {
    if (!isSupported()) return null;
    const reg = await navigator.serviceWorker.ready;
    return reg.pushManager.getSubscription();
  }

  async function subscribe() {
    if (!isSupported()) throw new Error('Push notifications are not supported in this browser.');
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') throw new Error('Notification permission was not granted.');
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
    });
    const raw = sub.toJSON();
    await App.api.savePushSubscription({ endpoint: raw.endpoint, p256dh: raw.keys.p256dh, authKey: raw.keys.auth });
    return sub;
  }

  async function unsubscribe() {
    const sub = await getSubscription();
    if (!sub) return;
    try { await App.api.deletePushSubscriptionByEndpoint(sub.endpoint); } catch (e) { /* row may already be gone */ }
    await sub.unsubscribe();
  }

  return { isSupported, getSubscription, subscribe, unsubscribe };
})();
