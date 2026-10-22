import { releaseOf } from '@lifeos/shared';

/** The API's version (spec §12): its package's, reported beside the release. */
export const VERSION = '0.1.0';

/**
 * The release this API runs (release-version brief, ADR-103): the LIFEOS_BUILD its image was built
 * with, kept in the image's environment (docker/Dockerfile): a tag from the published images' CI,
 * a commit from scripts/start.sh, `dev` when the build named none. GET /api/health and
 * /api/system/about report it as `release`; Settings → About compares it with the page's.
 */
export const RELEASE = releaseOf(process.env.LIFEOS_BUILD);
