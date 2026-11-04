import { lookup as dnsLookup } from 'node:dns';
import { BlockList, isIP } from 'node:net';

/** Everything a public form must never be able to make the server call: loopback, private, link-local, metadata. */
const blocked = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 4], ['240.0.0.0', 4],
  ['168.63.129.16', 32], // Azure platform endpoint (wireserver, DNS)
] as const) blocked.addSubnet(net, prefix, 'ipv4');
// ::/96 IPv4-compatible, 64:ff9b::/96 NAT64, 2002::/16 6to4 and fec0::/10 site-local all embed or reach an IPv4 or internal address.
for (const [net, prefix] of [['::', 96], ['::1', 128], ['64:ff9b::', 96], ['2002::', 16], ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8]] as const) blocked.addSubnet(net, prefix, 'ipv6');

export function isPrivateAddress(ip: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped) return blocked.check(mapped[1]!, 'ipv4');
  const family = isIP(ip);
  return family === 0 ? true : blocked.check(ip, family === 4 ? 'ipv4' : 'ipv6');
}

type LookupCallback = (err: Error | null, address: string | { address: string; family: number }[], family?: number) => void;

/**
 * A DNS lookup that refuses private addresses at connect time. Checking the name first and
 * connecting later would let a rebinding DNS server answer differently the second time.
 */
export function guardedLookup(allowPrivate: boolean) {
  return (hostname: string, options: { all?: boolean; family?: number }, callback: LookupCallback): void => {
    dnsLookup(hostname, { all: true, family: options.family }, (err, addresses) => {
      if (err) return callback(err, '');
      const bad = addresses.find((a) => isPrivateAddress(a.address));
      if (bad && !allowPrivate) return callback(new Error(`refusing to connect to a private address (${bad.address})`), '');
      if (options.all) return callback(null, addresses);
      const first = addresses[0];
      if (!first) return callback(new Error('no address found'), '');
      return callback(null, first.address, first.family);
    });
  };
}
