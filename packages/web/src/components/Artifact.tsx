import { QRCodeSVG } from 'qrcode.react';
import type { SwarmState } from '../store';

/**
 * The artifact panel — the thing the team built, running inside the thing that
 * watched them build it.
 *
 * This is the punchline, so it gets the whole stage area rather than a corner.
 * The QR code is not decoration: a cloudflared hostname is four random words
 * nobody can type from the back of a room, and the close of this demo is a
 * roomful of people hitting the link at once and watching the chart move.
 */
export function Artifact({ state }: { state: SwarmState }) {
  const url = state.deployUrl;
  if (!url) return null;

  const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1)/i.test(url);

  return (
    <div className="artifact">
      <iframe
        className="artifact-frame"
        src={url}
        title="The deployed application"
        // No sandbox attribute: this is the app the team just built and the
        // whole point is watching it work, live stream and all.
      />

      <aside className="artifact-side">
        <span className="placard">Scan to open</span>
        <div className="qr">
          <QRCodeSVG value={url} size={220} level="M" bgColor="#ffffff" fgColor="#0e131c" />
        </div>

        <a className="artifact-url" href={url} target="_blank" rel="noreferrer">
          {url.replace(/^https?:\/\//, '')}
        </a>

        {isLocal ? (
          <p className="artifact-note">
            This is a local address, so only this machine can open it. Install <code>cloudflared</code>{' '}
            and set <code>SWARM_DEPLOY_TARGET=tunnel</code> for a public link the room can scan.
          </p>
        ) : (
          <p className="artifact-note">Public link. Anyone here can open it right now.</p>
        )}
      </aside>
    </div>
  );
}
