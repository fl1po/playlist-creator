/**
 * A request's client as a person would name it ("Safari on iPhone"), so a
 * task's log says which of the owner's browsers or devices started it.
 */
export function describeClient(userAgent: string | undefined): string {
  if (!userAgent) return 'an unknown client';
  const browser = browserOf(userAgent);
  const device = deviceOf(userAgent);
  if (browser && device) return `${browser} on ${device}`;
  return userAgent.length > 40 ? `${userAgent.slice(0, 40)}…` : userAgent;
}

function browserOf(ua: string): string | null {
  if (/Edg(A|iOS)?\//.test(ua)) return 'Edge';
  if (/Firefox\/|FxiOS\//.test(ua)) return 'Firefox';
  if (/Chrome\/|CriOS\//.test(ua)) return 'Chrome';
  if (/Version\/[\d.]+.*Safari\//.test(ua)) return 'Safari';
  return null;
}

function deviceOf(ua: string): string | null {
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua)) return 'iPad';
  if (/Android/.test(ua)) return 'Android';
  if (/Macintosh|Mac OS X/.test(ua)) return 'macOS';
  if (/Windows/.test(ua)) return 'Windows';
  if (/Linux|X11/.test(ua)) return 'Linux';
  return null;
}
