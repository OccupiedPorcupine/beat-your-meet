"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { DocMeta } from "@/components/DocList";

interface DocViewerProps {
  doc: DocMeta | null;
  content: string;
  titleOverride?: string;
  loading: boolean;
  error: string | null;
}

function formatBytes(bytes?: number) {
  if (!Number.isFinite(bytes)) return "—";
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  const mb = kb / 1024;
  return `${mb.toFixed(1)} MB`;
}

function formatTimestamp(value?: string) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}

export default function DocViewer({
  doc,
  content,
  titleOverride,
  loading,
  error,
}: DocViewerProps) {
  const title = titleOverride || doc?.title || "Meeting Document";

  return (
    <section className="post-viewer">
      <header className="post-viewer-header">
        <div>
          <p className="post-viewer-kicker">Meeting File</p>
          <h1 className="post-viewer-title">{title}</h1>
        </div>
        <div className="post-viewer-meta">
          <span>{doc?.filename ?? "—"}</span>
          <span>{formatBytes(doc?.size_bytes)}</span>
          <span>{formatTimestamp(doc?.created_at)}</span>
        </div>
      </header>
      <div className="post-viewer-body">
        {loading && (
          <div className="post-docs-placeholder">
            <div className="post-spinner" aria-hidden="true" />
            <p>Loading document…</p>
          </div>
        )}
        {!loading && error && (
          <div className="post-docs-error">
            <p>{error}</p>
          </div>
        )}
        {!loading && !error && !doc && (
          <div className="post-docs-placeholder">
            <p>Select a document to preview.</p>
          </div>
        )}
        {!loading && !error && doc && !content && (
          <div className="post-docs-placeholder">
            <p>No content available.</p>
          </div>
        )}
        {!loading && !error && content && (
          <article className="doc-markdown">
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              components={{
                table: ({ children }) => (
                  <div className="overflow-x-auto">
                    <table className="doc-table">{children}</table>
                  </div>
                ),
                input: ({ checked }) => (
                  <input
                    type="checkbox"
                    checked={checked}
                    readOnly
                    className="mr-2"
                  />
                ),
              }}
            >
              {content}
            </ReactMarkdown>
          </article>
        )}
      </div>
    </section>
  );
}
