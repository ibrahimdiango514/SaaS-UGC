-- Prefer verified default gemini-2.5-flash (priority 10) ahead of slower/less stable gemini-3.5-flash (priority 11)
-- across business_analysis and sales_analysis so manual Gemini selection starts on the most reliable model.
-- Shift through a temporary offset to satisfy UNIQUE (role_key, priority).

UPDATE saas_business.ai_routing_rules
SET priority = priority + 1000
WHERE provider_key = 'gemini'
  AND role_key IN ('business_analysis', 'sales_analysis')
  AND model_key IN ('gemini-2.5-flash', 'gemini-3.5-flash');

UPDATE saas_business.ai_routing_rules
SET priority = CASE model_key
  WHEN 'gemini-2.5-flash' THEN 10
  WHEN 'gemini-3.5-flash' THEN 11
  ELSE priority
END
WHERE provider_key = 'gemini'
  AND role_key IN ('business_analysis', 'sales_analysis')
  AND model_key IN ('gemini-2.5-flash', 'gemini-3.5-flash');
