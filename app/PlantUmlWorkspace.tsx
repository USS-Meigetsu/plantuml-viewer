"use client";

import {
  ArrowDown,
  ArrowUp,
  Braces,
  Check,
  ChevronLeft,
  CircleAlert,
  Code2,
  Copy,
  CopyPlus,
  Download,
  Expand,
  FileCode2,
  Focus,
  GitBranch,
  GripVertical,
  Link2,
  LoaderCircle,
  Maximize2,
  Minus,
  MousePointer2,
  PencilLine,
  Play,
  Plus,
  PlusCircle,
  Redo2,
  RotateCcw,
  ShieldCheck,
  Sparkles,
  Trash2,
  Undo2,
  X,
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
type EditableActivity = {
  key: string;
  startLine: number;
  endLine: number;
  label: string;
  lane: string;
  indent: string;
  rawLines: string[];
  context: string;
};
type ActivityShape = {
  activityKey: string;
  x: number;
  y: number;
  width: number;
  height: number;
};
type ActivityDropPosition = "before" | "after";
type ActivityDragIntent = "reorder" | "lane";
type SourceDiffLine = {
  type: "same" | "added" | "removed" | "skip";
  oldLine: number | null;
  newLine: number | null;
  text: string;
};
type IfStructure = {
  startLine: number;
  elseLine: number;
  endLine: number;
  indent: string;
  condition: string;
  yesLabel: string;
  noLabel: string;
};
type WhileStructure = {
  startLine: number;
  endLine: number;
  indent: string;
  condition: string;
  yesLabel: string;
  noLabel: string;
};
type ForkBranch = { lines: string[] };
type ForkStructure = {
  startLine: number;
  endLine: number;
  indent: string;
  branches: ForkBranch[];
};
type StructureEditorTab = "add-if" | "move-branch" | "connection" | "control";
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

function parseSwimlaneLine(line: string) {
  const match = line.trim().match(/^\|(.+)\|$/);
  if (!match) return null;
  const parts = match[1].split("|").map((part) => part.trim());
  const rawName = parts[0]?.startsWith("#")
    ? parts.slice(1).join("|")
    : parts.join("|");
  const name = rawName.trim().replace(/^"|"$/g, "");
  return name ? { name, directive: line.trim() } : null;
}

function getSwimlaneDirectives(source: string) {
  const directives = new Map<string, string>();
  for (const line of source.split(/\r\n|\r|\n/)) {
    const lane = parseSwimlaneLine(line);
    if (lane && !directives.has(lane.name)) {
      directives.set(lane.name, lane.directive);
    }
  }
  return directives;
}

function normalizeActivityLabel(label: string) {
  return label
    .replace(/\\n/g, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/(?:\*\*|__|\/\/|~~|"")/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function parseEditableActivities(source: string): EditableActivity[] {
  const lines = source.split(/\r\n|\r|\n/);
  const activities: EditableActivity[] = [];
  const contextStack: string[] = [];
  let currentLane = "主体未指定";

  const updateContext = (trimmed: string, lineIndex: number) => {
    if (/^(?:end\s*fork|endfork|endif|endwhile|endswitch)\b/i.test(trimmed)) {
      contextStack.pop();
      return;
    }
    if (/^repeat\s+while\b/i.test(trimmed)) {
      contextStack.pop();
      return;
    }
    if (/^(?:else|elseif|fork\s+again|case)\b/i.test(trimmed)) {
      if (contextStack.length) {
        const root = contextStack[contextStack.length - 1].split(":")[0];
        contextStack[contextStack.length - 1] = `${root}:${lineIndex}`;
      }
      return;
    }
    if (/^(?:if\s*\(|while\s*\(|repeat\b|fork\b|switch\s*\()/i.test(trimmed)) {
      contextStack.push(`${lineIndex}:${lineIndex}`);
    }
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.trim();
    const lane = parseSwimlaneLine(line);
    if (lane) {
      currentLane = lane.name;
      continue;
    }

    updateContext(trimmed, index);
    const start = line.match(/^(\s*):(.*)$/);
    if (!start) continue;

    const rawLines = [line];
    let endLine = index;
    while (!rawLines.join("\n").includes(";") && endLine + 1 < lines.length) {
      endLine += 1;
      rawLines.push(lines[endLine]);
    }
    const raw = rawLines.join("\n");
    const colonIndex = raw.indexOf(":");
    const semicolonIndex = raw.indexOf(";", colonIndex + 1);
    if (semicolonIndex < 0) continue;
    const label = raw
      .slice(colonIndex + 1, semicolonIndex)
      .replace(/\\n/g, "\n")
      .replace(/\n\s*/g, "\n")
      .trim();
    if (!label) continue;

    activities.push({
      key: `${index}:${endLine}`,
      startLine: index,
      endLine,
      label,
      lane: currentLane,
      indent: start[1],
      rawLines,
      context: contextStack.join(">"),
    });
    index = endLine;
  }
  return activities;
}

function parseIfStructures(source: string): IfStructure[] {
  const lines = source.split(/\r\n|\r|\n/);
  const stack: Array<Omit<IfStructure, "elseLine" | "endLine" | "noLabel"> & {
    elseLine: number;
    noLabel: string;
  }> = [];
  const structures: IfStructure[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.trim();
    const start = trimmed.match(/^if\s*\((.*)\)\s*then\s*\((.*)\)\s*$/i);
    if (start) {
      stack.push({
        startLine: index,
        indent: line.match(/^\s*/)?.[0] ?? "",
        condition: start[1].trim(),
        yesLabel: start[2].trim() || "はい",
        elseLine: -1,
        noLabel: "いいえ",
      });
      continue;
    }
    const alternate = trimmed.match(/^else(?:\s*\((.*)\))?\s*$/i);
    if (alternate && stack.length) {
      const current = stack[stack.length - 1];
      if (current.elseLine < 0) {
        current.elseLine = index;
        current.noLabel = alternate[1]?.trim() || "いいえ";
      }
      continue;
    }
    if (/^endif\b/i.test(trimmed) && stack.length) {
      const current = stack.pop()!;
      if (current.elseLine >= 0) {
        structures.push({ ...current, endLine: index });
      }
    }
  }
  return structures.sort((a, b) => a.startLine - b.startLine);
}

function parseWhileStructures(source: string): WhileStructure[] {
  const lines = source.split(/\r\n|\r|\n/);
  const stack: Array<Omit<WhileStructure, "endLine" | "noLabel">> = [];
  const structures: WhileStructure[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.trim();
    const start =
      trimmed.match(/^while\s*\((.*)\)\s+is\s*\((.*)\)\s*$/i) ??
      trimmed.match(/^while\s*\((.*)\)\s*$/i);
    if (start) {
      stack.push({
        startLine: index,
        indent: line.match(/^\s*/)?.[0] ?? "",
        condition: start[1].trim(),
        yesLabel: start[2]?.trim() || "はい",
      });
      continue;
    }
    const end = trimmed.match(/^endwhile(?:\s*\((.*)\))?\s*$/i);
    if (end && stack.length) {
      const current = stack.pop()!;
      structures.push({
        ...current,
        endLine: index,
        noLabel: end[1]?.trim() || "いいえ",
      });
    }
  }
  return structures.sort((a, b) => a.startLine - b.startLine);
}

function parseForkStructures(source: string): ForkStructure[] {
  const lines = source.split(/\r\n|\r|\n/);
  const stack: Array<{
    startLine: number;
    indent: string;
    separators: number[];
  }> = [];
  const structures: ForkStructure[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.trim();
    if (/^fork\s+again\b/i.test(trimmed) && stack.length) {
      stack[stack.length - 1].separators.push(index);
      continue;
    }
    if (/^fork\b/i.test(trimmed)) {
      stack.push({
        startLine: index,
        indent: line.match(/^\s*/)?.[0] ?? "",
        separators: [],
      });
      continue;
    }
    if (/^(?:end\s*fork|endfork)\b/i.test(trimmed) && stack.length) {
      const current = stack.pop()!;
      const boundaries = [current.startLine, ...current.separators, index];
      const branches = boundaries.slice(0, -1).map((boundary, branchIndex) => ({
        lines: lines.slice(boundary + 1, boundaries[branchIndex + 1]),
      }));
      structures.push({
        startLine: current.startLine,
        endLine: index,
        indent: current.indent,
        branches,
      });
    }
  }
  return structures.sort((a, b) => a.startLine - b.startLine);
}

function getActiveLaneAtLine(source: string, lineIndex: number) {
  const lines = source.split(/\r\n|\r|\n/);
  let lane = "主体未指定";
  for (let index = 0; index < Math.min(lineIndex, lines.length); index += 1) {
    const parsed = parseSwimlaneLine(lines[index]);
    if (parsed) lane = parsed.name;
  }
  return lane;
}

function reindentLines(lines: string[], fromIndent: string, toIndent: string) {
  return lines.map((line) =>
    line.startsWith(fromIndent) ? `${toIndent}${line.slice(fromIndent.length)}` : line,
  );
}

function getSvgTextPosition(element: Element) {
  const firstTspan = element.querySelector("tspan");
  return {
    x:
      readSvgNumber(element, "x") ??
      (firstTspan ? readSvgNumber(firstTspan, "x") : null),
    y:
      readSvgNumber(element, "y") ??
      (firstTspan ? readSvgNumber(firstTspan, "y") : null),
  };
}

function extractActivityShapes(svg: string, source: string): ActivityShape[] {
  const activities = parseEditableActivities(source);
  if (!activities.length) return [];
  const document = new DOMParser().parseFromString(svg, "image/svg+xml");
  if (document.querySelector("parsererror")) return [];
  const root = document.documentElement;
  const viewBox = root.getAttribute("viewBox")?.split(/[ ,]+/).map(Number);
  const minX = viewBox?.length === 4 && Number.isFinite(viewBox[0]) ? viewBox[0] : 0;
  const minY = viewBox?.length === 4 && Number.isFinite(viewBox[1]) ? viewBox[1] : 0;

  const rectangles = Array.from(document.querySelectorAll("rect"))
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
        rect.width >= 24 &&
        rect.height >= 14,
    );
  const texts = Array.from(document.querySelectorAll("text"))
    .map((element, index) => {
      const position = getSvgTextPosition(element);
      return {
        index,
        label: normalizeActivityLabel(element.textContent ?? ""),
        x: position.x,
        y: position.y,
      };
    })
    .filter((text) => text.label && text.x !== null && text.y !== null);
  const usedTexts = new Set<number>();
  const shapes: ActivityShape[] = [];

  for (const activity of activities) {
    const wanted = normalizeActivityLabel(activity.label);
    const text = texts.find(
      (candidate) =>
        !usedTexts.has(candidate.index) &&
        (candidate.label === wanted ||
          candidate.label.replace(/\s/g, "") === wanted.replace(/\s/g, "")),
    );
    if (!text || text.x === null || text.y === null) continue;
    const containing = rectangles
      .filter(
        (rect) =>
          rect.x !== null &&
          rect.y !== null &&
          rect.width !== null &&
          rect.height !== null &&
          text.x! >= rect.x - 3 &&
          text.x! <= rect.x + rect.width + 3 &&
          text.y! >= rect.y - 3 &&
          text.y! <= rect.y + rect.height + 8,
      )
      .sort((a, b) => a.width! * a.height! - b.width! * b.height!)[0];
    if (!containing) continue;
    usedTexts.add(text.index);
    shapes.push({
      activityKey: activity.key,
      x: containing.x! - minX,
      y: containing.y! - minY,
      width: containing.width!,
      height: containing.height!,
    });
  }
  return shapes;
}

function canMoveActivity(
  source: string,
  activities: EditableActivity[],
  index: number,
  direction: -1 | 1,
) {
  const other = activities[index + direction];
  const current = activities[index];
  if (!current || !other || current.context !== other.context) return false;
  const lines = source.split(/\r\n|\r|\n/);
  const first = direction === -1 ? other : current;
  const second = direction === -1 ? current : other;
  return lines
    .slice(first.endLine + 1, second.startLine)
    .every((line) => !line.trim() || Boolean(parseSwimlaneLine(line)));
}

function replaceSourceLines(
  source: string,
  startLine: number,
  endLine: number,
  replacement: string[],
) {
  const lines = source.split(/\r\n|\r|\n/);
  lines.splice(startLine, endLine - startLine + 1, ...replacement);
  return lines.join("\n");
}

function moveActivityOnce(source: string, index: number, direction: -1 | 1) {
  const activities = parseEditableActivities(source);
  const selected = activities[index];
  if (!selected || !canMoveActivity(source, activities, index, direction)) {
    return null;
  }
  const other = activities[index + direction];
  const first = direction === -1 ? other : selected;
  const second = direction === -1 ? selected : other;
  const ordered = direction === -1 ? [selected, other] : [other, selected];
  const directives = getSwimlaneDirectives(source);
  const originalEndingLane = second.lane;
  const replacement: string[] = [];
  let activeLane = "";

  for (const activity of ordered) {
    if (activity.lane !== activeLane) {
      replacement.push(
        `${activity.indent}${directives.get(activity.lane) ?? `|${activity.lane}|`}`,
      );
      activeLane = activity.lane;
    }
    replacement.push(...activity.rawLines);
  }
  if (activeLane !== originalEndingLane) {
    replacement.push(
      `${second.indent}${directives.get(originalEndingLane) ?? `|${originalEndingLane}|`}`,
    );
  }

  return {
    source: replaceSourceLines(source, first.startLine, second.endLine, replacement),
    index: index + direction,
  };
}

function createSourceDiff(before: string, after: string): SourceDiffLine[] {
  const beforeLines = before.split(/\r\n|\r|\n/);
  const afterLines = after.split(/\r\n|\r|\n/);
  const rows = beforeLines.length + 1;
  const columns = afterLines.length + 1;

  // Visual edits normally change only a few lines. For exceptionally large,
  // completely different inputs, avoid allocating an unbounded LCS table.
  if (rows * columns > 4_000_000) {
    return [
      ...beforeLines.map((text, index) => ({
        type: "removed" as const,
        oldLine: index + 1,
        newLine: null,
        text,
      })),
      ...afterLines.map((text, index) => ({
        type: "added" as const,
        oldLine: null,
        newLine: index + 1,
        text,
      })),
    ];
  }

  const lengths = Array.from(
    { length: rows },
    () => new Uint32Array(columns),
  );
  for (let oldIndex = beforeLines.length - 1; oldIndex >= 0; oldIndex -= 1) {
    for (let newIndex = afterLines.length - 1; newIndex >= 0; newIndex -= 1) {
      lengths[oldIndex][newIndex] =
        beforeLines[oldIndex] === afterLines[newIndex]
          ? lengths[oldIndex + 1][newIndex + 1] + 1
          : Math.max(
              lengths[oldIndex + 1][newIndex],
              lengths[oldIndex][newIndex + 1],
            );
    }
  }

  const diff: SourceDiffLine[] = [];
  let oldIndex = 0;
  let newIndex = 0;
  while (oldIndex < beforeLines.length || newIndex < afterLines.length) {
    if (
      oldIndex < beforeLines.length &&
      newIndex < afterLines.length &&
      beforeLines[oldIndex] === afterLines[newIndex]
    ) {
      diff.push({
        type: "same",
        oldLine: oldIndex + 1,
        newLine: newIndex + 1,
        text: beforeLines[oldIndex],
      });
      oldIndex += 1;
      newIndex += 1;
    } else if (
      newIndex < afterLines.length &&
      (oldIndex >= beforeLines.length ||
        lengths[oldIndex][newIndex + 1] > lengths[oldIndex + 1][newIndex])
    ) {
      diff.push({
        type: "added",
        oldLine: null,
        newLine: newIndex + 1,
        text: afterLines[newIndex],
      });
      newIndex += 1;
    } else {
      diff.push({
        type: "removed",
        oldLine: oldIndex + 1,
        newLine: null,
        text: beforeLines[oldIndex],
      });
      oldIndex += 1;
    }
  }

  const changedIndexes = diff
    .map((line, index) => (line.type === "same" ? -1 : index))
    .filter((index) => index >= 0);
  if (!changedIndexes.length) return [];

  const visible = new Set<number>();
  for (const index of changedIndexes) {
    for (
      let contextIndex = Math.max(0, index - 3);
      contextIndex <= Math.min(diff.length - 1, index + 3);
      contextIndex += 1
    ) {
      visible.add(contextIndex);
    }
  }

  const compact: SourceDiffLine[] = [];
  let previousIndex = -2;
  for (const index of [...visible].sort((a, b) => a - b)) {
    if (index > previousIndex + 1) {
      compact.push({
        type: "skip",
        oldLine: null,
        newLine: null,
        text: `${index - previousIndex - 1}行を省略`,
      });
    }
    compact.push(diff[index]);
    previousIndex = index;
  }
  if (previousIndex < diff.length - 1) {
    compact.push({
      type: "skip",
      oldLine: null,
      newLine: null,
      text: `${diff.length - previousIndex - 1}行を省略`,
    });
  }
  return compact;
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
  const [activityShapes, setActivityShapes] = useState<ActivityShape[]>([]);
  const [isEditMode, setIsEditMode] = useState(false);
  const [selectedActivityKey, setSelectedActivityKey] = useState("");
  const [activityLabelDraft, setActivityLabelDraft] = useState("");
  const [editMessage, setEditMessage] = useState("");
  const [editBaseline, setEditBaseline] = useState("");
  const [isDiffOpen, setIsDiffOpen] = useState(false);
  const [isStructureEditorOpen, setIsStructureEditorOpen] = useState(false);
  const [structureEditorTab, setStructureEditorTab] =
    useState<StructureEditorTab>("add-if");
  const [newIfCondition, setNewIfCondition] = useState("条件を入力");
  const [newIfYesAction, setNewIfYesAction] = useState("はい側の処理");
  const [newIfNoAction, setNewIfNoAction] = useState("いいえ側の処理");
  const [selectedIfStartLine, setSelectedIfStartLine] = useState(-1);
  const [selectedIfBranch, setSelectedIfBranch] = useState<"yes" | "no">("yes");
  const [connectionTargetKey, setConnectionTargetKey] = useState("");
  const [selectedControlKey, setSelectedControlKey] = useState("");
  const [whileConditionDraft, setWhileConditionDraft] = useState("");
  const [whileYesLabelDraft, setWhileYesLabelDraft] = useState("はい");
  const [whileNoLabelDraft, setWhileNoLabelDraft] = useState("いいえ");
  const [selectedForkBranch, setSelectedForkBranch] = useState(0);
  const [draggedActivityKey, setDraggedActivityKey] = useState("");
  const [activityDropTarget, setActivityDropTarget] = useState<{
    key: string;
    position: ActivityDropPosition;
  } | null>(null);
  const [activityLaneTarget, setActivityLaneTarget] = useState("");
  const [isNewActivityDragging, setIsNewActivityDragging] = useState(false);
  const [newActivityDropTarget, setNewActivityDropTarget] = useState<{
    key: string;
    position: ActivityDropPosition;
  } | null>(null);
  const [editHistory, setEditHistory] = useState<{
    past: string[];
    future: string[];
  }>({ past: [], future: [] });
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
  const activityPointerDragRef = useRef<{
    pointerId: number;
    activityKey: string;
    startX: number;
    startY: number;
    active: boolean;
    intent: ActivityDragIntent | null;
  } | null>(null);
  const activityDropTargetRef = useRef<{
    key: string;
    position: ActivityDropPosition;
  } | null>(null);
  const activityLaneTargetRef = useRef("");
  const newActivityPointerDragRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    active: boolean;
  } | null>(null);
  const newActivityDropTargetRef = useRef<{
    key: string;
    position: ActivityDropPosition;
  } | null>(null);
  const suppressActivityClickRef = useRef(false);
  const lines = useMemo(() => source.split("\n"), [source]);
  const editableActivities = useMemo(
    () => parseEditableActivities(source),
    [source],
  );
  const ifStructures = useMemo(() => parseIfStructures(source), [source]);
  const whileStructures = useMemo(() => parseWhileStructures(source), [source]);
  const forkStructures = useMemo(() => parseForkStructures(source), [source]);
  const swimlaneNames = useMemo(() => getSourceSwimlaneNames(source), [source]);
  const targetSwimlane = useMemo(
    () => swimlanes.find((lane) => lane.name === activityLaneTarget) ?? null,
    [activityLaneTarget, swimlanes],
  );
  const selectedActivity = useMemo(
    () =>
      editableActivities.find((activity) => activity.key === selectedActivityKey) ??
      null,
    [editableActivities, selectedActivityKey],
  );
  const selectedIfStructure = useMemo(
    () =>
      ifStructures.find((structure) => structure.startLine === selectedIfStartLine) ??
      ifStructures[0] ??
      null,
    [ifStructures, selectedIfStartLine],
  );
  const selectedWhileStructure = useMemo(() => {
    if (!selectedControlKey.startsWith("while:")) return null;
    const startLine = Number(selectedControlKey.slice("while:".length));
    return whileStructures.find((structure) => structure.startLine === startLine) ?? null;
  }, [selectedControlKey, whileStructures]);
  const selectedForkStructure = useMemo(() => {
    if (!selectedControlKey.startsWith("fork:")) return null;
    const startLine = Number(selectedControlKey.slice("fork:".length));
    return forkStructures.find((structure) => structure.startLine === startLine) ?? null;
  }, [forkStructures, selectedControlKey]);
  const connectionTargets = useMemo(
    () =>
      selectedActivity
        ? editableActivities.filter(
            (activity) =>
              activity.key !== selectedActivity.key &&
              activity.context === selectedActivity.context,
          )
        : [],
    [editableActivities, selectedActivity],
  );
  const sourceDiff = useMemo(
    () => (editBaseline ? createSourceDiff(editBaseline, source) : []),
    [editBaseline, source],
  );
  const sourceDiffSummary = useMemo(
    () => ({
      added: sourceDiff.filter((line) => line.type === "added").length,
      removed: sourceDiff.filter((line) => line.type === "removed").length,
    }),
    [sourceDiff],
  );
  const selectedActivityIndex = selectedActivity
    ? editableActivities.findIndex((activity) => activity.key === selectedActivity.key)
    : -1;
  const canMoveSelectedUp =
    selectedActivityIndex >= 0 &&
    canMoveActivity(source, editableActivities, selectedActivityIndex, -1);
  const canMoveSelectedDown =
    selectedActivityIndex >= 0 &&
    canMoveActivity(source, editableActivities, selectedActivityIndex, 1);
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

  const renderDiagram = useCallback(async (
    limitOverride?: number,
    sourceOverride?: string,
  ) => {
    const activeLimit = limitOverride ?? renderLimit;
    const activeSource = sourceOverride ?? source;
    const normalized = normalizeSource(activeSource);
    if (!normalized.source) {
      setRenderState("error");
      setStatusMessage("PlantUMLコードを貼り付けてください。");
      setErrorDetails("PlantUML描画エラー\n\n入力欄が空です。");
      setErrorCopied(false);
      setSvg("");
      setSvgUrl("");
      setDiagramType("");
      setSwimlanes([]);
      setActivityShapes([]);
      setLimitError(null);
      textareaRef.current?.focus();
      return;
    }

    const requestId = ++renderRequestRef.current;
    setRenderState("loading");
    setActivityShapes([]);
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
        setActivityShapes([]);
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
      setRenderedSource(activeSource);
      setDiagramType(detectDiagramType(normalized.source));
      setSwimlanes(extractSwimlanes(safeSvg, normalized.source));
      setActivityShapes(extractActivityShapes(safeSvg, normalized.source));
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
      setActivityShapes([]);
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

  const selectActivityAtIndex = (nextSource: string, preferredIndex: number) => {
    const nextActivities = parseEditableActivities(nextSource);
    if (!nextActivities.length || preferredIndex < 0) {
      setSelectedActivityKey("");
      setActivityLabelDraft("");
      return;
    }
    const activity = nextActivities[clamp(preferredIndex, 0, nextActivities.length - 1)];
    setSelectedActivityKey(activity.key);
    setActivityLabelDraft(activity.label);
  };

  const applyVisualEdit = (
    nextSource: string,
    message: string,
    nextSelectionIndex = selectedActivityIndex,
  ) => {
    if (nextSource === source) return;
    setEditHistory((current) => ({
      past: [...current.past.slice(-49), source],
      future: [],
    }));
    setSource(nextSource);
    selectActivityAtIndex(nextSource, nextSelectionIndex);
    setEditMessage(message);
    setStatusMessage(`${message}。再描画しています…`);
    void renderDiagram(undefined, nextSource);
  };

  const undoVisualEdit = () => {
    const previous = editHistory.past.at(-1);
    if (previous === undefined) return;
    setEditHistory({
      past: editHistory.past.slice(0, -1),
      future: [...editHistory.future, source],
    });
    setSource(previous);
    selectActivityAtIndex(previous, selectedActivityIndex);
    setEditMessage("直前の編集を元に戻しました");
    void renderDiagram(undefined, previous);
  };

  const redoVisualEdit = () => {
    const next = editHistory.future.at(-1);
    if (next === undefined) return;
    setEditHistory({
      past: [...editHistory.past, source],
      future: editHistory.future.slice(0, -1),
    });
    setSource(next);
    selectActivityAtIndex(next, selectedActivityIndex);
    setEditMessage("編集をやり直しました");
    void renderDiagram(undefined, next);
  };

  const selectEditableActivity = (key: string) => {
    const activity = editableActivities.find((candidate) => candidate.key === key);
    setSelectedActivityKey(key);
    setActivityLabelDraft(activity?.label ?? "");
    setEditMessage("");
  };

  const updateSelectedActivityLabel = () => {
    if (!selectedActivity) return;
    const trimmed = activityLabelDraft.trim();
    if (!trimmed) {
      setEditMessage("箱の文章を入力してください");
      return;
    }
    if (trimmed.includes(";")) {
      setEditMessage("箱の文章には半角セミコロン（;）を使用できません");
      return;
    }
    const raw = selectedActivity.rawLines.join("\n");
    const colonIndex = raw.indexOf(":");
    const semicolonIndex = raw.indexOf(";", colonIndex + 1);
    const suffix = raw.slice(semicolonIndex + 1).trim();
    const label = trimmed.replace(/\r?\n/g, "\\n");
    const replacement = [
      `${selectedActivity.indent}:${label};${suffix ? ` ${suffix}` : ""}`,
    ];
    applyVisualEdit(
      replaceSourceLines(
        source,
        selectedActivity.startLine,
        selectedActivity.endLine,
        replacement,
      ),
      "箱の文章を変更しました",
    );
  };

  const addActivityNearSelected = (position: "before" | "after") => {
    if (!selectedActivity) return;
    const insertAt =
      position === "before"
        ? selectedActivity.startLine
        : selectedActivity.endLine + 1;
    const lines = source.split(/\r\n|\r|\n/);
    lines.splice(insertAt, 0, `${selectedActivity.indent}:新しい処理;`);
    applyVisualEdit(
      lines.join("\n"),
      position === "before"
        ? "選択した箱の前に追加しました"
        : "選択した箱の後に追加しました",
      position === "before" ? selectedActivityIndex + 1 : selectedActivityIndex,
    );
  };

  const addActivityAtDrop = (
    targetKey: string,
    position: ActivityDropPosition,
  ) => {
    const targetIndex = editableActivities.findIndex(
      (activity) => activity.key === targetKey,
    );
    const target = editableActivities[targetIndex];
    if (!target || targetIndex < 0) return;
    const insertAt = position === "before" ? target.startLine : target.endLine + 1;
    const nextLines = source.split(/\r\n|\r|\n/);
    nextLines.splice(insertAt, 0, `${target.indent}:新しい処理;`);
    applyVisualEdit(
      nextLines.join("\n"),
      position === "before"
        ? "ドラッグした位置の前に箱を追加しました"
        : "ドラッグした位置の後に箱を追加しました",
      position === "before" ? targetIndex : targetIndex + 1,
    );
  };

  const duplicateSelectedActivity = () => {
    if (!selectedActivity) return;
    const lines = source.split(/\r\n|\r|\n/);
    lines.splice(
      selectedActivity.endLine + 1,
      0,
      ...selectedActivity.rawLines,
    );
    applyVisualEdit(lines.join("\n"), "箱を複製しました");
  };

  const deleteSelectedActivity = () => {
    if (!selectedActivity) return;
    applyVisualEdit(
      replaceSourceLines(
        source,
        selectedActivity.startLine,
        selectedActivity.endLine,
        [],
      ),
      "箱を削除しました",
    );
  };

  const changeActivityLane = (activityKey: string, nextLane: string) => {
    const activityIndex = editableActivities.findIndex(
      (activity) => activity.key === activityKey,
    );
    const activity = editableActivities[activityIndex];
    if (!activity || !nextLane || nextLane === activity.lane) return;
    const directives = getSwimlaneDirectives(source);
    const targetDirective = directives.get(nextLane) ?? `|${nextLane}|`;
    const restoreDirective =
      directives.get(activity.lane) ?? `|${activity.lane}|`;
    const replacement = [
      `${activity.indent}${targetDirective}`,
      ...activity.rawLines,
      `${activity.indent}${restoreDirective}`,
    ];
    applyVisualEdit(
      replaceSourceLines(
        source,
        activity.startLine,
        activity.endLine,
        replacement,
      ),
      `主体を「${nextLane}」へ変更しました`,
      activityIndex,
    );
  };

  const changeSelectedActivityLane = (nextLane: string) => {
    if (!selectedActivity) return;
    changeActivityLane(selectedActivity.key, nextLane);
  };

  const moveSelectedActivity = (direction: -1 | 1) => {
    if (!selectedActivity || selectedActivityIndex < 0) return;
    const moved = moveActivityOnce(source, selectedActivityIndex, direction);
    if (!moved) {
      setEditMessage("分岐・ループの境界を越える移動はできません");
      return;
    }
    applyVisualEdit(
      moved.source,
      direction === -1 ? "箱を一つ前へ移動しました" : "箱を一つ後ろへ移動しました",
      moved.index,
    );
  };

  const addConditionAfterSelected = () => {
    if (!selectedActivity) return;
    const condition = newIfCondition.trim();
    const yesAction = newIfYesAction.trim();
    const noAction = newIfNoAction.trim();
    if (!condition || !yesAction || !noAction) {
      setEditMessage("条件・はい側・いいえ側をすべて入力してください");
      return;
    }
    if ([condition, yesAction, noAction].some((value) => value.includes(";"))) {
      setEditMessage("入力欄には半角セミコロン（;）を使用できません");
      return;
    }
    const indent = selectedActivity.indent;
    const nextLines = source.split(/\r\n|\r|\n/);
    nextLines.splice(
      selectedActivity.endLine + 1,
      0,
      `${indent}if (${condition}) then (はい)`,
      `${indent}  :${yesAction};`,
      `${indent}else (いいえ)`,
      `${indent}  :${noAction};`,
      `${indent}endif`,
    );
    applyVisualEdit(
      nextLines.join("\n"),
      "選択した箱の後に条件分岐を追加しました",
      selectedActivityIndex + 1,
    );
  };

  const moveSelectedActivityToBranch = () => {
    if (!selectedActivity || !selectedIfStructure) return;
    const removedLineCount = selectedActivity.endLine - selectedActivity.startLine + 1;
    const adjustedIfStart =
      selectedActivity.endLine < selectedIfStructure.startLine
        ? selectedIfStructure.startLine - removedLineCount
        : selectedIfStructure.startLine;
    const withoutActivity = replaceSourceLines(
      source,
      selectedActivity.startLine,
      selectedActivity.endLine,
      [],
    );
    const nextStructure = parseIfStructures(withoutActivity).find(
      (structure) => structure.startLine === adjustedIfStart,
    );
    if (!nextStructure) {
      setEditMessage("移動先の条件分岐を安全に特定できませんでした");
      return;
    }
    const insertAt =
      selectedIfBranch === "yes" ? nextStructure.elseLine : nextStructure.endLine;
    const activeLane = getActiveLaneAtLine(withoutActivity, insertAt);
    const directives = getSwimlaneDirectives(withoutActivity);
    const targetIndent = `${nextStructure.indent}  `;
    const insertion: string[] = [];
    if (activeLane !== selectedActivity.lane) {
      insertion.push(
        `${targetIndent}${directives.get(selectedActivity.lane) ?? `|${selectedActivity.lane}|`}`,
      );
    }
    insertion.push(
      ...reindentLines(selectedActivity.rawLines, selectedActivity.indent, targetIndent),
    );
    if (activeLane !== selectedActivity.lane) {
      insertion.push(
        `${targetIndent}${directives.get(activeLane) ?? `|${activeLane}|`}`,
      );
    }
    const nextLines = withoutActivity.split(/\r\n|\r|\n/);
    nextLines.splice(insertAt, 0, ...insertion);
    const nextSource = nextLines.join("\n");
    const nextActivities = parseEditableActivities(nextSource);
    const movedIndex = nextActivities.findIndex(
      (activity) =>
        activity.startLine >= insertAt &&
        normalizeActivityLabel(activity.label) ===
          normalizeActivityLabel(selectedActivity.label),
    );
    applyVisualEdit(
      nextSource,
      `箱を「${selectedIfBranch === "yes" ? "はい" : "いいえ"}」側へ移動しました`,
      movedIndex >= 0 ? movedIndex : selectedActivityIndex,
    );
  };

  const connectSelectedActivityToTarget = () => {
    if (!selectedActivity || !connectionTargetKey) return;
    const target = editableActivities.find(
      (activity) => activity.key === connectionTargetKey,
    );
    if (!target || target.context !== selectedActivity.context) {
      setEditMessage("同じ直列フロー内の箱だけを接続先にできます");
      return;
    }
    if (reorderActivityByDrop(selectedActivity.key, target.key, "before")) {
      setEditMessage("選択した箱の次の接続先を変更しました");
    }
  };

  const loadWhileDrafts = (structure: WhileStructure) => {
    setWhileConditionDraft(structure.condition);
    setWhileYesLabelDraft(structure.yesLabel);
    setWhileNoLabelDraft(structure.noLabel);
  };

  const applyWhileStructureEdit = () => {
    if (!selectedWhileStructure) return;
    const condition = whileConditionDraft.trim();
    const yesLabel = whileYesLabelDraft.trim();
    const noLabel = whileNoLabelDraft.trim();
    if (!condition || !yesLabel || !noLabel) {
      setEditMessage("whileの条件・継続・終了ラベルを入力してください");
      return;
    }
    const nextLines = source.split(/\r\n|\r|\n/);
    nextLines[selectedWhileStructure.startLine] =
      `${selectedWhileStructure.indent}while (${condition}) is (${yesLabel})`;
    nextLines[selectedWhileStructure.endLine] =
      `${selectedWhileStructure.indent}endwhile (${noLabel})`;
    applyVisualEdit(nextLines.join("\n"), "whileの条件とラベルを変更しました");
  };

  const replaceForkBranches = (
    structure: ForkStructure,
    branches: ForkBranch[],
    nextBranchIndex: number,
    message: string,
  ) => {
    const body: string[] = [];
    branches.forEach((branch, index) => {
      if (index > 0) body.push(`${structure.indent}fork again`);
      body.push(...branch.lines);
    });
    const nextSource = replaceSourceLines(
      source,
      structure.startLine + 1,
      structure.endLine - 1,
      body,
    );
    setSelectedForkBranch(nextBranchIndex);
    applyVisualEdit(nextSource, message);
  };

  const addForkBranch = () => {
    if (!selectedForkStructure) return;
    const branches = [
      ...selectedForkStructure.branches,
      { lines: [`${selectedForkStructure.indent}  :新しい並列処理;`] },
    ];
    replaceForkBranches(
      selectedForkStructure,
      branches,
      branches.length - 1,
      "forkに新しい枝を追加しました",
    );
  };

  const moveForkBranch = (direction: -1 | 1) => {
    if (!selectedForkStructure) return;
    const nextIndex = selectedForkBranch + direction;
    if (nextIndex < 0 || nextIndex >= selectedForkStructure.branches.length) return;
    const branches = [...selectedForkStructure.branches];
    [branches[selectedForkBranch], branches[nextIndex]] = [
      branches[nextIndex],
      branches[selectedForkBranch],
    ];
    replaceForkBranches(
      selectedForkStructure,
      branches,
      nextIndex,
      "forkの枝を並べ替えました",
    );
  };

  const deleteForkBranch = () => {
    if (!selectedForkStructure || selectedForkStructure.branches.length <= 2) {
      setEditMessage("forkには最低2つの枝が必要です");
      return;
    }
    const branches = selectedForkStructure.branches.filter(
      (_, index) => index !== selectedForkBranch,
    );
    replaceForkBranches(
      selectedForkStructure,
      branches,
      Math.min(selectedForkBranch, branches.length - 1),
      "forkの枝を削除しました",
    );
  };

  const chooseControlStructure = (key: string) => {
    setSelectedControlKey(key);
    setSelectedForkBranch(0);
    if (key.startsWith("while:")) {
      const startLine = Number(key.slice("while:".length));
      const structure = whileStructures.find(
        (candidate) => candidate.startLine === startLine,
      );
      if (structure) loadWhileDrafts(structure);
    }
  };

  const openStructureEditor = () => {
    setIsDiffOpen(false);
    setIsStructureEditorOpen(true);
    setEditMessage("");
    if (ifStructures.length && selectedIfStartLine < 0) {
      setSelectedIfStartLine(ifStructures[0].startLine);
    }
    if (connectionTargets.length && !connectionTargetKey) {
      setConnectionTargetKey(connectionTargets[0].key);
    }
    if (!selectedControlKey) {
      const firstWhile = whileStructures[0];
      const firstFork = forkStructures[0];
      if (firstWhile) {
        chooseControlStructure(`while:${firstWhile.startLine}`);
      } else if (firstFork) {
        chooseControlStructure(`fork:${firstFork.startLine}`);
      }
    }
  };

  const clearActivityDrag = () => {
    activityPointerDragRef.current = null;
    activityDropTargetRef.current = null;
    activityLaneTargetRef.current = "";
    setDraggedActivityKey("");
    setActivityDropTarget(null);
    setActivityLaneTarget("");
  };

  const clearNewActivityDrag = () => {
    newActivityPointerDragRef.current = null;
    newActivityDropTargetRef.current = null;
    setIsNewActivityDragging(false);
    setNewActivityDropTarget(null);
  };

  const reorderActivityByDrop = (
    sourceKey: string,
    targetKey: string,
    position: ActivityDropPosition,
  ) => {
    const fromIndex = editableActivities.findIndex(
      (activity) => activity.key === sourceKey,
    );
    const targetIndex = editableActivities.findIndex(
      (activity) => activity.key === targetKey,
    );
    if (fromIndex < 0 || targetIndex < 0 || fromIndex === targetIndex) {
      return false;
    }

    let desiredIndex = targetIndex + (position === "after" ? 1 : 0);
    if (fromIndex < desiredIndex) desiredIndex -= 1;
    desiredIndex = clamp(desiredIndex, 0, editableActivities.length - 1);
    if (desiredIndex === fromIndex) return false;

    let nextSource = source;
    let currentIndex = fromIndex;
    const direction: -1 | 1 = desiredIndex < fromIndex ? -1 : 1;
    while (currentIndex !== desiredIndex) {
      const moved = moveActivityOnce(nextSource, currentIndex, direction);
      if (!moved) {
        setEditMessage(
          "分岐・ループの境界を越える位置には移動できません",
        );
        return false;
      }
      nextSource = moved.source;
      currentIndex = moved.index;
    }
    applyVisualEdit(
      nextSource,
      "ドラッグした位置へ箱を移動しました",
      currentIndex,
    );
    return true;
  };

  const getActivityDropTargetAtPoint = (
    clientX: number,
    clientY: number,
    excludedKey = "",
  ) => {
    const element = document
      .elementFromPoint(clientX, clientY)
      ?.closest<HTMLButtonElement>(".activity-hit-target");
    const key = element?.dataset.activityKey;
    if (!element || !key || key === excludedKey) return null;
    const rect = element.getBoundingClientRect();
    const position: ActivityDropPosition =
      clientY < rect.top + rect.height / 2 ? "before" : "after";
    return { key, position };
  };

  const getSwimlaneAtPoint = (clientX: number) => {
    const canvas = canvasRef.current;
    if (!canvas || !swimlanes.length || transformRef.current.scale <= 0) return null;
    const canvasRect = canvas.getBoundingClientRect();
    const naturalX =
      (clientX - canvasRect.left - transformRef.current.x) /
      transformRef.current.scale;
    return (
      swimlanes.find((lane) => naturalX >= lane.x0 && naturalX <= lane.x1) ??
      null
    );
  };

  const handleActivityPointerDown = (
    event: ReactPointerEvent<HTMLButtonElement>,
    activityKey: string,
  ) => {
    event.stopPropagation();
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    activityPointerDragRef.current = {
      pointerId: event.pointerId,
      activityKey,
      startX: event.clientX,
      startY: event.clientY,
      active: false,
      intent: null,
    };
    selectEditableActivity(activityKey);
  };

  const handleActivityPointerMove = (
    event: ReactPointerEvent<HTMLButtonElement>,
  ) => {
    const drag = activityPointerDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const distance = Math.hypot(
      event.clientX - drag.startX,
      event.clientY - drag.startY,
    );
    if (!drag.active && distance < 6) return;
    if (!drag.active) {
      drag.active = true;
      drag.intent =
        Math.abs(event.clientX - drag.startX) >
        Math.abs(event.clientY - drag.startY)
          ? "lane"
          : "reorder";
      suppressActivityClickRef.current = true;
      setDraggedActivityKey(drag.activityKey);
    }
    event.preventDefault();
    if (drag.intent === "lane") {
      const lane = getSwimlaneAtPoint(event.clientX);
      const sourceLane = editableActivities.find(
        (activity) => activity.key === drag.activityKey,
      )?.lane;
      const nextLane = lane && lane.name !== sourceLane ? lane.name : "";
      activityLaneTargetRef.current = nextLane;
      setActivityLaneTarget(nextLane);
      activityDropTargetRef.current = null;
      setActivityDropTarget(null);
    } else {
      const target = getActivityDropTargetAtPoint(
        event.clientX,
        event.clientY,
        drag.activityKey,
      );
      activityDropTargetRef.current = target;
      setActivityDropTarget(target);
      activityLaneTargetRef.current = "";
      setActivityLaneTarget("");
    }
  };

  const handleActivityPointerEnd = (
    event: ReactPointerEvent<HTMLButtonElement>,
  ) => {
    const drag = activityPointerDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const target = drag.intent === "reorder"
      ? getActivityDropTargetAtPoint(
          event.clientX,
          event.clientY,
          drag.activityKey,
        ) ?? activityDropTargetRef.current
      : null;
    const laneTarget =
      drag.intent === "lane"
        ? getSwimlaneAtPoint(event.clientX)?.name ??
          activityLaneTargetRef.current
        : "";
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    clearActivityDrag();
    if (drag.active && laneTarget) {
      changeActivityLane(drag.activityKey, laneTarget);
    } else if (drag.active && target) {
      reorderActivityByDrop(drag.activityKey, target.key, target.position);
    }
  };

  const handleNewActivityPointerDown = (
    event: ReactPointerEvent<HTMLButtonElement>,
  ) => {
    event.stopPropagation();
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    newActivityPointerDragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      active: false,
    };
  };

  const handleNewActivityPointerMove = (
    event: ReactPointerEvent<HTMLButtonElement>,
  ) => {
    const drag = newActivityPointerDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const distance = Math.hypot(
      event.clientX - drag.startX,
      event.clientY - drag.startY,
    );
    if (!drag.active && distance < 6) return;
    if (!drag.active) {
      drag.active = true;
      setIsNewActivityDragging(true);
    }
    event.preventDefault();
    const target = getActivityDropTargetAtPoint(event.clientX, event.clientY);
    newActivityDropTargetRef.current = target;
    setNewActivityDropTarget(target);
  };

  const handleNewActivityPointerEnd = (
    event: ReactPointerEvent<HTMLButtonElement>,
  ) => {
    const drag = newActivityPointerDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const target =
      getActivityDropTargetAtPoint(event.clientX, event.clientY) ??
      newActivityDropTargetRef.current;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    clearNewActivityDrag();
    if (drag.active && target) {
      addActivityAtDrop(target.key, target.position);
    }
  };

  const handleActivityClick = (activityKey: string) => {
    if (suppressActivityClickRef.current) {
      suppressActivityClickRef.current = false;
      return;
    }
    selectEditableActivity(activityKey);
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

  const handleManualSourceChange = (nextSource: string) => {
    setSource(nextSource);
    setEditHistory({ past: [], future: [] });
    setSelectedActivityKey("");
    setEditMessage("");
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
    setEditHistory({ past: [], future: [] });
    setSelectedActivityKey("");
    setEditMessage("");
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
    setEditHistory({ past: [], future: [] });
    setSelectedActivityKey("");
    setIsEditMode(false);
    setEditMessage("");
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
              onChange={(event) => handleManualSourceChange(event.target.value)}
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
            <div className="preview-actions">
              <button
                className={`edit-mode-button ${isEditMode ? "is-active" : ""}`}
                type="button"
                disabled={!svg || editableActivities.length === 0}
                aria-pressed={isEditMode}
                title={
                  editableActivities.length
                    ? "箱の文章・順番・主体を編集"
                    : "標準的なアクティビティ図を描画すると利用できます"
                }
                onClick={() => {
                  const next = !isEditMode;
                  setIsEditMode(next);
                  setEditMessage("");
                  setIsDiffOpen(false);
                  setIsStructureEditorOpen(false);
                  if (next) {
                    setEditBaseline(source);
                    setEditHistory({ past: [], future: [] });
                    if (!selectedActivityKey) {
                      selectEditableActivity(editableActivities[0]?.key ?? "");
                    }
                  }
                }}
              >
                <PencilLine size={16} aria-hidden="true" />
                {isEditMode ? "編集を終了" : "箱を編集"}
              </button>
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

            {isEditMode && (
              <aside
                className="activity-editor-panel"
                aria-label="箱の編集パネル"
                onPointerDown={(event) => event.stopPropagation()}
                onWheel={(event) => event.stopPropagation()}
              >
                <div className="activity-editor-heading">
                  <div>
                    <strong>箱を編集</strong>
                    <span>縦ドラッグで順番・横ドラッグで主体を変更</span>
                  </div>
                  <button
                    type="button"
                    className="activity-editor-close"
                    onClick={() => {
                      setIsEditMode(false);
                      setIsDiffOpen(false);
                      setIsStructureEditorOpen(false);
                    }}
                    aria-label="編集モードを終了"
                  >
                    <X size={17} />
                  </button>
                </div>

                <div className="activity-history-buttons">
                  <button
                    type="button"
                    onClick={undoVisualEdit}
                    disabled={editHistory.past.length === 0}
                  >
                    <Undo2 size={15} /> 元に戻す
                  </button>
                  <button
                    type="button"
                    onClick={redoVisualEdit}
                    disabled={editHistory.future.length === 0}
                  >
                    <Redo2 size={15} /> やり直す
                  </button>
                  <button
                    type="button"
                    className="activity-diff-button"
                    onClick={() => {
                      setIsStructureEditorOpen(false);
                      setIsDiffOpen(true);
                    }}
                    disabled={sourceDiff.length === 0}
                  >
                    <FileCode2 size={15} /> コード差分
                    {sourceDiff.length > 0 && (
                      <span aria-label={`追加${sourceDiffSummary.added}行、削除${sourceDiffSummary.removed}行`}>
                        <b>+{sourceDiffSummary.added}</b>
                        <em>−{sourceDiffSummary.removed}</em>
                      </span>
                    )}
                  </button>
                </div>

                <button
                  type="button"
                  className={`activity-new-drag-button ${isNewActivityDragging ? "is-dragging" : ""}`}
                  aria-pressed={isNewActivityDragging}
                  onPointerDown={handleNewActivityPointerDown}
                  onPointerMove={handleNewActivityPointerMove}
                  onPointerUp={handleNewActivityPointerEnd}
                  onPointerCancel={handleNewActivityPointerEnd}
                >
                  <PlusCircle size={17} />
                  <span>
                    <b>新しい箱をドラッグ</b>
                    <small>箱の上半分・下半分へドロップ</small>
                  </span>
                  <GripVertical size={17} aria-hidden="true" />
                </button>

                <button
                  type="button"
                  className="activity-structure-button"
                  onClick={openStructureEditor}
                >
                  <GitBranch size={17} />
                  <span>
                    <b>構造編集</b>
                    <small>条件分岐・接続先・while・fork</small>
                  </span>
                </button>

                <label className="activity-field">
                  <span>編集する箱</span>
                  <select
                    value={selectedActivityKey}
                    onChange={(event) => selectEditableActivity(event.target.value)}
                  >
                    <option value="">箱を選択してください</option>
                    {editableActivities.map((activity, index) => (
                      <option value={activity.key} key={activity.key}>
                        {`${index + 1}. [${activity.lane}] ${normalizeActivityLabel(activity.label)}`}
                      </option>
                    ))}
                  </select>
                </label>

                {selectedActivity ? (
                  <>
                    <label className="activity-field">
                      <span>箱の文章</span>
                      <textarea
                        value={activityLabelDraft}
                        rows={3}
                        onChange={(event) => setActivityLabelDraft(event.target.value)}
                      />
                    </label>
                    <button
                      type="button"
                      className="activity-primary-action"
                      onClick={updateSelectedActivityLabel}
                    >
                      <Check size={16} /> 文章を反映
                    </button>

                    <label className="activity-field">
                      <span>主体</span>
                      <select
                        value={selectedActivity.lane}
                        disabled={swimlaneNames.length < 2}
                        onChange={(event) =>
                          changeSelectedActivityLane(event.target.value)
                        }
                      >
                        {swimlaneNames.map((lane) => (
                          <option value={lane} key={lane}>
                            {lane}
                          </option>
                        ))}
                      </select>
                    </label>

                    <div className="activity-action-grid">
                      <button
                        type="button"
                        onClick={() => moveSelectedActivity(-1)}
                        disabled={!canMoveSelectedUp}
                        title="分岐やループの境界は越えられません"
                      >
                        <ArrowUp size={16} /> 一つ前へ
                      </button>
                      <button
                        type="button"
                        onClick={() => moveSelectedActivity(1)}
                        disabled={!canMoveSelectedDown}
                        title="分岐やループの境界は越えられません"
                      >
                        <ArrowDown size={16} /> 一つ後ろへ
                      </button>
                      <button
                        type="button"
                        onClick={() => addActivityNearSelected("before")}
                      >
                        <PlusCircle size={16} /> 前に追加
                      </button>
                      <button
                        type="button"
                        onClick={() => addActivityNearSelected("after")}
                      >
                        <PlusCircle size={16} /> 後に追加
                      </button>
                      <button type="button" onClick={duplicateSelectedActivity}>
                        <CopyPlus size={16} /> 複製
                      </button>
                      <button
                        type="button"
                        className="activity-delete-action"
                        onClick={deleteSelectedActivity}
                      >
                        <Trash2 size={16} /> 削除
                      </button>
                    </div>
                  </>
                ) : (
                  <p className="activity-editor-empty">編集する箱を選択してください。</p>
                )}

                {editMessage && (
                  <p className="activity-edit-message" role="status">
                    {editMessage}
                  </p>
                )}
                <p className="activity-editor-note">
                  箱は動かし始めた方向で操作を判定します。縦なら前後移動、横なら主体変更です。新しい箱も挿入線を確認して追加できます。
                </p>
              </aside>
            )}

            {isEditMode && isDiffOpen && (
              <section
                className="source-diff-panel"
                role="dialog"
                aria-modal="true"
                aria-labelledby="source-diff-title"
                onPointerDown={(event) => event.stopPropagation()}
                onWheel={(event) => event.stopPropagation()}
              >
                <div className="source-diff-heading">
                  <div>
                    <strong id="source-diff-title">編集前後のコード差分</strong>
                    <span>
                      <b>+{sourceDiffSummary.added} 追加</b>
                      <em>−{sourceDiffSummary.removed} 削除</em>
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={() => setIsDiffOpen(false)}
                    aria-label="コード差分を閉じる"
                  >
                    <X size={18} />
                  </button>
                </div>
                <div className="source-diff-legend" aria-hidden="true">
                  <span className="is-removed">− 編集前</span>
                  <span className="is-added">+ 編集後</span>
                  <span>変更箇所の前後3行を表示</span>
                </div>
                <div className="source-diff-content" tabIndex={0}>
                  {sourceDiff.map((line, index) =>
                    line.type === "skip" ? (
                      <div className="source-diff-skip" key={`skip-${index}`}>
                        ⋯ {line.text} ⋯
                      </div>
                    ) : (
                      <div
                        className={`source-diff-line is-${line.type}`}
                        key={`${line.type}-${line.oldLine}-${line.newLine}-${index}`}
                      >
                        <span className="source-diff-marker" aria-hidden="true">
                          {line.type === "added"
                            ? "+"
                            : line.type === "removed"
                              ? "−"
                              : " "}
                        </span>
                        <span className="source-diff-line-number">
                          {line.oldLine ?? ""}
                        </span>
                        <span className="source-diff-line-number">
                          {line.newLine ?? ""}
                        </span>
                        <code>{line.text || " "}</code>
                      </div>
                    ),
                  )}
                </div>
              </section>
            )}

            {isEditMode && isStructureEditorOpen && (
              <section
                className="structure-editor-panel"
                role="dialog"
                aria-modal="true"
                aria-labelledby="structure-editor-title"
                onPointerDown={(event) => event.stopPropagation()}
                onWheel={(event) => event.stopPropagation()}
              >
                <div className="structure-editor-heading">
                  <div>
                    <strong id="structure-editor-title">構造編集</strong>
                    <span>安全に変換できるPlantUML構造だけを編集します</span>
                  </div>
                  <button
                    type="button"
                    onClick={() => setIsStructureEditorOpen(false)}
                    aria-label="構造編集を閉じる"
                  >
                    <X size={18} />
                  </button>
                </div>

                <div className="structure-editor-tabs" role="tablist">
                  {([
                    ["add-if", "分岐を追加"],
                    ["move-branch", "はい／いいえへ移動"],
                    ["connection", "接続先を変更"],
                    ["control", "while・fork"],
                  ] as Array<[StructureEditorTab, string]>).map(([tab, label]) => (
                    <button
                      type="button"
                      role="tab"
                      aria-selected={structureEditorTab === tab}
                      className={structureEditorTab === tab ? "is-active" : ""}
                      onClick={() => setStructureEditorTab(tab)}
                      key={tab}
                    >
                      {label}
                    </button>
                  ))}
                </div>

                <div className="structure-editor-content">
                  {structureEditorTab === "add-if" && (
                    <div className="structure-editor-section">
                      <h3>選択した箱の後に条件分岐を追加</h3>
                      <p>
                        現在選択中：
                        <strong>
                          {selectedActivity
                            ? normalizeActivityLabel(selectedActivity.label)
                            : "箱が選択されていません"}
                        </strong>
                      </p>
                      <label className="structure-field">
                        <span>条件</span>
                        <input
                          value={newIfCondition}
                          onChange={(event) => setNewIfCondition(event.target.value)}
                        />
                      </label>
                      <div className="structure-two-columns">
                        <label className="structure-field">
                          <span>はい側の最初の箱</span>
                          <input
                            value={newIfYesAction}
                            onChange={(event) => setNewIfYesAction(event.target.value)}
                          />
                        </label>
                        <label className="structure-field">
                          <span>いいえ側の最初の箱</span>
                          <input
                            value={newIfNoAction}
                            onChange={(event) => setNewIfNoAction(event.target.value)}
                          />
                        </label>
                      </div>
                      <button
                        type="button"
                        className="structure-primary-action"
                        onClick={addConditionAfterSelected}
                        disabled={!selectedActivity}
                      >
                        <GitBranch size={16} /> 条件分岐を追加
                      </button>
                    </div>
                  )}

                  {structureEditorTab === "move-branch" && (
                    <div className="structure-editor-section">
                      <h3>選択した箱を既存の分岐へ移動</h3>
                      {ifStructures.length ? (
                        <>
                          <label className="structure-field">
                            <span>移動先の条件分岐</span>
                            <select
                              value={selectedIfStructure?.startLine ?? ""}
                              onChange={(event) =>
                                setSelectedIfStartLine(Number(event.target.value))
                              }
                            >
                              {ifStructures.map((structure) => (
                                <option
                                  value={structure.startLine}
                                  key={structure.startLine}
                                >
                                  {`${structure.startLine + 1}行目：${structure.condition}`}
                                </option>
                              ))}
                            </select>
                          </label>
                          <div className="structure-branch-choice">
                            <button
                              type="button"
                              className={selectedIfBranch === "yes" ? "is-active" : ""}
                              onClick={() => setSelectedIfBranch("yes")}
                            >
                              はい側（{selectedIfStructure?.yesLabel}）
                            </button>
                            <button
                              type="button"
                              className={selectedIfBranch === "no" ? "is-active" : ""}
                              onClick={() => setSelectedIfBranch("no")}
                            >
                              いいえ側（{selectedIfStructure?.noLabel}）
                            </button>
                          </div>
                          <button
                            type="button"
                            className="structure-primary-action"
                            onClick={moveSelectedActivityToBranch}
                            disabled={!selectedActivity || !selectedIfStructure}
                          >
                            <GitBranch size={16} /> 選択した箱を移動
                          </button>
                        </>
                      ) : (
                        <p className="structure-empty">
                          編集できる if / else / endif 分岐がありません。
                        </p>
                      )}
                    </div>
                  )}

                  {structureEditorTab === "connection" && (
                    <div className="structure-editor-section">
                      <h3>直列フローの次の接続先を変更</h3>
                      <p>
                        選択した箱を接続先の直前へ移動し、PlantUMLの暗黙の線を
                        安全に付け替えます。分岐境界は越えません。
                      </p>
                      <label className="structure-field">
                        <span>次につなぐ箱</span>
                        <select
                          value={connectionTargetKey}
                          onChange={(event) =>
                            setConnectionTargetKey(event.target.value)
                          }
                          disabled={!connectionTargets.length}
                        >
                          <option value="">接続先を選択</option>
                          {connectionTargets.map((activity) => (
                            <option value={activity.key} key={activity.key}>
                              {`[${activity.lane}] ${normalizeActivityLabel(activity.label)}`}
                            </option>
                          ))}
                        </select>
                      </label>
                      <button
                        type="button"
                        className="structure-primary-action"
                        onClick={connectSelectedActivityToTarget}
                        disabled={!selectedActivity || !connectionTargetKey}
                      >
                        <Link2 size={16} /> 接続先を変更
                      </button>
                    </div>
                  )}

                  {structureEditorTab === "control" && (
                    <div className="structure-editor-section">
                      <h3>while・fork専用編集</h3>
                      {whileStructures.length || forkStructures.length ? (
                        <>
                          <label className="structure-field">
                            <span>編集する構造</span>
                            <select
                              value={selectedControlKey}
                              onChange={(event) =>
                                chooseControlStructure(event.target.value)
                              }
                            >
                              {whileStructures.map((structure) => (
                                <option
                                  value={`while:${structure.startLine}`}
                                  key={`while:${structure.startLine}`}
                                >
                                  {`while ${structure.startLine + 1}行目：${structure.condition}`}
                                </option>
                              ))}
                              {forkStructures.map((structure) => (
                                <option
                                  value={`fork:${structure.startLine}`}
                                  key={`fork:${structure.startLine}`}
                                >
                                  {`fork ${structure.startLine + 1}行目：${structure.branches.length}枝`}
                                </option>
                              ))}
                            </select>
                          </label>

                          {selectedWhileStructure && (
                            <div className="control-editor-card">
                              <label className="structure-field">
                                <span>while条件</span>
                                <input
                                  value={whileConditionDraft}
                                  onChange={(event) =>
                                    setWhileConditionDraft(event.target.value)
                                  }
                                />
                              </label>
                              <div className="structure-two-columns">
                                <label className="structure-field">
                                  <span>継続ラベル</span>
                                  <input
                                    value={whileYesLabelDraft}
                                    onChange={(event) =>
                                      setWhileYesLabelDraft(event.target.value)
                                    }
                                  />
                                </label>
                                <label className="structure-field">
                                  <span>終了ラベル</span>
                                  <input
                                    value={whileNoLabelDraft}
                                    onChange={(event) =>
                                      setWhileNoLabelDraft(event.target.value)
                                    }
                                  />
                                </label>
                              </div>
                              <button
                                type="button"
                                className="structure-primary-action"
                                onClick={applyWhileStructureEdit}
                              >
                                whileへ反映
                              </button>
                            </div>
                          )}

                          {selectedForkStructure && (
                            <div className="control-editor-card">
                              <div className="fork-branch-list">
                                {selectedForkStructure.branches.map((branch, index) => (
                                  <button
                                    type="button"
                                    className={selectedForkBranch === index ? "is-active" : ""}
                                    onClick={() => setSelectedForkBranch(index)}
                                    key={index}
                                  >
                                    <b>枝 {index + 1}</b>
                                    <span>
                                      {normalizeActivityLabel(
                                        branch.lines.find((line) => line.includes(":")) ??
                                          "処理なし",
                                      )}
                                    </span>
                                  </button>
                                ))}
                              </div>
                              <div className="fork-actions">
                                <button
                                  type="button"
                                  onClick={() => moveForkBranch(-1)}
                                  disabled={selectedForkBranch <= 0}
                                >
                                  <ArrowUp size={15} /> 前の枝へ
                                </button>
                                <button
                                  type="button"
                                  onClick={() => moveForkBranch(1)}
                                  disabled={
                                    selectedForkBranch >=
                                    selectedForkStructure.branches.length - 1
                                  }
                                >
                                  <ArrowDown size={15} /> 次の枝へ
                                </button>
                                <button type="button" onClick={addForkBranch}>
                                  <PlusCircle size={15} /> 枝を追加
                                </button>
                                <button
                                  type="button"
                                  className="is-danger"
                                  onClick={deleteForkBranch}
                                  disabled={selectedForkStructure.branches.length <= 2}
                                >
                                  <Trash2 size={15} /> 枝を削除
                                </button>
                              </div>
                            </div>
                          )}
                        </>
                      ) : (
                        <p className="structure-empty">
                          編集できる while または fork 構造がありません。
                        </p>
                      )}
                    </div>
                  )}
                </div>
              </section>
            )}

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
                {isEditMode && targetSwimlane && (
                  <div
                    className="activity-lane-drop-preview"
                    style={{
                      left: targetSwimlane.x0,
                      top: targetSwimlane.headerBottom,
                      width: targetSwimlane.x1 - targetSwimlane.x0,
                      height: Math.max(
                        1,
                        diagramSize.height - targetSwimlane.headerBottom,
                      ),
                    }}
                    aria-hidden="true"
                  >
                    <span>{targetSwimlane.name}へ移動</span>
                  </div>
                )}
                {isEditMode &&
                  activityShapes.map((shape) => (
                    <button
                      type="button"
                      className={`activity-hit-target ${selectedActivityKey === shape.activityKey ? "is-selected" : ""} ${draggedActivityKey === shape.activityKey ? "is-dragging" : ""} ${activityDropTarget?.key === shape.activityKey ? `drop-${activityDropTarget.position}` : ""} ${newActivityDropTarget?.key === shape.activityKey ? `add-${newActivityDropTarget.position}` : ""}`}
                      style={{
                        left: shape.x,
                        top: shape.y,
                        width: shape.width,
                        height: shape.height,
                      }}
                      key={`${shape.activityKey}-${shape.x}-${shape.y}`}
                      aria-label="この箱を編集"
                      aria-grabbed={draggedActivityKey === shape.activityKey}
                      data-activity-key={shape.activityKey}
                      title="クリックして編集・縦ドラッグで順番変更・横ドラッグで主体変更"
                      onPointerDown={(event) =>
                        handleActivityPointerDown(event, shape.activityKey)
                      }
                      onPointerMove={handleActivityPointerMove}
                      onPointerUp={handleActivityPointerEnd}
                      onPointerCancel={handleActivityPointerEnd}
                      onClick={() => handleActivityClick(shape.activityKey)}
                    />
                  ))}
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
