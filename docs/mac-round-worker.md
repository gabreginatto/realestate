# Mac Round Worker

The review app on Cloud Run is the control plane. It serves the UI, writes
review decisions, queues the next matching round in GCS, and loads finished
rounds from GCS.

The Mac is the compute plane. It runs the matcher pipeline locally and uploads
the finished round plus intermediate artifacts back to GCS.

## Normal workflow

1. Deploy or run the review app.
2. Keep the worker running on the Mac:

   ```bash
   node scripts/mac-round-worker.js
   ```

3. In the review UI, click `Prepare round N` when a pass is complete.
4. The review app writes a queued status file under:

   ```text
   review-sessions/round-jobs/{trial_run_id}/round-N.json
   ```

5. The Mac worker claims the job, syncs lightweight inputs from GCS, runs:

   ```bash
   ./scripts/run-next-review-round.sh --summary ... --round N
   ```

6. The worker uploads the final round and artifacts under:

   ```text
   review-rounds/{trial_run_id}/pass-N/
   ```

7. The review UI polls GCS, loads the ready round, and advances the session.

## Useful one-shot command

When the UI shows a queued round, it also shows a command in this form:

```bash
node scripts/mac-round-worker.js --once --status review-sessions/round-jobs/{trial_run_id}/round-N.json
```

Use the long-running worker for normal operation; use the one-shot command for
debugging a specific queued round.
