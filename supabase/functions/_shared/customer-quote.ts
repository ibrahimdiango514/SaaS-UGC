/** Deliberate allowlist: never expose supplier prices, currency, margins or raw errors. */
export function customerQuote(quote: { available: boolean; error_code: string | null } | null) {
  if (!quote) return null;
  return {
    available: quote.available === true,
    error_code: quote.error_code === 'PROMPT_REQUIRED' ? 'PROMPT_REQUIRED' : null,
  };
}
