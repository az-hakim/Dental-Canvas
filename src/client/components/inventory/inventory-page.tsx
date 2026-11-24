import { useEffect, useMemo, useState } from "react";
import { useDataRefresh } from "@/hooks/use-data-refresh";
import {
  AlertTriangle,
  Archive,
  Boxes,
  CalendarClock,
  ClipboardList,
  History,
  Minus,
  PackagePlus,
  Plus,
  RefreshCw,
  Settings2,
  Trash2,
} from "lucide-react";
import { api } from "@/api";
import { useApp } from "@/context";
import { cn, formatDate, formatMoney } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import type {
  InventoryAlert,
  InventoryAlertSeverity,
  InventoryItem,
  InventoryMovement,
  InventoryScanResult,
} from "@/types";

const CATEGORIES = [
  "Restorative",
  "Anesthetics",
  "Sterilization",
  "Surgical",
  "Endodontic",
  "Prosthodontic",
  "PPE",
  "Consumables",
  "Other",
];
const UNITS = ["piece", "box", "pack", "cartridge", "pair", "set"];

interface InventorySettings {
  inventory_expiry_alert_days: number;
  inventory_alert_email: string;
}

const SEVERITY_STYLE: Record<InventoryAlertSeverity, string> = {
  critical: "bg-rose-100 text-rose-800 border-rose-200 dark:bg-rose-950 dark:text-rose-200 dark:border-rose-800",
  warning: "bg-amber-100 text-amber-800 border-amber-200 dark:bg-amber-950 dark:text-amber-200 dark:border-amber-800",
  info: "bg-sky-100 text-sky-800 border-sky-200 dark:bg-sky-950 dark:text-sky-200 dark:border-sky-800",
};

function statusFor(item: InventoryItem): { label: string; cls: string } | null {
  if (item.min_threshold > 0 && item.current_stock === 0) {
    return { label: "Out of stock", cls: "bg-rose-100 text-rose-800 border-rose-200 dark:bg-rose-950 dark:text-rose-200 dark:border-rose-800" };
  }
  if (item.min_threshold > 0 && item.current_stock <= item.min_threshold) {
    return { label: "Low", cls: "bg-amber-100 text-amber-800 border-amber-200 dark:bg-amber-950 dark:text-amber-200 dark:border-amber-800" };
  }
  return { label: "In stock", cls: "bg-emerald-100 text-emerald-800 border-emerald-200 dark:bg-emerald-950 dark:text-emerald-200 dark:border-emerald-800" };
}

function expiryFor(item: InventoryItem, expiryDays: number): { label: string; cls: string; date: string } | null {
  if (!item.expiry_date) return null;
  const today = new Date().toISOString().slice(0, 10);
  if (item.expiry_date <= today) return { label: "Expired", cls: "bg-rose-100 text-rose-800 border-rose-200 dark:bg-rose-950 dark:text-rose-200 dark:border-rose-800", date: item.expiry_date };
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() + expiryDays);
  if (item.expiry_date <= cutoff.toISOString().slice(0, 10)) return { label: "Expiring", cls: "bg-amber-100 text-amber-800 border-amber-200 dark:bg-amber-950 dark:text-amber-200 dark:border-amber-800", date: item.expiry_date };
  return { label: "OK", cls: "bg-muted text-muted-foreground border-border", date: item.expiry_date };
}

