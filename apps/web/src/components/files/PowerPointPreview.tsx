/* oxlint-disable react/no-array-index-key -- Slide elements have stable indexed positions. */
import { useEffect, useMemo, useRef, useState } from "react";
import JSZip from "jszip";
import {
  ChevronLeft,
  ChevronRight,
  Image as ImageIcon,
  LayoutGrid,
  ListTree,
  Maximize2,
  Presentation,
} from "lucide-react";

import { cn } from "~/lib/utils";
import { Button } from "~/components/ui/button";
import { FileSurfaceFailure, FileSurfaceLoading } from "./fileSurfaceChrome";

interface PowerPointPreviewProps {
  readonly name: string;
  readonly src?: string | null | undefined;
  readonly file?: Blob | null | undefined;
  readonly data?: ArrayBuffer | Uint8Array | null | undefined;
  readonly onError?: ((error: Error) => void) | undefined;
}

interface SlideElementTextRun {
  readonly text: string;
  readonly bold?: boolean | undefined;
  readonly italic?: boolean | undefined;
  readonly fontSizePt?: number | undefined;
}

interface SlideElementParagraph {
  readonly runs: SlideElementTextRun[];
  readonly isBullet?: boolean | undefined;
  readonly align?: ("left" | "center" | "right") | undefined;
}

interface SlideElement {
  readonly kind: "text" | "image";
  readonly xPct: number;
  readonly yPct: number;
  readonly widthPct: number;
  readonly heightPct: number;
  readonly paragraphs?: SlideElementParagraph[] | undefined;
  readonly isTitle?: boolean | undefined;
  readonly imageSrc?: string | undefined;
}

interface SlideData {
  readonly index: number;
  readonly title: string;
  readonly elements: SlideElement[];
  readonly plainTexts: string[];
}

interface PresentationData {
  readonly slideWidth: number;
  readonly slideHeight: number;
  readonly aspectRatio: number; // e.g. 16/9 = 1.777...
  readonly slides: SlideData[];
}

// Default slide dimension in EMUs (16:9 standard: 960x540 pt)
const DEFAULT_WIDTH_EMU = 9144000;
const DEFAULT_HEIGHT_EMU = 5143500;

function findElementsByNames(parent: Element | Document, tagNames: string[]): Element[] {
  const result: Element[] = [];
  const set = new Set(tagNames.map((n) => n.toLowerCase()));
  const all = parent.querySelectorAll("*");
  for (let i = 0; i < all.length; i++) {
    const el = all[i]!;
    const local = el.localName?.toLowerCase();
    const tag = el.tagName?.toLowerCase();
    if ((local && set.has(local)) || (tag && set.has(tag))) {
      result.push(el);
    }
  }
  return result;
}

function findFirstElementByNames(parent: Element | Document, tagNames: string[]): Element | null {
  const set = new Set(tagNames.map((n) => n.toLowerCase()));
  const all = parent.querySelectorAll("*");
  for (let i = 0; i < all.length; i++) {
    const el = all[i]!;
    const local = el.localName?.toLowerCase();
    const tag = el.tagName?.toLowerCase();
    if ((local && set.has(local)) || (tag && set.has(tag))) {
      return el;
    }
  }
  return null;
}

