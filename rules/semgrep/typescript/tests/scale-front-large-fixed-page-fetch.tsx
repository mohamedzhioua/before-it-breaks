// Test cases for scale-front-large-fixed-page-fetch (invented notes platform).
import React, { useEffect, useState } from 'react';

declare const api: any;

export function NoteList({ workspaceId, query }: { workspaceId: string; query: string }) {
  const [notes, setNotes] = useState<any[]>([]);

  useEffect(() => {
    // ruleid: scale-front-large-fixed-page-fetch
    api.get('/notes', { params: { workspaceId, page: 1, size: 1000 } }).then((r: any) => setNotes(r.data));
  }, [workspaceId]);

  const visible = notes.filter((n) => n.title.includes(query)).slice(0, 20);
  return <ul>{visible.map((n) => <li key={n.id}>{n.title}</li>)}</ul>;
}

export function MemberPicker({ workspaceId }: { workspaceId: string }) {
  useEffect(() => {
    // ruleid: scale-front-large-fixed-page-fetch
    api.get('/members', { params: { workspaceId, pageSize: 500 } });
  }, [workspaceId]);
  return null;
}

export function NotePage({ workspaceId, page }: { workspaceId: string; page: number }) {
  useEffect(() => {
    // ok: scale-front-large-fixed-page-fetch
    api.get('/notes', { params: { workspaceId, page, size: 25 } });
  }, [workspaceId, page]);
  return null;
}

// A width or a character limit is not a page size, but the rule only sees a
// number under one of its keys; keep such constants below the threshold or
// rename the key.
export const editorLimits = {
  // ok: scale-front-large-fixed-page-fetch
  limit: 120,
};
