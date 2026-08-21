import type { ArenaState } from '../store';

const FRESH_MS = 5000;

/** Files as they appear and change. A revision badge marks a rewritten file. */
export function Workspace({ state }: { state: ArenaState }) {
  const files = Object.values(state.files).sort((a, b) => a.path.localeCompare(b.path));

  return (
    <section className="bay">
      <header>
        <span className="placard">Workspace</span>
        <span className="placard">{files.length} files</span>
      </header>
      <div className="body files">
        {files.length === 0 && <p className="empty">No files yet. The engineers write them here.</p>}
        {files.map((file) => (
          <div
            className="file"
            key={file.path}
            data-fresh={state.now !== null && state.now - file.at < FRESH_MS}
          >
            <span className="path">{file.path}</span>
            {file.revisions > 1 && <span className="rev">v{file.revisions}</span>}
            <span className="by">{file.by}</span>
            <span className="size">{file.bytes.toLocaleString()}b</span>
          </div>
        ))}
      </div>
    </section>
  );
}
