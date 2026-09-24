export const API_BASE = "/api";

export type Health = {
  status: "ok";
  bucket: string;
  region: string;
  account: string;
  reviewer: ReviewerIdentity;
};

export type ReviewerIdentity = {
  name: string;
  role: string;
  initials: string;
};

export type JobSummary = {
  id: string;
  captured: string;
  time: string;
  models: number;
  successful_models: number;
  status: string;
  signal: number;
  workflows: string[];
  preview_available: boolean;
  source_available: boolean;
  has_corrections: boolean;
  preview_tone: number;
  preferred_batch_size?: number;
  failure_summary?: string | null;
};

export type Annotation = {
  id: string;
  model_id: string;
  class_id: number;
  label: string;
  confidence: number;
  x: number;
  y: number;
  width: number;
  height: number;
  track_id?: number;
  attributes?: Record<string, unknown>;
  manual: boolean;
};

export type Segment = {
  label: string;
  start_ms: number;
  end_ms: number;
  confidence: number;
};

export type FrameModel = {
  id: string;
  name: string;
  short: string;
  color: string;
  kind: "box" | "vehicle" | "segment" | "people" | "group";
  status: string;
  classes: string[];
  annotations: Annotation[];
  segments: Segment[];
  /** Legacy single-segment field kept for older API responses. */
  segment: Segment | null;
  count: number;
  people_count?: number;
  group_count?: number;
  grouped_people_count?: number;
};

export type FrameReview = {
  frame_number: number;
  timestamp_ms: number;
  models: FrameModel[];
  reviewed: boolean;
  corrected_models: string[];
};

export type JobDetail = {
  job_id: string;
  status: string;
  source_key: string;
  source_etag: string;
  metadata: { fps: number; frame_count: number; width: number; height: number };
  total_frames: number;
  sample_interval: number;
  reviewed_frames: number[];
  batch: number;
  batch_size: number;
  total_batches: number;
  frames: FrameReview[];
  failed_models: { id: string; error: string }[];
};

export type BatchSaveResult = {
  saved: boolean;
  saved_count: number;
  failed_count: number;
  results: { frame_number: number; saved: boolean; error?: string }[];
};

export type JobsPage = {
  jobs: JobSummary[];
  count: number;
  total_count: number;
  limit: number;
  next_continuation_token: string | null;
};

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      ...init,
      headers: { "Content-Type": "application/json", ...init?.headers },
    });
  } catch {
    throw new Error("The dashboard route could not be reached");
  }
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    if (response.status === 503)
      throw new Error(
        "AWS access is unavailable. Refresh the SSO session and retry",
      );
    if (response.status === 403)
      throw new Error(
        "The AWS role does not have permission for this operation",
      );
    if (response.status === 404)
      throw new Error(body.detail ?? "The requested S3 object was not found");
    throw new Error(
      body.detail ?? `The dashboard request failed (${response.status})`,
    );
  }
  return response.json() as Promise<T>;
}

export function rangeCode(label: string) {
  return (
    (
      {
        "Last 1 hour": "1h",
        "Last 24 hours": "24h",
        "Last 7 days": "7d",
        "Custom range": "custom",
      } as Record<string, string>
    )[label] ?? "7d"
  );
}
