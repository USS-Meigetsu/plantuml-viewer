"use client";

import {
  Braces,
  Check,
  ChevronLeft,
  CircleAlert,
  Code2,
  Copy,
  Download,
  Expand,
  FileCode2,
  Focus,
  GripVertical,
  LoaderCircle,
  Maximize2,
  Minus,
  MousePointer2,
  Play,
  Plus,
  RotateCcw,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import {
  ClipboardEvent as ReactClipboardEvent,
  PointerEvent as ReactPointerEvent,
  UIEvent,
  WheelEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

const SAMPLE_SOURCE = `@startuml
title オンライン注文フロー

skinparam shadowing false
skinparam roundcorner 12
skinparam activity {
  BackgroundColor #F8FAFC
  BorderColor #475569
  DiamondBackgroundColor #FEF3C7
  DiamondBorderColor #B45309
  StartColor #2563EB
  EndColor #16A34A
}

|#EAF2FF|利用者|
start
:商品をカートに入れる;
:購入を確定する;

|#ECFDF5|Webアプリ|
:在庫を確認する;

if (在庫がある？) then (はい)
  :注文を作成する;

  |#FFF7ED|決済サービス|
  :支払いを承認する;

  if (決済に成功？) then (はい)
    |#F5F3FF|倉庫|
    :商品を梱包する;
    :配送を開始する;

    |Webアプリ|
    :発送通知を送る;

    |利用者|
    :商品を受け取る;
    stop
  else (いいえ)
    |Webアプリ|
    :決済エラーを表示する;

    |利用者|
    :支払い方法を変更する;
    stop
  endif
else (いいえ)
  |Webアプリ|
  :在庫切れを案内する;

  |利用者|
  :入荷通知を登録する;
  stop
endif
@enduml`;

const STORAGE_KEY = "plantuml-viewer-source-v2";
const RENDER_LIMIT_STORAGE_KEY = "plantuml-viewer-render-limit-v1";
const DEFAULT_RENDER_LIMIT = 8192;
const MAX_RENDER_LIMIT = 32768;
const MIN_SCALE = 0.02;
const MAX_SCALE = 8;
const LANE_GUIDE_TOP = 64;

declare global {
  interface Window {
    __PLANTUML_ENGINE__?: EngineModule;
    __PLANTUML_VIEWER_LIMIT__?: number;
  }
}

type EngineModule = {
  renderToString: (
    lines: string[],
    onSuccess: (svg: string) => void,
    onError: (message: string) => void,
  ) => void;
};
type RenderState = "idle" | "loading" | "success" | "error";
type Transform = { scale: number; x: number; y: number };
type Point = { x: number; y: number };
type DiagramSize = { width: number; height: number };
type DiagramLimitError = {
  width: number;
  height: number;
  currentLimit: number;
  requiredLimit: number;
  recommendedLimit: number;
};
type Swimlane = {
  name: string;
  x0: number;
  x1: number;
  headerBottom: number;
  colorIndex: number;
};
type NormalizedSource = {
  source: string;
  strippedMarkdownFence: boolean;
};
let enginePromise: Promise<EngineModule> | null = null;
let renderQueue: Promise<void> = Promise.resolve();

function loadScript(src: string, type: "classic" | "module" = "classic") {
  return new Promise<void>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(
      `script[data-plantuml-runtime="${src}"]`,
    );
    if (existing?.dataset.loaded === "true") {
      resolve();
      return;
    }
    if (existing) {
      existing.addEventListener("load", () => resolve(), { once: true });
      existing.addEventListener(
        "error",
        () => reject(new Error("PlantUML描画エンジンを読み込めませんでした。")),
        { once: true },
      );
      return;
    }

    const script = document.createElement("script");
    script.src = src;
    script.async = true;
    if (type === "module") script.type = "module";
    script.dataset.plantumlRuntime = src;
    script.addEventListener(
      "load",
      () => {
        script.dataset.loaded = "true";
        resolve();
      },
      { once: true },
    );
    script.addEventListener(
      "error",
      () => reject(new Error("PlantUML描画エンジンを読み込めませんでした。")),
      { once: true },
    );
    document.head.appendChild(script);
  });
}

async function loadPlantUmlEngine() {
  if (!enginePromise) {
    enginePromise = (async () => {
      await loadScript("/plantuml/viz-global.js");
      await loadScript(
        "/plantuml/plantuml-loader.js?v=dynamic-limit-1",
        "module",
      );
      if (!window.__PLANTUML_ENGINE__) {
        throw new Error("PlantUML描画エンジンを初期化できませんでした。");
      }
      return window.__PLANTUML_ENGINE__;
    })();
  }
  return enginePromise;
}

