/**
 * Salutation réellement alignée sur le fuseau horaire de l'utilisateur.
 *
 * - le fuseau vient du navigateur (`Intl`), jamais d'une heure serveur ;
 * - si le fuseau est inconnu ou invalide, on retourne une salutation neutre
 *   plutôt qu'une heure potentiellement fausse ;
 * - la plage « Bon après-midi » s'arrête à 18 h locales.
 */
export interface LocalGreeting {
  greeting: 'Bonjour' | 'Bon après-midi' | 'Bonsoir' | 'Bienvenue';
  timeZone: string | null;
  hour: number | null;
  reliable: boolean;
}

export function browserTimeZone(): string | null {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (!zone) return null;
    new Intl.DateTimeFormat('fr-FR', { timeZone: zone }).format(new Date());
    return zone;
  } catch {
    return null;
  }
}

export function localGreeting(date: Date = new Date(), timeZone: string | null = browserTimeZone()): LocalGreeting {
  if (!timeZone) {
    return { greeting: 'Bienvenue', timeZone: null, hour: null, reliable: false };
  }
  try {
    const parts = new Intl.DateTimeFormat('fr-FR', {
      hour: '2-digit',
      hour12: false,
      timeZone,
    }).formatToParts(date);
    const rawHour = Number(parts.find((part) => part.type === 'hour')?.value ?? '');
    if (!Number.isFinite(rawHour)) {
      return { greeting: 'Bienvenue', timeZone: null, hour: null, reliable: false };
    }
    const hour = rawHour % 24;
    const greeting = hour < 12 ? 'Bonjour' : hour < 18 ? 'Bon après-midi' : 'Bonsoir';
    return { greeting, timeZone, hour, reliable: true };
  } catch {
    return { greeting: 'Bienvenue', timeZone: null, hour: null, reliable: false };
  }
}

export function localTimeLabel(date: Date, timeZone: string | null): string | null {
  if (!timeZone) return null;
  try {
    return new Intl.DateTimeFormat('fr-FR', {
      hour: '2-digit',
      minute: '2-digit',
      timeZone,
    }).format(date);
  } catch {
    return null;
  }
}
