-- Grant the new structured get_weather tool to the main agent so it answers
-- weather directly (keyless open-meteo) instead of guessing from web search.
-- Also give it to ingestion, which already does web lookups.

UPDATE agents SET allowed_tools = array_append(allowed_tools, 'get_weather'), updated_at = now()
WHERE name = 'main' AND NOT ('get_weather' = ANY(allowed_tools));

UPDATE agents SET allowed_tools = array_append(allowed_tools, 'get_weather'), updated_at = now()
WHERE name = 'ingestion' AND NOT ('get_weather' = ANY(allowed_tools));
