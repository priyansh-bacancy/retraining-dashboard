# ICU Retraining Dashboard

A Next.js dashboard for reviewing sampled video frames and saving sparse manual annotation corrections to S3.

## Architecture

The UI and server functionality run in one Next.js application on port 3000. Next.js Route Handlers under `app/api/` perform all server-only work:

- read and paginate real video jobs from S3;
- merge original model labels with saved manual overrides;
- inspect source-video metadata and extract requested frames with bundled FFmpeg;
- expose temporary preview URLs;
- save clean frames and complete corrected label files under a model-first
  `manual-annotations/models/{model_id}/{job_id}/` layout;
- preserve MMC track attributes and multiple Aggression time segments.

Jobs remain manually reviewable when model inference fails. The server resolves
both supported upload layouts, derives sampled frames directly from the source
video, and exposes failed requested models as empty editable layers. Only a
missing or unreadable source video blocks annotation.

People Count and Group Detection retain their distinct S3 semantics. People
Count totals may be entered directly during manual review while person boxes
remain optional for location-based retraining. Group Detection keeps outer
group boxes separate from each group's `people_count` and nested
`person_boxes`, and falls back to the stored `best_frame_number` when legacy
instances have no frame number.

The job dashboard can filter to jobs containing saved reviewer corrections,
and the annotation workspace can filter to corrected frames. Reviewer display
details are configured at runtime with `REVIEWER_NAME` and `REVIEWER_ROLE`, so
no individual user identity is hardcoded in the interface.

The dashboard contains no Python service and requires no separate API process. AWS credentials stay on the server and are never sent to the browser. Existing inference outputs remain unchanged.

## Run locally

```powershell
cd C:\Users\BAPS\Desktop\ICU-Video-Analytics\retraining-dashboard
aws sso login --profile bacancy
$env:AWS_PROFILE="bacancy"
npm install
npm run dev
```

Open `http://localhost:3000`. The same process serves both the UI and `/api/*` routes.

For a production-style local run:

```powershell
npm run build
$env:AWS_PROFILE="bacancy"
npm start
```

## Disposable S3 test job

The test-data utility is also Node.js:

```powershell
npm run test-job:create
npm run test-job:replace
npm run test-job:delete
```

## Correction behavior

- The original machine-generated labels are read-only.
- New corrections are written model-first under
  `manual-annotations/models/{model_id}/{job_id}/`, with shared clean images
  under `manual-annotations/images/{job_id}/`.
- During migration, writes are mirrored to the legacy
  `manual-annotations/{job_id}/` paths and reads fall back to those paths.
- A changed model is saved as its complete final label file, not as one individual box delta.
- Deleting every detection writes an empty override, so reopening does not restore the original detection.
- Reopening a job shows the complete sampled-frame set and applies manual overrides only where they exist.

## Model-first S3 migration

Preview the non-destructive migration of existing annotations:

```bash
npm run annotations:migrate
```

After reviewing the object and manifest counts, apply and verify the migration:

```bash
npm run annotations:migrate:apply
```

The migration never deletes legacy objects. Keep the legacy paths until the
new structure has been validated in production and a separate, approved
retirement process has completed.

Use `ANNOTATION_LEGACY_READ=true` and `ANNOTATION_LEGACY_WRITE=true` during
migration. After verification, disable legacy writes first. Disable legacy
reads only after the old objects have been independently backed up and retired.
