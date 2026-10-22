/**
 * Which release LifeOS runs (release-version brief, ADR-103). One string names it for the whole
 * app: `LIFEOS_BUILD`, given to both images when they are built (docker/Dockerfile): a tag (v0.1.3)
 * from the published images' CI, the commit (a86a16b, "+" when apps/ or packages/ had changes) from
 * scripts/start.sh, `dev` from a build that named none. The web bundle bakes it in, the API image
 * keeps it in its environment; GET /api/health reports the API's as `release`, and Settings → About
 * shows the page's as one line and says when the API's differs (an update replaces both images,
 * but a phone may hold the old page).
 */

/** The release from a raw LIFEOS_BUILD: trimmed, `dev` when it is empty or not one plain word. */
export function releaseOf(raw: string | null | undefined): string {
  const v = (raw ?? '').trim();
  return /^[0-9A-Za-z][0-9A-Za-z._+-]{0,63}$/.test(v) ? v : 'dev';
}

/** A published tag: a version, with or without its "v" (v0.1.3, 0.2.0-rc.1). */
const TAG = /^v?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]+)?)$/;

/** The release as people read it: a tag always with its "v". */
function releaseKey(release: string): string {
  const r = releaseOf(release);
  const m = TAG.exec(r);
  return m ? `v${m[1]}` : r;
}

/**
 * The release as one line: a tag is the version ("LifeOS v0.1.3"); a commit or `dev` follows the
 * package version it was built at ("LifeOS 0.1.0 · a86a16b", "LifeOS 0.1.0 · dev").
 */
export function releaseName(release: string, version: string): string {
  const key = releaseKey(release);
  return TAG.test(key) ? `LifeOS ${key}` : `LifeOS ${version} · ${key}`;
}

/** Whether the page and the server are different releases; an older server that does not say is not one. */
export function releasesDiffer(page: string, server: string | null | undefined): boolean {
  return typeof server === 'string' && releaseKey(page) !== releaseKey(server);
}
