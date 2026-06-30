"use client";

import type { ReactNode } from "react";

export function Card({
  title,
  subtitle,
  right,
  children,
}: {
  title?: string;
  subtitle?: ReactNode;
  right?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="rounded-xl border border-black/10 bg-white/60 p-6 shadow-sm backdrop-blur dark:border-white/10 dark:bg-white/3">
      {(title || right) && (
        <div className="mb-4 flex items-start justify-between gap-4">
          <div>
            {title && <h2 className="text-lg font-semibold">{title}</h2>}
            {subtitle && <p className="mt-1 text-sm text-black/55 dark:text-white/55">{subtitle}</p>}
          </div>
          {right}
        </div>
      )}
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
  disabled,
}: {
  label: string;
  help?: ReactNode;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  placeholder?: string;
  required?: boolean;
  disabled?: boolean;
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
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        className="mt-1 w-full rounded-md border border-black/15 bg-transparent px-3 py-2 text-sm outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 disabled:opacity-50 dark:border-white/20"
      />
      {help && <span className="mt-1 block text-xs text-black/55 dark:text-white/55">{help}</span>}
    </label>
  );
}

export function TextArea({
  label,
  help,
  value,
  onChange,
  placeholder,
  rows = 5,
  mono = false,
  disabled,
}: {
  label?: string;
  help?: ReactNode;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  rows?: number;
  mono?: boolean;
  disabled?: boolean;
}) {
  return (
    <label className="block">
      {label && <span className="text-sm font-medium">{label}</span>}
      <textarea
        value={value}
        rows={rows}
        placeholder={placeholder}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        className={`mt-1 w-full rounded-md border border-black/15 bg-transparent px-3 py-2 text-sm outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 disabled:opacity-50 dark:border-white/20 ${
          mono ? "font-mono" : ""
        }`}
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
  size = "md",
  disabled,
}: {
  children: ReactNode;
  onClick?: () => void;
  type?: "button" | "submit";
  variant?: "primary" | "ghost" | "danger";
  size?: "sm" | "md";
  disabled?: boolean;
}) {
  const sizes = { sm: "px-3 py-1.5 text-xs", md: "px-4 py-2 text-sm" }[size];
  const base = `rounded-md font-medium transition disabled:opacity-50 disabled:pointer-events-none ${sizes}`;
  const styles = {
    primary: "bg-blue-600 text-white shadow-sm hover:bg-blue-700",
    ghost: "border border-black/15 hover:bg-black/5 dark:border-white/20 dark:hover:bg-white/10",
    danger: "bg-red-600 text-white shadow-sm hover:bg-red-700",
  }[variant];
  return (
    <button type={type} onClick={onClick} disabled={disabled} className={`${base} ${styles}`}>
      {children}
    </button>
  );
}

export function Badge({
  tone = "gray",
  children,
}: {
  tone?: "gray" | "green" | "red" | "blue" | "amber";
  children: ReactNode;
}) {
  const tones = {
    gray: "bg-black/10 text-black/60 dark:bg-white/10 dark:text-white/60",
    green: "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300",
    red: "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300",
    blue: "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300",
    amber: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300",
  }[tone];
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${tones}`}>
      {children}
    </span>
  );
}

export function Banner({ kind, children }: { kind: "error" | "success" | "info" | "warning"; children: ReactNode }) {
  const styles = {
    error: "bg-red-50 text-red-700 dark:bg-red-950/40 dark:text-red-300",
    success: "bg-green-50 text-green-700 dark:bg-green-950/40 dark:text-green-300",
    info: "bg-blue-50 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300",
    warning: "bg-amber-50 text-amber-800 dark:bg-amber-950/40 dark:text-amber-200",
  }[kind];
  return <div className={`whitespace-pre-wrap rounded-md px-3 py-2 text-sm ${styles}`}>{children}</div>;
}

export function Select({
  value,
  onChange,
  children,
  disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  children: ReactNode;
  disabled?: boolean;
}) {
  return (
    <select
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
      className="rounded-md border border-black/15 bg-transparent px-3 py-2 text-sm outline-none transition focus:border-blue-500 disabled:opacity-50 dark:border-white/20 dark:bg-neutral-900"
    >
      {children}
    </select>
  );
}
