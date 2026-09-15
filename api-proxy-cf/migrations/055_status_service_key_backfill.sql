-- Migration 055: backfill renamed status_checks service keys (2026-09-15)
--
-- status.js's SERVICES list was renamed twice (axion_api -> sennoric_api on
-- 2026-09-12, lumen -> fresco earlier) but the historical rows in
-- status_checks kept their old service key. getStatusSnapshot() groups rows
-- by the CURRENT SERVICES keys, so every day of history recorded under the
-- old key became invisible once the rename shipped — this is why the
-- Sennoric API row on /status only showed data from the day of the rename
-- onward, despite checks having run continuously since 2026-08-10.

UPDATE status_checks SET service = 'sennoric_api' WHERE service = 'axion_api';
UPDATE status_checks SET service = 'fresco' WHERE service = 'lumen';

UPDATE status_incidents SET service = 'sennoric_api' WHERE service = 'axion_api';
UPDATE status_incidents SET service = 'fresco' WHERE service = 'lumen';
