/** Public Supabase project URL shared by the browser and the development relay. */
export const DEFAULT_SUPABASE_URL = 'https://xbuuhfwobrafcbgtdgjx.supabase.co';

/** The optional development override must never send a user token to an arbitrary host. */
export function isLocalBusinessGrowFunctionUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:'
      && ['localhost', '127.0.0.1'].includes(url.hostname)
      && url.port === '54321'
      && url.pathname === '/functions/v1/business-grow'
      && !url.username && !url.password && !url.search && !url.hash;
  } catch {
    return false;
  }
}
