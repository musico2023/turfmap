/**
 * Postcode extraction from a freeform address string.
 *
 * Why this exists: Nominatim normalizes postcodes to its own database
 * record, which doesn't always match what the operator typed. Anthony
 * hit this on Kidcrew's Don Mills location — typed `M3B 3S6` (the real
 * Canada Post code), Nominatim's parse returned `M3B 2S7`, and the
 * audit then flagged Google + Apple Maps (which correctly show M3B 3S6)
 * as inconsistencies against the wrong canonical.
 *
 * Fix: when the operator's typed address already contains a valid
 * postcode, treat THAT as authoritative and ignore Nominatim's
 * normalized version. Everything else (street/city/region/country)
 * Nominatim is still better at — only postcode is high-precision +
 * easy to extract from operator input.
 */

const CANADIAN_POSTAL = /\b([A-Z]\d[A-Z])[\s-]?(\d[A-Z]\d)\b/i;
const US_ZIP = /\b(\d{5})(-\d{4})?\b/;

/**
 * Returns the postcode the operator literally typed in the address
 * string, or null if no postcode pattern is found. Canadian codes are
 * normalized to "A1A 1A1" form (uppercase, single space). US ZIPs are
 * returned as-is (5 digits or ZIP+4).
 *
 * Doesn't validate that the postcode is a real one — just that it
 * matches the format. The geocoder's lat/lng confirmation catches
 * truly bogus input.
 */
export function extractPostcodeFromAddress(
  address: string | null | undefined
): string | null {
  if (!address) return null;
  const text = address.trim();
  const ca = text.match(CANADIAN_POSTAL);
  if (ca) {
    const normalized = `${ca[1].toUpperCase()} ${ca[2].toUpperCase()}`;
    return normalized;
  }
  const us = text.match(US_ZIP);
  if (us) {
    return us[2] ? `${us[1]}${us[2]}` : us[1];
  }
  return null;
}
