"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

// Auth + chrome live in layout.tsx; the bare /admin index sends you to the default section.
export default function AdminIndex() {
  const router = useRouter();
  useEffect(() => {
    router.replace("/admin/chat");
  }, [router]);
  return null;
}