function renderPlantUml(source: string, renderLimit: number) {
  const job = renderQueue.then(async () => {
    window.__PLANTUML_VIEWER_LIMIT__ = renderLimit;
    const engine = await loadPlantUmlEngine();
    return new Promise<string>((resolve, reject) => {
      engine.renderToString(
        source.split(/\r\n|\r|\n/),
        resolve,
        (message) => reject(new Error(String(message))),
      );
    });
  });

  renderQueue = job.then(
    () => undefined,
    () => undefined,
  );
  return job;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function extractFencedPlantUml(source: string) {
  const trimmed = source.replace(/^\uFEFF/, "").trim();
  const fencedBlock = trimmed.match(
    /(?:^|\r?\n)[ \t]*(`{3,}|~{3,})[ \t]*(?:plantuml|puml|uml)?[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*\1[ \t]*(?=\r?\n|$)/i,
  );
  if (!fencedBlock) return null;

  const candidate = fencedBlock[2].trim();
  return /@start[a-z0-9_]*/i.test(candidate) ? candidate : null;
}

function normalizeSource(source: string): NormalizedSource {
  const fencedSource = extractFencedPlantUml(source);
  const trimmed = (fencedSource ?? source).replace(/^\uFEFF/, "").trim();
  if (!trimmed) return { source: "", strippedMarkdownFence: false };
  if (/^\s*@start[a-z0-9_]*/im.test(trimmed)) {
    return {
      source: trimmed,
      strippedMarkdownFence: fencedSource !== null,
    };
  }
  return {
    source: `@startuml\n${trimmed}\n@enduml`,
    strippedMarkdownFence: fencedSource !== null,
  };
}

function extractPlantUmlError(svg: string) {
  const document = new DOMParser().parseFromString(svg, "image/svg+xml");
  if (document.querySelector("parsererror")) return "";

  const lines = Array.from(document.querySelectorAll("text"))
    .map((element) => element.textContent?.replace(/\s+/g, " ").trim() ?? "")
    .filter(Boolean);
  const message = lines.join("\n");
  const isPlantUmlError = [
    /diagram not supported by this release of plantuml/i,
    /syntax error/i,
    /error line\s*\d+/i,
    /directive .+ is not recognized/i,
    /no diagram found/i,
    /cannot include/i,
    /cannot decode/i,
  ].some((pattern) => pattern.test(message));

  return isPlantUmlError ? `PlantUML描画エラー\n\n${message}` : "";
}

function sanitizeSvg(svg: string) {
  const parser = new DOMParser();
  const document = parser.parseFromString(svg, "image/svg+xml");
  if (document.querySelector("parsererror")) {
    throw new Error("生成されたSVGを読み取れませんでした。");
  }

  document
    .querySelectorAll("script, foreignObject, iframe, object, embed")
    .forEach((element) => element.remove());

  document.querySelectorAll("*").forEach((element) => {
    for (const attribute of Array.from(element.attributes)) {
      const name = attribute.name.toLowerCase();
      const value = attribute.value.trim().toLowerCase();
      if (name.startsWith("on")) element.removeAttribute(attribute.name);
      if (
        (name === "href" || name === "xlink:href") &&
        (value.startsWith("javascript:") || value.startsWith("data:text/html"))
      ) {
        element.removeAttribute(attribute.name);
      }
    }
  });

  const root = document.documentElement;
  root.setAttribute("role", "img");
  root.setAttribute("aria-label", "PlantUMLで生成した図");
  return new XMLSerializer().serializeToString(root);
}

function getSvgSize(svg: string): DiagramSize {
  const document = new DOMParser().parseFromString(svg, "image/svg+xml");
  const root = document.documentElement;
  const viewBox = root.getAttribute("viewBox")?.split(/[ ,]+/).map(Number);
  const width = Number.parseFloat(root.getAttribute("width") ?? "");
  const height = Number.parseFloat(root.getAttribute("height") ?? "");
  const viewBoxIsValid =
    viewBox?.length === 4 &&
    Number.isFinite(viewBox[2]) &&
    Number.isFinite(viewBox[3]) &&
    viewBox[2] > 0 &&
    viewBox[3] > 0;
  return {
    width: viewBoxIsValid
      ? viewBox[2]
      : Number.isFinite(width) && width > 0
        ? width
        : 800,
    height: viewBoxIsValid
      ? viewBox[3]
      : Number.isFinite(height) && height > 0
        ? height
        : 600,
  };
}

function parseDiagramLimitError(
  message: string,
  currentLimit: number,
): DiagramLimitError | null {
  const match = message.match(
    /Diagram too large for browser rendering:\s*([\d.]+)x([\d.]+)/i,
  );
  if (!match) return null;

  const width = Math.ceil(Number(match[1]));
  const height = Math.ceil(Number(match[2]));
  if (!Number.isFinite(width) || !Number.isFinite(height)) return null;

  const requiredLimit = Math.max(width, height);
  const recommendedLimit = Math.min(
    MAX_RENDER_LIMIT,
    Math.max(
      currentLimit + 512,
      Math.ceil((requiredLimit * 1.1) / 512) * 512,
    ),
  );
  return {
    width,
    height,
    currentLimit,
    requiredLimit,
    recommendedLimit,
  };
}

function getSourceSwimlaneNames(source: string) {
  const names: string[] = [];
  for (const line of source.split(/\r\n|\r|\n/)) {
    const match = line.trim().match(/^\|(.+)\|$/);
    if (!match) continue;
    const parts = match[1].split("|").map((part) => part.trim());
    const rawName = parts[0]?.startsWith("#")
      ? parts.slice(1).join("|")
      : parts.join("|");
    const name = rawName.trim().replace(/^"|"$/g, "");
    if (name && !names.includes(name)) names.push(name);
  }
  return names;
}

function readSvgNumber(element: Element, attribute: string) {
  const value = Number.parseFloat(element.getAttribute(attribute) ?? "");
  return Number.isFinite(value) ? value : null;
}

function extractSwimlanes(svg: string, source: string): Swimlane[] {
  const sourceNames = getSourceSwimlaneNames(source);
  if (sourceNames.length < 2) return [];

  const document = new DOMParser().parseFromString(svg, "image/svg+xml");
  if (document.querySelector("parsererror")) return [];
  const root = document.documentElement;
  const viewBox = root.getAttribute("viewBox")?.split(/[ ,]+/).map(Number);
  const minX = viewBox?.length === 4 && Number.isFinite(viewBox[0]) ? viewBox[0] : 0;
  const minY = viewBox?.length === 4 && Number.isFinite(viewBox[1]) ? viewBox[1] : 0;
  const width =
    viewBox?.length === 4 && Number.isFinite(viewBox[2]) && viewBox[2] > 0
      ? viewBox[2]
      : Number.parseFloat(root.getAttribute("width") ?? "") || 800;
  const height =
    viewBox?.length === 4 && Number.isFinite(viewBox[3]) && viewBox[3] > 0
      ? viewBox[3]
      : Number.parseFloat(root.getAttribute("height") ?? "") || 600;

  type BoundaryGroup = { y0: number; y1: number; xs: number[] };
  const groups: BoundaryGroup[] = [];
  for (const line of Array.from(document.querySelectorAll("line"))) {
    const x1 = readSvgNumber(line, "x1");
    const x2 = readSvgNumber(line, "x2");
    const y1 = readSvgNumber(line, "y1");
    const y2 = readSvgNumber(line, "y2");
    if (x1 === null || x2 === null || y1 === null || y2 === null) continue;
    if (Math.abs(x1 - x2) > 0.75 || Math.abs(y2 - y1) < height * 0.65) continue;
    const y0 = Math.min(y1, y2);
    const yEnd = Math.max(y1, y2);
    let group = groups.find(
      (candidate) =>
        Math.abs(candidate.y0 - y0) <= 2 && Math.abs(candidate.y1 - yEnd) <= 2,
    );
    if (!group) {
      group = { y0, y1: yEnd, xs: [] };
      groups.push(group);
    }
    group.xs.push((x1 + x2) / 2);
  }

  const rankedGroups = groups
    .map((group) => ({
      ...group,
      xs: group.xs
        .sort((a, b) => a - b)
        .filter((x, index, values) => index === 0 || Math.abs(x - values[index - 1]) > 1),
    }))
    .filter(
      (group) =>
        group.xs.length >= 3 &&
        group.xs[group.xs.length - 1] - group.xs[0] >= width * 0.25,
    )
    .sort((a, b) => {
      const countDifference = b.xs.length - a.xs.length;
      if (countDifference) return countDifference;
      return b.xs[b.xs.length - 1] - b.xs[0] - (a.xs[a.xs.length - 1] - a.xs[0]);
    });
  const boundaryGroup = rankedGroups[0];
  if (!boundaryGroup) return [];

  const boundaries = boundaryGroup.xs;
  const headerRect = Array.from(document.querySelectorAll("rect"))
    .map((rect) => ({
      x: readSvgNumber(rect, "x"),
      y: readSvgNumber(rect, "y"),
      width: readSvgNumber(rect, "width"),
      height: readSvgNumber(rect, "height"),
    }))
    .filter(
      (rect) =>
        rect.x !== null &&
        rect.y !== null &&
        rect.width !== null &&
        rect.height !== null &&
        Math.abs(rect.y - boundaryGroup.y0) <= 3 &&
        rect.x <= boundaries[0] + 3 &&
        rect.x + rect.width >= boundaries[boundaries.length - 1] - 3 &&
        rect.height >= 8 &&
        rect.height <= Math.min(120, height * 0.2),
    )
    .sort((a, b) => (a.height ?? 0) - (b.height ?? 0))[0];
  const headerBottom =
    headerRect && headerRect.y !== null && headerRect.height !== null
      ? headerRect.y + headerRect.height
      : boundaryGroup.y0 + 32;

  const headerTexts = Array.from(document.querySelectorAll("text"))
    .map((text) => {
      const firstTspan = text.querySelector("tspan");
      return {
        text: text.textContent?.replace(/\s+/g, " ").trim() ?? "",
        x: readSvgNumber(text, "x") ?? (firstTspan ? readSvgNumber(firstTspan, "x") : null),
        y: readSvgNumber(text, "y") ?? (firstTspan ? readSvgNumber(firstTspan, "y") : null),
      };
    })
    .filter(
      (text) =>
        text.text &&
        text.x !== null &&
        text.y !== null &&
        text.y >= boundaryGroup.y0 - 3 &&
        text.y <= headerBottom + 4,
    );

  const laneCount = Math.min(boundaries.length - 1, sourceNames.length);
  return Array.from({ length: laneCount }, (_, index) => {
    const x0 = boundaries[index];
    const x1 = boundaries[index + 1];
    const label = headerTexts.find(
      (text) => text.x !== null && text.x >= x0 && text.x <= x1,
    )?.text;
    return {
      name: label || sourceNames[index] || `レーン ${index + 1}`,
      x0: x0 - minX,
      x1: x1 - minX,
      headerBottom: headerBottom - minY,
      colorIndex: index % 6,
    };
  });
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function detectDiagramType(source: string) {
  const start = source.match(/@start([a-z0-9_]+)/i)?.[1]?.toLowerCase();
  if (start && start !== "uml") return start.toUpperCase();
  if (/^\s*(?:actor|participant|boundary|control|entity|database)\b/im.test(source)) {
    return "Sequence Diagram";
  }
  if (/^\s*(?:class|interface|enum|abstract\s+class)\b/im.test(source)) {
    return "Class Diagram";
  }
  if (/^\s*(?:component|node|cloud|artifact|package)\b/im.test(source)) {
    return "Component Diagram";
  }
  if (/^\s*(?:state|\[\*\])\b/im.test(source)) return "State Diagram";
  if (/^\s*(?:start|stop|if\s*\(|partition)\b/im.test(source)) {
    return "Activity Diagram";
  }
  return "PlantUML";
}

export default function PlantUmlWorkspace() {
  const [source, setSource] = useState(SAMPLE_SOURCE);
  const [renderedSource, setRenderedSource] = useState("");
  const [svg, setSvg] = useState("");
  const [svgUrl, setSvgUrl] = useState("");
  const [diagramSize, setDiagramSize] = useState<DiagramSize>({
    width: 800,
    height: 600,
  });
  const [renderState, setRenderState] = useState<RenderState>("idle");
  const [statusMessage, setStatusMessage] = useState("サンプルを表示できます");
  const [errorDetails, setErrorDetails] = useState("");
  const [errorCopied, setErrorCopied] = useState(false);
  const [renderLimit, setRenderLimit] = useState(DEFAULT_RENDER_LIMIT);
  const [limitError, setLimitError] = useState<DiagramLimitError | null>(null);
  const [proposedLimit, setProposedLimit] = useState("");
  const [limitInputError, setLimitInputError] = useState("");
  const [diagramType, setDiagramType] = useState("");
  const [swimlanes, setSwimlanes] = useState<Swimlane[]>([]);
  const [editorPercent, setEditorPercent] = useState(35);
  const [canvasSize, setCanvasSize] = useState({ width: 0, height: 0 });
  const [toolbarPosition, setToolbarPosition] = useState<Point | null>(null);
  const [transform, setTransform] = useState<Transform>({
    scale: 1,
    x: 0,
    y: 0,
  });
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [isEditorCollapsed, setIsEditorCollapsed] = useState(false);

  const workspaceRef = useRef<HTMLDivElement>(null);
  const previewPanelRef = useRef<HTMLElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const gutterRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fullscreenButtonRef = useRef<HTMLButtonElement>(null);
  const renderRequestRef = useRef(0);
  const transformRef = useRef(transform);
  const pointersRef = useRef(new Map<number, { x: number; y: number }>());
  const panOriginRef = useRef<{
    pointerX: number;
    pointerY: number;
    x: number;
    y: number;
  } | null>(null);
  const pinchOriginRef = useRef<{
    distance: number;
    centerX: number;
    centerY: number;
    transform: Transform;
  } | null>(null);
  const splitDragRef = useRef<{ startX: number; startPercent: number } | null>(
    null,
  );
  const toolbarDragRef = useRef<{
    pointerId: number;
    pointerX: number;
    pointerY: number;
    x: number;
    y: number;
  } | null>(null);

  const lines = useMemo(() => source.split("\n"), [source]);
  const sourceIsDirty = Boolean(svg && source.trim() !== renderedSource.trim());
  const laneGuideSegments = useMemo(() => {
    if (!swimlanes.length || !canvasSize.width) return [];
    const naturalHeaderBottom =
      transform.y + swimlanes[0].headerBottom * transform.scale;
    if (naturalHeaderBottom >= LANE_GUIDE_TOP) return [];

    const center = canvasSize.width / 2;
    return swimlanes
      .map((lane) => {
        const rawLeft = transform.x + lane.x0 * transform.scale;
        const rawRight = transform.x + lane.x1 * transform.scale;
        const left = clamp(rawLeft, 0, canvasSize.width);
        const right = clamp(rawRight, 0, canvasSize.width);
        return {
          ...lane,
          left,
          width: right - left,
          isPrimary: rawLeft <= center && rawRight >= center,
        };
      })
      .filter((lane) => lane.width > 3);
  }, [canvasSize.width, swimlanes, transform]);

  useEffect(() => {
    transformRef.current = transform;
  }, [transform]);

  useEffect(() => {
    let timer = 0;
    try {
      const saved = window.localStorage.getItem(STORAGE_KEY);
      const savedLimit = Number(
        window.localStorage.getItem(RENDER_LIMIT_STORAGE_KEY),
      );
      const hasSavedLimit =
        Number.isInteger(savedLimit) &&
        savedLimit >= DEFAULT_RENDER_LIMIT &&
        savedLimit <= MAX_RENDER_LIMIT;
      if (saved || hasSavedLimit) {
        timer = window.setTimeout(() => {
          if (saved) setSource(saved);
          if (hasSavedLimit) setRenderLimit(savedLimit);
        }, 0);
      }
    } catch {
      // Local persistence is optional; the editor remains fully usable.
    }
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      try {
        window.localStorage.setItem(STORAGE_KEY, source);
      } catch {
        // Ignore storage quota and privacy-mode failures.
      }
    }, 350);
    return () => window.clearTimeout(timer);
  }, [source]);

  useEffect(() => {
    if (!svg) {
      return;
    }
    const url = URL.createObjectURL(
      new Blob([svg], { type: "image/svg+xml;charset=utf-8" }),
    );
    const timer = window.setTimeout(() => setSvgUrl(url), 0);
    return () => {
      window.clearTimeout(timer);
      URL.revokeObjectURL(url);
    };
  }, [svg]);

  const fitDiagram = useCallback(
    (size = diagramSize) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const width = canvas.clientWidth;
      const height = canvas.clientHeight;
      const padding = width < 640 ? 28 : 56;
      const nextScale = clamp(
        Math.min(
          (width - padding * 2) / size.width,
          (height - padding * 2) / size.height,
        ),
        MIN_SCALE,
        MAX_SCALE,
      );
      setTransform({
        scale: nextScale,
        x: (width - size.width * nextScale) / 2,
        y: (height - size.height * nextScale) / 2,
      });
    },
    [diagramSize],
  );

  const centerAtScale = useCallback(
    (scale: number) => {
      const canvas = canvasRef.current;
      if (!canvas || !svg) return;
      const nextScale = clamp(scale, MIN_SCALE, MAX_SCALE);
      setTransform({
        scale: nextScale,
        x: (canvas.clientWidth - diagramSize.width * nextScale) / 2,
        y: (canvas.clientHeight - diagramSize.height * nextScale) / 2,
      });
    },
    [diagramSize, svg],
  );

  const changeScaleAroundPoint = useCallback(
    (nextScale: number, clientX?: number, clientY?: number) => {
      const canvas = canvasRef.current;
      if (!canvas || !svg) return;
      const rect = canvas.getBoundingClientRect();
      const current = transformRef.current;
      const scale = clamp(nextScale, MIN_SCALE, MAX_SCALE);
      const pointX = clientX === undefined ? rect.width / 2 : clientX - rect.left;
      const pointY =
        clientY === undefined ? rect.height / 2 : clientY - rect.top;
      const ratio = scale / current.scale;
      setTransform({
        scale,
        x: pointX - (pointX - current.x) * ratio,
        y: pointY - (pointY - current.y) * ratio,
      });
    },
    [svg],
  );

  const renderDiagram = useCallback(async (limitOverride?: number) => {
    const activeLimit = limitOverride ?? renderLimit;
    const normalized = normalizeSource(source);
    if (!normalized.source) {
      setRenderState("error");
      setStatusMessage("PlantUMLコードを貼り付けてください。");
      setErrorDetails("PlantUML描画エラー\n\n入力欄が空です。");
      setErrorCopied(false);
      setSvg("");
      setSvgUrl("");
      setDiagramType("");
      setSwimlanes([]);
      setLimitError(null);
      textareaRef.current?.focus();
      return;
    }

    const requestId = ++renderRequestRef.current;
    setRenderState("loading");
    setStatusMessage("描画エンジンを準備しています…");
    setErrorDetails("");
    setErrorCopied(false);
    setLimitError(null);
    setLimitInputError("");

    try {
      setStatusMessage("図を描画しています…");

      const rawSvg = await Promise.race([
        renderPlantUml(normalized.source, activeLimit),
        new Promise<never>((_, reject) =>
          window.setTimeout(
            () => reject(new Error("描画に時間がかかりすぎています。図を小さくして再度お試しください。")),
            45000,
          ),
        ),
      ]);

      if (requestId !== renderRequestRef.current) return;
      const plantUmlError = extractPlantUmlError(rawSvg);
      if (plantUmlError) {
        setSvg("");
        setSvgUrl("");
        setDiagramType("");
        setSwimlanes([]);
        setRenderedSource("");
        setRenderState("error");
        setStatusMessage("描画できませんでした。エラー内容を確認してください。");
        setErrorDetails(plantUmlError);
        return;
      }

      const safeSvg = sanitizeSvg(rawSvg);
      const size = getSvgSize(safeSvg);
      setSvg(safeSvg);
      setDiagramSize(size);
      setRenderedSource(source);
      setDiagramType(detectDiagramType(normalized.source));
      setSwimlanes(extractSwimlanes(safeSvg, normalized.source));
      setRenderState("success");
      setStatusMessage(
        normalized.strippedMarkdownFence
          ? "Markdownのコード囲みを除去して描画しました"
          : "描画完了",
      );
      window.requestAnimationFrame(() => fitDiagram(size));
    } catch (error) {
      if (requestId !== renderRequestRef.current) return;
      const rawMessage =
        error instanceof Error
          ? error.message
          : "描画中に問題が発生しました。もう一度お試しください。";
      const diagramLimitError = parseDiagramLimitError(rawMessage, activeLimit);
      const message = diagramLimitError
        ? rawMessage.replace(/\(max\s+[\d.]+\)/i, `(max ${activeLimit})`)
        : rawMessage;
      setSvg("");
      setSvgUrl("");
      setDiagramType("");
      setSwimlanes([]);
      setRenderedSource("");
      setRenderState("error");
      setStatusMessage("描画できませんでした。エラー内容を確認してください。");
      setErrorDetails(`PlantUML描画エラー\n\n${message}`);
      setLimitError(diagramLimitError);
      if (diagramLimitError) {
        setProposedLimit(String(diagramLimitError.recommendedLimit));
      }
    }
  }, [fitDiagram, renderLimit, source]);

  const copyErrorDetails = async () => {
    if (!errorDetails) return;
    try {
      await navigator.clipboard.writeText(errorDetails);
    } catch {
      const textarea = document.createElement("textarea");
      textarea.value = errorDetails;
      textarea.style.position = "fixed";
      textarea.style.left = "-9999px";
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand("copy");
      textarea.remove();
    }
    setErrorCopied(true);
    window.setTimeout(() => setErrorCopied(false), 1800);
  };

  const applyRenderLimit = () => {
    if (!limitError) return;
    const nextLimit = Number(proposedLimit);
    if (!Number.isInteger(nextLimit)) {
      setLimitInputError("整数のpx値を入力してください。");
      return;
    }
    if (nextLimit < limitError.requiredLimit) {
      setLimitInputError(
        `この図には ${limitError.requiredLimit.toLocaleString("ja-JP")}px 以上が必要です。`,
      );
      return;
    }
    if (nextLimit > MAX_RENDER_LIMIT) {
      setLimitInputError(
        `ブラウザ保護のため ${MAX_RENDER_LIMIT.toLocaleString("ja-JP")}px 以下にしてください。`,
      );
      return;
    }

    setRenderLimit(nextLimit);
    setLimitInputError("");
    try {
      window.localStorage.setItem(RENDER_LIMIT_STORAGE_KEY, String(nextLimit));
    } catch {
      // The new limit still applies to the current tab when storage is blocked.
    }
    void renderDiagram(nextLimit);
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
        event.preventDefault();
        void renderDiagram();
        return;
      }

      const target = event.target as HTMLElement | null;
      const isEditing =
        target?.tagName === "TEXTAREA" ||
        target?.tagName === "INPUT" ||
        target?.isContentEditable;
      if (isEditing || !svg) return;

      if (event.key === "+" || event.key === "=") {
        event.preventDefault();
        changeScaleAroundPoint(transformRef.current.scale * 1.2);
      } else if (event.key === "-") {
        event.preventDefault();
        changeScaleAroundPoint(transformRef.current.scale / 1.2);
      } else if (event.key === "0") {
        event.preventDefault();
        centerAtScale(1);
      } else if (event.key.toLowerCase() === "f") {
        event.preventDefault();
        fitDiagram();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [centerAtScale, changeScaleAroundPoint, fitDiagram, renderDiagram, svg]);

  useEffect(() => {
    const onFullscreenChange = () => {
      const active = document.fullscreenElement === previewPanelRef.current;
      setIsFullscreen(active);
      if (!active) fullscreenButtonRef.current?.focus();
      window.requestAnimationFrame(() => fitDiagram());
    };
    document.addEventListener("fullscreenchange", onFullscreenChange);
    return () =>
      document.removeEventListener("fullscreenchange", onFullscreenChange);
  }, [fitDiagram]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || typeof ResizeObserver === "undefined") return;
    let previousWidth = canvas.clientWidth;
    let previousHeight = canvas.clientHeight;
    const observer = new ResizeObserver(() => {
      const nextWidth = canvas.clientWidth;
      const nextHeight = canvas.clientHeight;
      setCanvasSize({ width: nextWidth, height: nextHeight });
      setToolbarPosition((current) => {
        if (!current || !toolbarRef.current) return current;
        const margin = 8;
        return {
          x: clamp(
            current.x,
            margin,
            Math.max(margin, nextWidth - toolbarRef.current.offsetWidth - margin),
          ),
          y: clamp(
            current.y,
            margin,
            Math.max(margin, nextHeight - toolbarRef.current.offsetHeight - margin),
          ),
        };
      });
      if (!svg || !previousWidth || !previousHeight) {
        previousWidth = nextWidth;
        previousHeight = nextHeight;
        return;
      }
      const current = transformRef.current;
      setTransform({
        ...current,
        x: current.x + (nextWidth - previousWidth) / 2,
        y: current.y + (nextHeight - previousHeight) / 2,
      });
      previousWidth = nextWidth;
      previousHeight = nextHeight;
    });
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [svg]);

  const handleEditorScroll = (event: UIEvent<HTMLTextAreaElement>) => {
    if (gutterRef.current) {
      gutterRef.current.scrollTop = event.currentTarget.scrollTop;
    }
  };

  const handleSourcePaste = (
    event: ReactClipboardEvent<HTMLTextAreaElement>,
  ) => {
    const pastedText = event.clipboardData.getData("text/plain");
    const extracted = extractFencedPlantUml(pastedText);
    if (!extracted) return;

    event.preventDefault();
    const textarea = event.currentTarget;
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const nextSource = source.slice(0, start) + extracted + source.slice(end);
    setSource(nextSource);
    setRenderState("idle");
    setErrorDetails("");
    setErrorCopied(false);
    setStatusMessage("Markdownのコード囲みを除去して貼り付けました");

    window.requestAnimationFrame(() => {
      const cursor = start + extracted.length;
      textareaRef.current?.setSelectionRange(cursor, cursor);
    });
  };

  const handleCanvasWheel = (event: WheelEvent<HTMLDivElement>) => {
    if (!svg) return;
    event.preventDefault();
    const factor = Math.exp(-event.deltaY * 0.0015);
    changeScaleAroundPoint(
      transformRef.current.scale * factor,
      event.clientX,
      event.clientY,
    );
  };

  const handleCanvasPointerDown = (
    event: ReactPointerEvent<HTMLDivElement>,
  ) => {
    if (!svg || (event.pointerType === "mouse" && event.button !== 0)) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    pointersRef.current.set(event.pointerId, {
      x: event.clientX,
      y: event.clientY,
    });

    if (pointersRef.current.size === 1) {
      const current = transformRef.current;
      panOriginRef.current = {
        pointerX: event.clientX,
        pointerY: event.clientY,
        x: current.x,
        y: current.y,
      };
    } else if (pointersRef.current.size === 2) {
      const [first, second] = Array.from(pointersRef.current.values());
      pinchOriginRef.current = {
        distance: Math.hypot(second.x - first.x, second.y - first.y),
        centerX: (first.x + second.x) / 2,
        centerY: (first.y + second.y) / 2,
        transform: transformRef.current,
      };
      panOriginRef.current = null;
    }
  };

  const handleCanvasPointerMove = (
    event: ReactPointerEvent<HTMLDivElement>,
  ) => {
    if (!pointersRef.current.has(event.pointerId)) return;
    pointersRef.current.set(event.pointerId, {
      x: event.clientX,
      y: event.clientY,
    });

    if (pointersRef.current.size === 2 && pinchOriginRef.current) {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const [first, second] = Array.from(pointersRef.current.values());
      const origin = pinchOriginRef.current;
      const distance = Math.max(
        1,
        Math.hypot(second.x - first.x, second.y - first.y),
      );
      const centerX = (first.x + second.x) / 2;
      const centerY = (first.y + second.y) / 2;
      const rect = canvas.getBoundingClientRect();
      const scale = clamp(
        origin.transform.scale * (distance / Math.max(1, origin.distance)),
        MIN_SCALE,
        MAX_SCALE,
      );
      const originLocalX = origin.centerX - rect.left;
      const originLocalY = origin.centerY - rect.top;
      const nextLocalX = centerX - rect.left;
      const nextLocalY = centerY - rect.top;
      const ratio = scale / origin.transform.scale;
      setTransform({
        scale,
        x:
          nextLocalX -
          (originLocalX - origin.transform.x) * ratio,
        y:
          nextLocalY -
          (originLocalY - origin.transform.y) * ratio,
      });
    } else if (pointersRef.current.size === 1 && panOriginRef.current) {
      const origin = panOriginRef.current;
      setTransform((current) => ({
        ...current,
        x: origin.x + event.clientX - origin.pointerX,
        y: origin.y + event.clientY - origin.pointerY,
      }));
    }
  };

  const handleCanvasPointerEnd = (
    event: ReactPointerEvent<HTMLDivElement>,
  ) => {
    pointersRef.current.delete(event.pointerId);
    pinchOriginRef.current = null;
    panOriginRef.current = null;
    if (pointersRef.current.size === 1) {
      const remaining = Array.from(pointersRef.current.values())[0];
      const current = transformRef.current;
      panOriginRef.current = {
        pointerX: remaining.x,
        pointerY: remaining.y,
        x: current.x,
        y: current.y,
      };
    }
  };

  const getCurrentToolbarPosition = () => {
    const canvas = canvasRef.current;
    const toolbar = toolbarRef.current;
    if (!canvas || !toolbar) return { x: 8, y: 8 };
    const canvasRect = canvas.getBoundingClientRect();
    const toolbarRect = toolbar.getBoundingClientRect();
    return {
      x: toolbarRect.left - canvasRect.left,
      y: toolbarRect.top - canvasRect.top,
    };
  };

  const clampToolbarPoint = (point: Point) => {
    const canvas = canvasRef.current;
    const toolbar = toolbarRef.current;
    if (!canvas || !toolbar) return point;
    const margin = 8;
    return {
      x: clamp(
        point.x,
        margin,
        Math.max(margin, canvas.clientWidth - toolbar.offsetWidth - margin),
      ),
      y: clamp(
        point.y,
        margin,
        Math.max(margin, canvas.clientHeight - toolbar.offsetHeight - margin),
      ),
    };
  };

  const handleToolbarPointerDown = (
    event: ReactPointerEvent<HTMLButtonElement>,
  ) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    const current = clampToolbarPoint(
      toolbarPosition ?? getCurrentToolbarPosition(),
    );
    setToolbarPosition(current);
    toolbarDragRef.current = {
      pointerId: event.pointerId,
      pointerX: event.clientX,
      pointerY: event.clientY,
      x: current.x,
      y: current.y,
    };
  };

  const handleToolbarPointerMove = (
    event: ReactPointerEvent<HTMLButtonElement>,
  ) => {
    const origin = toolbarDragRef.current;
    if (!origin || origin.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    setToolbarPosition(
      clampToolbarPoint({
        x: origin.x + event.clientX - origin.pointerX,
        y: origin.y + event.clientY - origin.pointerY,
      }),
    );
  };

  const handleToolbarPointerEnd = (
    event: ReactPointerEvent<HTMLButtonElement>,
  ) => {
    if (toolbarDragRef.current?.pointerId !== event.pointerId) return;
    event.stopPropagation();
    toolbarDragRef.current = null;
  };

  const handleToolbarKeyDown = (
    event: React.KeyboardEvent<HTMLButtonElement>,
  ) => {
    const direction: Record<string, Point> = {
      ArrowLeft: { x: -1, y: 0 },
      ArrowRight: { x: 1, y: 0 },
      ArrowUp: { x: 0, y: -1 },
      ArrowDown: { x: 0, y: 1 },
    };
    const delta = direction[event.key];
    if (!delta) return;
    event.preventDefault();
    event.stopPropagation();
    const step = event.shiftKey ? 24 : 8;
    const current = toolbarPosition ?? getCurrentToolbarPosition();
    setToolbarPosition(
      clampToolbarPoint({
        x: current.x + delta.x * step,
        y: current.y + delta.y * step,
      }),
    );
  };

  const handleSplitterPointerDown = (
    event: ReactPointerEvent<HTMLDivElement>,
  ) => {
    if (isEditorCollapsed) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    splitDragRef.current = {
      startX: event.clientX,
      startPercent: editorPercent,
    };
  };

  const handleSplitterPointerMove = (
    event: ReactPointerEvent<HTMLDivElement>,
  ) => {
    if (!splitDragRef.current || !workspaceRef.current) return;
    const delta = event.clientX - splitDragRef.current.startX;
    const next =
      splitDragRef.current.startPercent +
      (delta / workspaceRef.current.clientWidth) * 100;
    setEditorPercent(clamp(next, 25, 55));
  };

  const handleSplitterPointerUp = () => {
    splitDragRef.current = null;
  };

  const handleSplitterKeyDown = (
    event: React.KeyboardEvent<HTMLDivElement>,
  ) => {
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      setEditorPercent((current) =>
        clamp(current + (event.key === "ArrowRight" ? 2 : -2), 25, 55),
      );
    }
  };

  const toggleFullscreen = async () => {
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
      } else {
        await previewPanelRef.current?.requestFullscreen();
      }
    } catch {
      setStatusMessage("このブラウザでは全画面表示を開始できませんでした。");
    }
  };

  const downloadSvg = () => {
    if (!svg) return;
    downloadBlob(
      new Blob([svg], { type: "image/svg+xml;charset=utf-8" }),
      "plantuml-diagram.svg",
    );
  };

  const downloadPng = async () => {
    if (!svg) return;
    setStatusMessage("PNGを準備しています…");
    let exportUrl = "";
    try {
      const svgBlob = new Blob([svg], {
        type: "image/svg+xml;charset=utf-8",
      });
      exportUrl = URL.createObjectURL(svgBlob);
      const image = new Image();
      const loaded = new Promise<void>((resolve, reject) => {
        image.onload = () => resolve();
        image.onerror = () => reject(new Error("SVGの画像化に失敗しました。"));
      });
      image.src = exportUrl;
      await loaded;

      const maxDimension = 16384;
      const maxPixels = 64_000_000;
      const idealScale = 2;
      const safeScale = Math.min(
        idealScale,
        maxDimension / diagramSize.width,
        maxDimension / diagramSize.height,
        Math.sqrt(maxPixels / (diagramSize.width * diagramSize.height)),
      );
      if (!Number.isFinite(safeScale) || safeScale < 0.05) {
        throw new Error("この図はPNGには大きすぎます。SVGで保存してください。");
      }
      const exportScale = safeScale;
      const width = Math.max(1, Math.round(diagramSize.width * exportScale));
      const height = Math.max(1, Math.round(diagramSize.height * exportScale));
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("PNGの描画領域を作成できませんでした。");
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, width, height);
      context.drawImage(image, 0, 0, width, height);

      const png = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob(resolve, "image/png"),
      );
      if (!png) throw new Error("PNGファイルを作成できませんでした。");
      downloadBlob(png, "plantuml-diagram.png");
      setStatusMessage(
        exportScale < 1
          ? "図全体が入るよう縮小してPNGを保存しました"
          : "PNGを保存しました",
      );
    } catch (error) {
      setStatusMessage(
        error instanceof Error
          ? error.message
          : "PNGの保存に失敗しました。SVG保存をお試しください。",
      );
    } finally {
      if (exportUrl) URL.revokeObjectURL(exportUrl);
    }
  };

  const loadSample = () => {
    setSource(SAMPLE_SOURCE);
    setRenderState("idle");
    setErrorDetails("");
    setErrorCopied(false);
    setStatusMessage("サンプルを読み込みました");
    textareaRef.current?.focus();
  };

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand" aria-label="PlantUML Viewer">
          <span className="brand-mark" aria-hidden="true">
            <Braces size={23} strokeWidth={2.2} />
          </span>
          <span>PlantUML Viewer</span>
        </div>
        <div className="privacy-note" title="コードは外部サーバーへ送信されません">
          <ShieldCheck size={19} aria-hidden="true" />
          <span>ブラウザ内で処理</span>
        </div>
      </header>

      <div
        className={`workspace ${isEditorCollapsed ? "editor-collapsed" : ""}`}
        ref={workspaceRef}
        style={
          {
            "--editor-width": isEditorCollapsed
              ? "0px"
              : `${editorPercent}%`,
          } as React.CSSProperties
        }
      >
        <section className="source-panel" aria-label="PlantUMLソースエディタ">
          <div className="panel-heading source-heading">
            <div className="panel-title">
              <Code2 size={19} aria-hidden="true" />
              <h1>PlantUML ソース</h1>
            </div>
            <button className="text-button" type="button" onClick={loadSample}>
              <FileCode2 size={17} aria-hidden="true" />
              サンプル
            </button>
          </div>

          <div className="editor-body">
            <div className="line-numbers" ref={gutterRef} aria-hidden="true">
              {lines.map((_, index) => (
                <span key={index}>{index + 1}</span>
              ))}
            </div>
            <textarea
              ref={textareaRef}
              className="source-input"
              value={source}
              onChange={(event) => setSource(event.target.value)}
              onPaste={handleSourcePaste}
              onScroll={handleEditorScroll}
              wrap="off"
              spellCheck={false}
              aria-label="PlantUMLコード"
              aria-describedby="editor-help"
            />
          </div>

          <div className="source-footer">
            <div className="editor-meta" id="editor-help">
              <span>{lines.length} 行</span>
              <span className="meta-separator" aria-hidden="true" />
              <span>{source.length.toLocaleString("ja-JP")} 文字</span>
              {sourceIsDirty && <span className="dirty-badge">未描画の変更</span>}
            </div>
            <button
              className="render-button"
              type="button"
              onClick={() => void renderDiagram()}
              disabled={renderState === "loading"}
            >
              {renderState === "loading" ? (
                <LoaderCircle className="spin" size={19} aria-hidden="true" />
              ) : (
                <Play size={19} fill="currentColor" aria-hidden="true" />
              )}
              {renderState === "loading" ? "描画中…" : "図を表示"}
              <kbd>Ctrl ↵</kbd>
            </button>
          </div>
        </section>

        <div
          className="splitter"
          role="separator"
          aria-label="エディタとプレビューの幅を調整"
          aria-orientation="vertical"
          aria-valuemin={25}
          aria-valuemax={55}
          aria-valuenow={Math.round(editorPercent)}
          tabIndex={0}
          onPointerDown={handleSplitterPointerDown}
          onPointerMove={handleSplitterPointerMove}
          onPointerUp={handleSplitterPointerUp}
          onPointerCancel={handleSplitterPointerUp}
          onKeyDown={handleSplitterKeyDown}
        >
          <span className="splitter-grip" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
        </div>

        <section
          className="preview-panel"
          aria-label="PlantUMLプレビュー"
          ref={previewPanelRef}
        >
          <div className="preview-heading">
            <div className="preview-label">
              {isEditorCollapsed && (
                <button
                  className="icon-button show-editor-button"
                  type="button"
                  onClick={() => setIsEditorCollapsed(false)}
                  aria-label="ソースエディタを表示"
                >
                  <Code2 size={18} />
                </button>
              )}
              <span>プレビュー</span>
              {diagramType && <span className="diagram-type">{diagramType}</span>}
            </div>
            {!isEditorCollapsed && (
              <button
                className="collapse-editor-button"
                type="button"
                onClick={() => setIsEditorCollapsed(true)}
                aria-label="ソースエディタを隠して図を広く表示"
              >
                <ChevronLeft size={17} aria-hidden="true" />
                図を広く
              </button>
            )}
          </div>

          <div
            className={`canvas ${svg ? "has-diagram" : ""}`}
            ref={canvasRef}
            tabIndex={0}
            aria-label="PlantUML図。ドラッグで移動、ホイールで拡大縮小できます"
            onWheel={handleCanvasWheel}
            onPointerDown={handleCanvasPointerDown}
            onPointerMove={handleCanvasPointerMove}
            onPointerUp={handleCanvasPointerEnd}
            onPointerCancel={handleCanvasPointerEnd}
          >
            <div
              className="canvas-toolbar"
              role="toolbar"
              aria-label="図の表示操作"
              ref={toolbarRef}
              style={
                toolbarPosition
                  ? {
                      top: toolbarPosition.y,
                      left: toolbarPosition.x,
                      transform: "none",
                    }
                  : undefined
              }
              onPointerDown={(event) => event.stopPropagation()}
              onWheel={(event) => event.stopPropagation()}
            >
              <button
                className="toolbar-drag-handle"
                type="button"
                aria-label="操作バーを移動"
                title="ドラッグで移動・矢印キーで微調整・ダブルクリックで元の位置"
                onPointerDown={handleToolbarPointerDown}
                onPointerMove={handleToolbarPointerMove}
                onPointerUp={handleToolbarPointerEnd}
                onPointerCancel={handleToolbarPointerEnd}
                onKeyDown={handleToolbarKeyDown}
                onDoubleClick={() => setToolbarPosition(null)}
              >
                <GripVertical size={17} aria-hidden="true" />
              </button>
              <button
                className="tool-button icon-only"
                type="button"
                onClick={() =>
                  changeScaleAroundPoint(transformRef.current.scale / 1.2)
                }
                disabled={!svg}
                aria-label="縮小"
                title="縮小（-）"
              >
                <Minus size={18} />
              </button>
              <output className="zoom-value" aria-label="現在の倍率">
                {Math.round(transform.scale * 100)}%
              </output>
              <button
                className="tool-button icon-only"
                type="button"
                onClick={() =>
                  changeScaleAroundPoint(transformRef.current.scale * 1.2)
                }
                disabled={!svg}
                aria-label="拡大"
                title="拡大（+）"
              >
                <Plus size={18} />
              </button>
              <span className="tool-divider" aria-hidden="true" />
              <button
                className="tool-button"
                type="button"
                onClick={() => fitDiagram()}
                disabled={!svg}
                title="全体表示（F）"
              >
                <Focus size={18} aria-hidden="true" />
                <span>全体表示</span>
              </button>
              <button
                className="tool-button"
                type="button"
                onClick={() => centerAtScale(1)}
                disabled={!svg}
                title="100%へリセット（0）"
              >
                <RotateCcw size={17} aria-hidden="true" />
                <span>100%</span>
              </button>
              <button
                ref={fullscreenButtonRef}
                className="tool-button"
                type="button"
                onClick={() => void toggleFullscreen()}
                disabled={!svg}
              >
                <Maximize2 size={17} aria-hidden="true" />
                <span>{isFullscreen ? "戻る" : "全画面"}</span>
              </button>
              <span className="tool-divider" aria-hidden="true" />
              <button
                className="tool-button"
                type="button"
                onClick={() => void downloadPng()}
                disabled={!svg}
                title="図全体をPNGで保存"
              >
                <Download size={17} aria-hidden="true" />
                <span>PNG</span>
              </button>
              <button
                className="tool-button"
                type="button"
                onClick={downloadSvg}
                disabled={!svg}
                title="図全体をSVGで保存"
              >
                <Download size={17} aria-hidden="true" />
                <span>SVG</span>
              </button>
            </div>

            {laneGuideSegments.length > 0 && (
              <div
                className="lane-guide"
                aria-label="現在表示中のスイムレーン"
              >
                {laneGuideSegments.map((lane) => (
                  <div
                    className={`lane-guide-segment lane-color-${lane.colorIndex} ${lane.isPrimary ? "is-primary" : ""}`}
                    style={{ left: lane.left, width: lane.width }}
                    key={`${lane.name}-${lane.x0}`}
                    title={lane.name}
                  >
                    <span>{lane.name}</span>
                  </div>
                ))}
              </div>
            )}

            {errorDetails ? (
              <section
                className="error-card"
                role="alert"
                aria-label="PlantUML描画エラー"
              >
                <div className="error-card-heading">
                  <div className="error-card-title">
                    <span className="error-card-icon" aria-hidden="true">
                      <CircleAlert size={21} />
                    </span>
                    <div>
                      <h2>描画できませんでした</h2>
                      <p>
                        下の内容は選択でき、そのまま修正依頼へ貼り付けられます。
                      </p>
                    </div>
                  </div>
                  <button
                    className="copy-error-button"
                    type="button"
                    onClick={() => void copyErrorDetails()}
                  >
                    {errorCopied ? <Check size={17} /> : <Copy size={17} />}
                    {errorCopied ? "コピーしました" : "エラーをコピー"}
                  </button>
                </div>
                {limitError && (
                  <div className="limit-recovery">
                    <div className="limit-recovery-copy">
                      <h3>描画上限をアップしますか？</h3>
                      <p>
                        {`この図は ${limitError.width.toLocaleString("ja-JP")} × ${limitError.height.toLocaleString("ja-JP")}px。現在の上限は ${limitError.currentLimit.toLocaleString("ja-JP")}px です。`}
                      </p>
                    </div>
                    {limitError.requiredLimit <= MAX_RENDER_LIMIT ? (
                      <>
                        <div className="limit-recovery-controls">
                          <label htmlFor="render-limit-input">新しい上限</label>
                          <div className="limit-input-wrap">
                            <input
                              id="render-limit-input"
                              type="number"
                              inputMode="numeric"
                              min={limitError.requiredLimit}
                              max={MAX_RENDER_LIMIT}
                              step={1}
                              value={proposedLimit}
                              aria-describedby="render-limit-help"
                              aria-invalid={Boolean(limitInputError)}
                              onChange={(event) => {
                                setProposedLimit(event.target.value);
                                setLimitInputError("");
                              }}
                              onKeyDown={(event) => {
                                if (event.key === "Enter") applyRenderLimit();
                              }}
                            />
                            <span>px</span>
                          </div>
                          <button
                            className="raise-limit-button"
                            type="button"
                            onClick={applyRenderLimit}
                          >
                            上限を変更して再描画
                          </button>
                        </div>
                        <p className="limit-help" id="render-limit-help">
                          推奨値は {limitError.recommendedLimit.toLocaleString("ja-JP")}px。
                          変更値はこのブラウザに保存されます。
                        </p>
                        {limitInputError && (
                          <p className="limit-input-error" role="status">
                            {limitInputError}
                          </p>
                        )}
                      </>
                    ) : (
                      <p className="limit-input-error">
                        この図はブラウザ保護上限の {MAX_RENDER_LIMIT.toLocaleString("ja-JP")}px
                        も超えています。図を分割してお試しください。
                      </p>
                    )}
                  </div>
                )}
                <pre className="error-details" tabIndex={0}>
                  {errorDetails}
                </pre>
              </section>
            ) : svgUrl ? (
              <div
                className="diagram-stage"
                style={{
                  width: diagramSize.width,
                  height: diagramSize.height,
                  transform: `translate3d(${transform.x}px, ${transform.y}px, 0) scale(${transform.scale})`,
                }}
              >
                {/* Loading the SVG as an image keeps its contents isolated. */}
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={svgUrl}
                  width={diagramSize.width}
                  height={diagramSize.height}
                  alt="PlantUMLで生成した図"
                  draggable={false}
                />
              </div>
            ) : (
              <div className="empty-state">
                <span className="empty-icon" aria-hidden="true">
                  <Sparkles size={27} />
                </span>
                <h2>PlantUMLを貼り付けて図を表示</h2>
                <p>
                  大きな図も、ホイールで拡大縮小しながら
                  <br className="desktop-only" />
                  ドラッグして自由に確認できます。
                </p>
                <button
                  className="empty-action"
                  type="button"
                  onClick={() => void renderDiagram()}
                >
                  <Play size={17} fill="currentColor" aria-hidden="true" />
                  サンプルを表示
                </button>
              </div>
            )}

            {renderState === "loading" && (
              <div className="render-overlay" role="status">
                <LoaderCircle className="spin" size={28} aria-hidden="true" />
                <span>{statusMessage}</span>
                <small>初回のみ描画エンジンの準備に少し時間がかかります</small>
              </div>
            )}
          </div>

          <footer className="preview-footer">
            <div
              className={`status-message status-${renderState}`}
              role="status"
              aria-live="polite"
            >
              {renderState === "success" && <Check size={16} aria-hidden="true" />}
              {renderState === "error" && (
                <CircleAlert size={16} aria-hidden="true" />
              )}
              {renderState === "loading" && (
                <LoaderCircle className="spin" size={16} aria-hidden="true" />
              )}
              {renderState === "idle" && <Braces size={16} aria-hidden="true" />}
              <span>{statusMessage}</span>
            </div>
            <div className="canvas-hints" aria-hidden="true">
              <span>
                <MousePointer2 size={15} /> ドラッグで移動
              </span>
              <span>
                <Expand size={15} /> ホイールで拡大・縮小
              </span>
            </div>
          </footer>
        </section>
      </div>
    </main>
  );
}
