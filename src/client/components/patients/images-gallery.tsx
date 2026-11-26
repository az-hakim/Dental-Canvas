import { useCallback, useEffect, useRef, useState } from "react";
import { Aperture, ImageIcon, Move, Pencil, RotateCcw, Scissors, Trash2, Upload, X, ZoomIn, ZoomOut } from "lucide-react";
import { api } from "@/api";
import { useApp } from "@/context";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { formatDate } from "@/lib/utils";
import type { PatientImage, PatientImageKind, StorageStatus } from "@/types";

const KIND_LABELS: Record<PatientImageKind, string> = {
  xray: "X-Ray",
  intraoral: "Intraoral",
  panoramic: "Panoramic",
  photo: "Photo",
};

const KIND_ORDER: Array<PatientImageKind | "all"> = ["all", "xray", "intraoral", "panoramic", "photo"];

/** A DICOM file can't be rendered by the browser — we store it and tell the user. */
const isDicomFile = (mime?: string): boolean => /dicom/i.test(mime ?? "");

interface Props {
  patientId: number;
}

export function ImagesGallery({ patientId }: Props) {
  const app = useApp();
  const [images, setImages] = useState<PatientImage[]>([]);
  const [storage, setStorage] = useState<StorageStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<PatientImageKind | "all">("all");
  const [uploading, setUploading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [viewerImage, setViewerImage] = useState<PatientImage | null>(null);
  const [editing, setEditing] = useState<PatientImage | null>(null);
  const [compareA, setCompareA] = useState<PatientImage | null>(null);
  const [compareOpen, setCompareOpen] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const dragDepth = useRef(0);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    try {
      const data = await api<{ images: PatientImage[]; storage: Partial<StorageStatus> }>(
        "GET",
        `/api/patients/${patientId}/images`,
      );
      if (!alive.current) return;
      setImages(data.images ?? []);
      setStorage({
        provider: "none",
        endpoint: "",
        region: "",
        bucket: "",
        public_base_url: "",
        expiry_minutes: 15,
        max_file_mb: 25,
        access_key_id: "",
        has_secret: false,
        ...(data.storage ?? {}),
        enabled: Boolean(data.storage?.enabled),
      });
    } catch (err) {
      if (alive.current) app.setError((err as Error).message);
    } finally {
      if (alive.current) setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [patientId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function uploadFiles(files: File[]) {
    const candidates = files.filter((f) => f.size > 0);
    if (!candidates.length) return;
    setUploading(true);
    try {
      const meta = await api<{ uploads: Array<{ key: string; upload_url: string; headers: Record<string, string> }> }>(
        "POST",
        `/api/patients/${patientId}/images/uploads`,
        { files: candidates.map((f) => ({ name: f.name, type: f.type || "application/octet-stream", size: f.size })) },
      );
      const finalized = [];
      for (let i = 0; i < meta.uploads.length; i++) {
        const up = meta.uploads[i];
        const f = candidates[i];
        const r = await fetch(up.upload_url, { method: "PUT", headers: up.headers ?? {}, body: f });
        if (!r.ok) throw new Error(`Upload of "${f.name}" failed (${r.status}).`);
        finalized.push({
          key: up.key,
          file_name: f.name,
          mime_type: f.type || "application/octet-stream",
          size_bytes: f.size,
          kind: guessKind(f.name, f.type),
        });
      }
      if (finalized.length) {
        await api("POST", `/api/patients/${patientId}/images`, { files: finalized });
      }
      await load();
    } catch (err) {
      app.setError((err as Error).message);
    } finally {
      setUploading(false);
    }
  }

  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    dragDepth.current = 0;
    setDragging(false);
    if (e.dataTransfer.files?.length) void uploadFiles(Array.from(e.dataTransfer.files));
  }

  const visible = filter === "all" ? images : images.filter((i) => i.kind === filter);
  const storageEnabled = storage?.enabled ?? false;

  return (
    <div
      onDragEnter={(e) => {
        e.preventDefault();
        dragDepth.current += 1;
        setDragging(true);
      }}
      onDragOver={(e) => e.preventDefault()}
      onDragLeave={() => {
        dragDepth.current -= 1;
        if (dragDepth.current <= 0) {
          dragDepth.current = 0;
          setDragging(false);
        }
      }}
      onDrop={onDrop}
      className="flex flex-col gap-4"
    >
      {/* Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-1">
          {KIND_ORDER.map((k) => {
            const count = k === "all" ? images.length : images.filter((i) => i.kind === k).length;
            return (
              <button
                key={k}
                onClick={() => setFilter(k)}
                className={
                  filter === k
                    ? "rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground"
                    : "rounded-md px-2.5 py-1 text-xs font-medium text-muted-foreground hover:bg-muted"
                }
              >
                {k === "all" ? "All" : KIND_LABELS[k as PatientImageKind]}
                <span className="ml-1 opacity-60">{count}</span>
              </button>
            );
          })}
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={images.length < 2}
            onClick={() => setCompareOpen(true)}
            title="Compare two images side by side"
          >
            <Scissors className="h-4 w-4" />
            Compare
          </Button>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept="image/*,.dicom,.dcm"
            className="hidden"
            onChange={(e) => {
              if (e.target.files?.length) void uploadFiles(Array.from(e.target.files));
              e.target.value = "";
            }}
          />
          <Button size="sm" disabled={uploading || !storageEnabled} onClick={() => fileInputRef.current?.click()}>
            {uploading ? <Upload className="h-4 w-4 animate-pulse" /> : <Upload className="h-4 w-4" />}
            {uploading ? "Uploading…" : "Upload images"}
          </Button>
        </div>
      </div>

      {!storageEnabled && (
        <div className="rounded-lg border border-dashed bg-muted/40 px-4 py-3 text-sm text-muted-foreground">
          <ImageIcon className="mr-2 inline h-4 w-4" />
          Uploads are disabled — configure an S3 or Cloudflare R2 bucket in{" "}
          <span className="font-medium text-foreground">Settings → Storage</span> to store X-rays and photos.
        </div>
      )}

      {dragging && (
        <div className="rounded-xl border-2 border-dashed border-primary/60 bg-primary/5 px-4 py-10 text-center text-sm font-medium text-primary">
          Drop images to upload
        </div>
      )}

      {loading ? (
        <div className="py-10 text-center text-sm text-muted-foreground">Loading images…</div>
      ) : visible.length === 0 ? (
        <div className="rounded-xl border border-dashed px-6 py-14 text-center">
          <ImageIcon className="mx-auto mb-3 h-10 w-10 text-muted-foreground/50" />
          <p className="text-sm font-medium text-foreground">
            {filter === "all" ? "No images yet" : `No ${KIND_LABELS[filter as PatientImageKind].toLowerCase()} images`}
          </p>
          <p className="mt-1 text-sm text-muted-foreground">
            {storageEnabled
              ? "Drag & drop files anywhere in this panel, or use Upload images."
              : "Connect a bucket in Settings → Storage to start."}
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
          {visible.map((img) => (
            <ImageCard
              key={img.id}
              image={img}
              onOpen={() => setViewerImage(img)}
              onEdit={() => setEditing(img)}
              onCompare={() => {
                setCompareA(img);
                setCompareOpen(true);
              }}
              onDelete={async () => {
                if (!confirm("Remove this image from the patient record?")) return;
                try {
                  await api("DELETE", `/api/images/${img.id}`);
                  await load();
                } catch (err) {
                  app.setError((err as Error).message);
                }
              }}
            />
          ))}
        </div>
      )}

      {viewerImage && (
        <ImageViewer
          image={viewerImage}
          onClose={() => setViewerImage(null)}
          onSelect={setViewerImage}
          images={images.filter((i) => i.url)}
        />
      )}

      {editing && (
        <ImageEditDialog
          key={editing.id}
          image={editing}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            await load();
          }}
        />
      )}

      {compareOpen && (
        <CompareDialog
          images={visible.filter((i) => i.url)}
          onClose={() => {
            setCompareOpen(false);
            setCompareA(null);
          }}
          initialA={compareA}
        />
      )}
    </div>
  );
}

function guessKind(name: string, mime: string): PatientImageKind {
  const lower = `${name} ${mime}`.toLowerCase();
  if (/dicom/i.test(mime)) return "xray";
  if (lower.includes("panoramic")) return "panoramic";
  if (lower.includes("xray") || lower.includes("x-ray") || lower.includes("periapical")) return "xray";
  if (lower.includes("intraoral") || lower.includes("occlusal") || lower.includes("bitewing")) return "intraoral";
  return "photo";
}

function ImageCard({
  image,
  onOpen,
  onEdit,
  onCompare,
  onDelete,
}: {
  image: PatientImage;
  onOpen: () => void;
  onEdit: () => void;
  onCompare: () => void;
  onDelete: () => void;
}) {
  const dicom = isDicomFile(image.mime_type);
  return (
    <div className="group relative overflow-hidden rounded-lg border bg-muted/40">
      <button onClick={onOpen} className="block aspect-[4/3] w-full" title={image.label || image.file_name || "View image"}>
        {image.url && !dicom ? (
          <img
            src={image.url}
            alt={image.label || image.file_name || "Patient image"}
            className="h-full w-full object-cover"
            loading="lazy"
          />
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-1 bg-muted/60 text-muted-foreground">
            <Aperture className="h-6 w-6" />
            <span className="px-2 text-center text-[10px] font-medium uppercase tracking-wide">
              {dicom ? "DICOM data" : "Preview pending"}
            </span>
          </div>
        )}
        <span className="absolute left-1.5 top-1.5">
          <Badge variant="secondary" className="text-[10px] opacity-90">
            {KIND_LABELS[image.kind]}
          </Badge>
        </span>
      </button>
      <div className="flex items-center justify-between gap-1 px-2 py-1.5">
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs font-medium text-foreground">
            {image.label || image.file_name || `Image #${image.id}`}
          </p>
          <p className="text-[11px] text-muted-foreground">
            {formatDate(image.uploaded_at, { month: "short", day: "numeric", year: "numeric" })}
          </p>
        </div>
        <div className="flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
          <Button variant="ghost" size="icon" className="h-7 w-7" onClick={onEdit} title="Edit details">
            <Pencil className="h-3.5 w-3.5" />
          </Button>
          <Button variant="ghost" size="icon" className="h-7 w-7" onClick={onCompare} title="Use in a before/after comparison">
            <Scissors className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 text-destructive hover:text-destructive"
            onClick={onDelete}
            title="Remove"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>
    </div>
  );
}

/** Full-screen image viewer with zoom/pan and brightness/contrast. */
function ImageViewer({
  image,
  images,
  onSelect,
  onClose,
}: {
  image: PatientImage;
  images: PatientImage[];
  onSelect: (img: PatientImage) => void;
  onClose: () => void;
}) {
  const [zoom, setZoom] = useState(1);
  const [brightness, setBrightness] = useState(100);
  const [contrast, setContrast] = useState(100);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const dragRef = useRef<{ sx: number; sy: number; ox: number; oy: number } | null>(null);
  const idx = images.findIndex((i) => i.id === image.id);
  const prev = idx > 0 ? images[idx - 1] : null;
  const next = idx >= 0 && idx < images.length - 1 ? images[idx + 1] : null;
  const dicom = isDicomFile(image.mime_type);

  function reset() {
    setZoom(1);
    setBrightness(100);
    setContrast(100);
    setPan({ x: 0, y: 0 });
  }

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-black/95 text-white">
      {/* Top bar */}
      <div className="flex items-center justify-between gap-3 px-4 py-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">{image.label || image.file_name || `Image #${image.id}`}</p>
          <p className="text-xs text-white/50">
            {KIND_LABELS[image.kind]} · {formatDate(image.uploaded_at)}
            {dicom ? " · DICOM — stored only, no in-browser preview" : ""}
          </p>
        </div>
        <div className="flex items-center gap-1">
          {prev && (
            <Button
              variant="ghost"
              size="sm"
              className="text-white hover:bg-white/10 hover:text-white"
              onClick={() => {
                reset();
                onSelect(prev);
              }}
              title="Previous"
            >
              ←
            </Button>
          )}
          {next && (
            <Button
              variant="ghost"
              size="sm"
              className="text-white hover:bg-white/10 hover:text-white"
              onClick={() => {
                reset();
                onSelect(next);
              }}
              title="Next"
            >
              →
            </Button>
          )}
          <Button variant="ghost" size="sm" className="text-white hover:bg-white/10 hover:text-white" onClick={onClose}>
            <X className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* Stage */}
      <div
        className="relative flex-1 overflow-hidden"
        onWheel={(e) => {
          if (!e.ctrlKey && !e.metaKey) return;
          e.preventDefault();
          setZoom((z) => Math.max(1, Math.min(6, z - e.deltaY * 0.002)));
        }}
        onPointerDown={(e) => {
          dragRef.current = { sx: e.clientX, sy: e.clientY, ox: pan.x, oy: pan.y };
          (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          if (!dragRef.current) return;
          setPan({
            x: dragRef.current.ox + (e.clientX - dragRef.current.sx),
            y: dragRef.current.oy + (e.clientY - dragRef.current.sy),
          });
        }}
        onPointerUp={() => {
          dragRef.current = null;
        }}
        onDoubleClick={reset}
      >
        {image.url && !dicom ? (
          <img
            src={image.url}
            alt={image.label || image.file_name || "Patient image"}
            draggable={false}
            className="absolute left-1/2 top-1/2"
            style={{
              transform: `translate(-50%, -50%) translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
              filter: `brightness(${brightness}%) contrast(${contrast}%)`,
              cursor: dragRef.current ? "grabbing" : "grab",
            }}
          />
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-white/60">
            <Aperture className="h-12 w-12" />
            <p className="max-w-md px-6 text-center text-sm">
              DICOM images are stored and attached to prescriptions, but the browser can't preview them inline.
              Download the file from the practice bucket to view it.
            </p>
          </div>
        )}
      </div>

      {/* Bottom controls */}
      <div className="flex flex-wrap items-center justify-center gap-2 border-t border-white/10 px-4 py-3">
        <button className={btnCls} onClick={() => setZoom((z) => Math.min(6, z + 0.25))} title="Zoom in">
          <ZoomIn className="h-4 w-4" />
        </button>
        <span className="w-12 text-center text-xs tabular-nums">{Math.round(zoom * 100)}%</span>
        <button className={btnCls} onClick={() => setZoom((z) => Math.max(1, z - 0.25))} title="Zoom out" disabled={zoom <= 1}>
          <ZoomOut className="h-4 w-4" />
        </button>
        <button className={btnCls} onClick={reset} title="Reset view">
          <RotateCcw className="h-4 w-4" />
        </button>
        <span className="mx-2 h-5 w-px bg-white/15" />
        <span className="text-xs text-white/60">Brightness</span>
        <input
          type="range"
          min={40}
          max={160}
          value={brightness}
          onChange={(e) => setBrightness(Number(e.target.value))}
          className="w-24 accent-white"
        />
        <span className="ml-3 text-xs text-white/60">Contrast</span>
        <input
          type="range"
          min={60}
          max={160}
          value={contrast}
          onChange={(e) => setContrast(Number(e.target.value))}
          className="w-24 accent-white"
        />
        <span className="ml-3 hidden text-xs text-white/40 sm:inline">
          <Move className="mr-1 inline h-3 w-3" />
          drag to pan · double-click to reset
        </span>
      </div>
    </div>
  );
}

const btnCls =
  "flex h-8 w-8 items-center justify-center rounded-md bg-white/10 text-white transition hover:bg-white/20 disabled:opacity-40";

/** Edit kind / label / before-after grouping for one image. */
function ImageEditDialog({
  image,
  onClose,
  onSaved,
}: {
  image: PatientImage;
  onClose: () => void;
  onSaved: () => void;
}) {
  const app = useApp();
  const [kind, setKind] = useState<PatientImageKind>(image.kind);
  const [label, setLabel] = useState(image.label ?? "");
  const [compareGroup, setCompareGroup] = useState(image.compare_group ?? "");
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    try {
      await api("PATCH", `/api/images/${image.id}`, {
        kind,
        label: label.trim() || null,
        compare_group: compareGroup.trim() || null,
      });
      onSaved();
    } catch (err) {
      app.setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Pencil className="h-4 w-4" />
            Image details
          </DialogTitle>
          <DialogDescription>Type, caption, and before/after grouping.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3">
          <div className="grid gap-1.5">
            <Label>Type</Label>
            <Select value={kind} onValueChange={(v) => setKind(v as PatientImageKind)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(Object.keys(KIND_LABELS) as PatientImageKind[]).map((k) => (
                  <SelectItem key={k} value={k}>
                    {KIND_LABELS[k]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor={`img-label-${image.id}`}>Caption</Label>
            <Input
              id={`img-label-${image.id}`}
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="e.g. Pre-op lower right molar"
            />
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor={`img-cg-${image.id}`}>Before/after group</Label>
            <Input
              id={`img-cg-${image.id}`}
              value={compareGroup}
              onChange={(e) => setCompareGroup(e.target.value)}
              placeholder="e.g. crown-36 — same value on the 'after' shot"
            />
            <p className="text-xs text-muted-foreground">
              Give the matching "after" image the same value to link this pair.
            </p>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={save} disabled={busy}>
            {busy ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Side-by-side before/after comparison with a draggable divider. */
function CompareDialog({
  images,
  initialA,
  onClose,
}: {
  images: PatientImage[];
  initialA: PatientImage | null;
  onClose: () => void;
}) {
  const [a, setA] = useState<PatientImage | null>(initialA);
  const [b, setB] = useState<PatientImage | null>(null);
  const [pos, setPos] = useState(50);

  useEffect(() => {
    if (!a || b) return;
    // Prefer a mate with the same compare_group; fall back to any other image.
    const paired = images.find((i) => i.id !== a.id && i.compare_group && i.compare_group === a.compare_group);
    setB(paired ?? images.find((i) => i.id !== a.id) ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [a]);

  const canCompare = Boolean(a && b && a.id !== b.id && a.url && b.url);

  function pick(side: "a" | "b", id: number) {
    const img = images.find((i) => i.id === id);
    if (!img) return;
    if (side === "a") setA(img);
    else setB(img);
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Scissors className="h-4 w-4" />
            Before / after comparison
          </DialogTitle>
          <DialogDescription>Pick the "before" and "after" of the same view to slide between them.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="grid gap-1.5">
            <Label>Before</Label>
            <Select value={a ? String(a.id) : ""} onValueChange={(v) => pick("a", Number(v))}>
              <SelectTrigger>
                <SelectValue placeholder="Choose an image" />
              </SelectTrigger>
              <SelectContent>
                {images.map((i) => (
                  <SelectItem key={i.id} value={String(i.id)}>
                    {imageLabel(i)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid gap-1.5">
            <Label>After</Label>
            <Select value={b ? String(b.id) : ""} onValueChange={(v) => pick("b", Number(v))}>
              <SelectTrigger>
                <SelectValue placeholder="Choose an image" />
              </SelectTrigger>
              <SelectContent>
                {images.map((i) => (
                  <SelectItem key={i.id} value={String(i.id)}>
                    {imageLabel(i)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        {canCompare ? (
          <div className="relative select-none overflow-hidden rounded-lg border bg-black">
            <img src={a!.url!} alt="Before" className="block w-full" draggable={false} />
            <div
              className="absolute inset-0"
              style={{ clipPath: `inset(0 0 0 ${pos}%)` }}
              onPointerDown={(e) => (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)}
              onPointerMove={(e) => {
                const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                setPos(Math.max(0, Math.min(100, ((e.clientX - rect.left) / rect.width) * 100)));
              }}
            >
              <img src={b!.url!} alt="After" className="block w-full" draggable={false} />
            </div>
            <div className="pointer-events-none absolute inset-y-0" style={{ left: `${pos}%` }}>
              <div className="absolute inset-y-0 w-0.5 -translate-x-1/2 bg-white/90" />
              <div className="absolute top-1/2 flex h-8 w-8 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-white/90 text-sm font-bold text-black shadow">
                ⇄
              </div>
            </div>
            <span className="absolute left-2 top-2 rounded bg-black/50 px-2 py-0.5 text-[11px] font-medium text-white">
              Before
            </span>
            <span className="absolute right-2 top-2 rounded bg-black/50 px-2 py-0.5 text-[11px] font-medium text-white">
              After
            </span>
          </div>
        ) : (
          <div className="rounded-lg border border-dashed px-6 py-10 text-center text-sm text-muted-foreground">
            Choose two different images to start comparing.
          </div>
        )}

        <DialogFooter className="gap-2">
          <Button
            variant="ghost"
            onClick={() => {
              setA(null);
              setB(null);
            }}
          >
            Clear
          </Button>
          <Button onClick={onClose}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function imageLabel(i: PatientImage): string {
  const datePart = formatDate(i.uploaded_at, { month: "short", day: "numeric" });
  return `${i.label || i.file_name || `Image #${i.id}`} · ${datePart}`;
}