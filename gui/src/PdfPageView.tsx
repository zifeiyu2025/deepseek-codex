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

type PdfPageAction = {
  id: string;
  text: string;
  rect?: PdfRect;
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
}: {
  dataUrl: string;
  page: number;
  zoom: number;
  rotation: number;
  selecting: boolean;
  annotations: PdfPageAction[];
  onPageCount: (count: number) => void;
  onRectSelected: (rect: PdfRect) => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const renderTaskRef = useRef<RenderTask | null>(null);
  const dragRef = useRef<{ x: number; y: number } | null>(null);
  const [document, setDocument] = useState<PDFDocumentProxy | null>(null);
  const [containerWidth, setContainerWidth] = useState(0);
  const [pageSize, setPageSize] = useState({ width: 0, height: 0 });
  const [draft, setDraft] = useState<PdfRect | null>(null);
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
    let cancelled = false;
    renderTaskRef.current?.cancel();
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
      >
        <canvas ref={canvasRef} className="pdf-page-canvas" />
        {annotations.map((annotation) =>
          annotation.rect ? (
            <div
              key={annotation.id}
              className="pdf-highlight-box"
              title={annotation.text}
              style={{
                left: `${annotation.rect.x * 100}%`,
                top: `${annotation.rect.y * 100}%`,
                width: `${annotation.rect.width * 100}%`,
                height: `${annotation.rect.height * 100}%`,
              }}
            />
          ) : null,
        )}
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
      </div>
    </div>
  );
}
