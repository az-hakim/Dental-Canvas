import { useEffect, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, FileUp, Loader2, Upload } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { api } from "@/api";
import { toast } from "@/components/ui/toast";

/**
 * Bulk import of a patient list exported from another practice system.
 *
 * The dialog never guesses silently: it shows which columns were recognised,
 * which were ignored, and the status of every row (new, already on file,
 * unreadable) before anything is written. The server does the parsing and the
 * matching (see src/server/patient-import.ts), so the preview here is exactly
 * what the import will do.
 */

type Status = "new" | "duplicate" | "invalid";

interface PreviewRow {
  line: number;
  status: Status;
  reason: string | null;
  duplicate_of: number | null;
  duplicate_of_line: number | null;
  warnings: string[];
  patient: {
    first_name: string;
    last_name: string;
    phone: string | null;
    email: string | null;
    date_of_birth: string | null;
  };
}

interface Preview {
  columns: Record<string, number>;
  labels: Record<string, string>;
  unmapped: string[];
  total: number;
  counts: Record<Status, number>;
  rows: PreviewRow[];
  truncated: boolean;
}

const FIELD_LABELS: Record<string, string> = {
  first_name: "First name",
  last_name: "Last name",
  full_name: "Full name",
  phone: "Phone",
  email: "Email",
  date_of_birth: "Date of birth",
  address: "Address",
  notes: "Notes",
  patient_gender: "Gender",
  medical_alerts: "Alerts",
  referral_source: "Referral",
};

const TEMPLATE = [
  "First name,Last name,Phone,Email,Date of birth,Address,Notes",
  "Jane,Cooper,555-0100,jane@example.com,1988-03-22,12 Elm Street,Referred by Dr Lee",
  "Marcus,Hale,555-0117,,,,",
].join("\n");

const STATUS_STYLE: Record<Status, string> = {
  new: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200",
  duplicate: "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200",
  invalid: "bg-rose-100 text-rose-800 dark:bg-rose-950 dark:text-rose-200",
};

const STATUS_TEXT: Record<Status, string> = {
  new: "New",
  duplicate: "On file",
  invalid: "Unreadable",
};

