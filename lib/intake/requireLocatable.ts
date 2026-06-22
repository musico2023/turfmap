/** A scan needs a center point. It can come from map-pin coordinates (the
 *  GBP pick supplies these even for a service-area business with no street
 *  address) OR a geocodable address string. This is the single rule every
 *  intake endpoint shares — never "street address required". */
export function hasLocatableCenter(input: {
  latitude: number | null | undefined;
  longitude: number | null | undefined;
  address: string | null | undefined;
}): boolean {
  const hasCoords =
    typeof input.latitude === 'number' && typeof input.longitude === 'number';
  const hasAddress = Boolean(input.address && input.address.trim().length >= 4);
  return hasCoords || hasAddress;
}
