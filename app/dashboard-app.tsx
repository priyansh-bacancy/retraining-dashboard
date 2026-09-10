"use client";

import {
  AlertTriangle,
  ArrowRight,
  CalendarDays,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Filter,
  Flame,
  Layers3,
  LoaderCircle,
  ScanLine,
  Search,
  Sparkles,
  Video,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { API_BASE, api, Health, JobsPage, JobSummary, rangeCode } from "./api";
import { ReviewDashboard } from "./review-dashboard";

export function DashboardApp() {
  const [selectedJob, setSelectedJob] = useState<JobSummary | null>(null);
  const [jobs, setJobs] = useState<JobSummary[]>([]);
  const [health, setHealth] = useState<Health | null>(null);

  if (selectedJob) {
    return (
      <ReviewDashboard
        key={selectedJob.id}
        job={selectedJob}
        jobs={jobs}
        health={health}
        onBack={() => setSelectedJob(null)}
        onSelectJob={setSelectedJob}
      />
    );
  }
  return (
    <JobsLanding
      jobs={jobs}
      setJobs={setJobs}
      health={health}
      setHealth={setHealth}
      onOpenJob={setSelectedJob}
    />
  );
}

export function ConnectionState({ health }: { health: Health | null }) {
  return (
    <div className={`system-state ${health ? "" : "system-state-offline"}`}>
      <span className="live-dot" />
      {health ? `S3 · ${health.region}` : "S3 unavailable"}
    </div>
  );
}

function JobsLanding({
  jobs,
  setJobs,
  health,
  setHealth,
  onOpenJob,
}: {
  jobs: JobSummary[];
  setJobs: (jobs: JobSummary[]) => void;
  health: Health | null;
  setHealth: (health: Health | null) => void;
  onOpenJob: (job: JobSummary) => void;
}) {
  const [query, setQuery] = useState("");
  const [range, setRange] = useState("Last 7 days");
  const [customStart, setCustomStart] = useState(() =>
    new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10),
  );
  const [customEnd, setCustomEnd] = useState(() =>
    new Date().toISOString().slice(0, 10),
  );
  const [cursor, setCursor] = useState("");
  const [cursorHistory, setCursorHistory] = useState<string[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [totalJobs, setTotalJobs] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [reviewableOnly, setReviewableOnly] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const timer = window.setTimeout(
      async () => {
        setLoading(true);
        setError("");
        try {
          const params = new URLSearchParams({
            range: rangeCode(range),
            limit: "25",
            search: query,
          });
          if (cursor) params.set("continuation_token", cursor);
          if (range === "Custom range") {
            params.set(
              "start",
              new Date(`${customStart}T00:00:00`).toISOString(),
            );
            params.set(
              "end",
              new Date(`${customEnd}T23:59:59.999`).toISOString(),
            );
          }
          const [healthResult, jobsResult] = await Promise.all([
            api<Health>("/health"),
            api<JobsPage>(`/v1/jobs?${params.toString()}`),
          ]);
          if (!cancelled) {
            setHealth(healthResult);
            setJobs(jobsResult.jobs);
            setTotalJobs(jobsResult.total_count);
            setNextCursor(jobsResult.next_continuation_token);
          }
        } catch (caught) {
          if (!cancelled) {
            setHealth(null);
            setJobs([]);
            setTotalJobs(0);
            setError(
              caught instanceof Error
                ? caught.message
                : "The S3 API is unavailable",
            );
          }
        } finally {
          if (!cancelled) setLoading(false);
        }
      },
      query ? 300 : 0,
    );
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [query, range, customStart, customEnd, cursor, setHealth, setJobs]);

  function resetPage() {
    setCursor("");
    setCursorHistory([]);
    setPage(1);
  }
  function chooseRange(value: string) {
    setRange(value);
    resetPage();
  }
  function nextPage() {
    if (!nextCursor) return;
    setCursorHistory((items) => [...items, cursor]);
    setCursor(nextCursor);
    setPage((value) => value + 1);
  }
  function previousPage() {
    if (!cursorHistory.length) return;
    const previous = cursorHistory[cursorHistory.length - 1];
    setCursorHistory((items) => items.slice(0, -1));
    setCursor(previous);
    setPage((value) => Math.max(1, value - 1));
  }

  const displayedJobs = useMemo(
    () =>
      reviewableOnly ? jobs.filter((job) => job.successful_models > 0) : jobs,
    [jobs, reviewableOnly],
  );
  const totals = useMemo(
    () => ({
      models: displayedJobs.reduce(
        (sum, job) => sum + job.successful_models,
        0,
      ),
      reviewable: displayedJobs.filter((job) => job.successful_models > 0)
        .length,
      failed: displayedJobs.filter((job) => job.successful_models === 0).length,
    }),
    [displayedJobs],
  );

  return (
    <main className="jobs-home">
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
          <div className="reviewer" aria-label="Current reviewer">
            <div className="avatar" aria-hidden="true">PD</div>
            <div>
              <strong>Priyansh</strong>
              <span>Reviewer</span>
            </div>
          </div>
        </div>
      </header>
      <section className="jobs-home-content">
        <div className="jobs-hero">
          <div className="hero-copy">
            <p className="hero-eyebrow">
              <span />
              Manual annotation workspace
            </p>
            <h1>
              Review smarter.
              <br />
              <em>Correct what matters.</em>
            </h1>
            <p>
              Select a real S3 video job, inspect every successful model on the
              same frame, and save only your corrections.
            </p>
            <div className="range-filter-line">
              <div className="range-pills" aria-label="Job time range">
                {["Last 1 hour", "Last 24 hours", "Last 7 days"].map(
                  (option) => (
                    <button
                      key={option}
                      className={range === option ? "active" : ""}
                      onClick={() => chooseRange(option)}
                    >
                      {option.replace("Last ", "")}
                    </button>
                  ),
                )}
                <button
                  className={range === "Custom range" ? "active" : ""}
                  onClick={() => chooseRange("Custom range")}
                >
                  Custom
                </button>
              </div>
              {range === "Custom range" && (
                <div className="custom-range">
                  <label>
                    From
                    <input
                      type="date"
                      value={customStart}
                      max={customEnd}
                      onChange={(event) => {
                        setCustomStart(event.target.value);
                        resetPage();
                      }}
                    />
                  </label>
                  <label>
                    To
                    <input
                      type="date"
                      value={customEnd}
                      min={customStart}
                      onChange={(event) => {
                        setCustomEnd(event.target.value);
                        resetPage();
                      }}
                    />
                  </label>
                </div>
              )}
            </div>
          </div>
          <div className="hero-preview" aria-hidden="true">
            <div className="hero-preview-frame">
              <span className="preview-corner corner-one" />
              <span className="preview-corner corner-two" />
              <i className="preview-box box-one">Labels</i>
              <i className="preview-box box-two">MMC</i>
            </div>
            <div className="hero-preview-card">
              <span>
                <ScanLine size={18} />
              </span>
              <div>
                <strong>One frame</strong>
                <small>All live model layers</small>
              </div>
            </div>
            <span className="hero-model-pill pill-aggression">
              <Flame size={12} />
              Segments
            </span>
            <span className="hero-model-pill pill-mmc">S3 source</span>
          </div>
        </div>
        <div className="summary-grid">
          <div className="summary-card">
            <span className="summary-icon green">
              <Video size={19} />
            </span>
            <div>
              <small>Jobs on page</small>
              <strong>{loading ? "—" : displayedJobs.length}</strong>
              <p>{totalJobs} in selected period</p>
            </div>
          </div>
          <div className="summary-card">
            <span className="summary-icon green">
              <CheckCircle2 size={19} />
            </span>
            <div>
              <small>Reviewable jobs</small>
              <strong>{loading ? "—" : totals.reviewable}</strong>
              <p>On this page</p>
            </div>
          </div>
          <div className="summary-card">
            <span className="summary-icon blue">
              <Layers3 size={19} />
            </span>
            <div>
              <small>Successful model runs</small>
              <strong>{loading ? "—" : totals.models}</strong>
              <p>On this page</p>
            </div>
          </div>
          <div className="summary-card">
            <span className="summary-icon rose">
              <AlertTriangle size={19} />
            </span>
            <div>
              <small>Unavailable jobs</small>
              <strong>{loading ? "—" : totals.failed}</strong>
              <p>On this page</p>
            </div>
          </div>
        </div>
        <section className="jobs-table-card">
          <div className="jobs-table-header">
            <div>
              <h2>{reviewableOnly ? "Reviewable jobs" : "All jobs"}</h2>
              <p>Showing up to 25 jobs from the selected period.</p>
            </div>
            <div className="jobs-controls">
              <label className="search-field home-search">
                <Search size={16} />
                <input
                  value={query}
                  onChange={(event) => {
                    setQuery(event.target.value);
                    resetPage();
                  }}
                  placeholder="Search exact job ID"
                  aria-label="Search jobs"
                />
              </label>
              <button
                className={`filter-button ${reviewableOnly ? "filter-button-active" : ""}`}
                aria-pressed={reviewableOnly}
                onClick={() => setReviewableOnly((value) => !value)}
              >
                <Filter size={15} />
                Reviewable{reviewableOnly && <span>On</span>}
              </button>
            </div>
          </div>
          <div className="jobs-table-labels">
            <span>Job & source</span>
            <span>Captured</span>
            <span>Models</span>
            <span>Detections</span>
            <span>Review modes</span>
            <span />
          </div>
          <div className="jobs-rows">
            {loading && (
              <div className="jobs-loading">
                <LoaderCircle className="spin" size={22} />
                <strong>Loading jobs from S3</strong>
              </div>
            )}
            {!loading && error && (
              <div className="no-jobs error-state">
                <AlertTriangle size={22} />
                <strong>Dashboard data unavailable</strong>
                <span>{error}</span>
              </div>
            )}
            {!loading &&
              !error &&
              displayedJobs.map((job) => (
                <button
                  className="jobs-row"
                  key={job.id}
                  onClick={() => onOpenJob(job)}
                >
                  <span className="job-primary">
                    <i
                      className={`job-preview job-preview-${job.preview_tone % 4}`}
                      style={
                        job.preview_available
                          ? {
                              backgroundImage: `linear-gradient(rgba(8,38,29,.12),rgba(8,38,29,.32)),url('${API_BASE}/v1/jobs/${job.id}/preview')`,
                              backgroundSize: "cover",
                              backgroundPosition: "center",
                            }
                          : undefined
                      }
                    >
                      <Video size={17} />
                      <span>{job.status}</span>
                    </i>
                    <span>
                      <strong>{job.id}</strong>
                      <small>
                        {job.status === "FAILED"
                          ? (job.failure_summary ??
                            "No successful model output")
                          : `${job.successful_models} of ${job.models} models succeeded`}
                      </small>
                    </span>
                  </span>
                  <span className="table-cell captured">
                    <CalendarDays size={14} />
                    <span>{new Date(job.captured).toLocaleString()}</span>
                  </span>
                  <span className="table-cell">
                    <b>
                      {job.successful_models}/{job.models}
                    </b>
                    <small>successful</small>
                  </span>
                  <span className="table-cell">
                    <b>{job.successful_models ? job.signal : "—"}</b>
                    <small>
                      {job.successful_models ? "detections" : "not generated"}
                    </small>
                  </span>
                  <span className="workflow-tags">
                    {job.workflows.map((workflow) => (
                      <i
                        key={workflow}
                        className={
                          workflow === "MMC"
                            ? "tag-mmc"
                            : workflow === "Aggression"
                              ? "tag-aggression"
                              : ""
                        }
                      >
                        {workflow}
                      </i>
                    ))}
                  </span>
                  <span className="open-job">
                    {job.successful_models ? (
                      <>
                        Review
                        <ArrowRight size={15} />
                      </>
                    ) : (
                      <>
                        Unavailable
                        <AlertTriangle size={14} />
                      </>
                    )}
                  </span>
                </button>
              ))}
            {!loading && !error && displayedJobs.length === 0 && (
              <div className="no-jobs">
                <Search size={22} />
                <strong>No matching S3 jobs found</strong>
                <span>Try a wider time period or show unavailable jobs.</span>
              </div>
            )}
          </div>
          <div className="jobs-table-footer">
            <span>
              Showing {displayedJobs.length} jobs on this page · {totalJobs} in
              selected period
            </span>
            <div>
              <button
                aria-label="Previous page"
                onClick={previousPage}
                disabled={!cursorHistory.length || loading}
              >
                <ChevronLeft size={16} />
              </button>
              <span>
                Page {page} of {Math.max(1, Math.ceil(totalJobs / 25))}
              </span>
              <button
                aria-label="Next page"
                onClick={nextPage}
                disabled={!nextCursor || loading}
              >
                <ChevronRight size={16} />
              </button>
            </div>
          </div>
        </section>
      </section>
    </main>
  );
}
