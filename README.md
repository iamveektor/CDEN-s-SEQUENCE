# C-DEN'S SEQUENCE

A web app for generating images and videos through your own kie.ai account.

## Text-to-video (no source image needed)

The Video and Bulk Video tabs now have a **Generation mode** toggle:

- **Image → Video** (default) — the original behavior, animates a source
  image with `grok-imagine-video-1.5` (480p)
- **Text → Video** — generates straight from your prompt with
  `grok-imagine/text-to-video` (480p), no image required at all. Switching
  to this mode hides the source-image upload section since it's not needed.

Both modes work the same way everywhere else: single or bulk, and through
the MCP connector — `cdens_generate_video` and `cdens_bulk_generate_videos` now
automatically use text-to-video whenever no source image or character name
is provided, and image-to-video whenever one is.

## Talk to it from Claude directly (MCP)

`mcp_server.py` is a companion server that exposes this app as tools Claude
can call in a normal chat — "generate these 10 scenes" turns into Claude
actually calling your site, not just describing what it would do.

**Tools it exposes:**
- `cdens_get_credits` — check kie.ai balance
- `cdens_list_characters` — see what's saved in your Subject/Scene/Style library
- `cdens_generate_image` / `cdens_generate_video` — start a single generation, returns a `task_id`
- `cdens_check_task` — poll a single generation for its result
- `cdens_bulk_generate_images` / `cdens_bulk_generate_videos` — start a batch (up to 150), returns a `batch_id`
- `cdens_check_batch` — poll a batch for progress and failures

All tool names use a `cdens_` prefix on purpose — some other connectors
(vidIQ, Higgsfield, etc.) also expose generically-named tools like "Generate
Video," and Claude can end up calling the wrong one if names collide. The
prefix makes it unambiguous which tool belongs to this app.

This mirrors the same async job/poll pattern as your other MCP tools (vidIQ,
etc.) — Claude starts a job, gets an ID back, and checks on it, rather than
sitting there waiting.

### Deploying it (as a second Railway service, same repo)

1. In your Railway project, click **+ New** → **GitHub Repository** → pick
   **CDEN-s-SEQUENCE** again (yes, the same repo — Railway can run it twice
   with different start commands)
2. Once it's created, click into the new service → **Settings**
3. Under **Deploy**, find **Custom Start Command** and set it to:
   ```
   python mcp_server.py
   ```
4. Go to **Variables** → **New Variable**:
   - Name: `APP_BASE_URL`
   - Value: your main site's URL (e.g. `https://web-production-3bfee.up.railway.app`)
     — **no trailing slash**
5. Go to **Settings** → **Networking** → **Generate Domain**. You'll get a
   URL like `https://mcp-production-xxxx.up.railway.app` — the actual MCP
   endpoint is that URL **plus `/mcp`**, e.g.
   `https://mcp-production-xxxx.up.railway.app/mcp`

### Connecting it to Claude

1. In claude.ai, go to **Settings → Connectors → Add custom connector**
2. Paste in your MCP URL (the one ending in `/mcp` from step 5 above)
3. Click **Connect**

Once connected, you can just say things like *"generate an image of Dana at
her kitchen table, then check on it"* in a normal Claude conversation, and
Claude will call these tools directly.

### A security note

Neither this app nor the MCP server has a login of any kind — anyone who
has the URL can trigger generations against your kie.ai credits. That's
fine for personal/solo use, but don't share either URL publicly. If you
ever want to lock it down further (a shared secret header, etc.), let me
know and I can add that.



- **Text-to-image / image-editing**: `nano-banana-2-lite`
- **Image-to-video**: `grok-imagine-video-1.5-preview` (480p)

Your kie.ai API key stays on the server — it is never sent to the browser.

## 1. Run it locally first (optional but recommended)

```bash
cd kie-ai-studio
pip install -r requirements.txt
export KIE_API_KEY=your-kie-ai-api-key
python app.py
```

Open http://localhost:5000 in your browser. Try generating an image, then try
image-to-video (upload a source image, or click "Use last generated image").

## 2. Deploy it online

Any host that runs a Python web app works. Two easy free/cheap options:

### Option A — Render

