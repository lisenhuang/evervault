"use client";

import { api } from "./adminApi";
import StorageForm from "./StorageForm";
import { Button } from "./ui";

export default function Dashboard({ email, onLogout }: { email: string; onLogout: () => void }) {
  async function logout() {
    await api("/api/admin/logout", { method: "POST" });
    onLogout();
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <p className="text-sm text-black/60 dark:text-white/60">
          Signed in as <strong>{email}</strong>
        </p>
        <Button variant="ghost" onClick={logout}>
          Log out
        </Button>
      </div>

      <StorageForm />
    </div>
  );
}
