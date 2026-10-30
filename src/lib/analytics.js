import { GA_MEASUREMENT_ID } from '../config.js';

// Google Analytics, loaded only once the player allowed it (lib/privacy.js). Withdrawing stops
// sending through GA's own opt-out flag and drops its cookies.

let loaded = false;

export function enableAnalytics() {
  window[`ga-disable-${GA_MEASUREMENT_ID}`] = false;
  if (loaded) return;
  loaded = true;
  window.dataLayer = window.dataLayer || [];
  // gtag reads the `arguments` object, not an array.
  window.gtag = function gtag() {
    window.dataLayer.push(arguments);
  };
  window.gtag('js', new Date());
  window.gtag('config', GA_MEASUREMENT_ID);
  document.head.append(Object.assign(document.createElement('script'), { async: true, src: `https://www.googletagmanager.com/gtag/js?id=${GA_MEASUREMENT_ID}` }));
}

export function disableAnalytics() {
  window[`ga-disable-${GA_MEASUREMENT_ID}`] = true;
  const domain = location.hostname;
  const parent = domain.split('.').slice(-2).join('.');
  for (const cookie of document.cookie.split(';')) {
    const name = cookie.split('=')[0].trim();
    if (!name.startsWith('_ga')) continue;
    for (const d of ['', `; domain=${domain}`, `; domain=.${parent}`]) {
      document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/${d}`;
    }
  }
}
