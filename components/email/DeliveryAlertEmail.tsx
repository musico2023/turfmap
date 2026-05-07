/**
 * Operator-internal scan-delivery alert. Fires from the
 * check-scan-delivery cron when buyers paid in the last 24-25 hours
 * but their initial scan hasn't completed — those buyers are inside
 * the 24-hour refund window per the TurfMap terms.
 *
 * Single email per cron run, listing all at-risk clients with
 * deep-links into the agency dashboard. Operator clicks through and
 * fires a manual re-scan.
 *
 * This is the "[TurfMap ops]"-prefixed internal email. Brand shell
 * matches the rest of the React Email lineup (EmailLayout) so all
 * outbound mail looks like the same product.
 */

import {
  EmailLayout,
  H1,
  P,
  PSmall,
} from './EmailLayout';

export type DeliveryAlertClient = {
  businessName: string;
  publicId: string;
  hoursSincePurchase: number;
  billingMode: string;
  buyerEmail: string | null;
  dashboardUrl: string;
};

export type DeliveryAlertEmailProps = {
  clients: DeliveryAlertClient[];
};

export function DeliveryAlertEmail({ clients }: DeliveryAlertEmailProps) {
  const count = clients.length;
  const headline = `${count} client${count === 1 ? '' : 's'} awaiting first scan`;
  return (
    <EmailLayout preview={`${headline} — refund window`}>
      <PSmall>
        <span style={{
          textTransform: 'uppercase',
          letterSpacing: '0.18em',
          color: '#71717a',
          fontWeight: 600,
        }}>
          TurfMap ops alert
        </span>
      </PSmall>
      <H1>{headline}</H1>
      <P>
        These buyers paid via Stripe Checkout but their initial scan
        hasn&rsquo;t completed yet. They&rsquo;re inside the 24-hour
        refund window per the TurfMap terms — fire a re-scan from the
        dashboard before it closes, or expect a refund request.
      </P>
      <table
        role="presentation"
        width="100%"
        cellPadding={0}
        cellSpacing={0}
        style={{
          background: '#0d0d0d',
          border: '1px solid #27272a',
          borderRadius: 6,
          borderCollapse: 'separate',
          borderSpacing: 0,
          margin: '0 0 16px',
        }}
      >
        <tbody>
          {clients.map((c) => {
            const remaining = Math.max(0, 24 - c.hoursSincePurchase);
            const remColor = remaining <= 4 ? '#ff8e8e' : '#ffb86b';
            return (
              <tr key={c.publicId}>
                <td
                  style={{
                    padding: '8px 12px',
                    borderBottom: '1px solid #27272a',
                  }}
                >
                  <a
                    href={c.dashboardUrl}
                    style={{
                      color: '#c5ff3a',
                      textDecoration: 'none',
                      fontWeight: 600,
                    }}
                  >
                    {c.businessName}
                  </a>
                  <div
                    style={{
                      fontSize: 11,
                      color: '#71717a',
                      marginTop: 2,
                    }}
                  >
                    {c.billingMode}
                    {c.buyerEmail ? ` · ${c.buyerEmail}` : ''}
                  </div>
                </td>
                <td
                  style={{
                    padding: '8px 12px',
                    borderBottom: '1px solid #27272a',
                    fontFamily: 'ui-monospace, monospace',
                    fontSize: 12,
                    color: remColor,
                    textAlign: 'right',
                  }}
                >
                  {c.hoursSincePurchase}h since · {remaining}h left
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <PSmall>
        Click any name to jump to the agency dashboard, then hit{' '}
        <strong>Re-scan turf</strong> to retry. If the issue is upstream
        (DataForSEO outage, geocoding failure), you&rsquo;ll see the error
        inline and can decide whether to refund proactively.
      </PSmall>
    </EmailLayout>
  );
}
