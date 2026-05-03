import { net, protocol } from 'electron';
import { pathToFileURL } from 'node:url';
import { existsSync } from 'node:fs';
import { getArtifactPath } from '../db/evidence';

/**
 * Custom `obelisk://` protocol so issue + PR bodies can link to local
 * artifacts without exposing absolute filesystem paths.
 *
 * Supported routes:
 *   obelisk://artifact/<artifact-id>   → resolves to evidence_artifacts.path
 *
 * The renderer's CSP allows obelisk: in img-src and link rels through the
 * `connect-src` allow rule wired in index.html. The protocol is registered
 * as standard + secure + bypassesCSP for fetches initiated within Obelisk.
 */
const SCHEME = 'obelisk';

export function registerObeliskProtocolSchemes(): void {
  // Must be called BEFORE app.whenReady().
  protocol.registerSchemesAsPrivileged([
    {
      scheme: SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        stream: true,
      },
    },
  ]);
}

export function registerObeliskProtocolHandler(): void {
  protocol.handle(SCHEME, async (request) => {
    try {
      const url = new URL(request.url);
      if (url.hostname === 'artifact') {
        const id = decodeURIComponent(url.pathname.replace(/^\/+/, ''));
        const path = getArtifactPath(id);
        if (!path) return new Response('artifact not found', { status: 404 });
        if (!existsSync(path)) return new Response('artifact missing on disk', { status: 410 });
        return net.fetch(pathToFileURL(path).toString());
      }
      return new Response('unknown obelisk route', { status: 404 });
    } catch (e) {
      return new Response(`bad request: ${(e as Error).message}`, { status: 400 });
    }
  });
}

/** Build an obelisk:// URL for an artifact. Centralizes the format. */
export function obeliskArtifactUrl(artifactId: string): string {
  return `obelisk://artifact/${encodeURIComponent(artifactId)}`;
}
