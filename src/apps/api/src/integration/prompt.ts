/**
 * The copy-ready prompt for Hermes (product brief 9 §3–4, ADR-88): `docs/hermes-prompt.md` with the
 * real values filled in. Placeholders are `{{name}}`; a line whose placeholder has no value is left
 * out; `{{?name}}` keeps its line only while `name` has a value and prints nothing itself; the
 * leading HTML comment is the template's own note and never part of the prompt.
 */
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Ctx } from '../context.js';
import { JOB_TIMES } from './jobs.js';
import { fromName, type Identity } from './whoami.js';

const here = dirname(fileURLToPath(import.meta.url));
/** apps/api/{src,dist}/integration → the repository (or /repo in the image) → docs/ */
export const TEMPLATE_PATH = resolve(here, '../../../../docs/hermes-prompt.md');

export function fill(template: string, values: Record<string, string>): string {
  const body = template.replace(/^\s*<!--[\s\S]*?-->\s*/, '');
  const out: string[] = [];
  for (const line of body.split('\n')) {
    const names = [...line.matchAll(/\{\{\??(\w+)\}\}/g)].map((m) => m[1]);
    if (names.some((n) => !values[n])) continue;
    out.push(line.replace(/\{\{(\?)?(\w+)\}\}/g, (_m, flag: string | undefined, n: string) => (flag ? '' : values[n])));
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}

/**
 * The values a prompt is filled with (never the token: that is passed in once). The container and
 * network are the ones Docker's DNS gave at start (ADR-93), else LIFEOS_NAME's.
 */
export function promptValues(ctx: Ctx, id: Identity = fromName(ctx.config.name)) {
  const s = ctx.settings();
  // LIFEOS_PUBLIC_URL, else the address learned from the owner's browser; until then the prompt
  // says it is not known yet (ADR-104)
  const pub = ctx.publicUrl() ?? '';
  const local = `http://localhost:${ctx.config.webPort}/lifeos`;
  return {
    docker_url: `http://${id.container}:8481`,
    container: id.container,
    network: id.network,
    public_url: pub,
    no_public_url: pub ? '' : 'yes',
    // the same machine without Docker: only when it is not already the public address
    local_url: pub === local ? '' : local,
    timezone: ctx.tz(),
    quiet_start: s.quietStart,
    quiet_end: s.quietEnd,
    morning: JOB_TIMES.morning,
    midday: JOB_TIMES.midday,
    evening: JOB_TIMES.evening,
  };
}

/** The template, or null when this build has none (it ships in the image beside the API). */
export async function loadTemplate(): Promise<string | null> {
  return readFile(TEMPLATE_PATH, 'utf8').catch(() => null);
}

export async function renderPrompt(ctx: Ctx, token: string, template?: string, id?: Identity): Promise<string> {
  const t = template ?? (await readFile(TEMPLATE_PATH, 'utf8'));
  return fill(t, { ...promptValues(ctx, id), token });
}
