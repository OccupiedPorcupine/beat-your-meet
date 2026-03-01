"use client";

import { useEffect, useMemo, useState } from "react";
import { useParams, useSearchParams, useRouter } from "next/navigation";
import DocList, { DocMeta } from "@/components/DocList";
import DocViewer from "@/components/DocViewer";

const SERVER_URL =
  process.env.NEXT_PUBLIC_SERVER_URL || "http://localhost:8000";

interface DocDetail {
  filename: string;
  title: string;
  content: string;
}

export default function PostMeetingPageInner() {
  const params = useParams();
  const searchParams = useSearchParams();
  const router = useRouter();

  const roomId = params.id as string;
  const accessCode = searchParams.get("code") ?? "";

  const [docs, setDocs] = useState<DocMeta[]>([]);
  const [activeFilename, setActiveFilename] = useState<string | null>(null);
  const [docDetail, setDocDetail] = useState<DocDetail | null>(null);
  const [loadingList, setLoadingList] = useState(true);
  const [loadingDoc, setLoadingDoc] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [docError, setDocError] = useState<string | null>(null);

  useEffect(() => {
    if (!accessCode) return;
    try {
      sessionStorage.setItem(`postMeetingAccessCode:${roomId}`, accessCode);
    } catch {
      // Best-effort storage only
    }
  }, [accessCode, roomId]);

  useEffect(() => {
    let cancelled = false;
    let intervalId: ReturnType<typeof setInterval> | null = null;

    const fetchDocs = async (silent = false) => {
      if (!silent) setLoadingList(true);
      try {
        const res = await fetch(`${SERVER_URL}/api/rooms/${roomId}/docs`, {
          cache: "no-store",
        });
        if (!res.ok) {
          throw new Error(`Failed to load docs (${res.status})`);
        }
        const data = (await res.json()) as DocMeta[];
        if (cancelled) return;
        setDocs(data);
        setListError(null);
        setLoadingList(false);
        if (data.length > 0 && intervalId) {
          clearInterval(intervalId);
          intervalId = null;
        }
      } catch (err) {
        if (cancelled) return;
        setLoadingList(false);
        setListError(
          err instanceof Error
            ? err.message
            : "Could not load documents yet."
        );
      }
    };

    fetchDocs();
    intervalId = setInterval(() => fetchDocs(true), 3000);

    return () => {
      cancelled = true;
      if (intervalId) clearInterval(intervalId);
    };
  }, [roomId]);

  useEffect(() => {
    if (!docs.length) return;
    if (!activeFilename || !docs.some((doc) => doc.filename === activeFilename)) {
      setActiveFilename(docs[0].filename);
    }
  }, [docs, activeFilename]);

  useEffect(() => {
    if (!activeFilename) return;
    let cancelled = false;
    const controller = new AbortController();

    const fetchDoc = async () => {
      setLoadingDoc(true);
      setDocError(null);
      setDocDetail(null);
      try {
        const res = await fetch(
          `${SERVER_URL}/api/rooms/${roomId}/docs/${activeFilename}`,
          { cache: "no-store", signal: controller.signal }
        );
        if (!res.ok) {
          throw new Error(`Failed to load document (${res.status})`);
        }
        const data = (await res.json()) as DocDetail;
        if (cancelled) return;
        setDocDetail(data);
        setLoadingDoc(false);
      } catch (err) {
        if (cancelled) return;
        if ((err as Error).name === "AbortError") return;
        setLoadingDoc(false);
        setDocError(
          err instanceof Error
            ? err.message
            : "Could not load document."
        );
      }
    };

    fetchDoc();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [activeFilename, roomId]);

  const activeDoc = useMemo(
    () => docs.find((doc) => doc.filename === activeFilename) ?? null,
    [docs, activeFilename]
  );

  return (
    <main className="post-shell">
      <div className="post-noise" aria-hidden="true" />
      <div className="post-glow" aria-hidden="true" />
      <header className="post-header">
        <div className="post-brand">
          <span className="post-brand-name">Beat Your Meet</span>
          <span className="post-brand-divider">·</span>
          <span className="post-brand-sub">Meeting Documents</span>
        </div>
        <div className="post-header-actions">
          <span className="post-room-id">Room {roomId}</span>
          <button
            type="button"
            onClick={() => router.push("/")}
            className="room-home-btn"
          >
            Home
          </button>
        </div>
      </header>
      <div className="post-layout">
        <DocList
          docs={docs}
          activeFilename={activeFilename}
          onSelect={setActiveFilename}
          loading={loadingList}
          error={listError}
        />
        <DocViewer
          doc={activeDoc}
          content={docDetail?.content ?? ""}
          titleOverride={docDetail?.title}
          loading={loadingDoc}
          error={docError}
        />
      </div>
    </main>
  );
}
