/** Compatibility boundary. Legacy clients interpret available=true as a USD
 * quote and dereference billing_units. Never let them display a fictitious $0.
 * New clients use verified; billable credits remain in the estimate envelope.
 * No provider-controlled text or pricing metadata crosses this boundary. */
export function customerQuote(quote: { available: boolean; error_code: string | null } | null) {
  if (!quote) return null;
  return {
    available: false,
    verified: quote.available === true,
    error_code: quote.error_code === 'PROMPT_REQUIRED' ? 'PROMPT_REQUIRED' : null,
    error_message: 'Consultez le coût en crédits VYORA avant de confirmer.',
    billing_units: [] as string[],
  };
}
