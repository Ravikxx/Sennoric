// Single source of truth for the frontend origins this Worker trusts for
// credentialed CORS. Split into its own module so index.js and
// chatGeneration.js can both import it without a circular dependency
// (index.js is what imports ChatGeneration from chatGeneration.js).
//
export const WEB_ORIGIN = 'https://sennoric.com'
export const LEGACY_WEB_ORIGIN = 'https://axion.amplifiedsmp.org'
export const ALLOWED_WEB_ORIGINS = [WEB_ORIGIN, LEGACY_WEB_ORIGIN]
