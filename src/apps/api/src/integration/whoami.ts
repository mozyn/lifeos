/**
 * Where a Hermes in Docker finds this API (product brief 10 §2, ADR-93): the container's own name
 * and network, asked of Docker's DNS at start. Docker answers a PTR query for a container's address
 * with `<container>.<network>`, so the Hermes prompt is right whatever Dockge or compose called the
 * project. The answer is checked forwards (the container name must resolve to that address); a
 * name with dots is split where the check passes. Without Docker's DNS (outside Docker, Podman
 * without PTR records, tests) the prompt falls back to LIFEOS_NAME: `<name>-api` on `<name>-net`.
 *
 * The queries go to the container's own resolver (Docker's, for its own address); nothing leaves.
 */
import { promises as dns } from 'node:dns';
import { networkInterfaces } from 'node:os';

export interface Identity {
  container: string;
  network: string;
  /** docker: from Docker's DNS; env: from LIFEOS_NAME */
  source: 'docker' | 'env';
}

export const fromName = (name: string): Identity => ({ container: `${name}-api`, network: `${name}-net`, source: 'env' });

const ptrName = (ip: string) => `${ip.split('.').reverse().join('.')}.in-addr.arpa`;

export interface Lookup {
  ptr(name: string): Promise<string[]>;
  a(host: string): Promise<string[]>;
}

function resolver(): Lookup {
  const r = new dns.Resolver({ timeout: 1000, tries: 1 });
  return { ptr: (n) => r.resolvePtr(n), a: (h) => r.resolve4(h) };
}

/** This container's IPv4 addresses (not loopback). */
export function ownAddresses(): string[] {
  return Object.values(networkInterfaces())
    .flat()
    .filter((a): a is NonNullable<typeof a> => !!a && a.family === 'IPv4' && !a.internal)
    .map((a) => a.address);
}

/** The container and network Docker's DNS names for these addresses, or null. */
export async function dockerIdentity(addresses: string[] = ownAddresses(), lookup: Lookup = resolver()): Promise<Identity | null> {
  for (const ip of addresses) {
    const names = await lookup.ptr(ptrName(ip)).catch(() => [] as string[]);
    for (const raw of names) {
      const name = raw.replace(/\.$/, '');
      const dots = [...name.matchAll(/\./g)].map((m) => m.index!);
      for (const i of dots) {
        const container = name.slice(0, i);
        const network = name.slice(i + 1);
        const back = await lookup.a(container).catch(() => [] as string[]);
        if (back.includes(ip)) return { container, network, source: 'docker' };
      }
    }
  }
  return null;
}
