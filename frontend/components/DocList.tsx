"use client";

export interface DocMeta {
  filename: string;
  title: string;
  size_bytes: number;
  created_at: string;
}

interface DocListProps {
  docs: DocMeta[];
  activeFilename: string | null;
  onSelect: (filename: string) => void;
  loading: boolean;
  error: string | null;
}

export default function DocList({
  docs,
  activeFilename,
  onSelect,
  loading,
  error,
}: DocListProps) {
  return (
    <aside className="post-docs-panel">
      <div className="post-docs-header">
        <span>Documents</span>
        <span className="post-docs-count">{docs.length}</span>
      </div>
      <div className="post-docs-body">
        {loading && (
          <div className="post-docs-placeholder">
            <div className="post-spinner" aria-hidden="true" />
            <p>Scanning for documents…</p>
          </div>
        )}
        {!loading && error && (
          <div className="post-docs-error">
            <p>{error}</p>
          </div>
        )}
        {!loading && !error && docs.length === 0 && (
          <div className="post-docs-placeholder">
            <p>No documents yet.</p>
            <span>Hang tight — Beat is finishing up.</span>
          </div>
        )}
        {!loading && !error && docs.length > 0 && (
          <div className="post-docs-list">
            {docs.map((doc) => {
              const isActive = doc.filename === activeFilename;
              return (
                <button
                  key={doc.filename}
                  type="button"
                  onClick={() => onSelect(doc.filename)}
                  className={isActive ? "post-doc-item active" : "post-doc-item"}
                >
                  <span className="post-doc-dot" aria-hidden="true" />
                  <div className="post-doc-text">
                    <span className="post-doc-title">{doc.title}</span>
                    <span className="post-doc-sub">{doc.filename}</span>
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </aside>
  );
}
