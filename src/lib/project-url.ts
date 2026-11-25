/**
 * The public URL of a project, as the API returns it in `project.url`
 * An Enterprise app lives at `https://<app>.<customer>.sota.io`
 * and has no `<slug>.sota.io` host, so tools show this value instead of
 * composing one from the slug.
 *
 * The slug-based fallback is only for an API from before the `url` field;
 * such an API has no Enterprise projects, so the composed URL is right there.
 */
export function projectUrl(project: { slug: string; url?: string | null }): string {
  if (typeof project.url === 'string' && project.url !== '') {
    return project.url;
  }
  return `https://${project.slug}.sota.io`;
}
