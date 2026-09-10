# ICU Retraining Dashboard

A Next.js dashboard for reviewing sampled video frames and saving sparse manual annotation corrections to S3.

## Architecture

The UI and server functionality run in one Next.js application on port 3000. Next.js Route Handlers under `app/api/` perform all server-only work:

- read and paginate real video jobs from S3;
- merge original model labels with saved manual overrides;
- inspect source-video metadata and extract requested frames with bundled FFmpeg;
- expose temporary preview URLs;
- save clean frames and complete corrected label files under `manual-annotations/`;
- preserve MMC track attributes and multiple Aggression time segments.

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
- Only frames/models changed by the reviewer are written under `manual-annotations/{job_id}/`.
- A changed model is saved as its complete final label file, not as one individual box delta.
- Deleting every detection writes an empty override, so reopening does not restore the original detection.
- Reopening a job shows the complete sampled-frame set and applies manual overrides only where they exist.
