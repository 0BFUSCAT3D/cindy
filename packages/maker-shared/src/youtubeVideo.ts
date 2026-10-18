/** Public watch URLs are pages, not media bytes. Only known YouTube hosts become embeds. */
export function youtubeVideo(source: string): { id: string; embed: string; watch: string; poster: string } | null {
  try {
    const url = new URL(source);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.port) return null;
    const host = url.hostname.toLowerCase();
    let id: string | null = null;
    if (host === 'youtu.be') id = /^\/([\w-]{11})\/?$/.exec(url.pathname)?.[1] ?? null;
    else if (['youtube.com', 'www.youtube.com', 'm.youtube.com', 'www.youtube-nocookie.com'].includes(host)) {
      id = url.pathname === '/watch' ? url.searchParams.get('v')
        : /^\/(?:embed|shorts|live)\/([\w-]{11})\/?$/.exec(url.pathname)?.[1] ?? null;
    }
    if (!id || !/^[\w-]{11}$/.test(id)) return null;
    const value = url.searchParams.get('start') ?? url.searchParams.get('t') ?? '';
    const match = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s?)?$/.exec(value);
    const seconds = match ? Number(match[1] ?? 0) * 3600 + Number(match[2] ?? 0) * 60 + Number(match[3] ?? 0) : 0;
    const start = Number.isSafeInteger(seconds) && seconds > 0 ? seconds : 0;
    return {
      id,
      embed: `https://www.youtube-nocookie.com/embed/${id}?playsinline=1&autoplay=0${start ? `&start=${start}` : ''}`,
      watch: `https://www.youtube.com/watch?v=${id}${start ? `&t=${start}` : ''}`,
      poster: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
    };
  } catch { return null; }
}

/** Host navigation gate: no arbitrary query parameters or non-player pages. */
export function isYoutubeEmbedUrl(source: string): boolean {
  return youtubeVideo(source)?.embed === source;
}

/** Player login/help links leave the sandbox; account pages never enter it. */
export function youtubePlayerExternalUrl(source: string, target: string): string | null {
  if (!isYoutubeEmbedUrl(source)) return null;
  try {
    const url = new URL(target);
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
    if (url.hostname === 'support.google.com' && url.pathname.startsWith('/youtube/')) return url.href;
    if (url.hostname === 'accounts.google.com'
      || ['youtube.com', 'www.youtube.com', 'm.youtube.com', 'www.youtube-nocookie.com', 'youtu.be'].includes(url.hostname)) {
      // Use the browser's own login context, without forwarding sandbox login
      // continuations or copying credentials back into the embedded player.
      return youtubeVideo(target)?.watch ?? youtubeVideo(source)!.watch;
    }
  } catch { /* Invalid or non-web targets remain blocked. */ }
  return null;
}
