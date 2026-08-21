import dns from 'node:dns';
import net from 'node:net';
import { ChannelError, ErrorCode } from '../errors.js';

const PRIVATE_IPV4_CIDRS = [
  '0.0.0.0/8',
  '10.0.0.0/8',
  '127.0.0.0/8',
  '169.254.0.0/16',
  '172.16.0.0/12',
  '192.168.0.0/16',
  '100.64.0.0/10',
  '192.0.0.0/24',
  '192.0.2.0/24',
  '198.18.0.0/15',
  '198.51.100.0/24',
  '203.0.113.0/24',
  '224.0.0.0/4',
  '240.0.0.0/4',
];

function ipToInt(ip) {
  return ip.split('.').reduce((acc, oct) => (acc << 8) + parseInt(oct, 10), 0) >>> 0;
}

function isIPv4InCIDR(ip, cidr) {
  const [base, bits] = cidr.split('/');
  const mask = parseInt(bits, 10);
  const shift = 32 - mask;
  return (ipToInt(ip) >>> shift) === (ipToInt(base) >>> shift);
}

function isPrivateIPv4(ip) {
  return PRIVATE_IPV4_CIDRS.some((cidr) => isIPv4InCIDR(ip, cidr));
}

function expandIPv6(ip) {
  const lower = ip.toLowerCase();
  const v4Mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (v4Mapped) {
    return { v4mapped: true, ipv4: v4Mapped[1] };
  }
  let parts;
  const dblColon = lower.indexOf('::');
  if (dblColon >= 0) {
    const left = lower.slice(0, dblColon).split(':').filter(Boolean);
    const right = lower.slice(dblColon + 2).split(':').filter(Boolean);
    const missing = 8 - left.length - right.length;
    if (missing < 0) return null;
    parts = [...left, ...Array(missing).fill('0000'), ...right];
  } else {
    parts = lower.split(':');
  }
  if (parts.length !== 8) return null;
  return { v4mapped: false, groups: parts.map((p) => p.padStart(4, '0')) };
}

function isBlockedIPv6(ip) {
  const expanded = expandIPv6(ip);
  if (!expanded) return true;
  if (expanded.v4mapped) {
    return isPrivateIPv4(expanded.ipv4);
  }
  const g = expanded.groups;
  const first = parseInt(g[0], 16);
  if (g.slice(0, 7).every((x) => x === '0000') && g[7] === '0001') return true;
  if (g.every((x) => x === '0000')) return true;
  if ((first & 0xffc0) === 0xfe80) return true;
  if ((first & 0xfe00) === 0xfc00) return true;
  if ((first & 0xff00) === 0xff00) return true;
  if (g[5] === 'ffff' && g.slice(0, 5).every((x) => x === '0000')) {
    const g6 = parseInt(g[6], 16);
    const g7 = parseInt(g[7], 16);
    const ipv4 = `${(g6 >> 8) & 0xff}.${g6 & 0xff}.${(g7 >> 8) & 0xff}.${g7 & 0xff}`;
    if (isPrivateIPv4(ipv4)) return true;
  }
  if (g.slice(0, 6).every((x) => x === '0000') && g[6] !== '0000') {
    const g6 = parseInt(g[6], 16);
    const g7 = parseInt(g[7], 16);
    const ipv4 = `${(g6 >> 8) & 0xff}.${g6 & 0xff}.${(g7 >> 8) & 0xff}.${g7 & 0xff}`;
    if (isPrivateIPv4(ipv4)) return true;
  }
  return false;
}

export function hostAllowed(host, allowlist) {
  if (!allowlist || !allowlist.length) return false;
  const h = String(host).toLowerCase().replace(/\.$/, '');
  for (const entry of allowlist) {
    const e = String(entry).toLowerCase().replace(/\.$/, '');
    if (h === e) return true;
    if (e.startsWith('*.') && h.endsWith(e.slice(1))) return true;
  }
  return false;
}

export async function assertPublicUrl(url, allowlist = null) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch (err) {
    throw new ChannelError(ErrorCode.SSRF_BLOCKED, `invalid URL: ${url}`, err);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ChannelError(
      ErrorCode.SSRF_BLOCKED,
      `blocked protocol: ${parsed.protocol}`,
    );
  }
  const host = parsed.hostname;
  // 白名单豁免（企业内网 CDN/专有云场景）
  if (hostAllowed(host, allowlist)) return;
  let addresses;
  if (net.isIP(host)) {
    addresses = [{ address: host }];
  } else {
    try {
      addresses = await dns.promises.lookup(host, { all: true });
    } catch (err) {
      throw new ChannelError(
        ErrorCode.SSRF_BLOCKED,
        `dns lookup failed for ${host}`,
        err,
      );
    }
  }
  if (!addresses || addresses.length === 0) {
    throw new ChannelError(ErrorCode.SSRF_BLOCKED, `no DNS records for ${host}`);
  }
  for (const { address } of addresses) {
    const kind = net.isIP(address);
    if (kind === 4) {
      if (isPrivateIPv4(address)) {
        throw new ChannelError(
          ErrorCode.SSRF_BLOCKED,
          `private IP blocked: ${address}`,
        );
      }
    } else if (kind === 6) {
      if (isBlockedIPv6(address)) {
        throw new ChannelError(
          ErrorCode.SSRF_BLOCKED,
          `blocked IPv6: ${address}`,
        );
      }
    } else {
      throw new ChannelError(
        ErrorCode.SSRF_BLOCKED,
        `unrecognized IP format: ${address}`,
      );
    }
  }
}
