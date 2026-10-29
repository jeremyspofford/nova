-- Why a message hasn't gone out: quiet hours (it goes when they end, if its rule still stands),
-- needs_ok (Nova wasn't sure; only the person releases it), or withdrawn (its rule was paused,
-- removed or turned off before it could go; it never will).
ALTER TABLE message ADD COLUMN hold TEXT CHECK (hold IN ('quiet', 'needs_ok', 'withdrawn'));
UPDATE message SET hold = 'quiet' WHERE delivered_at IS NULL;