1. Push this folder to a GitHub repo (or use Render's "upload" flow).
2. On [render.com](https://render.com), click **New → Web Service**, connect the repo.
3. Build command: `pip install -r requirements.txt`
4. Start command: `gunicorn app:app --bind 0.0.0.0:$PORT`
5. Under **Environment**, add `KIE_API_KEY` = your kie.ai key.
6. Deploy. Render gives you a public URL like `https://your-app.onrender.com`.

### Option B — Railway

1. Push this folder to a GitHub repo.
2. On [railway.app](https://railway.app), click **New Project → Deploy from GitHub repo**.
3. Railway auto-detects the `Procfile` and Python — no build/start command needed.
4. In the **Variables** tab, add `KIE_API_KEY` = your kie.ai key.
5. Deploy. Railway gives you a public URL under Settings → Networking → Generate Domain.

Either way, the only secret you need to set is `KIE_API_KEY`. Get it from
your kie.ai dashboard: https://kie.ai/api-key

## Credit balance & full-size previews

- **Top-right credit balance** — a small pill next to the header shows
  your current kie.ai credit balance, pulled from kie.ai's `/chat/credit`
  endpoint. It refreshes on page load, every 60 seconds, and right after
  any generation finishes. It turns red if your balance drops under 20.
- **Click any generated image or video to preview it full-size** — this
  works in the Image tab, Video tab, and both Bulk grids. In the bulk
  grids, opening one image lets you page through every other successful
  result in that batch with ◀ ▶ (or your keyboard's arrow keys), without
  closing the preview. Videos keep their normal play controls in the
  grid; click the small ⛶ button on a video card (or next to the single
  Video tab's result) to open the full-size preview instead.

## Reference library — Subject / Scene / Style

The **Characters** tab now mirrors Whisk's structure directly: three
separate categories —

- **Subject** — a person, character, or object that should look the same
  every time
- **Scene** — a backdrop or setting you reuse across generations
- **Style** — a visual style/art-direction reference

Each category has its own upload form and its own grid. Click any item
in a category to make it the **active** one for that category (click it
again to deactivate) — the active pick is shown with a checkmark and an
"Active: name" label, exactly like Whisk's left rail.

The Image and Bulk Image tabs show the same three rows as compact chips
right above the prompt box. Whatever's active in Subject/Scene/Style
feeds into generation as reference images alongside your prompt — pick
once in the Characters tab (or right there in the Image tab, they're the
same shared state) and it carries over automatically. You can still
upload a one-off reference image separately if you don't want to save it
to the library.

Video and Bulk Video don't use the Subject/Scene/Style split — that
model only accepts a single source image, so their picker just shows
everything in your library in one flat list to choose from.

Everything is stored in `data/characters.json` on the server (actual
image bytes stay on kie.ai's file host — this file just keeps the name +
category + URL). On Render/Railway's default ephemeral disk, this resets
on redeploy; if you want your library to persist permanently, attach a
small persistent volume/disk to the `data/` folder, or set `DATA_DIR` to
point at it.

## Bulk generation

Two extra tabs handle bulk runs, up to **150 items per batch**, styled as
a dedicated Prompts + Settings workspace with a live progress bar and a
Queue panel:

- **Bulk Image** — paste up to 150 prompts (one per line). Pick a quick
  style preset (Cinematic / Editorial / Minimal / Vivid, or add your own),
  which gets prepended to every prompt. Optionally attach one shared
  reference image if you want every prompt to edit the same base image.
- **Bulk Video** — paste up to 150 prompts, then upload either:
  - **1 image** → used as the source for every prompt, or
  - **exactly as many images as prompts** → paired up in order (1st image
    with 1st prompt, 2nd with 2nd, etc.)

Both bulk tabs show:
- A live progress bar with elapsed time and an ETA estimate
- A **Cancel** button (stops picking up new items — anything already in
  flight finishes) and a **Resume** button to pick back up where you left off
- A **Queue** panel listing every item's status (queued / generating /
  retrying / success / failed / cancelled)
- A results gallery that fills in as each item finishes, plus a
  **Download all as .zip** link once done (partial zips work too)
- **Concurrency** and **Max retries** controls, so you can tune how many
  generations run at once and how many times a failed item retries
  automatically before being marked failed

Behind the scenes, the server runs your chosen number of generations at a
time per batch (default 4 for images, 3 for video) so a batch of 150
doesn't slam kie.ai's rate limits or your account all at once. A batch of
150 will typically take a while to fully complete — leave the tab open,
or check back later; progress is tracked server-side, not in the browser.

**A note on hosting for bulk jobs:** bulk batches run as background
threads on the server process. Free tiers on Render/Railway can spin the
app down after inactivity, which would interrupt an in-progress batch —
use Resume to pick it back up once the app is awake again. For heavy
bulk use, consider a paid "always-on" tier, or run batches from your own
machine (`python app.py`) where you control when it's running.

## How it works

```
Browser  →  Flask backend (app.py)  →  kie.ai API
                 (holds KIE_API_KEY)
```

- `POST /api/upload` — uploads a picked image to kie.ai's temporary file
  storage (used as the source image for image-to-video, or as an optional
  reference image for image editing).
- `GET /api/characters` / `POST /api/characters` / `DELETE /api/characters/<id>`
  — manage the reference library (name + `category` of subject/scene/style
  + kie.ai file URL), persisted to `data/characters.json`.
- `GET /api/credits` — proxies kie.ai's remaining-credit-balance check,
  used by the pill in the top-right corner of the header.
- `POST /api/image` — creates a `nano-banana-2-lite` generation task.
- `POST /api/video` — creates a `grok-imagine-video-1-5-preview` task
  (fixed at 480p, duration 1–15s).
- `GET /api/status/<task_id>` — polls kie.ai until the task succeeds or fails.
  The frontend polls this every 3 seconds.
- `POST /api/batch/image` / `POST /api/batch/video` — accept up to 150
  prompts plus `concurrency` and `max_retries`, spin up a background
  thread pool that creates and polls each task server-side (retrying
  failed items automatically up to `max_retries` times), and return a
  `batch_id` immediately.
- `GET /api/batch/<batch_id>` — progress + per-item results, polled by the
  frontend every 2.5 seconds.
- `POST /api/batch/<batch_id>/cancel` — stops picking up new queued items;
  anything already in flight is left to finish.
- `POST /api/batch/<batch_id>/resume` — re-queues anything not yet
  completed and restarts processing.
- `GET /api/batch/<batch_id>/zip` — downloads every successful result and
  streams them back as a single zip.

## Notes

- Files you upload through kie.ai's file API are temporary (auto-deleted
  after ~24h–3 days) — that's fine here, since they're only used as the
  input reference for a generation task, not for permanent storage.
- Generated image/video URLs returned by kie.ai are also temporary. If you
  want to keep an output, download it (the "Download" link under each
  result) rather than relying on the link staying live.
- The Grok Imagine 1.5 Preview model is image-to-video only — there's no
  text-to-video mode for this specific model, so a source image is always
  required.
- To swap in other kie.ai models later, edit `IMAGE_MODEL` / `VIDEO_MODEL`
  in `app.py` and adjust the `input` payload to match that model's docs at
  https://docs.kie.ai/market/quickstart
