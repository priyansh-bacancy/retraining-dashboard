"use client";

import {
  Activity,
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  Box,
  CarFront,
  Check,
  ChevronLeft,
  ChevronRight,
  Clock3,
  Cloud,
  Eye,
  EyeOff,
  Filter,
  Flame,
  Layers3,
  LoaderCircle,
  Menu,
  MoreHorizontal,
  MousePointer2,
  Plus,
  RotateCcw,
  Save,
  Search,
  ShieldCheck,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import Image from "next/image";
import {
  PointerEvent as ReactPointerEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Annotation,
  API_BASE,
  api,
  BatchSaveResult,
  FrameModel,
  Health,
  JobDetail,
  JobsPage,
  JobSummary,
  Segment,
} from "./api";
import { adjacentFrame, frameWindow, mergeFrameNumbers } from "./frame-filter.mjs";

type VisibleModel = FrameModel & { visible: boolean };
type DragMode = "move" | "nw" | "ne" | "sw" | "se";
type FrameDraft = {
  annotations: Annotation[];
  dirtyModels: string[];
  peopleCounts: Record<string, number>;
  segments: Segment[];
};
type PendingNavigation = { run: () => void } | null;
type JobFilter = "all" | "reviewable" | "unavailable";
type FrameFilter = "all" | "corrected";

const FULL_JOB_PRELOAD_LIMIT = 100;
const FRAME_PRELOAD_CONCURRENCY = 4;
const MIN_BATCH_TRANSITION_MS = 300;

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

function ConnectionState({ health }: { health: Health | null }) {
  return (
    <div className={`system-state ${health ? "" : "system-state-offline"}`}>
      <span className="live-dot" />
      {health ? `S3 · ${health.region}` : "S3 unavailable"}
    </div>
  );
}

function defaultModelId(models: VisibleModel[]) {
  return (
    models.find(
      (model) => model.id === "mmc-vehicle-classification" && model.count,
    )?.id ??
    models.find((model) => model.count)?.id ??
    models[0]?.id ??
    ""
  );
}

function kindLabel(kind: FrameModel["kind"]) {
  if (kind === "segment") return "Time segment";
  if (kind === "vehicle") return "Track + attributes";
  if (kind === "people") return "People count";
  if (kind === "group") return "Groups + people count";
  return "Bounding box";
}

function peopleInGroup(annotation: Annotation) {
  const value = annotation.attributes?.people_count;
  if (value === undefined || value === null || value === "") return null;
  const count = Number(value);
  return Number.isInteger(count) && count >= 0 ? count : null;
}

function groupPeopleTotal(items: Annotation[]) {
  const counts = items.map(peopleInGroup);
  return counts.length > 0 && counts.every((count) => count !== null)
    ? (counts as number[]).reduce((total, count) => total + count, 0)
    : null;
}

export function ReviewDashboard({
  job,
  jobs,
  health,
  onBack,
  onSelectJob,
}: {
  job: JobSummary;
  jobs: JobSummary[];
  health: Health | null;
  onBack: () => void;
  onSelectJob: (job: JobSummary) => void;
}) {
  const [query, setQuery] = useState("");
  const [searchJobs, setSearchJobs] = useState<JobSummary[]>([]);
  const [queueJobs, setQueueJobs] = useState<JobSummary[]>(jobs);
  const [queueCursor, setQueueCursor] = useState<string | null>(null);
  const [queueLoading, setQueueLoading] = useState(true);
  const [sidebarLoading, setSidebarLoading] = useState(false);
  const [jobFilter, setJobFilter] = useState<JobFilter>("all");
  const [filterOpen, setFilterOpen] = useState(false);
  const [batch, setBatch] = useState(0);
  const [detail, setDetail] = useState<JobDetail | null>(null);
  const [currentFrameIndex, setCurrentFrameIndex] = useState(0);
  const [visibleThumbnailCount, setVisibleThumbnailCount] = useState(7);
  const [models, setModels] = useState<VisibleModel[]>([]);
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [activeModel, setActiveModel] = useState("");
  const [dirtyModels, setDirtyModels] = useState<Set<string>>(new Set());
  const [drafts, setDrafts] = useState<Record<string, FrameDraft>>({});
  const [pendingNavigation, setPendingNavigation] =
    useState<PendingNavigation>(null);
  const [saved, setSaved] = useState(false);
  const [loading, setLoading] = useState(true);
  const [imageLoading, setImageLoading] = useState(true);
  const [preparingBatch, setPreparingBatch] = useState(false);
  const [error, setError] = useState("");
  const [mobileJobs, setMobileJobs] = useState(false);
  const [activeSegments, setActiveSegments] = useState<Segment[]>([]);
  const [inspectorTab, setInspectorTab] = useState<"annotations" | "info">(
    "annotations",
  );
  const [fitMode, setFitMode] = useState<"cover" | "contain">("contain");
  const [jumpFrame, setJumpFrame] = useState("");
  const [frameFilter, setFrameFilter] = useState<FrameFilter>("all");
  const [reviewedFrameNumbers, setReviewedFrameNumbers] = useState<number[]>([]);
  const stageRef = useRef<HTMLDivElement>(null);
  const draftsRef = useRef<Record<string, FrameDraft>>({});
  const historyMarkerRef = useRef("");
  const historyEntryActiveRef = useRef(false);
  const allowHistoryBackRef = useRef(false);
  const batchEdgeRef = useRef<"first" | "last">("first");
  const batchTargetIndexRef = useRef<number | null>(null);
  const visibilityRef = useRef<Record<string, boolean>>({});
  const loadedFrameImagesRef = useRef<Set<string>>(new Set());
  const frameImagePromisesRef = useRef<Map<string, Promise<void>>>(new Map());
  const batchCacheRef = useRef<Map<number, JobDetail>>(new Map());
  const warmingBatchesRef = useRef<Set<number>>(new Set());
  const preloadGenerationRef = useRef(0);
  const currentImageKeyRef = useRef("");

  const sidebarSource = query.trim() ? searchJobs : queueJobs;
  const sidebarJobs = useMemo(
    () => [job, ...sidebarSource.filter((item) => item.id !== job.id)],
    [job, sidebarSource],
  );
  const filteredJobs = sidebarJobs.filter((item) => {
    const matchesQuery = item.id
      .toLowerCase()
      .includes(query.trim().toLowerCase());
    const matchesFilter =
      jobFilter === "all" ||
      (jobFilter === "reviewable"
        ? item.source_available
        : !item.source_available);
    return matchesQuery && matchesFilter;
  });
  const selected = annotations.find((item) => item.id === selectedId);
  const activeLayer =
    models.find((model) => model.id === activeModel) ?? models[0];
  const visibleModelIds = useMemo(
    () =>
      new Set(models.filter((model) => model.visible).map((model) => model.id)),
    [models],
  );
  const currentFrame = detail?.frames[currentFrameIndex];
  const thumbnailWindowStart =
    Math.floor(currentFrameIndex / visibleThumbnailCount) *
    visibleThumbnailCount;
  const visibleFrames =
    detail?.frames.slice(
      thumbnailWindowStart,
      thumbnailWindowStart + visibleThumbnailCount,
    ) ?? [];
  const imageUrl = currentFrame && detail
    ? frameImageUrl(detail, currentFrame.frame_number)
    : "";
  const currentDirty = dirtyModels.size > 0;
  const pendingFrameNumbers = useMemo(() => {
    const numbers = new Set(Object.keys(drafts).map(Number));
    if (currentDirty && currentFrame) numbers.add(currentFrame.frame_number);
    return numbers;
  }, [currentDirty, currentFrame, drafts]);
  const reviewedFrameSet = useMemo(
    () => new Set(reviewedFrameNumbers),
    [reviewedFrameNumbers],
  );
  const visibleCorrectedFrames = useMemo(
    () =>
      frameWindow(
        reviewedFrameNumbers,
        currentFrame?.frame_number ?? -1,
        visibleThumbnailCount,
      ),
    [reviewedFrameNumbers, currentFrame?.frame_number, visibleThumbnailCount],
  );
  const currentCorrectedIndex = currentFrame
    ? reviewedFrameNumbers.indexOf(currentFrame.frame_number)
    : -1;
  const currentFrameSaved = currentFrame
    ? reviewedFrameSet.has(currentFrame.frame_number) || currentFrame.reviewed
    : false;
  const dirty = pendingFrameNumbers.size > 0;

  function frameImageKey(source: JobDetail, frameNumber: number) {
    return `${source.job_id}:${source.source_etag}:${frameNumber}`;
  }

  function frameImageUrl(source: JobDetail, frameNumber: number) {
    return `${API_BASE}/v1/jobs/${source.job_id}/frames/${frameNumber}?source=${encodeURIComponent(source.source_etag)}`;
  }

  function preloadFrameImage(source: JobDetail, frameNumber: number) {
    const key = frameImageKey(source, frameNumber);
    if (loadedFrameImagesRef.current.has(key)) return Promise.resolve();
    const existing = frameImagePromisesRef.current.get(key);
    if (existing) return existing;
    const promise = new Promise<void>((resolve) => {
      const image = new window.Image();
      const finish = (loaded: boolean) => {
        if (loaded) {
          loadedFrameImagesRef.current.add(key);
          if (currentImageKeyRef.current === key) setImageLoading(false);
        }
        frameImagePromisesRef.current.delete(key);
        resolve();
      };
      image.onload = () => finish(true);
      image.onerror = () => finish(false);
      image.src = frameImageUrl(source, frameNumber);
    });
    frameImagePromisesRef.current.set(key, promise);
    return promise;
  }

  async function preloadFrameSet(source: JobDetail) {
    for (
      let start = 0;
      start < source.frames.length;
      start += FRAME_PRELOAD_CONCURRENCY
    ) {
      await Promise.all(
        source.frames
          .slice(start, start + FRAME_PRELOAD_CONCURRENCY)
          .map((frame) => preloadFrameImage(source, frame.frame_number)),
      );
    }
  }

  async function warmBatch(targetBatch: number, source: JobDetail, generation: number) {
    if (
      targetBatch < 0 ||
      targetBatch >= source.total_batches ||
      batchCacheRef.current.has(targetBatch) ||
      warmingBatchesRef.current.has(targetBatch)
    )
      return;
    warmingBatchesRef.current.add(targetBatch);
    try {
      const warmed = await api<JobDetail>(
        `/v1/jobs/${job.id}?batch=${targetBatch}&size=${source.batch_size}`,
      );
      if (generation !== preloadGenerationRef.current) return;
      await preloadFrameSet(warmed);
      if (generation === preloadGenerationRef.current)
        batchCacheRef.current.set(targetBatch, warmed);
    } catch {
      // Background warming is best-effort; normal navigation can retry it.
    } finally {
      warmingBatchesRef.current.delete(targetBatch);
    }
  }

  function applyFrame(
    index: number,
    source: JobDetail,
    reloadImage = true,
    useDraft = true,
  ) {
    const frame = source.frames[index];
    if (!frame) return;
    const draft = useDraft
      ? draftsRef.current[String(frame.frame_number)]
      : undefined;
    const nextAnnotations =
      draft?.annotations.map((item) => ({ ...item })) ??
      frame.models.flatMap((model) => model.annotations);
    const nextModels = frame.models.map((model) => {
      const visible = visibilityRef.current[model.id] ?? true;
      if (!draft?.dirtyModels.includes(model.id)) return { ...model, visible };
      if (model.kind === "segment")
        return {
          ...model,
          visible,
          count: draft.segments.length,
          segments: draft.segments,
          segment: draft.segments[0] ?? null,
        };
      const modelAnnotations = nextAnnotations.filter(
        (item) => item.model_id === model.id,
      );
      return {
        ...model,
        visible,
        annotations: modelAnnotations,
        count: modelAnnotations.length,
        people_count:
          model.kind === "people"
            ? (draft.peopleCounts[model.id] ??
              model.people_count ??
              modelAnnotations.length)
            : model.people_count,
      };
    });
    setCurrentFrameIndex(index);
    const imageKey = frameImageKey(source, frame.frame_number);
    currentImageKeyRef.current = imageKey;
    setModels(nextModels);
    setAnnotations(nextAnnotations);
    setSelectedId(nextAnnotations[0]?.id ?? "");
    setActiveModel(defaultModelId(nextModels));
    setDirtyModels(new Set(draft?.dirtyModels ?? []));
    const segmentModel = nextModels.find((model) => model.kind === "segment");
    setActiveSegments(
      draft?.segments ??
        segmentModel?.segments ??
        (segmentModel?.segment ? [segmentModel.segment] : []),
    );
    if (reloadImage)
      setImageLoading(!loadedFrameImagesRef.current.has(imageKey));
    setError("");
  }

  useEffect(() => {
    preloadGenerationRef.current += 1;
    loadedFrameImagesRef.current.clear();
    frameImagePromisesRef.current.clear();
    batchCacheRef.current.clear();
    warmingBatchesRef.current.clear();
    currentImageKeyRef.current = "";
  }, [job.id]);

  useEffect(() => {
    const value = query.trim();
    if (!value) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      api<JobsPage>(
        `/v1/jobs?range=all&limit=25&search=${encodeURIComponent(value)}`,
      )
        .then((result) => {
          if (!cancelled) setSearchJobs(result.jobs);
        })
        .catch(() => {
          if (!cancelled) setSearchJobs([]);
        })
        .finally(() => {
          if (!cancelled) setSidebarLoading(false);
        });
    }, 350);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [query]);

  useEffect(() => {
    let cancelled = false;
    const transitionStartedAt = Date.now();
    const finishBatchPreparation = async () => {
      const remaining = MIN_BATCH_TRANSITION_MS - (Date.now() - transitionStartedAt);
      if (remaining > 0)
        await new Promise((resolve) => window.setTimeout(resolve, remaining));
    };
    const cached = batchCacheRef.current.get(batch);
    if (cached) {
      void (async () => {
        await preloadFrameSet(cached);
        await finishBatchPreparation();
        if (cancelled) return;
        const index =
          batchTargetIndexRef.current === null
            ? batchEdgeRef.current === "last"
              ? Math.max(0, cached.frames.length - 1)
              : 0
            : Math.min(
                batchTargetIndexRef.current,
                Math.max(0, cached.frames.length - 1),
              );
        setDetail(cached);
        setReviewedFrameNumbers((current) =>
          mergeFrameNumbers(current, cached.reviewed_frames),
        );
        applyFrame(index, cached);
        batchEdgeRef.current = "first";
        batchTargetIndexRef.current = null;
        setPreparingBatch(false);
        setLoading(false);
      })();
      return () => {
        cancelled = true;
      };
    }
    api<JobDetail>(
      `/v1/jobs/${job.id}?batch=${batch}&size=${job.preferred_batch_size ?? 20}`,
    )
      .then(async (result) => {
        await preloadFrameSet(result);
        await finishBatchPreparation();
        if (!cancelled) {
          const index =
            batchTargetIndexRef.current === null
              ? batchEdgeRef.current === "last"
                ? Math.max(0, result.frames.length - 1)
                : 0
              : Math.min(
                  batchTargetIndexRef.current,
                  Math.max(0, result.frames.length - 1),
                );
          batchCacheRef.current.set(result.batch, result);
          setDetail(result);
          setReviewedFrameNumbers((current) =>
            mergeFrameNumbers(current, result.reviewed_frames),
          );
          applyFrame(index, result);
          batchEdgeRef.current = "first";
          batchTargetIndexRef.current = null;
          setPreparingBatch(false);
        }
      })
      .catch((caught) => {
        if (!cancelled) {
          setPreparingBatch(false);
          setImageLoading(false);
          setError(
            caught instanceof Error
              ? caught.message
              : "Could not load this job",
          );
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // Batch and job identity intentionally control this request lifecycle.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [batch, job.id]);

  useEffect(() => {
    if (!detail) return;
    const generation = preloadGenerationRef.current;
    void preloadFrameSet(detail);

    const batches =
      detail.total_frames <= FULL_JOB_PRELOAD_LIMIT
        ? Array.from({ length: detail.total_batches }, (_, index) => index)
        : [detail.batch - 1, detail.batch + 1];
    batches
      .filter((targetBatch) => targetBatch !== detail.batch)
      .forEach((targetBatch) => {
        void warmBatch(targetBatch, detail, generation);
      });
    // Re-warm only when the active server batch changes, not on UI state renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail?.batch, detail?.job_id, detail?.source_etag]);

  useEffect(() => {
    let cancelled = false;
    api<JobsPage>("/v1/jobs?range=all&limit=25")
      .then((result) => {
        if (!cancelled) {
          setQueueJobs(result.jobs);
          setQueueCursor(result.next_continuation_token);
        }
      })
      .finally(() => {
        if (!cancelled) setQueueLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function loadMoreJobs() {
    if (!queueCursor || queueLoading) return;
    setQueueLoading(true);
    try {
      const result = await api<JobsPage>(
        `/v1/jobs?range=all&limit=25&continuation_token=${encodeURIComponent(queueCursor)}`,
      );
      setQueueJobs((current) => [
        ...current,
        ...result.jobs.filter(
          (candidate) => !current.some((item) => item.id === candidate.id),
        ),
      ]);
      setQueueCursor(result.next_continuation_token);
    } finally {
      setQueueLoading(false);
    }
  }

  useEffect(() => {
    const updateThumbnailCount = () =>
      setVisibleThumbnailCount(
        window.innerWidth <= 620 ? 3 : window.innerWidth <= 1180 ? 5 : 7,
      );
    updateThumbnailCount();
    window.addEventListener("resize", updateThumbnailCount);
    return () => window.removeEventListener("resize", updateThumbnailCount);
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.target instanceof HTMLInputElement ||
        event.target instanceof HTMLSelectElement
      )
        return;
      if (event.key === "ArrowRight") goRelativeFrame(1);
      if (event.key === "ArrowLeft") goRelativeFrame(-1);
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void saveChanges();
      }
      if ((event.key === "Delete" || event.key === "Backspace") && selectedId)
        removeSelected();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (!dirty) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [dirty]);

  useEffect(() => {
    const marker = `retrain-review-${job.id}`;
    historyMarkerRef.current = marker;
    const state = window.history.state as { retrainReview?: string } | null;
    if (state?.retrainReview)
      window.history.replaceState(
        { ...state, retrainReview: marker },
        "",
        window.location.href,
      );
    else
      window.history.pushState(
        { ...state, retrainReview: marker },
        "",
        window.location.href,
      );
    historyEntryActiveRef.current = true;
  }, [job.id]);

  useEffect(() => {
    const onPopState = () => {
      if (allowHistoryBackRef.current) {
        allowHistoryBackRef.current = false;
        historyEntryActiveRef.current = false;
        onBack();
        return;
      }
      historyEntryActiveRef.current = false;
      if (!dirty) {
        onBack();
        return;
      }
      window.history.pushState(
        {
          ...(window.history.state ?? {}),
          retrainReview: historyMarkerRef.current,
        },
        "",
        window.location.href,
      );
      historyEntryActiveRef.current = true;
      stageCurrentFrame();
      setPendingNavigation({ run: returnToJobs });
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  });

  function markDirty(modelId: string) {
    setDirtyModels((current) => new Set(current).add(modelId));
    setSaved(false);
  }

  function toggleModel(id: string) {
    setModels((items) =>
      items.map((item) => {
        if (item.id !== id) return item;
        visibilityRef.current[id] = !item.visible;
        return { ...item, visible: !item.visible };
      }),
    );
  }

  function showAllModels() {
    models.forEach((model) => {
      visibilityRef.current[model.id] = true;
    });
    setModels((items) => items.map((item) => ({ ...item, visible: true })));
  }

  function updateSelected(patch: Partial<Annotation>) {
    if (!selected) return;
    setAnnotations((items) =>
      items.map((item) =>
        item.id === selected.id ? { ...item, ...patch } : item,
      ),
    );
    markDirty(selected.model_id);
  }

  function removeSelected() {
    if (!selected) return;
    setAnnotations((items) => items.filter((item) => item.id !== selected.id));
    setModels((items) =>
      items.map((item) =>
        item.id === selected.model_id
          ? {
              ...item,
              count: Math.max(0, item.count - 1),
              people_count:
                item.kind === "people"
                  ? Math.max(
                      Math.max(0, item.count - 1),
                      Math.max(0, (item.people_count ?? item.count) - 1),
                    )
                  : item.people_count,
            }
          : item,
      ),
    );
    markDirty(selected.model_id);
    setSelectedId("");
  }

  function removeModelAnnotations(modelId: string) {
    setAnnotations((items) =>
      items.filter((item) => item.model_id !== modelId),
    );
    setModels((items) =>
      items.map((item) =>
        item.id === modelId
          ? {
              ...item,
              count: 0,
              people_count: item.kind === "people" ? 0 : item.people_count,
            }
          : item,
      ),
    );
    if (selected?.model_id === modelId) setSelectedId("");
    markDirty(modelId);
  }

  function addAnnotation() {
    if (!activeLayer || activeLayer.kind === "segment" || !currentFrame) return;
    const label = activeLayer.classes[0] ?? "detection";
    const annotation: Annotation = {
      id: `${activeLayer.id}-${Date.now()}`,
      model_id: activeLayer.id,
      class_id: 0,
      label,
      confidence: 1,
      x: 38,
      y: 30,
      width: 18,
      height: 28,
      manual: true,
    };
    setAnnotations((items) => [...items, annotation]);
    setModels((items) =>
      items.map((item) =>
        item.id === activeLayer.id
          ? {
              ...item,
              count: item.count + 1,
              people_count:
                item.kind === "people"
                  ? Math.max(item.people_count ?? item.count, item.count + 1)
                  : item.people_count,
            }
          : item,
      ),
    );
    setSelectedId(annotation.id);
    markDirty(activeLayer.id);
  }

  function beginDrag(
    event: ReactPointerEvent,
    annotation: Annotation,
    mode: DragMode,
  ) {
    const bounds = stageRef.current?.getBoundingClientRect();
    if (!bounds) return;
    event.preventDefault();
    event.stopPropagation();
    setSelectedId(annotation.id);
    setActiveModel(annotation.model_id);
    const startX = event.clientX;
    const startY = event.clientY;
    let changed = false;
    const original = {
      x: annotation.x,
      y: annotation.y,
      width: annotation.width,
      height: annotation.height,
    };
    const move = (pointer: PointerEvent) => {
      const dx = ((pointer.clientX - startX) / bounds.width) * 100;
      const dy = ((pointer.clientY - startY) / bounds.height) * 100;
      if (!changed && Math.abs(dx) + Math.abs(dy) > 0.05) {
        changed = true;
        markDirty(annotation.model_id);
      }
      if (!changed) return;
      let { x, y, width, height } = original;
      if (mode === "move") {
        x = clamp(original.x + dx, 0, 100 - original.width);
        y = clamp(original.y + dy, 0, 100 - original.height);
      } else {
        if (mode.includes("e"))
          width = clamp(original.width + dx, 1, 100 - original.x);
        if (mode.includes("s"))
          height = clamp(original.height + dy, 1, 100 - original.y);
        if (mode.includes("w")) {
          x = clamp(original.x + dx, 0, original.x + original.width - 1);
          width = original.width + original.x - x;
        }
        if (mode.includes("n")) {
          y = clamp(original.y + dy, 0, original.y + original.height - 1);
          height = original.height + original.y - y;
        }
      }
      setAnnotations((items) =>
        items.map((item) =>
          item.id === annotation.id
            ? { ...item, x, y, width, height, manual: true }
            : item,
        ),
      );
    };
    const stop = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop, { once: true });
  }

  function goToFrame(index: number) {
    if (!detail || index === currentFrameIndex) return;
    stageCurrentFrame();
    applyFrame(index, detail);
  }

  function goRelativeFrame(direction: -1 | 1) {
    if (!detail || loading) return;
    if (frameFilter === "corrected") {
      const target = adjacentFrame(
        reviewedFrameNumbers,
        currentFrame?.frame_number ?? -1,
        direction,
      );
      if (target !== null) goToSampledFrame(target);
      return;
    }
    const next = currentFrameIndex + direction;
    if (next >= 0 && next < detail.frames.length) {
      goToFrame(next);
      return;
    }
    if (direction === 1 && batch < detail.total_batches - 1) {
      batchEdgeRef.current = "first";
      goToBatch(batch + 1);
    } else if (direction === -1 && batch > 0) {
      batchEdgeRef.current = "last";
      goToBatch(batch - 1);
    }
  }

  function jumpToRequestedFrame() {
    if (!detail) return;
    const requested = Number(jumpFrame);
    if (
      !Number.isFinite(requested) ||
      requested < 0 ||
      requested >= detail.metadata.frame_count
    ) {
      setError(
        `Enter a frame between 0 and ${Math.max(0, detail.metadata.frame_count - 1)}`,
      );
      return;
    }
    goToSampledFrame(requested);
    setJumpFrame("");
  }

  function goToSampledFrame(requested: number, stageCurrent = true) {
    if (!detail) return;
    if (stageCurrent) stageCurrentFrame();
    const interval = Math.max(1, detail.sample_interval || 15);
    const sampled = Math.round(requested / interval) * interval;
    const targetBatch = Math.floor(sampled / interval / detail.batch_size);
    const targetIndex = Math.floor(sampled / interval) % detail.batch_size;
    if (targetBatch === batch)
      applyFrame(Math.min(targetIndex, detail.frames.length - 1), detail);
    else {
      batchEdgeRef.current = "first";
      batchTargetIndexRef.current = targetIndex;
      setPreparingBatch(true);
      setImageLoading(true);
      setLoading(true);
      setBatch(targetBatch);
    }
  }

  function goToNextReviewedFrame() {
    if (!reviewedFrameNumbers.length || !currentFrame) return;
    const target =
      reviewedFrameNumbers.find(
        (frame) => frame > currentFrame.frame_number,
      ) ?? reviewedFrameNumbers[0];
    goToSampledFrame(target);
  }

  function changeFrameFilter(nextFilter: FrameFilter) {
    if (nextFilter === frameFilter) return;
    stageCurrentFrame();
    setFrameFilter(nextFilter);
    if (
      nextFilter === "corrected" &&
      reviewedFrameNumbers.length > 0 &&
      (!currentFrame ||
        !reviewedFrameNumbers.includes(currentFrame.frame_number))
    ) {
      goToSampledFrame(reviewedFrameNumbers[0], false);
    }
  }

  function resetChanges() {
    if (!detail || !currentFrame) return;
    const resetFrameNumber = currentFrame.frame_number;
    const nextDrafts = { ...draftsRef.current };
    delete nextDrafts[String(resetFrameNumber)];
    draftsRef.current = nextDrafts;
    setDrafts(nextDrafts);
    applyFrame(currentFrameIndex, detail, false, false);
  }

  function currentDraft(): FrameDraft | null {
    if (!currentFrame || !currentDirty) return null;
    return {
      annotations: annotations.map((item) => ({ ...item })),
      dirtyModels: [...dirtyModels],
      peopleCounts: Object.fromEntries(
        models
          .filter((model) => model.kind === "people")
          .map((model) => [
            model.id,
            model.people_count ??
              annotations.filter((item) => item.model_id === model.id).length,
          ]),
      ),
      segments: activeSegments.map((segment) => ({ ...segment })),
    };
  }

  function stageCurrentFrame() {
    const draft = currentDraft();
    if (!currentFrame || !draft) return;
    const nextDrafts = {
      ...draftsRef.current,
      [String(currentFrame.frame_number)]: draft,
    };
    draftsRef.current = nextDrafts;
    setDrafts(nextDrafts);
  }

  function requestNavigation(run: () => void) {
    if (!dirty) {
      run();
      return;
    }
    stageCurrentFrame();
    setPendingNavigation({ run });
  }

  function returnToJobs() {
    if (!historyEntryActiveRef.current) {
      onBack();
      return;
    }
    allowHistoryBackRef.current = true;
    window.history.back();
  }

  function discardAndLeave() {
    const run = pendingNavigation?.run;
    draftsRef.current = {};
    setDrafts({});
    setDirtyModels(new Set());
    setPendingNavigation(null);
    run?.();
  }

  function goToBatch(nextBatch: number) {
    if (
      !detail ||
      nextBatch < 0 ||
      nextBatch >= detail.total_batches ||
      nextBatch === batch
    )
      return;
    stageCurrentFrame();
    setPreparingBatch(true);
    setImageLoading(true);
    setLoading(true);
    setBatch(nextBatch);
  }

  async function saveChanges(afterSave?: () => void) {
    if (!currentFrame || !dirty) return;
    const current = currentDraft();
    const pendingDrafts = {
      ...draftsRef.current,
      ...(current ? { [String(currentFrame.frame_number)]: current } : {}),
    };
    setLoading(true);
    setError("");
    try {
      const frames = Object.entries(pendingDrafts).map(
        ([frameNumber, draft]) => ({
          frame_number: Number(frameNumber),
          corrections: draft.dirtyModels.map((modelId) => {
            const model =
              models.find((candidate) => candidate.id === modelId) ??
              currentFrame.models.find((candidate) => candidate.id === modelId);
            return {
              model_id: modelId,
              annotations: draft.annotations
                .filter((item) => item.model_id === modelId)
                .map((item) => ({
                  id: item.id,
                  class_id: item.class_id,
                  label: item.label,
                  confidence: item.confidence,
                  x: item.x,
                  y: item.y,
                  width: item.width,
                  height: item.height,
                  track_id: item.track_id,
                  attributes: item.attributes,
                })),
              people_count:
                model?.kind === "people"
                  ? draft.peopleCounts[modelId]
                  : undefined,
              segments:
                model?.kind === "segment" || modelId.includes("aggression")
                  ? draft.segments
                  : undefined,
              segment:
                model?.kind === "segment" || modelId.includes("aggression")
                  ? (draft.segments[0] ?? null)
                  : undefined,
            };
          }),
        }),
      );
      const result = await api<BatchSaveResult>(
        `/v1/jobs/${job.id}/corrections`,
        {
          method: "PUT",
          body: JSON.stringify({ source_etag: detail?.source_etag, frames }),
        },
      );
      const successfulFrames = new Set(
        result.results
          .filter((item) => item.saved)
          .map((item) => item.frame_number),
      );
      const nextReviewedFrames = mergeFrameNumbers(
        reviewedFrameNumbers,
        successfulFrames,
      );
      setReviewedFrameNumbers(nextReviewedFrames);
      const failedDrafts = Object.fromEntries(
        Object.entries(pendingDrafts).filter(
          ([frameNumber]) => !successfulFrames.has(Number(frameNumber)),
        ),
      );
      const nextDetail = detail
        ? {
            ...detail,
            reviewed_frames: [
              ...nextReviewedFrames,
            ],
            frames: detail.frames.map((frame) => {
              const draft = pendingDrafts[String(frame.frame_number)];
              if (!draft || !successfulFrames.has(frame.frame_number))
                return frame;
              return {
                ...frame,
                reviewed: true,
                corrected_models: [
                  ...new Set([
                    ...(frame.corrected_models ?? []),
                    ...draft.dirtyModels,
                  ]),
                ],
                models: frame.models.map((model) => {
                  if (!draft.dirtyModels.includes(model.id)) return model;
                  if (model.kind === "segment")
                    return {
                      ...model,
                      count: draft.segments.length,
                      segments: draft.segments,
                      segment: draft.segments[0] ?? null,
                    };
                  const modelAnnotations = draft.annotations.filter(
                    (item) => item.model_id === model.id,
                  );
                  return {
                    ...model,
                    annotations: modelAnnotations,
                    count: modelAnnotations.length,
                    people_count:
                      model.kind === "people"
                        ? (draft.peopleCounts[model.id] ??
                          modelAnnotations.length)
                        : model.people_count,
                  };
                }),
              };
            }),
          }
        : null;
      draftsRef.current = failedDrafts;
      setDrafts(failedDrafts);
      if (nextDetail) {
        batchCacheRef.current.clear();
        batchCacheRef.current.set(nextDetail.batch, nextDetail);
        setDetail(nextDetail);
        const currentFailed = failedDrafts[String(currentFrame.frame_number)];
        if (currentFailed)
          applyFrame(currentFrameIndex, nextDetail, false, true);
        else applyFrame(currentFrameIndex, nextDetail, false, false);
      }
      setSaved(result.saved_count > 0);
      if (result.failed_count)
        setError(
          `${result.saved_count} frame(s) saved; ${result.failed_count} failed and remain ready to retry.`,
        );
      window.setTimeout(() => setSaved(false), 3000);
      if (!result.failed_count) {
        setPendingNavigation(null);
        afterSave?.();
      }
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Could not save corrections",
      );
    } finally {
      setLoading(false);
    }
  }

  if (loading && !detail)
    return (
      <main className="review-loading-shell">
        <header className="home-topbar">
          <div className="brand">
            <div className="brand-mark">
              <Sparkles size={18} />
            </div>
            <div>
              <strong>Retrain Studio</strong>
              <span>Video intelligence review</span>
            </div>
          </div>
          <div className="topbar-status">
            <ConnectionState health={health} />
          </div>
        </header>
        <section className="review-loader-stage">
          <div className="review-loader-card">
            <span className="loader-orbit">
              <LoaderCircle className="spin" size={30} />
            </span>
            <p className="eyebrow">Preparing annotation workspace</p>
            <h1>Loading the selected video job</h1>
            <p>
              The source video is downloaded once and the requested frame
              batch is prepared for smooth review.
            </p>
            <div className="loader-job">
              <Cloud size={15} />
              <span>{job.id}</span>
            </div>
            <div className="loader-progress">
              <i />
            </div>
          </div>
        </section>
      </main>
    );

  return (
    <main className="dashboard-shell">
      <header className="topbar">
        <div className="brand">
          <button
            className="icon-button mobile-menu"
            aria-label="Open jobs"
            onClick={() => setMobileJobs(true)}
          >
            <Menu size={19} />
          </button>
          <div className="brand-mark">
            <Sparkles size={18} />
          </div>
          <div>
            <strong>Retrain Studio</strong>
            <span>Video intelligence review</span>
          </div>
        </div>
        <div className="topbar-status">
          <ConnectionState health={health} />
          <div className="reviewer" aria-label="Current reviewer">
            <div className="avatar" aria-hidden="true">PD</div>
            <div>
              <strong>Priyansh</strong>
              <span>Reviewer</span>
            </div>
          </div>
        </div>
      </header>
      <aside className={`jobs-panel ${mobileJobs ? "jobs-panel-open" : ""}`}>
        <div className="mobile-panel-title">
          <strong>Choose a job</strong>
          <button
            className="icon-button"
            onClick={() => setMobileJobs(false)}
            aria-label="Close jobs"
          >
            <X size={18} />
          </button>
        </div>
        <div className="jobs-heading">
          <div>
            <p className="eyebrow">Live queue</p>
            <h1>Video jobs</h1>
          </div>
          <span className="count-pill">
            {sidebarLoading ? "…" : filteredJobs.length}
          </span>
        </div>
        <div className="sidebar-search-row">
          <label className="search-field">
            <Search size={16} />
            <input
              value={query}
              onChange={(event) => {
                const value = event.target.value;
                setQuery(value);
                setSidebarLoading(Boolean(value.trim()));
                if (!value.trim()) setSearchJobs([]);
              }}
              placeholder="Search exact job ID"
              aria-label="Search exact job ID"
            />
            {sidebarLoading && (
              <LoaderCircle className="spin search-loader" size={15} />
            )}
          </label>
          <div className="sidebar-filter-wrap">
            <button
              className={`square-button ${jobFilter !== "all" ? "square-button-active" : ""}`}
              aria-label="Filter jobs"
              aria-expanded={filterOpen}
              onClick={() => setFilterOpen((open) => !open)}
            >
              <Filter size={16} />
            </button>
            {filterOpen && (
              <div className="sidebar-filter-menu" role="menu">
                <button
                  className={jobFilter === "all" ? "active" : ""}
                  onClick={() => {
                    setJobFilter("all");
                    setFilterOpen(false);
                  }}
                >
                  All jobs
                </button>
                <button
                  className={jobFilter === "reviewable" ? "active" : ""}
                  onClick={() => {
                    setJobFilter("reviewable");
                    setFilterOpen(false);
                  }}
                >
                  Reviewable
                </button>
                <button
                  className={jobFilter === "unavailable" ? "active" : ""}
                  onClick={() => {
                    setJobFilter("unavailable");
                    setFilterOpen(false);
                  }}
                >
                  Unavailable
                </button>
              </div>
            )}
          </div>
        </div>
        <div className="job-list">
          {sidebarLoading ? (
            <div className="sidebar-jobs-loading">
              <LoaderCircle className="spin" size={22} />
              <strong>Searching S3 jobs</strong>
            </div>
          ) : filteredJobs.length ? (
            filteredJobs.map((item) => (
              <button
                key={item.id}
                className={`job-card ${item.id === job.id ? "job-card-active" : ""}`}
                onClick={() => {
                  setMobileJobs(false);
                  if (item.id !== job.id)
                    requestNavigation(() => onSelectJob(item));
                }}
              >
                <div className="job-card-top">
                  <span className="job-id">{item.id}</span>
                  {item.id === job.id ? (
                    <span className="current-job-pill">Current</span>
                  ) : (
                    <MoreHorizontal size={17} />
                  )}
                </div>
                <div className="job-meta">
                  <span>
                    <Clock3 size={13} />
                    {item.time}
                  </span>
                  <span>
                    <Layers3 size={13} />
                    {item.successful_models}/{item.models} models
                  </span>
                </div>
                <div className="job-card-bottom">
                  <span>{item.status}</span>
                  <span
                    className={`signals ${!item.successful_models ? "signals-unavailable" : ""}`}
                  >
                    {item.successful_models
                      ? `${item.signal} detections`
                      : item.source_available
                        ? "Manual review"
                        : "Source unavailable"}
                  </span>
                </div>
              </button>
            ))
          ) : (
            <div className="sidebar-empty">
              <Search size={20} />
              <strong>No matching jobs</strong>
              <span>Try another job ID or filter.</span>
            </div>
          )}
        </div>
        <div className="pagination">
          <span>
            {queueLoading ? "Loading…" : `${filteredJobs.length} loaded`}
          </span>
          <button
            onClick={() => void loadMoreJobs()}
            disabled={!queueCursor || queueLoading || Boolean(query.trim())}
          >
            {queueCursor ? "Load more" : "All loaded"}
            <ChevronRight size={14} />
          </button>
        </div>
      </aside>
      <section className="workspace">
        <div className="workspace-header">
          <div>
            <div className="breadcrumbs">
              <button
                className="breadcrumb-back"
                onClick={() => requestNavigation(returnToJobs)}
              >
                <ChevronLeft size={13} />
                All jobs
              </button>
              <ChevronRight size={13} />
              <span>{job.id}</span>
            </div>
            <div className="title-line">
              <h2>Annotation workspace</h2>
              <span className="source-chip">
                <Cloud size={13} /> Live S3 data
              </span>
            </div>
          </div>
          <div className="header-actions">
            <button
              className="secondary-button"
              onClick={resetChanges}
              disabled={!currentDirty || loading}
            >
              <RotateCcw size={16} />
              Reset frame
            </button>
            <button
              className="primary-button"
              onClick={() => void saveChanges()}
              disabled={!dirty || loading}
            >
              <Save size={16} />
              {loading
                ? "Saving…"
                : dirty
                  ? `Save ${pendingFrameNumbers.size} frame${pendingFrameNumbers.size === 1 ? "" : "s"}`
                  : "Save corrections"}
            </button>
          </div>
        </div>
        {error && (
          <div className="workspace-error">
            <AlertTriangle size={16} />
            {error}
          </div>
        )}
        <div className="job-overview">
          <div className="overview-item">
            <span>JOB</span>
            <strong>{job.id}</strong>
          </div>
          <div className="overview-item">
            <span>RESULT</span>
            <strong>
              {detail?.status} · {job.successful_models}/{job.models} models
            </strong>
          </div>
          <div className="overview-item">
            <span>SOURCE</span>
            <strong>{detail?.source_key}</strong>
          </div>
          <div className="overview-item">
            <span>FRAME SET</span>
            <strong>{detail?.total_frames ?? 0} sampled frames</strong>
          </div>
        </div>
        <div className="review-layout">
          <div className="canvas-column">
            <div className="canvas-toolbar">
              <div className="frame-title">
                <span>
                  Frame {currentFrame?.frame_number ?? "—"}
                  {currentFrameSaved && (
                    <i className="reviewed-frame-pill">
                      <Check size={11} />
                      Reviewer corrected
                    </i>
                  )}
                </span>
                <small>
                  {((currentFrame?.timestamp_ms ?? 0) / 1000).toFixed(2)}s ·{" "}
                  {detail?.metadata.width} × {detail?.metadata.height}
                </small>
              </div>
              <div className="tool-group">
                <button
                  className="tool-button tool-button-active"
                  aria-label="Select annotation"
                >
                  <MousePointer2 size={16} />
                </button>
                <button
                  className="tool-button"
                  onClick={addAnnotation}
                  disabled={activeLayer?.kind === "segment"}
                  aria-label="Add bounding box"
                >
                  <Box size={16} />
                </button>
                <button
                  className="zoom-label"
                  onClick={() =>
                    setFitMode((value) =>
                      value === "contain" ? "cover" : "contain",
                    )
                  }
                  aria-label="Toggle frame fit"
                >
                  {fitMode === "contain" ? "Fit" : "Fill"}
                </button>
              </div>
            </div>
            <div className="video-stage-wrap">
              <div
                ref={stageRef}
                className={`video-stage video-stage-${fitMode}`}
                aria-label="Annotation canvas"
              >
                {imageUrl && (
                  <Image
                    key={imageUrl}
                    src={imageUrl}
                    alt={`Frame ${currentFrame?.frame_number} from ${job.id}`}
                    fill
                    unoptimized
                    priority
                    sizes="(max-width: 900px) 100vw, 70vw"
                    onLoad={() => {
                      if (detail && currentFrame) {
                        loadedFrameImagesRef.current.add(
                          frameImageKey(detail, currentFrame.frame_number),
                        );
                      }
                      setImageLoading(false);
                    }}
                    onError={() => {
                      setImageLoading(false);
                      setError("The extracted frame image could not be loaded");
                    }}
                  />
                )}
                {imageLoading && currentFrame && imageUrl && (
                  <div className="frame-loading-overlay">
                    <LoaderCircle className="spin" size={25} />
                    <strong>
                      {preparingBatch
                        ? "Preparing all frames in this batch"
                        : "Preparing this frame"}
                    </strong>
                  </div>
                )}
                {!imageLoading && !currentFrame && (
                  <div className="frame-unavailable-overlay">
                    <AlertTriangle size={25} />
                    <strong>Source frames are unavailable</strong>
                    <span>
                      This job has no resolvable source video. A source must be
                      attached before manual annotations can be created.
                    </span>
                  </div>
                )}
                <div className="camera-label">
                  <span className="live-dot" /> {job.id}
                </div>
                <div className="frame-badge">
                  FRAME{" "}
                  {String(currentFrame?.frame_number ?? 0).padStart(6, "0")}
                </div>
                {!imageLoading &&
                  annotations
                    .filter((item) => visibleModelIds.has(item.model_id))
                    .map((annotation) => {
                      const model = models.find(
                        (item) => item.id === annotation.model_id,
                      );
                      if (!model) return null;
                      return (
                        <button
                          key={annotation.id}
                          className={`annotation-box ${selectedId === annotation.id ? "annotation-selected" : ""}`}
                          style={{
                            left: `${annotation.x}%`,
                            top: `${annotation.y}%`,
                            width: `${annotation.width}%`,
                            height: `${annotation.height}%`,
                            borderColor: model.color,
                            color: model.color,
                          }}
                          onPointerDown={(event) =>
                            beginDrag(event, annotation, "move")
                          }
                          onClick={(event) => {
                            event.stopPropagation();
                            setSelectedId(annotation.id);
                            setActiveModel(annotation.model_id);
                          }}
                          aria-label={`${model.name}: ${annotation.label}`}
                        >
                          <span
                            className="annotation-label"
                            style={{ background: model.color }}
                          >
                            {model.short} · {annotation.label}
                            {model.kind === "group" &&
                            peopleInGroup(annotation) !== null
                              ? ` · ${peopleInGroup(annotation)} people`
                              : ""}{" "}
                            <b>{Math.round(annotation.confidence * 100)}%</b>
                          </span>
                          {selectedId === annotation.id && (
                            <>
                              <i
                                className="handle handle-nw"
                                onPointerDown={(event) =>
                                  beginDrag(event, annotation, "nw")
                                }
                              />
                              <i
                                className="handle handle-ne"
                                onPointerDown={(event) =>
                                  beginDrag(event, annotation, "ne")
                                }
                              />
                              <i
                                className="handle handle-sw"
                                onPointerDown={(event) =>
                                  beginDrag(event, annotation, "sw")
                                }
                              />
                              <i
                                className="handle handle-se"
                                onPointerDown={(event) =>
                                  beginDrag(event, annotation, "se")
                                }
                              />
                            </>
                          )}
                        </button>
                      );
                    })}
              </div>
              <div className="extraction-note">
                <Cloud size={15} />
                <span>
                  <strong>Batch cached.</strong> This frame came from{" "}
                  <code>{detail?.source_key}</code>; saved corrections reuse the
                  clean S3 frame.
                </span>
              </div>
            </div>
            <div className="frame-filter-bar">
              <div className="frame-filter-copy">
                <strong>Frame view</strong>
                <small>Limit the filmstrip to frames saved by a reviewer.</small>
              </div>
              <div
                className="frame-filter-tabs"
                role="group"
                aria-label="Choose frames to display"
              >
                <button
                  type="button"
                  className={frameFilter === "all" ? "active" : ""}
                  onClick={() => changeFrameFilter("all")}
                  aria-pressed={frameFilter === "all"}
                >
                  <Layers3 size={14} />
                  <span>All frames</span>
                  <em>{detail?.total_frames ?? 0}</em>
                </button>
                <button
                  type="button"
                  className={frameFilter === "corrected" ? "active" : ""}
                  onClick={() => changeFrameFilter("corrected")}
                  aria-pressed={frameFilter === "corrected"}
                  title="Show only frames with saved reviewer corrections"
                >
                  <Check size={14} />
                  <span>Corrected only</span>
                  <em>{reviewedFrameNumbers.length}</em>
                </button>
              </div>
            </div>
            <div className="frame-strip">
              <button
                className="strip-nav"
                onClick={() => goRelativeFrame(-1)}
                disabled={
                  frameFilter === "corrected"
                    ? currentCorrectedIndex <= 0
                    : currentFrameIndex === 0 && batch === 0
                }
                aria-label="Previous frame"
              >
                <ArrowLeft size={17} />
              </button>
              <div className="frame-thumbnails">
                {frameFilter === "all" ? (
                  visibleFrames.map((frame, offset) => {
                    const index = thumbnailWindowStart + offset;
                    const unsaved = pendingFrameNumbers.has(frame.frame_number);
                    const saved =
                      reviewedFrameSet.has(frame.frame_number) || frame.reviewed;
                    return (
                      <button
                        key={frame.frame_number}
                        className={`frame-thumb ${index === currentFrameIndex ? "frame-thumb-active" : ""} ${unsaved ? "frame-thumb-draft" : ""} ${saved ? "frame-thumb-reviewed" : ""}`}
                        onClick={() => goToFrame(index)}
                        title={
                          unsaved
                            ? saved
                              ? "Unsaved edits on a previously saved frame"
                              : "Unsaved correction"
                            : saved
                              ? `Reviewer corrected: ${frame.corrected_models.join(", ") || "saved changes"}`
                              : `Frame ${frame.frame_number}`
                        }
                      >
                        <span className="mini-scene mini-scene-ready">
                          {detail ? (
                            <Image
                              src={frameImageUrl(detail, frame.frame_number)}
                              alt={`Frame ${frame.frame_number} preview`}
                              fill
                              sizes="120px"
                              unoptimized
                            />
                          ) : (
                            <Cloud size={12} />
                          )}
                        </span>
                        <strong>{frame.frame_number}</strong>
                        <small>{(frame.timestamp_ms / 1000).toFixed(1)}s</small>
                        {unsaved ? (
                          <span className="draft-dot" title="Unsaved correction" />
                        ) : saved ? (
                          <span className="reviewed-dot" title="Saved reviewer correction">
                            <Check size={9} />
                          </span>
                        ) : (
                          frame.models.some((model) => model.count) && <i />
                        )}
                      </button>
                    );
                  })
                ) : visibleCorrectedFrames.length ? (
                  visibleCorrectedFrames.map((frameNumber) => {
                    const unsaved = pendingFrameNumbers.has(frameNumber);
                    const saved = reviewedFrameSet.has(frameNumber);
                    return (
                      <button
                        key={frameNumber}
                        className={`frame-thumb ${currentFrame?.frame_number === frameNumber ? "frame-thumb-active" : ""} ${unsaved ? "frame-thumb-draft" : ""} ${saved ? "frame-thumb-reviewed" : ""}`}
                        onClick={() => goToSampledFrame(frameNumber)}
                        title={
                          unsaved
                            ? saved
                              ? "Unsaved edits on a previously saved frame"
                              : "Unsaved correction"
                            : "Saved reviewer correction"
                        }
                      >
                        <span className="mini-scene mini-scene-ready">
                          {detail ? (
                            <Image
                              src={frameImageUrl(detail, frameNumber)}
                              alt={`Corrected frame ${frameNumber} preview`}
                              fill
                              sizes="120px"
                              unoptimized
                            />
                          ) : (
                            <Cloud size={12} />
                          )}
                        </span>
                        <strong>{frameNumber}</strong>
                        <small>
                          {(frameNumber / Math.max(detail?.metadata.fps ?? 1, 1)).toFixed(1)}s
                        </small>
                        {unsaved ? (
                          <span className="draft-dot" title="Unsaved correction" />
                        ) : (
                          <span className="reviewed-dot" title="Saved reviewer correction">
                            <Check size={9} />
                          </span>
                        )}
                      </button>
                    );
                  })
                ) : (
                  <div className="corrected-frames-empty">
                    <Check size={15} />
                    <span>
                      <strong>No corrected frames yet</strong>
                      Save a correction first, or return to all frames.
                    </span>
                  </div>
                )}
              </div>
              <button
                className="strip-nav"
                onClick={() => goRelativeFrame(1)}
                disabled={
                  frameFilter === "corrected"
                    ? currentCorrectedIndex < 0 ||
                      currentCorrectedIndex >= reviewedFrameNumbers.length - 1
                    : currentFrameIndex >= (detail?.frames.length ?? 1) - 1 &&
                      batch >= (detail?.total_batches ?? 1) - 1
                }
                aria-label="Next frame"
              >
                <ArrowRight size={17} />
              </button>
            </div>
            <div className="batch-footer">
              <span>
                {frameFilter === "corrected"
                  ? "Corrected frames"
                  : `Batch ${(detail?.batch ?? 0) + 1} of ${detail?.total_batches ?? 1}`}
              </span>
              <div className="batch-progress">
                <i
                  style={{
                    width:
                      frameFilter === "corrected"
                        ? `${((currentCorrectedIndex + 1) / Math.max(reviewedFrameNumbers.length, 1)) * 100}%`
                        : `${((currentFrameIndex + 1) / Math.max(detail?.frames.length ?? 1, 1)) * 100}%`,
                  }}
                />
              </div>
              <span>
                {frameFilter === "corrected"
                  ? `${Math.max(0, currentCorrectedIndex + 1)} / ${reviewedFrameNumbers.length}`
                  : `${currentFrameIndex + 1} / ${detail?.frames.length ?? 0}`}
              </span>
              <div className="batch-legend">
                <span>
                  <i className="legend-reviewed">
                    <Check size={8} />
                  </i>
                  Reviewer corrected
                </span>
                <span>
                  <i className="legend-unsaved" />
                  Unsaved
                </span>
              </div>
              {frameFilter === "all" && (
                <form
                  className="frame-jump"
                  onSubmit={(event) => {
                    event.preventDefault();
                    jumpToRequestedFrame();
                  }}
                >
                  <input
                    value={jumpFrame}
                    onChange={(event) => setJumpFrame(event.target.value)}
                    inputMode="numeric"
                    placeholder="Frame #"
                    aria-label="Jump to sampled frame"
                  />
                  <button type="submit" disabled={!jumpFrame}>
                    Go
                  </button>
                </form>
              )}
              <div className="shortcut-hint">
                {frameFilter === "corrected" ? (
                  <button onClick={() => changeFrameFilter("all")}>
                    Show all frames
                  </button>
                ) : detail && detail.total_batches > 1 ? (
                  <>
                    <button
                      onClick={() => goToBatch(Math.max(0, batch - 1))}
                      disabled={!batch}
                    >
                      Previous batch
                    </button>
                    <button
                      onClick={() =>
                        goToBatch(Math.min(detail.total_batches - 1, batch + 1))
                      }
                      disabled={batch >= detail.total_batches - 1}
                    >
                      Next batch
                    </button>
                  </>
                ) : null}
              </div>
            </div>
          </div>
          <aside className="inspector">
            <div className="inspector-tabs">
              <button
                className={inspectorTab === "annotations" ? "active" : ""}
                onClick={() => setInspectorTab("annotations")}
              >
                Annotations{" "}
                <span>
                  {models.reduce((sum, model) => sum + model.count, 0)}
                </span>
              </button>
              <button
                className={inspectorTab === "info" ? "active" : ""}
                onClick={() => setInspectorTab("info")}
              >
                Frame info
              </button>
            </div>
            {inspectorTab === "info" ? (
              <div className="frame-info-panel">
                <p className="eyebrow">Selected frame</p>
                <dl>
                  <div>
                    <dt>Frame</dt>
                    <dd>{currentFrame?.frame_number}</dd>
                  </div>
                  <div>
                    <dt>Timestamp</dt>
                    <dd>
                      {((currentFrame?.timestamp_ms ?? 0) / 1000).toFixed(2)}s
                    </dd>
                  </div>
                  <div>
                    <dt>Resolution</dt>
                    <dd>
                      {detail?.metadata.width} × {detail?.metadata.height}
                    </dd>
                  </div>
                  <div>
                    <dt>Review state</dt>
                    <dd>
                      {currentDirty
                        ? "Unsaved changes"
                        : currentFrameSaved
                          ? "Reviewer corrected"
                          : "Machine output"}
                    </dd>
                  </div>
                  <div>
                    <dt>Corrected models</dt>
                    <dd>
                      {currentFrame?.corrected_models.length
                        ? currentFrame.corrected_models.join(", ")
                        : "None"}
                    </dd>
                  </div>
                </dl>
                <button
                  className="add-button"
                  onClick={goToNextReviewedFrame}
                  disabled={!reviewedFrameNumbers.length}
                >
                  <Check size={15} />
                  Next reviewer-corrected frame
                </button>
              </div>
            ) : (
              <>
                <div className="model-section">
                  <div className="section-heading">
                    <div>
                      <p className="eyebrow">Live layers</p>
                      <h3>Model layers on this frame</h3>
                    </div>
                    <button className="text-button" onClick={showAllModels}>
                      Show all
                    </button>
                  </div>
                  <div className="model-list">
                    {models.map((model) => {
                      const layerAnnotations = annotations.filter(
                        (annotation) => annotation.model_id === model.id,
                      );
                      const groupedPeople = groupPeopleTotal(layerAnnotations);
                      const semanticSummary =
                        model.kind === "people"
                          ? `${model.people_count ?? layerAnnotations.length} ${(model.people_count ?? layerAnnotations.length) === 1 ? "person" : "people"}`
                          : model.kind === "group"
                            ? `${layerAnnotations.length} ${layerAnnotations.length === 1 ? "group" : "groups"} · ${groupedPeople ?? "—"} people`
                            : kindLabel(model.kind);
                      return (
                        <div
                          key={model.id}
                          className={`model-row ${activeModel === model.id ? "model-row-active" : ""}`}
                        >
                          <button
                            className="model-select"
                            onClick={() => setActiveModel(model.id)}
                          >
                            <span
                              className="model-dot"
                              style={{ background: model.color }}
                            />
                            <span className="model-copy">
                              <strong>{model.name}</strong>
                              <small>
                                {model.status === "SUCCESS"
                                  ? semanticSummary
                                  : `Manual only · ${semanticSummary}`}
                              </small>
                            </span>
                            <span className="model-count">
                              {model.kind === "segment"
                                ? activeSegments.length
                                : model.kind === "people"
                                  ? model.people_count ?? layerAnnotations.length
                                  : layerAnnotations.length}
                            </span>
                          </button>
                          <button
                            className="visibility"
                            onClick={() => toggleModel(model.id)}
                            aria-label={`${model.visible ? "Hide" : "Show"} ${model.name}`}
                          >
                            {model.visible ? (
                              <Eye size={16} />
                            ) : (
                              <EyeOff size={16} />
                            )}
                          </button>
                        </div>
                      );
                    })}
                  </div>
                </div>
                <div className="editor-section">
                  {!activeLayer ? (
                    <EmptyModelState
                      title="No model layers available"
                      description="This job does not identify any model that can receive a manual annotation."
                    />
                  ) : activeLayer.kind === "segment" ? (
                    <AggressionEditor
                      segments={activeSegments}
                      timestampMs={currentFrame?.timestamp_ms ?? 0}
                      onChange={(segments) => {
                        setActiveSegments(segments);
                        setModels((items) =>
                          items.map((item) =>
                            item.id === activeLayer.id
                              ? {
                                  ...item,
                                  segments,
                                  segment: segments[0] ?? null,
                                  count: segments.length,
                                }
                              : item,
                          ),
                        );
                        markDirty(activeLayer.id);
                      }}
                    />
                  ) : activeLayer.kind === "vehicle" ? (
                    <VehicleEditor
                      model={activeLayer}
                      selected={
                        selected?.model_id === activeLayer.id
                          ? selected
                          : annotations.find(
                              (item) => item.model_id === activeLayer.id,
                            )
                      }
                      onSelect={setSelectedId}
                      onUpdate={updateSelected}
                      onDelete={removeSelected}
                      onAdd={addAnnotation}
                      onRemoveAll={() => removeModelAnnotations(activeLayer.id)}
                    />
                  ) : activeLayer.kind === "group" ? (
                    <GroupEditor
                      model={activeLayer}
                      selected={
                        selected?.model_id === activeLayer.id
                          ? selected
                          : undefined
                      }
                      annotations={annotations.filter(
                        (item) => item.model_id === activeLayer.id,
                      )}
                      onSelect={setSelectedId}
                      onUpdate={updateSelected}
                      onDelete={removeSelected}
                      onAdd={addAnnotation}
                      onRemoveAll={() => removeModelAnnotations(activeLayer.id)}
                    />
                  ) : (
                    <BoxEditor
                      model={activeLayer}
                      selected={
                        selected?.model_id === activeLayer.id
                          ? selected
                          : undefined
                      }
                      annotations={annotations.filter(
                        (item) => item.model_id === activeLayer.id,
                      )}
                      onSelect={setSelectedId}
                      onUpdate={updateSelected}
                      onDelete={removeSelected}
                      onAdd={addAnnotation}
                      onRemoveAll={() => removeModelAnnotations(activeLayer.id)}
                      onPeopleCountChange={
                        activeLayer.kind === "people"
                          ? (peopleCount) => {
                              setModels((items) =>
                                items.map((item) =>
                                  item.id === activeLayer.id
                                    ? { ...item, people_count: peopleCount }
                                    : item,
                                ),
                              );
                              markDirty(activeLayer.id);
                            }
                          : undefined
                      }
                    />
                  )}
                </div>
              </>
            )}
          </aside>
        </div>
      </section>
      {mobileJobs && (
        <button
          className="mobile-backdrop"
          aria-label="Close jobs"
          onClick={() => setMobileJobs(false)}
        />
      )}
      {pendingNavigation && (
        <div className="unsaved-backdrop" role="presentation">
          <section
            className="unsaved-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="unsaved-title"
          >
            <button
              className="unsaved-close"
              onClick={() => setPendingNavigation(null)}
              aria-label="Close dialog"
            >
              <X size={18} />
            </button>
            <span className="unsaved-icon">
              <Save size={22} />
            </span>
            <p className="eyebrow">Unsaved corrections</p>
            <h3 id="unsaved-title">Save before leaving this job?</h3>
            <p>
              You have corrections on{" "}
              <strong>
                {pendingFrameNumbers.size} frame
                {pendingFrameNumbers.size === 1 ? "" : "s"}
              </strong>
              . Save them together to S3, or keep reviewing.
            </p>
            <div className="unsaved-actions">
              <button
                className="dialog-secondary"
                onClick={() => setPendingNavigation(null)}
              >
                Keep reviewing
              </button>
              <button className="dialog-danger" onClick={discardAndLeave}>
                Discard &amp; leave
              </button>
              <button
                className="dialog-primary"
                onClick={() => void saveChanges(pendingNavigation.run)}
                disabled={loading}
              >
                {loading ? (
                  <LoaderCircle className="spin" size={15} />
                ) : (
                  <Save size={15} />
                )}
                Save &amp; leave
              </button>
            </div>
          </section>
        </div>
      )}
      {saved && (
        <div className="toast">
          <span>
            <Check size={16} />
          </span>
          <div>
            <strong>Corrections saved to S3</strong>
            <small>
              All changed frames and only their changed model labels were
              written.
            </small>
          </div>
        </div>
      )}
    </main>
  );
}

function BoxEditor({
  model,
  selected,
  annotations,
  onSelect,
  onUpdate,
  onDelete,
  onAdd,
  onRemoveAll,
  onPeopleCountChange,
}: {
  model: VisibleModel;
  selected?: Annotation;
  annotations: Annotation[];
  onSelect: (id: string) => void;
  onUpdate: (patch: Partial<Annotation>) => void;
  onDelete: () => void;
  onAdd: () => void;
  onRemoveAll: () => void;
  onPeopleCountChange?: (count: number) => void;
}) {
  const isPeopleCount = model.kind === "people";
  const peopleCount = model.people_count ?? annotations.length;
  return (
    <>
      <div className="section-heading compact">
        <div>
          <p className="eyebrow">Edit layer</p>
          <h3>{model.name}</h3>
        </div>
        <span className="mode-tag">
          <Box size={13} />
          {isPeopleCount
            ? `${peopleCount} ${peopleCount === 1 ? "person" : "people"}`
            : "Boxes"}
        </span>
      </div>
      {isPeopleCount && (
        <div className="property-card people-count-card">
          <label>
            Total people in this frame
            <input
              type="number"
              min="0"
              step="1"
              inputMode="numeric"
              value={peopleCount}
              onChange={(event) =>
                onPeopleCountChange?.(
                  Math.max(0, Math.floor(Number(event.target.value) || 0)),
                )
              }
            />
          </label>
          <p className="group-editor-note">
            Enter the total directly. Person boxes are optional and can be added
            only when their locations are useful for retraining.
          </p>
        </div>
      )}
      {annotations.length ? (
        <div className="detection-list">
          {annotations.map((item, index) => (
            <button
              key={item.id}
              className={`detection-item ${selected?.id === item.id ? "active" : ""}`}
              onClick={() => onSelect(item.id)}
            >
              <span style={{ borderColor: model.color }}>{index + 1}</span>
              <div>
                <strong>{item.label}</strong>
                <small>
                  {item.manual
                    ? "Manual override"
                    : `${Math.round(item.confidence * 100)}% confidence`}
                </small>
              </div>
              <ChevronRight size={15} />
            </button>
          ))}
        </div>
      ) : (
        <EmptyModelState
          title={isPeopleCount ? "No person boxes added" : "No detections"}
          description={
            isPeopleCount
              ? "No person boxes added. You can still enter the total people count above."
              : "This model has no boxes on the selected frame."
          }
        />
      )}
      {selected && (
        <div className="property-card">
          {!isPeopleCount && (
            <label>
              Class
              <select
                value={selected.label}
                onChange={(event) =>
                  onUpdate({
                    label: event.target.value,
                    class_id: model.classes.indexOf(event.target.value),
                  })
                }
              >
                {model.classes.map((label) => (
                  <option key={label}>{label}</option>
                ))}
              </select>
            </label>
          )}
          <div className="coordinate-grid">
            <label>
              X
              <input
                type="number"
                min="0"
                max="100"
                value={selected.x.toFixed(2)}
                onChange={(event) =>
                  onUpdate({
                    x: clamp(
                      Number(event.target.value),
                      0,
                      100 - selected.width,
                    ),
                  })
                }
              />
            </label>
            <label>
              Y
              <input
                type="number"
                min="0"
                max="100"
                value={selected.y.toFixed(2)}
                onChange={(event) =>
                  onUpdate({
                    y: clamp(
                      Number(event.target.value),
                      0,
                      100 - selected.height,
                    ),
                  })
                }
              />
            </label>
            <label>
              W
              <input
                type="number"
                min="1"
                max="100"
                value={selected.width.toFixed(2)}
                onChange={(event) =>
                  onUpdate({
                    width: clamp(
                      Number(event.target.value),
                      1,
                      100 - selected.x,
                    ),
                  })
                }
              />
            </label>
            <label>
              H
              <input
                type="number"
                min="1"
                max="100"
                value={selected.height.toFixed(2)}
                onChange={(event) =>
                  onUpdate({
                    height: clamp(
                      Number(event.target.value),
                      1,
                      100 - selected.y,
                    ),
                  })
                }
              />
            </label>
          </div>
          <button className="danger-button" onClick={onDelete}>
            <Trash2 size={15} />
            Delete wrong detection
          </button>
        </div>
      )}
      <button className="add-button" onClick={onAdd}>
        <Plus size={16} />
        {isPeopleCount ? "Add person" : "Add annotation"}
      </button>
      {annotations.length > 0 && (
        <button className="danger-button remove-all" onClick={onRemoveAll}>
          <Trash2 size={15} />
          {isPeopleCount ? "Remove all people" : `Remove all ${model.short} boxes`}
        </button>
      )}
    </>
  );
}

function GroupEditor({
  model,
  selected,
  annotations,
  onSelect,
  onUpdate,
  onDelete,
  onAdd,
  onRemoveAll,
}: {
  model: VisibleModel;
  selected?: Annotation;
  annotations: Annotation[];
  onSelect: (id: string) => void;
  onUpdate: (patch: Partial<Annotation>) => void;
  onDelete: () => void;
  onAdd: () => void;
  onRemoveAll: () => void;
}) {
  const totalPeople = groupPeopleTotal(annotations);
  const selectedPeople = selected ? peopleInGroup(selected) : null;
  return (
    <>
      <div className="section-heading compact">
        <div>
          <p className="eyebrow">Group review</p>
          <h3>{model.name}</h3>
        </div>
        <span className="mode-tag">
          <Box size={13} />
          {annotations.length} {annotations.length === 1 ? "group" : "groups"}
        </span>
      </div>
      <div className="group-count-summary">
        <span>
          <strong>{annotations.length}</strong>
          {annotations.length === 1 ? "Group" : "Groups"}
        </span>
        <span>
          <strong>{totalPeople ?? "—"}</strong>
          People in groups
        </span>
      </div>
      {annotations.length ? (
        <div className="detection-list">
          {annotations.map((item, index) => {
            const people = peopleInGroup(item);
            return (
              <button
                key={item.id}
                className={`detection-item ${selected?.id === item.id ? "active" : ""}`}
                onClick={() => onSelect(item.id)}
              >
                <span style={{ borderColor: model.color }}>{index + 1}</span>
                <div>
                  <strong>Group {index + 1}</strong>
                  <small>
                    {people === null
                      ? "People count not set"
                      : `${people} ${people === 1 ? "person" : "people"}`}
                  </small>
                </div>
                <ChevronRight size={15} />
              </button>
            );
          })}
        </div>
      ) : (
        <EmptyModelState
          title="No groups detected"
          description="Add an outer box for each group, then enter how many people belong to it."
        />
      )}
      {selected && (
        <div className="property-card">
          <label>
            People in this group
            <input
              type="number"
              min="0"
              step="1"
              placeholder="Enter count"
              value={selectedPeople ?? ""}
              onChange={(event) => {
                const value = event.target.value;
                onUpdate({
                  attributes: {
                    ...(selected.attributes ?? {}),
                    people_count: value === "" ? null : Math.max(0, Math.floor(Number(value))),
                  },
                });
              }}
            />
          </label>
          <p className="group-editor-note">
            The box represents the complete group. This count is stored with the
            group metadata and is separate from the number of group boxes.
          </p>
          <button className="danger-button" onClick={onDelete}>
            <Trash2 size={15} />
            Delete this group
          </button>
        </div>
      )}
      <button className="add-button" onClick={onAdd}>
        <Plus size={16} />
        Add group
      </button>
      {annotations.length > 0 && (
        <button className="danger-button remove-all" onClick={onRemoveAll}>
          <Trash2 size={15} />
          Remove all groups
        </button>
      )}
    </>
  );
}

function nestedLabel(value: unknown, fallback: string) {
  return typeof value === "object" && value !== null && "label" in value
    ? String((value as { label: unknown }).label)
    : fallback;
}

function VehicleEditor({
  model,
  selected,
  onSelect,
  onUpdate,
  onDelete,
  onAdd,
  onRemoveAll,
}: {
  model: VisibleModel;
  selected?: Annotation;
  onSelect: (id: string) => void;
  onUpdate: (patch: Partial<Annotation>) => void;
  onDelete: () => void;
  onAdd: () => void;
  onRemoveAll: () => void;
}) {
  if (!selected)
    return (
      <>
        <div className="section-heading compact">
          <div>
            <p className="eyebrow">Vehicle review</p>
            <h3>MMC detections</h3>
          </div>
          <span className="mode-tag teal">
            <CarFront size={13} />
            MMC
          </span>
        </div>
        <EmptyModelState
          title="No vehicle on this frame"
          description={
            model.status === "SUCCESS"
              ? "MMC returned no vehicle track for this sampled frame."
              : "MMC inference was unavailable. Add a vehicle box manually."
          }
        />
        <button className="add-button" onClick={onAdd}>
          <Plus size={16} />
          Add vehicle annotation
        </button>
      </>
    );
  const attrs = selected.attributes ?? {};
  const color = nestedLabel(attrs.color, "Unknown");
  const makeModel =
    typeof attrs.make_model === "object" &&
    attrs.make_model !== null &&
    "make_model" in attrs.make_model
      ? String((attrs.make_model as { make_model: unknown }).make_model)
      : "Unknown";
  return (
    <>
      <div className="section-heading compact">
        <div>
          <p className="eyebrow">Vehicle review</p>
          <h3>Track #{selected.track_id ?? "—"}</h3>
        </div>
        <span className="mode-tag teal">
          <CarFront size={13} />
          MMC
        </span>
      </div>
      <button className="vehicle-summary" onClick={() => onSelect(selected.id)}>
        <span className="vehicle-crop-placeholder">
          <CarFront size={21} />
        </span>
        <div>
          <strong>{makeModel}</strong>
          <span>
            Track #{selected.track_id ?? "—"} · {color}
          </span>
          <small>
            {Math.round(selected.confidence * 100)}% detection confidence
          </small>
        </div>
        <ChevronRight size={16} />
      </button>
      <div className="property-card vehicle-properties">
        <label>
          Vehicle class
          <select
            value={selected.label}
            onChange={(event) =>
              onUpdate({
                label: event.target.value,
                class_id: model.classes.indexOf(event.target.value),
              })
            }
          >
            {model.classes.map((label) => (
              <option key={label}>{label}</option>
            ))}
          </select>
        </label>
        <div className="two-fields">
          <label>
            Colour
            <input value={color} readOnly />
          </label>
          <label>
            Make / model
            <input value={makeModel} readOnly />
          </label>
        </div>
        <div className="attribute-note">
          <ShieldCheck size={15} />
          <span>
            These attributes came from the real MMC result for track #
            {selected.track_id} on this frame.
          </span>
        </div>
        <button className="danger-button" onClick={onDelete}>
          <Trash2 size={15} />
          Delete vehicle detection
        </button>
        <button className="danger-button remove-all" onClick={onRemoveAll}>
          <Trash2 size={15} />
          Remove all MMC detections
        </button>
      </div>
    </>
  );
}

function AggressionEditor({
  segments,
  timestampMs,
  onChange,
}: {
  segments: Segment[];
  timestampMs: number;
  onChange: (value: Segment[]) => void;
}) {
  function addSegment() {
    const startMs = Math.max(0, timestampMs - 2500);
    onChange([
      ...segments,
      {
        label: "aggression",
        start_ms: startMs,
        end_ms: Math.max(startMs + 100, timestampMs + 2500),
        confidence: 1,
      },
    ]);
  }

  function updateSegment(index: number, nextSegment: Segment) {
    onChange(
      segments.map((segment, segmentIndex) =>
        segmentIndex === index ? nextSegment : segment,
      ),
    );
  }

  return (
    <>
      <div className="section-heading compact">
        <div>
          <p className="eyebrow">Temporal review</p>
          <h3>Aggression segments</h3>
        </div>
        <span className="mode-tag red">
          <Flame size={13} />
          {segments.length} {segments.length === 1 ? "segment" : "segments"}
        </span>
      </div>
      {!segments.length ? (
        <EmptyModelState
          title="No aggression event here"
          description="There is no aggression segment covering this frame."
        />
      ) : (
        <div className="segment-list">
          {segments.map((segment, index) => (
            <div className="segment-card" key={`${segment.start_ms}-${segment.end_ms}-${index}`}>
              <div className="segment-top">
                <span className="segment-icon">
                  <Activity size={17} />
                </span>
                <div>
                  <strong>
                    Segment {index + 1}: {(segment.start_ms / 1000).toFixed(1)}s
                    {" — "}
                    {(segment.end_ms / 1000).toFixed(1)}s
                  </strong>
                  <small>{segment.label}</small>
                </div>
                <span className="confidence-pill">
                  {Math.round(segment.confidence * 100)}%
                </span>
              </div>
              <div className="two-fields segment-fields">
                <label>
                  Start (seconds)
                  <input
                    aria-label={`Aggression segment ${index + 1} start time`}
                    type="number"
                    min="0"
                    step="0.1"
                    value={(segment.start_ms / 1000).toFixed(1)}
                    onChange={(event) =>
                      updateSegment(index, {
                        ...segment,
                        start_ms: Math.min(
                          Math.max(0, Number(event.target.value) * 1000),
                          segment.end_ms,
                        ),
                      })
                    }
                  />
                </label>
                <label>
                  End (seconds)
                  <input
                    aria-label={`Aggression segment ${index + 1} end time`}
                    type="number"
                    min="0"
                    step="0.1"
                    value={(segment.end_ms / 1000).toFixed(1)}
                    onChange={(event) =>
                      updateSegment(index, {
                        ...segment,
                        end_ms: Math.max(
                          Number(event.target.value) * 1000,
                          segment.start_ms,
                        ),
                      })
                    }
                  />
                </label>
              </div>
              <button
                className="danger-button"
                onClick={() =>
                  onChange(segments.filter((_, segmentIndex) => segmentIndex !== index))
                }
              >
                <Trash2 size={15} />
                Remove this aggression segment
              </button>
            </div>
          ))}
        </div>
      )}
      <button className="add-button" onClick={addSegment}>
        <Plus size={16} />
        {segments.length ? "Add another aggression segment" : "Add missed aggression event"}
      </button>
      {segments.length > 0 && (
        <p className="segment-save-note">
          All aggression segments in this correction will be saved together.
        </p>
      )}
    </>
  );
}

function EmptyModelState({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <div className="empty-detections">
      <span>
        <ShieldCheck size={18} />
      </span>
      <strong>{title}</strong>
      <p>{description}</p>
    </div>
  );
}
