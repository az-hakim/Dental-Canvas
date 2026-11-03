import { Cloud, Sparkles } from "lucide-react";
import { AccountStep } from "./account-step";

/**
 * First-run account offer for the browser/PWA and mobile shells. Desktop
 * installs already get this as a step in the setup wizard; this modal makes
 * the same offer on a fresh web install without hijacking an existing install
 * (it only renders while accountMode is `unset`).
 */
export function AccountFirstRun({ onDone }: { onDone: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/95 p-4 backdrop-blur-sm">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="account-first-run-title"
        className="flex max-h-[calc(100vh-2rem)] w-full max-w-md flex-col overflow-hidden rounded-2xl border bg-card shadow-2xl"
      >
        <div className="border-b bg-gradient-to-br from-primary/10 to-transparent px-6 pb-5 pt-6">
          <div className="flex items-center gap-2 text-sm font-medium text-primary">
            <Sparkles className="h-4 w-4" /> Optional cloud backup
          </div>
          <h1 id="account-first-run-title" className="mt-2 flex items-center gap-2 text-xl font-semibold tracking-tight">
            <Cloud className="h-5 w-5" /> Back up your practice
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Use an account to sync patients and appointments across devices. It's entirely
            optional — Dental Canvas works offline forever.
          </p>
        </div>
        <div className="force-scrollbar min-h-0 flex-1 overflow-y-auto px-6 py-5">
          <AccountStep onDone={onDone} />
        </div>
      </div>
    </div>
  );
}
