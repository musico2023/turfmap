/**
 * Small client logo treatment for header/meta surfaces in HTML pages
 * (agency dashboard, share view, etc.).
 *
 * Renders the uploaded client logo if present, otherwise a TurfMap-lime
 * square with the first letter of the business name. Object-contain so
 * tall/wide logos display in full instead of getting cropped, sitting on
 * a near-black background so transparent PNGs look intentional.
 *
 * Sized via the `size` prop (px). Default 28 — small enough to sit
 * inline next to a body-text business name without stealing the eye
 * from the name itself; the portal headers use 36 (`size={36}`) for
 * a more prominent treatment.
 *
 * Lives outside the LogoUploader component because LogoUploader is the
 * EDITOR (with file input + delete button); this is the read-only
 * RENDERER. Keeping them separate avoids dragging the uploader's client
 * hook + state into every page that just wants to show a logo.
 */
export function ClientBrandMark({
  logoUrl,
  businessName,
  size = 28,
}: {
  logoUrl: string | null | undefined;
  businessName: string;
  size?: number;
}) {
  const initial = (businessName.trim().charAt(0) || 'T').toUpperCase();
  const dim = `${size}px`;

  if (logoUrl) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={logoUrl}
        alt={businessName}
        className="rounded-md object-contain border flex-shrink-0"
        style={{
          width: dim,
          height: dim,
          padding: Math.max(2, Math.round(size * 0.08)),
          borderColor: 'var(--color-border)',
          background: '#0a0a0a',
          boxShadow: '0 0 16px #c5ff3a30',
        }}
      />
    );
  }

  return (
    <div
      className="rounded-md flex items-center justify-center font-display font-bold text-black flex-shrink-0"
      style={{
        width: dim,
        height: dim,
        background: 'var(--color-lime)',
        boxShadow: '0 0 16px #c5ff3a40',
        fontSize: Math.round(size * 0.5),
        lineHeight: 1,
      }}
      title={`${businessName} — no logo set`}
    >
      {initial}
    </div>
  );
}
