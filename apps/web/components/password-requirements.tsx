"use client";

import * as React from "react";
import { Check, Circle } from "lucide-react";
import { cn } from "@/lib/utils";

// Mirrors the rules in packages/shared/src/validation.ts (passwordSchema) —
// keep in sync if that schema changes.
const CHARACTER_CLASSES = [
  { label: "Lowercase letter", test: (v: string) => /[a-z]/.test(v) },
  { label: "Uppercase letter", test: (v: string) => /[A-Z]/.test(v) },
  { label: "Number", test: (v: string) => /[0-9]/.test(v) },
  { label: "Symbol", test: (v: string) => /[^a-zA-Z0-9]/.test(v) },
];

function Criterion({ met, children }: { met: boolean; children: React.ReactNode }) {
  return (
    <li className={cn("flex items-center gap-1.5", met ? "text-green-600" : "text-muted-foreground")}>
      {met ? <Check className="h-3.5 w-3.5 shrink-0" /> : <Circle className="h-3.5 w-3.5 shrink-0" />}
      {children}
    </li>
  );
}

export function PasswordRequirements({
  password,
  confirmPassword,
}: {
  password: string;
  confirmPassword?: string;
}) {
  const lengthMet = password.length >= 8 && password.length <= 128;
  const classesMet = CHARACTER_CLASSES.filter((c) => c.test(password)).length;

  return (
    <ul className="flex flex-col gap-0.5 text-xs">
      <Criterion met={lengthMet}>8-128 characters</Criterion>
      <Criterion met={classesMet >= 2}>
        At least 2 of: {CHARACTER_CLASSES.map((c) => c.label.toLowerCase()).join(", ")}
      </Criterion>
      {confirmPassword !== undefined && (
        <Criterion met={confirmPassword.length > 0 && confirmPassword === password}>
          Passwords match
        </Criterion>
      )}
    </ul>
  );
}
