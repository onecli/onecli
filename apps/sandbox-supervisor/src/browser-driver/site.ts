/**
 * "Same site": a host's registrable domain, or a subdomain of it. With no
 * public-suffix list at hand, the registrable domain is the last two
 * labels, or three under a country code with a short second-level label
 * (`ynet.co.il`, `bbc.co.uk`, `abc.com.au`). The last two alone would make
 * every `.co.il` host one site. An IP address, or a single label
 * (`localhost`), is its own site.
 */
export const siteOf = (hostname: string): string => {
  if (/^[\d.]+$/.test(hostname) || hostname.includes(":")) return hostname;
  const labels = hostname.split(".");
  const tld = labels.at(-1) ?? "";
  const second = labels.at(-2) ?? "";
  const depth =
    labels.length >= 3 && tld.length === 2 && second.length <= 3 ? 3 : 2;
  return labels.slice(-depth).join(".");
};

/** Whether `hostname` belongs to `site` (see siteOf). */
export const onSite = (hostname: string, site: string): boolean =>
  hostname === site || hostname.endsWith(`.${site}`);

/** A URL's hostname, or "" for one that does not parse. */
export const hostOf = (url: string): string => {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
};
