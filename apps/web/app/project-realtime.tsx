"use client";

import { useEffect, useTransition } from "react";
import { useRouter } from "next/navigation";

export function ProjectRealtime({ projectId }: { projectId: string }) {
  const router = useRouter();
  const [, startTransition] = useTransition();

  useEffect(() => {
    const events = new EventSource(`/api/v1/projects/${encodeURIComponent(projectId)}/events`);
    events.addEventListener("project-refresh", () => startTransition(() => router.refresh()));
    events.addEventListener("access-revoked", () => {
      events.close();
      router.replace("/");
      router.refresh();
    });
    return () => events.close();
  }, [projectId, router, startTransition]);

  return null;
}
