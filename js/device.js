// What kind of device we are on. ?ui=phone|tablet|desktop forces one (tests, debugging).

export function detectDevice() {
  const forced = new URLSearchParams(location.search).get('ui');
  if (forced === 'phone' || forced === 'tablet' || forced === 'desktop') return forced;
  const coarse = matchMedia('(pointer: coarse)').matches;
  if (!coarse) return 'desktop';                       // mouse/trackpad first: desktop browser
  return Math.min(screen.width, screen.height) >= 600 ? 'tablet' : 'phone';
}

export function isIOS() {
  const ua = navigator.userAgent || '';
  return /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
}

/** "iPad" (also iPadOS asking for the desktop site, the default) or "iPhone"; null elsewhere. */
export function iosDevice() {
  if (!isIOS()) return null;
  const ua = navigator.userAgent || '';
  return /iPad/.test(ua) || /Macintosh/.test(ua) ? 'iPad' : 'iPhone';
}

export function isStandalone() {
  try { if (matchMedia('(display-mode: standalone)').matches) return true; } catch { /* old */ }
  return navigator.standalone === true;
}

/** Name the hosts show ("X quiere controlar este equipo"), until the user sets one. */
export function defaultDeviceName() {
  const ua = navigator.userAgent || '';
  let dev = 'Navegador';
  if (/iPhone/.test(ua)) dev = 'iPhone';
  else if (/iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) dev = 'iPad';
  else if (/Android/.test(ua)) dev = /Mobile/.test(ua) ? 'Móvil Android' : 'Tablet Android';
  else if (/Windows/.test(ua)) dev = 'PC con Windows';
  else if (/Mac OS X/.test(ua)) dev = 'Mac';
  else if (/CrOS/.test(ua)) dev = 'Chromebook';
  else if (/Linux/.test(ua)) dev = 'PC con Linux';
  return `${dev} (navegador)`;
}