export function PowerPointPreview({ name, src, file, data, onError }: PowerPointPreviewProps) {
  const [presData, setPresData] = useState<PresentationData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [currentSlideIndex, setCurrentSlideIndex] = useState(0);
  const [viewMode, setViewMode] = useState<"canvas" | "outline">("canvas");
  const blobUrlsRef = useRef<string[]>([]);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();

    async function parsePresentation() {
      setLoading(true);
      setError(null);
      blobUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
      blobUrlsRef.current = [];

      try {
        let buffer: ArrayBuffer;
        if (data) {
          buffer =
            data instanceof Uint8Array
              ? (data.buffer.slice(
                  data.byteOffset,
                  data.byteOffset + data.byteLength,
                ) as ArrayBuffer)
              : data;
        } else if (file) {
          buffer = await file.arrayBuffer();
        } else if (src) {
          const response = await fetch(src, { signal: controller.signal });
          if (!response.ok) {
            throw new Error(`Failed to load file: HTTP ${response.status}`);
          }
          buffer = await response.arrayBuffer();
        } else {
          throw new Error("No source provided for PowerPoint preview.");
        }

        if (cancelled) return;

        const zip = await JSZip.loadAsync(buffer);
        const parser = new DOMParser();

        // 1. Parse presentation.xml for dimensions & slide references
        const presXmlFile = zip.file("ppt/presentation.xml");
        if (!presXmlFile) {
          throw new Error("Invalid presentation format: missing ppt/presentation.xml");
        }
        const presXmlStr = await presXmlFile.async("text");
        const presDoc = parser.parseFromString(presXmlStr, "application/xml");

        let slideWidthEmu = DEFAULT_WIDTH_EMU;
        let slideHeightEmu = DEFAULT_HEIGHT_EMU;

        const sldSzEl = findFirstElementByNames(presDoc, ["p:sldSz", "sldSz"]);
        if (sldSzEl) {
          const cx = Number(sldSzEl.getAttribute("cx"));
          const cy = Number(sldSzEl.getAttribute("cy"));
          if (cx > 0 && cy > 0) {
            slideWidthEmu = cx;
            slideHeightEmu = cy;
          }
        }
        const aspectRatio = slideWidthEmu / slideHeightEmu;

        // 2. Parse presentation relationships
        const relsMap = new Map<string, string>();
        const presRelsFile = zip.file("ppt/_rels/presentation.xml.rels");
        if (presRelsFile) {
          const presRelsStr = await presRelsFile.async("text");
          const relsDoc = parser.parseFromString(presRelsStr, "application/xml");
          const relEls = findElementsByNames(relsDoc, ["Relationship"]);
          relEls.forEach((el) => {
            const id = el.getAttribute("Id");
            const target = el.getAttribute("Target");
            if (id && target) {
              relsMap.set(id, target);
            }
          });
        }

        // Identify slide file paths
        const slideFiles: string[] = [];
        const sldIdEls = findElementsByNames(presDoc, ["p:sldId", "sldId"]);
        sldIdEls.forEach((el) => {
          const rId = el.getAttribute("r:id") ?? el.getAttribute("id");
          if (rId && relsMap.has(rId)) {
            const target = relsMap.get(rId)!;
            const fullPath = target.startsWith("/")
              ? target.slice(1)
              : target.startsWith("ppt/")
                ? target
                : `ppt/${target}`;
            slideFiles.push(fullPath);
          }
        });

        // Fallback: look for ppt/slides/slide*.xml files directly if none resolved
        if (slideFiles.length === 0) {
          const matchedFiles = Object.keys(zip.files).filter((f) =>
            /^ppt\/slides\/slide\d+\.xml$/i.test(f),
          );
          matchedFiles.sort((a, b) => {
            const numA = parseInt(a.match(/slide(\d+)\.xml/i)?.[1] ?? "0", 10);
            const numB = parseInt(b.match(/slide(\d+)\.xml/i)?.[1] ?? "0", 10);
            return numA - numB;
          });
          slideFiles.push(...matchedFiles);
        }

        if (slideFiles.length === 0) {
          throw new Error("No slides found in the presentation.");
        }

        // 3. Parse each slide
        const parsedSlides: SlideData[] = [];

        for (let i = 0; i < slideFiles.length; i++) {
          const slidePath = slideFiles[i]!;
          const slideZipFile = zip.file(slidePath);
          if (!slideZipFile) continue;

          const slideXmlStr = await slideZipFile.async("text");
          const slideDoc = parser.parseFromString(slideXmlStr, "application/xml");

          // Slide relationships for images
          const slideRelsMap = new Map<string, string>();
          const slideDir = slidePath.substring(0, slidePath.lastIndexOf("/"));
          const slideFilename = slidePath.substring(slidePath.lastIndexOf("/") + 1);
          const slideRelsPath = `${slideDir}/_rels/${slideFilename}.rels`;
          const slideRelsFile = zip.file(slideRelsPath);

          if (slideRelsFile) {
            const relsStr = await slideRelsFile.async("text");
            const sRelsDoc = parser.parseFromString(relsStr, "application/xml");
            findElementsByNames(sRelsDoc, ["Relationship"]).forEach((el) => {
              const id = el.getAttribute("Id");
              const target = el.getAttribute("Target");
              if (id && target) {
                slideRelsMap.set(id, target);
              }
            });
          }

          const elements: SlideElement[] = [];
          const plainTexts: string[] = [];
          let slideTitle = "";

          // Parse shapes (<p:sp>)
          const shapeEls = findElementsByNames(slideDoc, ["p:sp", "sp"]);
          shapeEls.forEach((sp) => {
            const phEl = findFirstElementByNames(sp, ["p:ph", "ph"]);
            const phType = phEl?.getAttribute("type");
            const isTitleShape = phType === "title" || phType === "ctrTitle";

            // Coordinate extraction
            const offEl = findFirstElementByNames(sp, ["a:off", "off"]);
            const extEl = findFirstElementByNames(sp, ["a:ext", "ext"]);
            const x = Number(offEl?.getAttribute("x") ?? 0);
            const y = Number(offEl?.getAttribute("y") ?? 0);
            const cx = Number(extEl?.getAttribute("cx") ?? slideWidthEmu);
            const cy = Number(extEl?.getAttribute("cy") ?? 0);

            const xPct = Math.max(0, Math.min(100, (x / slideWidthEmu) * 100));
            const yPct = Math.max(0, Math.min(100, (y / slideHeightEmu) * 100));
            const widthPct = Math.max(5, Math.min(100, (cx / slideWidthEmu) * 100));
            const heightPct = Math.max(3, Math.min(100, (cy / slideHeightEmu) * 100));

            // Text extraction
            const paragraphs: SlideElementParagraph[] = [];
            const pEls = findElementsByNames(sp, ["a:p", "p"]);

            pEls.forEach((pEl) => {
              const runs: SlideElementTextRun[] = [];
              const rEls = findElementsByNames(pEl, ["a:r", "r"]);

              rEls.forEach((rEl) => {
                const tEl = findFirstElementByNames(rEl, ["a:t", "t"]);
                const text = tEl?.textContent ?? "";
                if (text) {
                  const rPrEl = findFirstElementByNames(rEl, ["a:rPr", "rPr"]);
                  const bold = rPrEl?.getAttribute("b") === "1";
                  const italic = rPrEl?.getAttribute("i") === "1";
                  const szAttr = rPrEl?.getAttribute("sz");
                  const fontSizePt = szAttr ? Number(szAttr) / 100 : undefined;
                  runs.push({ text, bold, italic, fontSizePt });
                }
              });

              if (runs.length > 0) {
                const fullParaText = runs.map((r) => r.text).join("");
                plainTexts.push(fullParaText);
                if (isTitleShape && !slideTitle) {
                  slideTitle = fullParaText.trim();
                }

                const pPrEl = findFirstElementByNames(pEl, ["a:pPr", "pPr"]);
                const algn = pPrEl?.getAttribute("algn");
                const align = algn === "ctr" ? "center" : algn === "r" ? "right" : "left";
                paragraphs.push({ runs, align });
              }
            });

            if (paragraphs.length > 0) {
              elements.push({
                kind: "text",
                xPct,
                yPct,
                widthPct,
                heightPct,
                paragraphs,
                isTitle: isTitleShape,
              });
            }
          });

          // Parse pictures (<p:pic>)
          const picEls = findElementsByNames(slideDoc, ["p:pic", "pic"]);
          for (let pIdx = 0; pIdx < picEls.length; pIdx++) {
            const pic = picEls[pIdx]!;
            const blipEl = findFirstElementByNames(pic, ["a:blip", "blip"]);
            const embedId = blipEl?.getAttribute("r:embed");
            if (embedId && slideRelsMap.has(embedId)) {
              let target = slideRelsMap.get(embedId)!;
              // Resolve relative path, e.g. ../media/image1.png -> ppt/media/image1.png
              let mediaPath = target;
              if (target.startsWith("../")) {
                mediaPath = `ppt/${target.slice(3)}`;
              } else if (!target.startsWith("ppt/")) {
                mediaPath = `ppt/slides/${target}`;
              }

              const imgZip = zip.file(mediaPath);
              if (imgZip) {
                const imgBlob = await imgZip.async("blob");
                const blobUrl = URL.createObjectURL(imgBlob);
                blobUrlsRef.current.push(blobUrl);

                const offEl = findFirstElementByNames(pic, ["a:off", "off"]);
                const extEl = findFirstElementByNames(pic, ["a:ext", "ext"]);
                const x = Number(offEl?.getAttribute("x") ?? 0);
                const y = Number(offEl?.getAttribute("y") ?? 0);
                const cx = Number(extEl?.getAttribute("cx") ?? slideWidthEmu / 3);
                const cy = Number(extEl?.getAttribute("cy") ?? slideHeightEmu / 3);

                elements.push({
                  kind: "image",
                  xPct: Math.max(0, Math.min(100, (x / slideWidthEmu) * 100)),
                  yPct: Math.max(0, Math.min(100, (y / slideHeightEmu) * 100)),
                  widthPct: Math.max(5, Math.min(100, (cx / slideWidthEmu) * 100)),
                  heightPct: Math.max(5, Math.min(100, (cy / slideHeightEmu) * 100)),
                  imageSrc: blobUrl,
                });
              }
            }
          }

          if (!slideTitle && plainTexts.length > 0) {
            slideTitle = plainTexts[0]?.slice(0, 50) ?? "";
          }

          parsedSlides.push({
            index: i + 1,
            title: slideTitle || `Slide ${i + 1}`,
            elements,
            plainTexts,
          });
        }

        if (cancelled) return;

        setPresData({
          slideWidth: slideWidthEmu,
          slideHeight: slideHeightEmu,
          aspectRatio,
          slides: parsedSlides,
        });
        setCurrentSlideIndex(0);
      } catch (err: unknown) {
        if (cancelled) return;
        const msg = err instanceof Error ? err.message : "Failed to parse presentation.";
        setError(msg);
        if (err instanceof Error) {
          onError?.(err);
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    void parsePresentation();

    return () => {
      cancelled = true;
      controller.abort();
      blobUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
      blobUrlsRef.current = [];
    };
  }, [src, file, data, onError]);

  // Keyboard navigation
  useEffect(() => {
    if (typeof window === "undefined") return;

    function handleKeyDown(e: KeyboardEvent) {
      if (!presData) return;
      if (e.key === "ArrowLeft" || e.key === "PageUp") {
        setCurrentSlideIndex((prev) => Math.max(0, prev - 1));
      } else if (e.key === "ArrowRight" || e.key === "PageDown" || e.key === " ") {
        setCurrentSlideIndex((prev) => Math.min(presData.slides.length - 1, prev + 1));
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [presData]);

  if (loading) {
    return <FileSurfaceLoading className="p-8" />;
  }

  if (error || !presData) {
    return <FileSurfaceFailure message={error ?? "Could not load presentation."} />;
  }

  const currentSlide = presData.slides[currentSlideIndex];
  const totalSlides = presData.slides.length;

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-background">
      {/* Presentation Top Toolbar */}
      <div className="flex h-10 shrink-0 items-center justify-between border-b border-border bg-muted/30 px-3">
        <div className="flex items-center gap-2">
          <Presentation className="size-4 text-orange-600 dark:text-orange-400" />
          <span className="text-xs font-medium text-foreground truncate max-w-56">{name}</span>
          <span className="text-2xs text-muted-foreground">
            ({totalSlides} slide{totalSlides !== 1 ? "s" : ""})
          </span>
        </div>

        <div className="flex items-center gap-1.5">
          {/* View mode toggle */}
          <div className="flex rounded-md border border-border bg-background p-0.5">
            <Button
              type="button"
              size="icon-xs"
              variant={viewMode === "canvas" ? "secondary" : "ghost"}
              onClick={() => setViewMode("canvas")}
              aria-label="Canvas view"
              title="Slide canvas view"
            >
              <LayoutGrid className="size-3.5" />
            </Button>
            <Button
              type="button"
              size="icon-xs"
              variant={viewMode === "outline" ? "secondary" : "ghost"}
              onClick={() => setViewMode("outline")}
              aria-label="Outline view"
              title="Text outline view"
            >
              <ListTree className="size-3.5" />
            </Button>
          </div>

          <div className="h-4 w-px bg-border mx-1" />

          {/* Navigation Controls */}
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            disabled={currentSlideIndex <= 0}
            onClick={() => setCurrentSlideIndex((prev) => Math.max(0, prev - 1))}
            aria-label="Previous slide"
          >
            <ChevronLeft className="size-4" />
          </Button>
          <span className="min-w-16 text-center font-mono text-2xs text-foreground">
            {currentSlideIndex + 1} / {totalSlides}
          </span>
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            disabled={currentSlideIndex >= totalSlides - 1}
            onClick={() => setCurrentSlideIndex((prev) => Math.min(totalSlides - 1, prev + 1))}
            aria-label="Next slide"
          >
            <ChevronRight className="size-4" />
          </Button>
        </div>
      </div>

      {/* Main Content Area */}
      <div className="flex min-h-0 flex-1 overflow-hidden">
        {/* Left: Slide Thumbnails Rail */}
        <div className="w-48 shrink-0 overflow-y-auto border-r border-border bg-muted/20 p-2 space-y-2">
          {presData.slides.map((s, idx) => {
            const isSelected = idx === currentSlideIndex;
            return (
              <button
                key={s.index}
                type="button"
                onClick={() => setCurrentSlideIndex(idx)}
                className={cn(
                  "group relative flex w-full flex-col overflow-hidden rounded-md border p-1.5 text-left transition-all select-none",
                  isSelected
                    ? "border-primary bg-primary/5 ring-1 ring-primary shadow-xs"
                    : "border-border/70 bg-card hover:border-foreground/30 hover:bg-muted/40",
                )}
              >
                <div className="flex items-center justify-between gap-1 mb-1">
                  <span className="font-mono text-3xs font-semibold text-muted-foreground group-hover:text-foreground">
                    #{s.index}
                  </span>
                  <span className="text-3xs text-muted-foreground truncate flex-1 text-right">
                    {s.title}
                  </span>
                </div>
                {/* Mini aspect preview box */}
                <div
                  className="w-full rounded border border-border/40 bg-background/80 p-1 flex flex-col justify-start overflow-hidden pointer-events-none"
                  style={{ aspectRatio: `${presData.aspectRatio}` }}
                >
                  <p className="text-3xs font-medium text-foreground truncate line-clamp-1">
                    {s.title}
                  </p>
                  {s.plainTexts.length > 1 && (
                    <p className="text-4xs text-muted-foreground truncate line-clamp-2 mt-0.5">
                      {s.plainTexts.slice(1).join(" ")}
                    </p>
                  )}
                </div>
              </button>
            );
          })}
        </div>

        {/* Right: Slide Presentation Canvas / Outline */}
        <div className="flex min-h-0 flex-1 flex-col overflow-auto p-6 items-center justify-center bg-muted/10">
          {viewMode === "canvas" ? (
            currentSlide ? (
              <div className="w-full max-w-4xl flex flex-col items-center justify-center">
                {/* Slide Card Canvas */}
                <div
                  className="relative w-full overflow-hidden rounded-lg border border-border bg-card text-card-foreground shadow-md transition-all select-text"
                  style={{
                    aspectRatio: `${presData.aspectRatio}`,
                  }}
                >
                  {/* Render Elements */}
                  {currentSlide.elements.map((el, elIdx) => {
                    if (el.kind === "image" && el.imageSrc) {
                      return (
                        <div
                          key={elIdx}
                          className="absolute pointer-events-none flex items-center justify-center overflow-hidden"
                          style={{
                            left: `${el.xPct}%`,
                            top: `${el.yPct}%`,
                            width: `${el.widthPct}%`,
                            height: `${el.heightPct}%`,
                          }}
                        >
                          <img
                            src={el.imageSrc}
                            alt="Slide graphic"
                            className="max-h-full max-w-full object-contain"
                          />
                        </div>
                      );
                    }

                    if (el.kind === "text" && el.paragraphs) {
                      return (
                        <div
                          key={elIdx}
                          className={cn(
                            "absolute flex flex-col overflow-hidden p-1 leading-snug",
                            el.isTitle ? "font-bold text-foreground" : "text-foreground/90",
                          )}
                          style={{
                            left: `${el.xPct}%`,
                            top: `${el.yPct}%`,
                            width: `${el.widthPct}%`,
                            height: `${el.heightPct}%`,
                          }}
                        >
                          {el.paragraphs.map((p, pIdx) => (
                            <div
                              key={pIdx}
                              className={cn(
                                "my-0.5",
                                p.align === "center" && "text-center",
                                p.align === "right" && "text-right",
                              )}
                            >
                              {p.runs.map((r, rIdx) => (
                                <span
                                  key={rIdx}
                                  className={cn(r.bold && "font-bold", r.italic && "italic")}
                                  style={{
                                    fontSize: r.fontSizePt
                                      ? `clamp(10px, ${r.fontSizePt * 0.9}px, 28px)`
                                      : el.isTitle
                                        ? "1.25rem"
                                        : "0.875rem",
                                  }}
                                >
                                  {r.text}
                                </span>
                              ))}
                            </div>
                          ))}
                        </div>
                      );
                    }

                    return null;
                  })}

                  {/* Fallback if slide has plain texts but no placed elements */}
                  {currentSlide.elements.length === 0 && (
                    <div className="flex h-full flex-col justify-center p-8 text-center">
                      <h2 className="text-xl font-bold mb-4">{currentSlide.title}</h2>
                      <div className="space-y-2 text-sm text-muted-foreground">
                        {currentSlide.plainTexts.map((txt, tIdx) => (
                          <p key={tIdx}>{txt}</p>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Slide number watermark in bottom right */}
                  <div className="absolute bottom-2 right-3 font-mono text-3xs text-muted-foreground/60 select-none">
                    Slide {currentSlide.index}
                  </div>
                </div>
              </div>
            ) : null
          ) : (
            /* Outline View */
            <div className="w-full max-w-3xl space-y-4 py-4">
              {presData.slides.map((s) => (
                <div
                  key={s.index}
                  className={cn(
                    "rounded-lg border p-4 transition-colors",
                    s.index === currentSlideIndex + 1
                      ? "border-primary/60 bg-card shadow-xs"
                      : "border-border/60 bg-muted/20",
                  )}
                >
                  <div className="flex items-center gap-2 mb-2 border-b border-border/40 pb-2">
                    <span className="rounded bg-muted px-1.5 py-0.5 font-mono text-2xs font-semibold text-muted-foreground">
                      Slide {s.index}
                    </span>
                    <h3 className="text-sm font-semibold text-foreground">{s.title}</h3>
                  </div>
                  <div className="space-y-1.5 pl-2 text-xs text-foreground/80">
                    {s.plainTexts.map((txt, tIdx) => (
                      <p key={tIdx} className="leading-relaxed">
                        {txt}
                      </p>
                    ))}
                    {s.plainTexts.length === 0 && (
                      <p className="text-muted-foreground italic">
                        No text content found on this slide.
                      </p>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
