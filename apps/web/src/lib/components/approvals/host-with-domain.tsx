interface HostWithDomainProps {
  host: string;
  /** The registrable domain the host belongs to, or null when unknown. */
  domain: string | null;
}

/** A host with its registrable domain (the owner a credential goes to) set
 * apart, so a look-alike ("stripe.com.evil.io") reads as what it is. */
export const HostWithDomain = ({ host, domain }: HostWithDomainProps) => {
  // Highlight only on a label boundary: the host IS the domain or ends with
  // "." + domain. "notstripe.com" must not read as owned by "stripe.com".
  const matches = !!domain && (host === domain || host.endsWith(`.${domain}`));
  if (!domain || !matches) {
    return <span className="font-mono">{host}</span>;
  }
  const prefix = host.slice(0, host.length - domain.length);
  return (
    <span className="font-mono">
      <span className="text-muted-foreground">{prefix}</span>
      <mark className="text-foreground rounded bg-amber-200/60 px-0.5 font-semibold dark:bg-amber-500/30">
        {domain}
      </mark>
    </span>
  );
};
