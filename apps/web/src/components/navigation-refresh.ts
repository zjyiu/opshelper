"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef } from "react";

const refreshEvent = "opshelper:refresh-current-page";

export function useRouteRefresh() {
  const pathname = usePathname();
  const router = useRouter();

  useEffect(() => {
    router.refresh();
  }, [pathname, router]);
}

export function refreshCurrentPage(router: { refresh: () => void }) {
  router.refresh();
  window.dispatchEvent(new Event(refreshEvent));
}

export function usePageRefresh(handler: () => void) {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;
  useEffect(() => {
    const refresh = () => handlerRef.current();
    window.addEventListener(refreshEvent, refresh);
    return () => window.removeEventListener(refreshEvent, refresh);
  }, []);
}
