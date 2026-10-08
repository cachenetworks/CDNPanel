import ipaddr from 'ipaddr.js';

/** Returns true if `ip` matches any entry (plain IP or CIDR) in the list. */
export function ipMatchesAny(ip: string, entries: readonly string[]): boolean {
  let addr: ipaddr.IPv4 | ipaddr.IPv6;
  try {
    addr = normalize(ipaddr.parse(ip));
  } catch {
    return false;
  }
  for (const raw of entries) {
    const entry = raw.trim();
    if (!entry) continue;
    try {
      if (entry.includes('/')) {
        const [range, bits] = ipaddr.parseCIDR(entry);
        const r = normalize(range);
        if (r.kind() === addr.kind() && addr.match([r, r.kind() === 'ipv4' && range.kind() === 'ipv6' ? bits - 96 : bits] as [typeof r, number])) {
          return true;
        }
      } else {
        const other = normalize(ipaddr.parse(entry));
        if (other.kind() === addr.kind() && other.toString() === addr.toString()) return true;
      }
    } catch {
      // Ignore malformed entries (validated on input anyway).
    }
  }
  return false;
}

function normalize(addr: ipaddr.IPv4 | ipaddr.IPv6): ipaddr.IPv4 | ipaddr.IPv6 {
  if (addr.kind() === 'ipv6' && (addr as ipaddr.IPv6).isIPv4MappedAddress()) {
    return (addr as ipaddr.IPv6).toIPv4Address();
  }
  return addr;
}

export function isValidIpOrCidr(entry: string): boolean {
  try {
    if (entry.includes('/')) ipaddr.parseCIDR(entry);
    else ipaddr.parse(entry);
    return true;
  } catch {
    return false;
  }
}

/** Privacy-preserving truncation: IPv4 /24, IPv6 /48. */
export function anonymizeIp(ip: string): string {
  try {
    const addr = normalize(ipaddr.parse(ip));
    if (addr.kind() === 'ipv4') {
      const o = (addr as ipaddr.IPv4).octets;
      return `${o[0]}.${o[1]}.${o[2]}.0`;
    }
    const parts = (addr as ipaddr.IPv6).parts;
    return `${parts.slice(0, 3).map((p) => p.toString(16)).join(':')}::`;
  } catch {
    return '';
  }
}

/** Loopback, RFC 1918 / unique-local, link-local and CGNAT addresses. */
export function isPrivateIp(ip: string): boolean {
  try {
    const range = normalize(ipaddr.parse(ip)).range();
    return ['loopback', 'private', 'uniqueLocal', 'linkLocal', 'carrierGradeNat'].includes(range);
  } catch {
    return false;
  }
}