export function InventoryPage() {
  const app = useApp();
  const [items, setItems] = useState<InventoryItem[]>([]);
  const [alerts, setAlerts] = useState<InventoryAlert[]>([]);
  const [settings, setSettings] = useState<InventorySettings>({ inventory_expiry_alert_days: 30, inventory_alert_email: "" });
  const [loading, setLoading] = useState(true);
  const [scanning, setScanning] = useState(false);

  const [q, setQ] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | "out_of_stock" | "low_stock" | "expiring" | "expired">("all");
  const [categoryFilter, setCategoryFilter] = useState<string>("all");

  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<InventoryItem | null>(null);
  const [stockItem, setStockItem] = useState<InventoryItem | null>(null);
  const [movementItem, setMovementItem] = useState<InventoryItem | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [scanResult, setScanResult] = useState<InventoryScanResult | null>(null);

  async function load() {
    try {
      setLoading(true);
      const [inv, al, set] = await Promise.all([
        api<{ items: InventoryItem[] }>("GET", "/api/inventory"),
        api<{ alerts: InventoryAlert[] }>("GET", "/api/inventory/alerts"),
        api<{ settings: InventorySettings }>("GET", "/api/inventory/settings"),
      ]);
      setItems(inv.items);
      setAlerts(al.alerts);
      setSettings({ ...set.settings, inventory_expiry_alert_days: Number(set.settings.inventory_expiry_alert_days) || 30 });
    } catch (err) {
      app.setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Stock movements, alerts and scans made anywhere re-read the shelf list.
  useDataRefresh(load, { reasons: ["inventory"], debounceMs: 400 });

  async function scanNow() {
    setScanning(true);
    try {
      const res = await api<InventoryScanResult>("POST", "/api/inventory/scan");
      setScanResult(res);
      window.dispatchEvent(new Event("dental-canvas:inventory-scan"));
      await load();
    } catch (err) {
      app.setError((err as Error).message);
    } finally {
      setScanning(false);
    }
  }

  async function resolve(id: number) {
    try {
      await api("POST", `/api/inventory/alerts/${id}/resolve`);
      setAlerts((prev) => prev.filter((a) => a.id !== id));
    } catch (err) {
      app.setError((err as Error).message);
    }
  }

  async function remove(id: number) {
    const item = items.find((i) => i.id === id);
    if (!item) return;
    if (!confirm(`Delete “${item.name}”? Its stock history is kept.`)) return;
    try {
      await api("DELETE", `/api/inventory/${id}`);
      setItems((prev) => prev.filter((i) => i.id !== id));
    } catch (err) {
      app.setError((err as Error).message);
    }
  }

  const stats = useMemo(() => {
    const low = items.filter((i) => i.min_threshold > 0 && i.current_stock > 0 && i.current_stock <= i.min_threshold).length;
    const out = items.filter((i) => i.min_threshold > 0 && i.current_stock === 0).length;
    const expiring = items.filter((i) => i.expiry_date && expiryFor(i, settings.inventory_expiry_alert_days)?.label === "Expiring").length;
    const expired = items.filter((i) => i.expiry_date && expiryFor(i, settings.inventory_expiry_alert_days)?.label === "Expired").length;
    return { total: items.length, low, out, expiring, expired };
  }, [items, settings.inventory_expiry_alert_days]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    let rows = items;
    if (needle) {
      rows = rows.filter((i) =>
        [i.name, i.category, i.sku, i.supplier_name, i.batch_number, i.location]
          .filter(Boolean)
          .some((v) => (v as string).toLowerCase().includes(needle)),
      );
    }
    if (categoryFilter !== "all") rows = rows.filter((i) => i.category === categoryFilter);
    if (statusFilter !== "all") {
      rows = rows.filter((i) => {
        const s = statusFor(i);
        const e = expiryFor(i, settings.inventory_expiry_alert_days);
        if (statusFilter === "out_of_stock") return s?.label === "Out of stock";
        if (statusFilter === "low_stock") return s?.label === "Low";
        if (statusFilter === "expiring") return e?.label === "Expiring";
        if (statusFilter === "expired") return e?.label === "Expired";
        return true;
      });
    }
    return rows;
  }, [items, q, categoryFilter, statusFilter, settings.inventory_expiry_alert_days]);

  return (
    <div className="flex flex-1 flex-col overflow-hidden">
      {/* Header */}
      <div className="flex flex-wrap items-center gap-3 border-b bg-card px-4 py-3">
        <h1 className="flex items-center gap-2 text-lg font-semibold tracking-tight">
          <Boxes className="h-5 w-5" /> Inventory
        </h1>
        <div className="ml-auto flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={scanNow} disabled={scanning}>
            <RefreshCw className={cn("h-4 w-4", scanning && "animate-spin")} />
            {scanning ? "Scanning…" : "Scan now"}
          </Button>
          <Button variant="outline" size="sm" onClick={() => setSettingsOpen(true)} title="Alert settings">
            <Settings2 className="h-4 w-4" />
            <span className="hidden sm:inline">Alert settings</span>
          </Button>
          <Button onClick={() => setCreating(true)} size="sm">
            <Plus className="h-4 w-4" /> New item
          </Button>
        </div>
      </div>

      {/* Alert strip — the dashboard notification rendered on the page itself */}
      {alerts.length > 0 && (
        <div className="border-b bg-card px-4 py-2">
          <div className="flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 shrink-0 text-amber-600" />
            <span className="text-sm font-semibold">{alerts.length} open alert{alerts.length === 1 ? "" : "s"}</span>
            <span className="text-xs text-muted-foreground">from the latest stock scan</span>
          </div>
          <ul className="mt-2 flex flex-col gap-1">
            {alerts.slice(0, 5).map((a) => (
              <li key={a.id} className="flex items-center gap-2 text-sm">
                <span className={cn("rounded border px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider", SEVERITY_STYLE[a.severity])}>
                  {a.kind.replace("_", " ")}
                </span>
                <span className="min-w-0 flex-1 truncate text-muted-foreground">{a.message}</span>
                <Button variant="ghost" size="sm" className="h-6 px-2 text-xs" onClick={() => resolve(a.id)}>
                  Acknowledge
                </Button>
              </li>
            ))}
          </ul>
          {scanResult && (
            <p className="mt-1 text-xs text-muted-foreground">
              Last scan: {new Date(scanResult.scanned_at).toLocaleString()} · {scanResult.open} open
              {scanResult.emailed && scanResult.email_recipient ? ` · emailed ${scanResult.email_recipient}` : ""}
            </p>
          )}
        </div>
      )}

      <div className="flex-1 overflow-auto p-4">
        {/* Stats */}
        <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          <StatCard icon={<Archive className="h-4 w-4" />} label="Products" value={stats.total} cls="text-foreground" />
          <StatCard icon={<PackagePlus className="h-4 w-4" />} label="Low" value={stats.low} cls="text-amber-600" />
          <StatCard icon={<Minus className="h-4 w-4" />} label="Out of stock" value={stats.out} cls="text-rose-600" />
          <StatCard icon={<CalendarClock className="h-4 w-4" />} label="Expiring" value={stats.expiring} cls="text-amber-600" />
          <StatCard icon={<AlertTriangle className="h-4 w-4" />} label="Expired" value={stats.expired} cls="text-rose-600" />
        </div>

        {/* Filters */}
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search name, SKU, supplier, batch…"
            className="h-9 max-w-xs"
          />
          <Select value={statusFilter} onValueChange={(v) => setStatusFilter(v as typeof statusFilter)}>
            <SelectTrigger className="h-9 w-40"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All stock states</SelectItem>
              <SelectItem value="out_of_stock">Out of stock</SelectItem>
              <SelectItem value="low_stock">Low stock</SelectItem>
              <SelectItem value="expiring">Expiring</SelectItem>
              <SelectItem value="expired">Expired</SelectItem>
            </SelectContent>
          </Select>
          <Select value={categoryFilter} onValueChange={setCategoryFilter}>
            <SelectTrigger className="h-9 w-40"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All categories</SelectItem>
              {CATEGORIES.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>

        <Card className="overflow-hidden">
          <CardContent className="p-0">
            {loading ? (
              <p className="py-12 text-center text-sm text-muted-foreground">Loading…</p>
            ) : filtered.length === 0 ? (
              <p className="py-12 text-center text-sm text-muted-foreground">
                {items.length === 0 ? "No inventory items yet. Add your first item above." : "No items match the filters."}
              </p>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-muted/40 text-left text-xs uppercase tracking-wider text-muted-foreground">
                    <th className="px-3 py-2 font-semibold">Item</th>
                    <th className="px-3 py-2 font-semibold">Supplier</th>
                    <th className="px-3 py-2 font-semibold">SKU / Batch</th>
                    <th className="px-3 py-2 font-semibold">Expiry</th>
                    <th className="px-3 py-2 text-right font-semibold">On hand</th>
                    <th className="px-3 py-2 text-right font-semibold">Min</th>
                    <th className="px-3 py-2 font-semibold">Status</th>
                    <th className="px-3 py-2 text-right font-semibold"></th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((i) => {
                    const s = statusFor(i);
                    const e = expiryFor(i, settings.inventory_expiry_alert_days);
                    return (
                      <tr key={i.id} className="border-b last:border-0">
                        <td className="px-3 py-2">
                          <button type="button" onClick={() => setEditing(i)} className="text-left font-medium hover:underline">
                            {i.name}
                          </button>
                          <div className="text-xs text-muted-foreground">
                            {[i.category, i.location].filter(Boolean).join(" · ") || i.unit}
                          </div>
                        </td>
                        <td className="px-3 py-2">
                          <div>{i.supplier_name ?? "—"}</div>
                          <div className="text-xs text-muted-foreground">{i.supplier_contact ?? ""}</div>
                        </td>
                        <td className="px-3 py-2 text-xs text-muted-foreground">
                          <div>{i.sku ?? ""}</div>
                          <div className="tabular-nums">{i.batch_number ?? ""}</div>
                        </td>
                        <td className="px-3 py-2">
                          {e ? (
                            <span className={cn("rounded-full border px-2 py-0.5 text-xs font-medium", e.cls)}>
                              {e.label}{e.label !== "OK" ? ` · ${formatDate(e.date)}` : ""}
                            </span>
                          ) : (
                            <span className="text-xs text-muted-foreground">—</span>
                          )}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          <span className="font-semibold">{i.current_stock}</span>
                          <span className="ml-1 text-xs text-muted-foreground">{i.unit}</span>
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums text-muted-foreground">{i.min_threshold}</td>
                        <td className="px-3 py-2">
                          {s && <span className={cn("rounded-full border px-2 py-0.5 text-xs font-medium", s.cls)}>{s.label}</span>}
                        </td>
                        <td className="px-3 py-2">
                          <div className="flex items-center justify-end gap-1">
                            <Button size="sm" variant="outline" className="h-7 px-2 text-xs" onClick={() => setStockItem({ ...i, mode: "in" } as InventoryItem & { mode: string })}>
                              In
                            </Button>
                            <Button size="sm" variant="outline" className="h-7 px-2 text-xs" onClick={() => setStockItem({ ...i, mode: "out" } as InventoryItem & { mode: string })}>
                              Out
                            </Button>
                            <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => setMovementItem(i)} title="Stock history" aria-label="Stock history">
                              <History className="h-4 w-4" />
                            </Button>
                            <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => remove(i.id)} aria-label="Delete">
                              <Trash2 className="h-4 w-4 text-muted-foreground" />
                            </Button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </CardContent>
        </Card>
      </div>

      {scanResult && <ScanSummary result={scanResult} />}

      <ItemDialog
        open={creating || !!editing}
        onOpenChange={(o) => { if (!o) { setCreating(false); setEditing(null); } }}
        item={editing}
        onSaved={(it) => {
          setItems((prev) => (editing ? prev.map((x) => (x.id === it.id ? it : x)) : [it, ...prev]));
          setCreating(false);
          setEditing(null);
        }}
      />

      {stockItem && (
        <StockDialog
          item={stockItem}
          open={!!stockItem}
          onOpenChange={(o) => { if (!o) setStockItem(null); }}
          onApplied={(it) => {
            setItems((prev) => prev.map((x) => (x.id === it.id ? it : x)));
            setStockItem(null);
          }}
        />
      )}

      {movementItem && (
        <MovementsDialog
          item={movementItem}
          open={!!movementItem}
          onOpenChange={(o) => { if (!o) setMovementItem(null); }}
        />
      )}

      <AlertSettingsDialog
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        settings={settings}
        onSaved={(s) => { setSettings(s); }}
      />
    </div>
  );
}

function StatCard({ icon, label, value, cls }: { icon: React.ReactNode; label: string; value: number; cls: string }) {
  return (
    <div className="flex items-center gap-3 rounded-2xl border bg-card p-3 shadow-sm">
      <span className={cn("flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-muted", cls)}>{icon}</span>
      <div className="min-w-0">
        <div className="text-xl font-bold tabular-nums leading-none">{value}</div>
        <div className="truncate text-xs text-muted-foreground">{label}</div>
      </div>
    </div>
  );
}

// ── Scan result toast-style summary ─────────────────────────────────

function ScanSummary({ result }: { result: InventoryScanResult }) {
  const kinds: { k: keyof InventoryScanResult["by_kind"]; label: string; cls: string }[] = [
    { k: "out_of_stock", label: "Out of stock", cls: "text-rose-600" },
    { k: "expired", label: "Expired", cls: "text-rose-600" },
    { k: "low_stock", label: "Low", cls: "text-amber-600" },
    { k: "expiring", label: "Expiring", cls: "text-sky-600" },
  ];
  return (
    <div className="fixed bottom-24 right-4 z-50 w-72 rounded-2xl border bg-popover p-4 shadow-xl md:bottom-6">
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="text-sm font-semibold">Inventory scan complete</p>
          <p className="mt-0.5 text-xs text-muted-foreground">{result.open} open alerts</p>
        </div>
        <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-semibold text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300">
          {result.emailed ? "Emailed" : "In-app"}
        </span>
      </div>
      <div className="mt-3 space-y-1">
        {kinds.map((k) => (
          <div key={k.k} className="flex items-center justify-between text-xs">
            <span className="text-muted-foreground">{k.label}</span>
            <span className={cn("font-semibold tabular-nums", k.cls)}>{result.by_kind[k.k]}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Add / edit item dialog ─────────────────────────────────────────

function ItemDialog({
  open,
  onOpenChange,
  item,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  item: InventoryItem | null;
  onSaved: (it: InventoryItem) => void;
}) {
  const app = useApp();
  const [name, setName] = useState("");
  const [category, setCategory] = useState("");
  const [sku, setSku] = useState("");
  const [unit, setUnit] = useState("piece");
  const [stock, setStock] = useState("0");
  const [minThreshold, setMinThreshold] = useState("0");
  const [reorderQty, setReorderQty] = useState("");
  const [supplierName, setSupplierName] = useState("");
  const [supplierContact, setSupplierContact] = useState("");
  const [batchNumber, setBatchNumber] = useState("");
  const [expiryDate, setExpiryDate] = useState("");
  const [location, setLocation] = useState("");
  const [unitCost, setUnitCost] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName(item?.name ?? "");
    setCategory(item?.category ?? "");
    setSku(item?.sku ?? "");
    setUnit(item?.unit ?? "piece");
    setStock(item ? String(item.current_stock) : "0");
    setMinThreshold(item ? String(item.min_threshold) : "0");
    setReorderQty(item?.reorder_quantity != null ? String(item.reorder_quantity) : "");
    setSupplierName(item?.supplier_name ?? "");
    setSupplierContact(item?.supplier_contact ?? "");
    setBatchNumber(item?.batch_number ?? "");
    setExpiryDate(item?.expiry_date ?? "");
    setLocation(item?.location ?? "");
    setUnitCost(item?.unit_cost ? String(item.unit_cost) : "");
    setNotes(item?.notes ?? "");
  }, [open, item]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) { app.setError("Item name is required"); return; }
    setBusy(true);
    try {
      const body = {
        name: name.trim(),
        category: category || null,
        sku: sku.trim() || null,
        unit,
        current_stock: parseInt(stock, 10) || 0,
        min_threshold: parseInt(minThreshold, 10) || 0,
        reorder_quantity: reorderQty.trim() ? parseInt(reorderQty, 10) : null,
        supplier_name: supplierName.trim() || null,
        supplier_contact: supplierContact.trim() || null,
        batch_number: batchNumber.trim() || null,
        expiry_date: expiryDate || null,
        location: location.trim() || null,
        unit_cost: parseFloat(unitCost) || 0,
        notes: notes.trim() || null,
      };
      const res = item
        ? await api<{ item: InventoryItem }>("PUT", `/api/inventory/${item.id}`, body)
        : await api<{ item: InventoryItem }>("POST", "/api/inventory", body);
      onSaved(res.item);
    } catch (err) {
      app.setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{item ? "Edit item" : "New inventory item"}</DialogTitle>
          <DialogDescription>Products, supplier and minimum-stock reorder point.</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Item name *" className="col-span-2">
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Filtek Z250 Composite (A2)" required />
            </Field>
            <Field label="Category">
              <Select value={category} onValueChange={setCategory}>
                <SelectTrigger><SelectValue placeholder="Select…" /></SelectTrigger>
                <SelectContent>
                  {CATEGORIES.map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}
                </SelectContent>
              </Select>
            </Field>
            <Field label="Unit">
              <Select value={unit} onValueChange={setUnit}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {UNITS.map((u) => <SelectItem key={u} value={u}>{u}</SelectItem>)}
                </SelectContent>
              </Select>
            </Field>
            <Field label="On hand"><Input type="number" min="0" value={stock} onChange={(e) => setStock(e.target.value)} /></Field>
            <Field label="Min threshold"><Input type="number" min="0" value={minThreshold} onChange={(e) => setMinThreshold(e.target.value)} placeholder="reorder at" /></Field>
            <Field label="Reorder quantity"><Input type="number" min="1" value={reorderQty} onChange={(e) => setReorderQty(e.target.value)} placeholder="optional" /></Field>
            <Field label="Unit cost ($)"><Input type="number" min="0" step="0.01" value={unitCost} onChange={(e) => setUnitCost(e.target.value)} /></Field>
            <Field label="SKU"><Input value={sku} onChange={(e) => setSku(e.target.value)} /></Field>
            <Field label="Batch / lot #"><Input value={batchNumber} onChange={(e) => setBatchNumber(e.target.value)} /></Field>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Supplier"><Input value={supplierName} onChange={(e) => setSupplierName(e.target.value)} /></Field>
            <Field label="Supplier contact"><Input value={supplierContact} onChange={(e) => setSupplierContact(e.target.value)} placeholder="phone / email" /></Field>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Expiry date"><Input type="date" value={expiryDate} onChange={(e) => setExpiryDate(e.target.value)} /></Field>
            <Field label="Location"><Input value={location} onChange={(e) => setLocation(e.target.value)} placeholder="e.g. Store room B" /></Field>
          </div>

          <Field label="Notes">
            <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} />
          </Field>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>Cancel</Button>
            <Button type="submit" disabled={busy}>{busy ? "Saving…" : item ? "Save" : "Add item"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ── Stock in / out / adjust dialog ─────────────────────────────────

function StockDialog({
  item,
  open,
  onOpenChange,
  onApplied,
}: {
  item: InventoryItem & { mode?: string };
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onApplied: (it: InventoryItem) => void;
}) {
  const app = useApp();
  const mode = (item.mode ?? "in") as "in" | "out" | "adjust";
  const [qty, setQty] = useState("1");
  const [newStock, setNewStock] = useState("");
  const [unitCost, setUnitCost] = useState("");
  const [reason, setReason] = useState("");
  const [reference, setReference] = useState("");
  const [notes, setNotes] = useState("");
  const [allowNegative, setAllowNegative] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setQty("1");
    setNewStock("");
    setUnitCost("");
    setReason("");
    setReference("");
    setNotes("");
    setAllowNegative(false);
  }, [open, mode]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      if (mode === "adjust") {
        const stock = parseInt(newStock, 10);
        if (!Number.isFinite(stock) || stock < 0) { app.setError("Enter a valid new count"); setBusy(false); return; }
        const res = await api<{ item: InventoryItem }>("POST", `/api/inventory/${item.id}/adjust`, {
          new_stock: stock,
          reason: reason.trim() || null,
          notes: notes.trim() || null,
        });
        onApplied(res.item);
        return;
      }
      const quantity = parseInt(qty, 10);
      if (!Number.isFinite(quantity) || quantity < 1) { app.setError("Enter a quantity of at least 1"); setBusy(false); return; }
      const body = {
        quantity,
        unit_cost: unitCost ? parseFloat(unitCost) : null,
        reference: reference.trim() || null,
        notes: notes.trim() || null,
      };
      const path = mode === "in" ? `/api/inventory/${item.id}/stock-in` : `/api/inventory/${item.id}/stock-out`;
      const payload = mode === "out" ? { ...body, reason: reason.trim() || null, allow_negative: allowNegative } : body;
      const res = await api<{ item: InventoryItem }>("POST", path, payload);
      onApplied(res.item);
    } catch (err) {
      app.setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {mode === "in" ? "Stock in" : mode === "out" ? "Stock out / issue" : "Adjust count"} — {item.name}
          </DialogTitle>
          <DialogDescription>
            Currently on hand: {item.current_stock} {item.unit}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4">
          {mode === "adjust" ? (
            <Field label="New on-hand count">
              <Input type="number" min="0" value={newStock} onChange={(e) => setNewStock(e.target.value)} required />
            </Field>
          ) : (
            <Field label={`Quantity (${item.unit})`}>
              <Input type="number" min="1" value={qty} onChange={(e) => setQty(e.target.value)} required />
            </Field>
          )}

          {mode === "in" && (
            <Field label="Unit cost ($) — updates the item's cost">
              <Input type="number" min="0" step="0.01" value={unitCost} onChange={(e) => setUnitCost(e.target.value)} placeholder={item.unit_cost ? String(item.unit_cost) : "0.00"} />
            </Field>
          )}

          {mode !== "in" && (
            <Field label="Reason">
              <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder={mode === "out" ? "e.g. used in op 2, discarded expired stock" : "e.g. cycle count correction"} />
            </Field>
          )}

          <Field label="Reference (order # / patient)">
            <Input value={reference} onChange={(e) => setReference(e.target.value)} placeholder="e.g. PO-1042" />
          </Field>

          <Field label="Notes">
            <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} />
          </Field>

          {mode === "out" && (
            <label className="flex items-start gap-2 text-sm text-muted-foreground">
              <input type="checkbox" checked={allowNegative} onChange={(e) => setAllowNegative(e.target.checked)} className="mt-0.5" />
              Allow negative balance (oversell, then backfill)
            </label>
          )}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>Cancel</Button>
            <Button type="submit" disabled={busy}>{busy ? "Saving…" : mode === "in" ? "Stock in" : mode === "out" ? "Issue" : "Adjust"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ── Movement history dialog ────────────────────────────────────────

function MovementsDialog({
  item,
  open,
  onOpenChange,
}: {
  item: InventoryItem;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const [movements, setMovements] = useState<InventoryMovement[] | null>(null);

  useEffect(() => {
    if (!open) return;
    setMovements(null);
    api<{ movements: InventoryMovement[] }>("GET", `/api/inventory/${item.id}/movements`)
      .then((r) => setMovements(r.movements))
      .catch(() => setMovements([]));
  }, [open, item.id]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[80vh] overflow-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ClipboardList className="h-5 w-5" /> Stock history — {item.name}
          </DialogTitle>
          <DialogDescription>Every stock-in, issue and count adjustment, newest first.</DialogDescription>
        </DialogHeader>
        {movements === null ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : movements.length === 0 ? (
          <p className="text-sm text-muted-foreground">No movements recorded yet.</p>
        ) : (
          <ul className="space-y-2">
            {movements.map((m) => (
              <li key={m.id} className="rounded-xl border p-3">
                <div className="flex items-center justify-between gap-2">
                  <span
                    className={cn(
                      "rounded-full border px-2 py-0.5 text-xs font-semibold",
                      m.type === "in" && "bg-emerald-100 text-emerald-800 border-emerald-200 dark:bg-emerald-950 dark:text-emerald-200",
                      m.type === "out" && "bg-rose-100 text-rose-800 border-rose-200 dark:bg-rose-950 dark:text-rose-200",
                      m.type === "adjust" && "bg-sky-100 text-sky-800 border-sky-200 dark:bg-sky-950 dark:text-sky-200",
                    )}
                  >
                    {m.type === "in" ? "+" : m.type === "out" ? "−" : "="}{m.quantity}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {m.performed_at ? new Date(m.performed_at).toLocaleString() : ""}
                  </span>
                </div>
                <div className="mt-1 text-xs text-muted-foreground">
                  Balance after · <span className="tabular-nums font-medium text-foreground">{m.balance_after}</span>
                  {m.reason ? <> · {m.reason}</> : ""}
                  {m.reference ? <> · ref {m.reference}</> : ""}
                  {m.unit_cost != null && m.type === "in" ? <> · {formatMoney(Number(m.unit_cost))}</> : ""}
                </div>
                {m.notes && <div className="mt-0.5 text-xs text-muted-foreground">{m.notes}</div>}
              </li>
            ))}
          </ul>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ── Alert settings dialog ──────────────────────────────────────────

function AlertSettingsDialog({
  open,
  onOpenChange,
  settings,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  settings: InventorySettings;
  onSaved: (s: InventorySettings) => void;
}) {
  const app = useApp();
  const [expiryDays, setExpiryDays] = useState(String(settings.inventory_expiry_alert_days));
  const [email, setEmail] = useState(settings.inventory_alert_email);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setExpiryDays(String(settings.inventory_expiry_alert_days));
    setEmail(settings.inventory_alert_email);
  }, [open, settings]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const days = parseInt(expiryDays, 10);
      const res = await api<{ settings: InventorySettings }>("PUT", "/api/inventory/settings", {
        inventory_expiry_alert_days: Number.isFinite(days) && days >= 0 ? days : 30,
        inventory_alert_email: email.trim(),
      });
      onSaved({ ...res.settings, inventory_expiry_alert_days: Number(res.settings.inventory_expiry_alert_days) || 30 });
      onOpenChange(false);
    } catch (err) {
      app.setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Inventory alert settings</DialogTitle>
          <DialogDescription>
            The daily scan flags items below their threshold and products near their expiry.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="space-y-4">
          <Field label="Expiry alert window (days)">
            <Input type="number" min="0" max="3650" value={expiryDays} onChange={(e) => setExpiryDays(e.target.value)} required />
            <p className="text-xs text-muted-foreground">Items expiring within this many days show an “expiring” badge and alert.</p>
          </Field>
          <Field label="Alert email (optional)">
            <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="inventory@practice.example" />
            <p className="text-xs text-muted-foreground">
              Emails the daily scan summary via Resend (needs Settings → Email configured first).
            </p>
          </Field>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>Cancel</Button>
            <Button type="submit" disabled={busy}>{busy ? "Saving…" : "Save settings"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function Field({ label, children, className }: { label: string; children: React.ReactNode; className?: string }) {
  return (
    <div className={cn("space-y-1.5", className)}>
      <Label>{label}</Label>
      {children}
    </div>
  );
}