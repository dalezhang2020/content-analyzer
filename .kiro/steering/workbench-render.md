---
inclusion: manual
---

# Workbench Render Pre-flight Checklist

When asked to render a project (e.g. `#workbench-render proj_xxx`), ALWAYS perform these checks **before** spawning `hyperframes render`:

## 1. Query Neon for audio state

```sql
SELECT scene_index, audio_path, audio_blob_url
FROM content_analyzer.scenes
WHERE project_id = '{projectId}'
ORDER BY scene_index;
```

If any row has a non-null `audio_blob_url`, audio has been generated via the frontend TTS flow.

## 2. Check if audio is injected into index.html

Search the local `composition/index.html` for `<audio` tags. If Neon shows audio exists but `index.html` has no `<audio>` tags → audio injection is missing.

## 3. Download audio files to local assets

HyperFrames render reads audio from the local filesystem. If audio is hosted on Vercel Blob (remote URL), download them to `composition/assets/`:

```bash
curl -sL "{audio_blob_url}" -o "composition/assets/scene-{i}.mp3"
```

## 4. Inject audio tags before render

If audio exists in Neon but not in HTML, inject `<audio>` tags into `index.html` before rendering:

```html
<audio id="scene-{i}-audio" class="scene-audio"
       data-scene-index="{i}"
       data-start="{cumulativeStartSec}"
       data-duration="{durationSec}"
       src="{audio_blob_url}"></audio>
```

Place all audio tags before `</body>`. Compute `data-start` as the cumulative sum of preceding scenes' `durationSec`.

## 5. Verify project stage

Query Neon for the project's current `stage`. Render requires `stage = "audio"` or `stage = "render"`. If stage is wrong, fix it before proceeding.

## 6. Run render

Only after confirming audio injection (or confirming no audio exists), run:

```bash
npx --yes hyperframes@0.5.5 render --output {outputPath} --fps 30
```

in the project's `composition/` directory.

## Key insight

The frontend TTS flow writes audio URLs to Neon (`scenes.audio_blob_url`) but does NOT automatically inject `<audio>` tags into the local `index.html`. The injection step is normally done by the `POST /api/projects/{id}/audio/generate` route, but when TTS is triggered from the frontend UI on Vercel, the local filesystem is not updated. Always check Neon as the source of truth for audio state.
