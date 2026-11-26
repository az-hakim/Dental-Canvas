import { useState } from "react";
import { Link2, Server } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { apiBaseUrl, setApiBaseUrl } from "@/lib/api-base";

/**
 * Point this install at a hosted Dental Canvas deployment (for example the
 * Vercel web app). The desktop/offline backend keeps working locally; when a
 * server URL is saved, every `/api` call — and the sign-in requirement — follow
 * it instead.
 *
 * The value lives in localStorage so it survives app updates; it is not a
 * secret. The app reloads after saving because the shell reconnects at boot.
 */
export function ServerConnectionCard() {
  const current = apiBaseUrl();
  const [value, setValue] = useState(current);
  const [saved, setSaved] = useState(false);

  const hosting = typeof window !== "undefined" ? window.location.origin : "";
  const dirty = value.trim().replace(/\/+$/, "") !== current;

  function save(next: string | null) {
    setApiBaseUrl(next);
    setSaved(true);
    window.setTimeout(() => window.location.reload(), 400);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Server className="h-4 w-4" /> Server connection
        </CardTitle>
        <p className="text-sm text-muted-foreground">
          {current
            ? "This app reads and writes practice data on the server below and signs in with that practice's account."
            : "This app uses its own local backend. Connect it to your hosted web practice to sign in with the same account you use in the browser, and share the same patients and appointments."}
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="space-y-1.5">
          <Label htmlFor="server-url">Server URL</Label>
          <Input
            id="server-url"
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              setSaved(false);
            }}
            placeholder="https://your-practice.vercel.app"
            inputMode="url"
            autoComplete="off"
          />
          <p className="text-xs text-muted-foreground">
            {current ? (
              <>
                Currently connected to <span className="font-medium">{current}</span>.
              </>
            ) : (
              <>
                Running locally on <span className="font-medium">{hosting}</span>.
              </>
            )}{" "}
            A hosted server requires signing in, and each clinic's data is isolated.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            onClick={() => save(value.trim() || null)}
            disabled={!dirty}
            className="gap-2"
          >
            <Link2 className="h-4 w-4" /> {saved ? "Reconnecting…" : "Connect"}
          </Button>
          {current && (
            <Button variant="outline" onClick={() => save(null)}>
              Use this device
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
