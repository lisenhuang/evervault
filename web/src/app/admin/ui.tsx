"use client";

import type { ReactNode } from "react";

export function Card({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <div className="rounded-xl border border-black/10 bg-black/[0.02] p-6 shadow-sm dark:border-white/15 dark:bg-white/5">
      {title && <h2 className="mb-4 text-lg font-semibold">{title}</h2>}
      {children}
    </div>
  );
}

export function Field({
  label,
  help,
  value,
  onChange,
  type = "text",
  placeholder,
  required,
}: {
  label: string;
  help?: ReactNode;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  placeholder?: string;
  required?: boolean;
}) {
  return (
    <label className="block">
      <span className="text-sm font-medium">
        {label}
        {required && <span className="text-red-500"> *</span>}
      </span>
      <input
        type={type}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className="mt-1 w-full rounded-md border border-black/15 bg-transparent px-3 py-2 text-sm outline-none focus:border-blue-500 dark:border-white/20"
      />
      {help && <span className="mt-1 block text-xs text-black/55 dark:text-white/55">{help}</span>}
    </label>
  );
}

export function Button({
  children,
  onClick,
  type = "button",
  variant = "primary",
  disabled,
}: {
  children: ReactNode;
  onClick?: () => void;
  type?: "button" | "submit";
  variant?: "primary" | "ghost" | "danger";
  disabled?: boolean;
}) {
  const base = "rounded-md px-4 py-2 text-sm font-medium transition disabled:opacity-50";
  const styles = {
    primary: "bg-blue-600 text-white hover:bg-blue-700",
    ghost: "border border-black/15 hover:bg-black/5 dark:border-white/20 dark:hover:bg-white/10",
    danger: "text-red-600 hover:bg-red-50 dark:hover:bg-red-950/40",
  }[variant];
  return (
    <button type={type} onClick={onClick} disabled={disabled} className={`${base} ${styles}`}>
      {children}
    </button>
  );
}

export function Banner({ kind, children }: { kind: "error" | "success" | "info"; children: ReactNode }) {
  const styles = {
    error: "bg-red-50 text-red-700 dark:bg-red-950/40 dark:text-red-300",
    success: "bg-green-50 text-green-700 dark:bg-green-950/40 dark:text-green-300",
    info: "bg-blue-50 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300",
  }[kind];
  return <div className={`rounded-md px-3 py-2 text-sm ${styles}`}>{children}</div>;
}