export function ImportPatientsDialog({
  open,
  onOpenChange,
  onImported,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onImported: (created: number) => void;
}) {
  const [fileName, setFileName] = useState("");
  const [csv, setCsv] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [reading, setReading] = useState(false);
  const [importing, setImporting] = useState(false);
  const [includeDuplicates, setIncludeDuplicates] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) return;
    setFileName("");
    setCsv("");
    setPreview(null);
    setReading(false);
    setImporting(false);
    setIncludeDuplicates(false);
  }, [open]);

  async function readFile(file: File) {
    if (file.size > 2 * 1024 * 1024) {
      toast.error("That file is larger than 2 MB. Import it in parts.");
      return;
    }
    setReading(true);
    setPreview(null);
    setFileName(file.name);
    try {
      const text = await file.text();
      setCsv(text);
      const result = await api<Preview>("POST", "/api/patients/import/preview", { csv: text });
      setPreview(result);
      setIncludeDuplicates(false);
    } catch (err) {
      setCsv("");
      toast.error((err as Error).message);
    } finally {
      setReading(false);
    }
  }

  async function runImport() {
    if (!preview) return;
    const count = preview.counts.new + (includeDuplicates ? preview.counts.duplicate : 0);
    if (count === 0) return;
    setImporting(true);
    try {
      const result = await api<{ created: number; duplicates: number; invalid: number }>(
        "POST",
        "/api/patients/import",
        { csv, skip_duplicates: !includeDuplicates },
      );
      const skipped = result.duplicates;
      toast.success(
        `Imported ${result.created} ${result.created === 1 ? "patient" : "patients"}` +
          (skipped ? ` — ${skipped} already on file` : ""),
      );
      onImported(result.created);
      onOpenChange(false);
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setImporting(false);
    }
  }

  function downloadTemplate() {
    const url = URL.createObjectURL(new Blob([TEMPLATE], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = "dental-canvas-patients-template.csv";
    link.click();
    URL.revokeObjectURL(url);
  }

  const mapped = preview ? Object.entries(preview.columns) : [];
  const importCount = preview ? preview.counts.new + (includeDuplicates ? preview.counts.duplicate : 0) : 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileUp className="h-4 w-4 text-primary" />
            Import patients from a CSV
          </DialogTitle>
          <DialogDescription>
            Export your list from the old system (Excel and Google Sheets both save CSV) and check the
            preview before anything is added. Nobody on file is changed or deleted.
          </DialogDescription>
        </DialogHeader>

        <input
          ref={inputRef}
          type="file"
          accept=".csv,text/csv,text/plain"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            // Allow choosing the same file twice after fixing it.
            e.target.value = "";
            if (file) void readFile(file);
          }}
        />

        {!preview && (
          <div className="space-y-3">
            <button
              type="button"
              onClick={() => inputRef.current?.click()}
              disabled={reading}
              className="flex w-full flex-col items-center gap-2 rounded-xl border border-dashed border-border/70 bg-card/50 px-6 py-10 text-center transition-colors hover:border-primary/50 hover:bg-primary/[0.03] disabled:opacity-60"
            >
              {reading ? (
                <Loader2 className="h-6 w-6 animate-spin text-primary" />
              ) : (
                <Upload className="h-6 w-6 text-primary" />
              )}
              <span className="text-sm font-medium">
                {reading ? `Reading ${fileName}…` : "Choose a CSV file"}
              </span>
              <span className="text-xs text-muted-foreground">
                A “Name” column is enough. Phone, email, date of birth, address, notes, alerts and
                referral are picked up when present.
              </span>
            </button>
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
              <span>Dates are read as MM/DD/YYYY unless the day is over 12.</span>
              <Button type="button" variant="ghost" size="sm" className="h-7 rounded-full px-3 text-xs" onClick={downloadTemplate}>
                Download a template
              </Button>
            </div>
          </div>
        )}

        {preview && (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-100 px-2.5 py-1 font-semibold text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200">
                <CheckCircle2 className="h-3.5 w-3.5" />
                {preview.counts.new} new
              </span>
              {preview.counts.duplicate > 0 && (
                <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-100 px-2.5 py-1 font-semibold text-amber-900 dark:bg-amber-950 dark:text-amber-200">
                  {preview.counts.duplicate} already on file
                </span>
              )}
              {preview.counts.invalid > 0 && (
                <span className="inline-flex items-center gap-1.5 rounded-full bg-rose-100 px-2.5 py-1 font-semibold text-rose-800 dark:bg-rose-950 dark:text-rose-200">
                  <AlertTriangle className="h-3.5 w-3.5" />
                  {preview.counts.invalid} unreadable
                </span>
              )}
              <span className="ml-auto truncate text-muted-foreground" title={fileName}>
                {fileName}
              </span>
            </div>

            <p className="text-xs text-muted-foreground">
              {mapped.length > 0
                ? `Read as ${mapped.map(([field, index]) => `${FIELD_LABELS[field] ?? field} ← “${preview.labels[field] ?? ""}”`).join(", ")}`
                : "No columns were recognised."}
              {preview.unmapped.length > 0 && ` · ignored: ${preview.unmapped.join(", ")}`}
            </p>

            <div className="max-h-[42vh] overflow-auto rounded-lg border">
              <Table>
                <TableHeader className="sticky top-0 z-10 bg-background">
                  <TableRow>
                    <TableHead className="w-12 text-right">#</TableHead>
                    <TableHead>Patient</TableHead>
                    <TableHead className="hidden sm:table-cell">Phone</TableHead>
                    <TableHead className="hidden sm:table-cell">Date of birth</TableHead>
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {preview.rows.map((row) => (
                    <TableRow key={row.line}>
                      <TableCell className="text-right text-xs text-muted-foreground">{row.line}</TableCell>
                      <TableCell className="font-medium">
                        {row.patient.last_name}
                        {row.patient.first_name ? `, ${row.patient.first_name}` : ""}
                      </TableCell>
                      <TableCell className="hidden text-xs text-muted-foreground sm:table-cell">
                        {row.patient.phone ?? "—"}
                      </TableCell>
                      <TableCell className="hidden text-xs text-muted-foreground sm:table-cell">
                        {row.patient.date_of_birth ?? "—"}
                      </TableCell>
                      <TableCell>
                        <span
                          className={`inline-flex whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-medium ${STATUS_STYLE[row.status]}`}
                          title={row.reason ?? undefined}
                        >
                          {STATUS_TEXT[row.status]}
                        </span>
                        {(row.reason || row.warnings.length > 0) && (
                          <span className="mt-0.5 block text-[11px] text-muted-foreground">
                            {[
                              row.duplicate_of_line ? `${row.reason} (line ${row.duplicate_of_line})` : row.reason,
                              ...row.warnings,
                            ]
                              .filter(Boolean)
                              .join(" · ")}
                          </span>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>

            {preview.truncated && (
              <p className="text-xs text-muted-foreground">
                Showing the first {preview.rows.length} of {preview.total} rows — all {preview.total} are
                counted above.
              </p>
            )}

            {preview.counts.duplicate > 0 && (
              <label className="flex items-start gap-2 text-xs text-muted-foreground">
                <input
                  type="checkbox"
                  checked={includeDuplicates}
                  onChange={(e) => setIncludeDuplicates(e.target.checked)}
                  className="mt-0.5 h-3.5 w-3.5 accent-[var(--primary)]"
                />
                <span>
                  Import the {preview.counts.duplicate} rows that look like patients already on file — only
                  if they are genuinely different people.
                </span>
              </label>
            )}
          </div>
        )}

        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={importing}>
            Cancel
          </Button>
          {preview && (
            <Button
              type="button"
              variant="outline"
              onClick={() => inputRef.current?.click()}
              disabled={importing || reading}
            >
              Choose another file
            </Button>
          )}
          {preview && (
            <Button type="button" onClick={() => void runImport()} disabled={importing || importCount === 0}>
              {importing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
              Import {importCount} {importCount === 1 ? "patient" : "patients"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
