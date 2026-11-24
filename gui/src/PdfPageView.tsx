import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import * as pdfjs from 'pdfjs-dist';
import type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

export type PdfRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type PdfPoint = {
  x: number;
  y: number;
};

export type PdfDrawTool = 'none' | 'rect' | 'arrow' | 'ink' | 'erase';

type PdfPageAction = {
  id: string;
  text: string;
  rect?: PdfRect;
  rects?: PdfRect[];
  points?: PdfPoint[];
  shape?: 'rect' | 'arrow';
  from?: PdfPoint;
  to?: PdfPoint;
  color?: string;
  width?: number;
};

function dataUrlToBytes(dataUrl: string) {
  const comma = dataUrl.indexOf(',');
  if (comma < 0 || !dataUrl.slice(0, comma).includes(';base64')) {
    throw new Error('PDF 数据格式无效');
  }
  const binary = atob(dataUrl.slice(comma + 1));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

export function PdfPageView({
  dataUrl,
  page,
  zoom,
  rotation,
  selecting,
  annotations,
  onPageCount,
  onRectSelected,
  onTextSelected,
  drawTool,
  drawColor,
  drawWidth,
  onDrawShape,
  onDrawInk,
  onErase,
}: {
  dataUrl: string;
  page: number;
  zoom: number;
  rotation: number;
  selecting: boolean;
  annotations: PdfPageAction[];
  onPageCount: (count: number) => void;
  onRectSelected: (rect: PdfRect) => void;
  onTextSelected: (selection: { text: string; rects: PdfRect[] }) => void;
  drawTool: PdfDrawTool;
  drawColor: string;
  drawWidth: number;
  onDrawShape: (shape: 'rect' | 'arrow', from: PdfPoint, to: PdfPoint) => void;
  onDrawInk: (points: PdfPoint[]) => void;
  onErase: (id: string) => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const textLayerRef = useRef<HTMLDivElement | null>(null);
  const textLayerInstanceRef = useRef<pdfjs.TextLayer | null>(null);
  const renderTaskRef = useRef<RenderTask | null>(null);
  const dragRef = useRef<{ x: number; y: number } | null>(null);
  const [document, setDocument] = useState<PDFDocumentProxy | null>(null);
  const [containerWidth, setContainerWidth] = useState(0);
  const [pageSize, setPageSize] = useState({ width: 0, height: 0 });
  const [draft, setDraft] = useState<PdfRect | null>(null);
  type DrawDraft =
    | { shape: 'rect' | 'arrow'; from: PdfPoint; to: PdfPoint }
    | { points: PdfPoint[] };
  const [drawDraft, setDrawDraft] = useState<DrawDraft | null>(null);
  const drawDraftRef = useRef<DrawDraft | null>(null);
  const drawStartRef = useRef<PdfPoint | null>(null);
  const updateDrawDraft = (value: DrawDraft | null) => {
    drawDraftRef.current = value;
    setDrawDraft(value);
  };
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    setDocument(null);
    try {
      const task = pdfjs.getDocument({ data: dataUrlToBytes(dataUrl) });
      task.promise
        .then((next) => {
          if (cancelled) return;
          setDocument(next);
          onPageCount(next.numPages);
        })
        .catch((loadError: any) => {
          if (!cancelled) setError(String(loadError?.message || loadError || 'PDF 加载失败'));
        });
      return () => {
        cancelled = true;
        void task.destroy();
      };
    } catch (loadError: any) {
      setError(String(loadError?.message || loadError || 'PDF 加载失败'));
      return undefined;
    }
  }, [dataUrl, onPageCount]);

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return undefined;
    const update = () => setContainerWidth(Math.max(0, element.clientWidth));
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!document || !canvasRef.current || containerWidth <= 0) return undefined;
    const targetPage = clamp(Math.trunc(page) || 1, 1, document.numPages);
    const textLayerContainer = textLayerRef.current;
    let cancelled = false;
    renderTaskRef.current?.cancel();
    textLayerInstanceRef.current?.cancel();
    textLayerContainer?.replaceChildren();
    document
      .getPage(targetPage)
      .then((pdfPage) => {
        if (cancelled || !canvasRef.current) return null;
        const base = pdfPage.getViewport({ scale: 1, rotation });
        const fitScale = Math.max(0.2, (containerWidth - 24) / base.width);
        const viewport = pdfPage.getViewport({ scale: fitScale * zoom, rotation });
        const pixelRatio = clamp(window.devicePixelRatio || 1, 1, 2);
        const canvas = canvasRef.current;
        canvas.width = Math.max(1, Math.floor(viewport.width * pixelRatio));
        canvas.height = Math.max(1, Math.floor(viewport.height * pixelRatio));
        canvas.style.width = `${Math.floor(viewport.width)}px`;
        canvas.style.height = `${Math.floor(viewport.height)}px`;
        setPageSize({
          width: Math.floor(viewport.width),
          height: Math.floor(viewport.height),
        });
        const renderTask = pdfPage.render({
          canvas,
          viewport,
          transform: pixelRatio !== 1 ? [pixelRatio, 0, 0, pixelRatio, 0, 0] : undefined,
        });
        renderTaskRef.current = renderTask;
        if (textLayerContainer) {
          textLayerContainer.style.setProperty(
            '--total-scale-factor',
            String(viewport.scale),
          );
          const textLayer = new pdfjs.TextLayer({
            textContentSource: pdfPage.streamTextContent(),
            container: textLayerContainer,
            viewport,
          });
          textLayerInstanceRef.current = textLayer;
          textLayer.render().catch((textError: any) => {
            if (cancelled || textError?.name === 'AbortException') return;
            setError(String(textError?.message || textError || 'PDF 文本层渲染失败'));
          });
        }
        return renderTask.promise;
      })
      .catch((renderError: any) => {
        if (cancelled || renderError?.name === 'RenderingCancelledException') return;
        setError(String(renderError?.message || renderError || 'PDF 渲染失败'));
      });
    return () => {
      cancelled = true;
      renderTaskRef.current?.cancel();
      renderTaskRef.current = null;
      textLayerInstanceRef.current?.cancel();
      textLayerInstanceRef.current = null;
      textLayerContainer?.replaceChildren();
    };
  }, [document, page, zoom, rotation, containerWidth]);

  const pointFromEvent = (event: ReactPointerEvent<HTMLDivElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    return {
      x: clamp((event.clientX - bounds.left) / Math.max(1, bounds.width), 0, 1),
      y: clamp((event.clientY - bounds.top) / Math.max(1, bounds.height), 0, 1),
    };
  };

  const finishSelection = (event: ReactPointerEvent<HTMLDivElement>) => {
    const start = dragRef.current;
    if (!start) return;
    dragRef.current = null;
    try {
      event.currentTarget.releasePointerCapture?.(event.pointerId);
    } catch {
      /* synthetic pointer events may not have an active capture */
    }
    const end = pointFromEvent(event);
    const rect = {
      x: Math.min(start.x, end.x),
      y: Math.min(start.y, end.y),
      width: Math.abs(end.x - start.x),
      height: Math.abs(end.y - start.y),
    };
    setDraft(null);
    if (rect.width < 0.01 || rect.height < 0.01) return;
    onRectSelected(rect);
  };

  const captureTextSelection = (sheet: HTMLDivElement) => {
    if (selecting) return;
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || !selection.rangeCount) return;
    const range = selection.getRangeAt(0);
    const textLayer = textLayerRef.current;
    if (!textLayer || !textLayer.contains(range.commonAncestorContainer)) return;
    const text = selection.toString().replace(/\s+/g, ' ').trim();
    if (!text) return;
    const bounds = sheet.getBoundingClientRect();
    const rects = [...range.getClientRects()]
      .filter(
        (rect) =>
          rect.width > 1 &&
          rect.height > 1 &&
          rect.bottom >= bounds.top &&
          rect.top <= bounds.bottom,
      )
      .slice(0, 200)
      .map((rect) => {
        const x = clamp((rect.left - bounds.left) / Math.max(1, bounds.width), 0, 1);
        const y = clamp((rect.top - bounds.top) / Math.max(1, bounds.height), 0, 1);
        return {
          x,
          y,
          width: clamp(rect.width / Math.max(1, bounds.width), 0, 1 - x),
          height: clamp(rect.height / Math.max(1, bounds.height), 0, 1 - y),
        };
      })
      .filter((rect) => rect.width > 0.002 && rect.height > 0.002);
    if (!rects.length) return;
    onTextSelected({ text: text.slice(0, 2000), rects });
    selection.removeAllRanges();
  };

  const arrowHeadPoints = (from: PdfPoint, to: PdfPoint) => {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const length = Math.hypot(dx, dy);
    if (length < 0.001) return '';
    const ux = dx / length;
    const uy = dy / length;
    const size = 0.022;
    const half = 0.011;
    const baseX = to.x - ux * size;
    const baseY = to.y - uy * size;
    return [
      `${to.x},${to.y}`,
      `${baseX - uy * half},${baseY + ux * half}`,
      `${baseX + uy * half},${baseY - ux * half}`,
    ].join(' ');
  };

  const graphicalBounds = (annotation: PdfPageAction): PdfRect | null => {
    if (annotation.points?.length) {
      const xs = annotation.points.map((point) => point.x);
      const ys = annotation.points.map((point) => point.y);
      return {
        x: Math.min(...xs),
        y: Math.min(...ys),
        width: Math.max(...xs) - Math.min(...xs),
        height: Math.max(...ys) - Math.min(...ys),
      };
    }
    if (annotation.from && annotation.to) {
      return {
        x: Math.min(annotation.from.x, annotation.to.x),
        y: Math.min(annotation.from.y, annotation.to.y),
        width: Math.abs(annotation.to.x - annotation.from.x),
        height: Math.abs(annotation.to.y - annotation.from.y),
      };
    }
    return annotation.shape ? annotation.rect || null : null;
  };

  const startDrawing = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (drawTool === 'none') return;
    event.preventDefault();
    const point = pointFromEvent(event);
    if (drawTool === 'erase') {
      const target = [...annotations].reverse().find((annotation) => {
        const bounds = graphicalBounds(annotation);
        return (
          bounds &&
          point.x >= bounds.x - 0.01 &&
          point.x <= bounds.x + bounds.width + 0.01 &&
          point.y >= bounds.y - 0.01 &&
          point.y <= bounds.y + bounds.height + 0.01
        );
      });
      if (target) onErase(target.id);
      return;
    }
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      /* synthetic pointers may not support capture */
    }
    drawStartRef.current = point;
    if (drawTool === 'ink') updateDrawDraft({ points: [point] });
    else updateDrawDraft({ shape: drawTool, from: point, to: point });
  };

  const updateDrawing = (event: ReactPointerEvent<HTMLDivElement>) => {
    const start = drawStartRef.current;
    if (!start) return;
    const point = pointFromEvent(event);
    if (drawTool === 'ink') {
      const current = drawDraftRef.current;
      if (!current || !('points' in current)) return;
      const last = current.points[current.points.length - 1];
      if (last && Math.hypot(point.x - last.x, point.y - last.y) < 0.004) return;
      updateDrawDraft({ points: [...current.points, point].slice(-1000) });
      return;
    }
    if (drawTool === 'rect' || drawTool === 'arrow') {
      updateDrawDraft({ shape: drawTool, from: start, to: point });
    }
  };

  const finishDrawing = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!drawStartRef.current) return;
    drawStartRef.current = null;
    try {
      event.currentTarget.releasePointerCapture?.(event.pointerId);
    } catch {
      /* synthetic pointers may not support capture */
    }
    const draftValue = drawDraftRef.current;
    updateDrawDraft(null);
    if (!draftValue) return;
    if ('points' in draftValue) {
      if (draftValue.points.length > 1) onDrawInk(draftValue.points);
      return;
    }
    const width = Math.abs(draftValue.to.x - draftValue.from.x);
    const height = Math.abs(draftValue.to.y - draftValue.from.y);
    if (width + height > 0.01) {
      onDrawShape(draftValue.shape, draftValue.from, draftValue.to);
    }
  };

  useEffect(() => {
    drawDraftRef.current = null;
    setDrawDraft(null);
    drawStartRef.current = null;
  }, [drawTool, page, rotation]);

  if (error) {
    return <div className="files-error">{error}</div>;
  }

  return (
    <div className="pdf-page-viewport" ref={containerRef}>
      <div
        className="pdf-page-sheet"
        style={{
          width: pageSize.width || undefined,
          height: pageSize.height || undefined,
        }}
        onMouseUp={(event) => captureTextSelection(event.currentTarget)}
      >
        <canvas ref={canvasRef} className="pdf-page-canvas" />
        <div ref={textLayerRef} className="pdf-text-layer" />
        <svg
          className="pdf-shape-layer"
          viewBox="0 0 1 1"
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          {annotations.map((annotation) => {
            if (annotation.points?.length) {
              return (
                <polyline
                  key={`${annotation.id}-ink`}
                  points={annotation.points
                    .map((point) => `${point.x},${point.y}`)
                    .join(' ')}
                  fill="none"
                  stroke={annotation.color || '#5ea7ff'}
                  strokeWidth={annotation.width || 2.5}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  vectorEffect="non-scaling-stroke"
                />
              );
            }
            if (annotation.shape === 'rect') {
              const bounds = graphicalBounds(annotation);
              if (!bounds) return null;
              return (
                <rect
                  key={`${annotation.id}-rect`}
                  x={bounds.x}
                  y={bounds.y}
                  width={bounds.width}
                  height={bounds.height}
                  fill="none"
                  stroke={annotation.color || '#ff7a59'}
                  strokeWidth={annotation.width || 2}
                  vectorEffect="non-scaling-stroke"
                />
              );
            }
            if (annotation.shape === 'arrow' && annotation.from && annotation.to) {
              const color = annotation.color || '#ff7a59';
              return (
                <g key={`${annotation.id}-arrow`}>
                  <line
                    x1={annotation.from.x}
                    y1={annotation.from.y}
                    x2={annotation.to.x}
                    y2={annotation.to.y}
                    stroke={color}
                    strokeWidth={annotation.width || 2}
                    vectorEffect="non-scaling-stroke"
                  />
                  <polygon
                    points={arrowHeadPoints(annotation.from, annotation.to)}
                    fill={color}
                  />
                </g>
              );
            }
            return null;
          })}
          {drawDraft && 'points' in drawDraft ? (
            <polyline
              points={drawDraft.points
                .map((point) => `${point.x},${point.y}`)
                .join(' ')}
              fill="none"
              stroke={drawColor}
              strokeWidth={drawWidth}
              strokeLinecap="round"
              strokeLinejoin="round"
              vectorEffect="non-scaling-stroke"
              opacity="0.7"
            />
          ) : null}
          {drawDraft && 'shape' in drawDraft ? (
            drawDraft.shape === 'rect' ? (
              <rect
                x={Math.min(drawDraft.from.x, drawDraft.to.x)}
                y={Math.min(drawDraft.from.y, drawDraft.to.y)}
                width={Math.abs(drawDraft.to.x - drawDraft.from.x)}
                height={Math.abs(drawDraft.to.y - drawDraft.from.y)}
                fill="none"
                stroke={drawColor}
                strokeWidth={drawWidth}
                strokeDasharray="5 4"
                vectorEffect="non-scaling-stroke"
              />
            ) : (
              <g>
                <line
                  x1={drawDraft.from.x}
                  y1={drawDraft.from.y}
                  x2={drawDraft.to.x}
                  y2={drawDraft.to.y}
                  stroke={drawColor}
                  strokeWidth={drawWidth}
                  strokeDasharray="5 4"
                  vectorEffect="non-scaling-stroke"
                />
                <polygon
                  points={arrowHeadPoints(drawDraft.from, drawDraft.to)}
                  fill={drawColor}
                />
              </g>
            )
          ) : null}
        </svg>
        {annotations.map((annotation) => {
          const rects = annotation.rects?.length
            ? annotation.rects
            : annotation.rect
              ? [annotation.rect]
              : [];
          return rects.map((rect, index) => (
            <div
              key={`${annotation.id}-${index}`}
              className="pdf-highlight-box"
              title={annotation.text}
              style={{
                left: `${rect.x * 100}%`,
                top: `${rect.y * 100}%`,
                width: `${rect.width * 100}%`,
                height: `${rect.height * 100}%`,
              }}
            />
          ));
        })}
        {draft ? (
          <div
            className="pdf-highlight-box draft"
            style={{
              left: `${draft.x * 100}%`,
              top: `${draft.y * 100}%`,
              width: `${draft.width * 100}%`,
              height: `${draft.height * 100}%`,
            }}
          />
        ) : null}
        <div
          className={`pdf-select-surface ${selecting ? 'active' : ''}`}
          onPointerDown={(event) => {
            if (!selecting) return;
            event.preventDefault();
            try {
              event.currentTarget.setPointerCapture(event.pointerId);
            } catch {
              /* synthetic pointer events may not have an active pointer */
            }
            const start = pointFromEvent(event);
            dragRef.current = start;
            setDraft({ x: start.x, y: start.y, width: 0, height: 0 });
          }}
          onPointerMove={(event) => {
            const start = dragRef.current;
            if (!start) return;
            const end = pointFromEvent(event);
            setDraft({
              x: Math.min(start.x, end.x),
              y: Math.min(start.y, end.y),
              width: Math.abs(end.x - start.x),
              height: Math.abs(end.y - start.y),
            });
          }}
          onPointerUp={finishSelection}
          onPointerCancel={finishSelection}
        />
        <div
          className={`pdf-draw-surface ${drawTool !== 'none' ? 'active' : ''}`}
          onPointerDown={startDrawing}
          onPointerMove={updateDrawing}
          onPointerUp={finishDrawing}
          onPointerCancel={finishDrawing}
        />
      </div>
    </div>
  );
}
