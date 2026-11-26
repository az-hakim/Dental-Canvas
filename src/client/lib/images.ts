import { useEffect, useState } from "react";

/**
 * An image attached to a prescription sheet. `src` may be a cross-origin
 * presigned URL — fine for an <img> tag on screen, but the PDF renderer
 * (html-to-image) and the printable iframe both need the bytes locally, so
 * the sheet materials size to data URLs before print/export.
 */
export interface SheetImage {
  id: number;
  label?: string | null;
  src: string | null;
}

const isDataUrl = (s: string): boolean => s.startsWith("data:image/");

/**
 * Fetch an image into a data URL. Fails blue: a broken image silently drops
 * off the sheet rather than holding up a prescription.
 */
export async function imageToDataUrl(src: string): Promise<string | null> {
  if (isDataUrl(src)) return src;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    const res = await fetch(src, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return null;
    const blob = await res.blob();
    if (!blob.type.startsWith("image/")) return null;
    return await new Promise<string | null>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : null);
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(blob);
    });
  } catch {
    return null;
  }
}

export async function materializeSheetImages(images: SheetImage[]): Promise<SheetImage[]> {
  if (!images.length) return images;
  return Promise.all(
    images.map(async (im) => {
      if (!im.src || isDataUrl(im.src)) return im;
      const src = await imageToDataUrl(im.src);
      return { ...im, src };
    }),
  );
}

/**
 * Materialize attached images to data URLs while the sheet is on screen, and
 * report readiness so PDF/print actions can bail out early if they're not
 * ready yet (falls back to "present but blurry" rather than an error).
 */
export function useMaterializedImages(images: SheetImage[]): { ready: boolean; images: SheetImage[] } {
  const [ready, setReady] = useState(false);
  const [out, setOut] = useState<SheetImage[]>(images);

  useEffect(() => {
    let cancelled = false;
    setReady(false);
    setOut(images);
    if (!images.length) {
      setReady(true);
      return;
    }
    void materializeSheetImages(images).then((resolved) => {
      if (!cancelled) {
        setOut(resolved);
        setReady(true);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [images]);

  return { ready, images: out };
}