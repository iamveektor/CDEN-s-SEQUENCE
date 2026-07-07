import os
import io
import json
import time
import uuid
import base64
import zipfile
import threading
from concurrent.futures import ThreadPoolExecutor

import requests
from flask import Flask, request, jsonify, send_from_directory, send_file

app = Flask(__name__, static_folder="static", static_url_path="")

KIE_API_KEY = os.environ.get("KIE_API_KEY", "")
KIE_BASE = "https://api.kie.ai/api/v1"
KIE_UPLOAD_BASE = "https://kieai.redpandaai.co/api"

IMAGE_MODEL = "nano-banana-2-lite"
VIDEO_MODEL = "grok-imagine-video-1-5-preview"

MAX_BULK = 150
BULK_CONCURRENCY = 4  # simultaneous in-flight generations per batch, kind to rate limits
POLL_INTERVAL_SECS = 4
POLL_MAX_ATTEMPTS = 150  # ~10 min per job before giving up

# In-memory batch store. Fine for a single-instance personal deployment;
# batches are lost on restart, which only matters for jobs still running
# at that moment.
BATCHES = {}
BATCHES_LOCK = threading.Lock()

# Character library — persisted to a JSON file on disk so it survives
# process restarts (unlike batches). On ephemeral hosting without a
# persistent disk, this resets on redeploy; see README.
DATA_DIR = os.environ.get("DATA_DIR", os.path.join(os.path.dirname(__file__), "data"))
CHARACTERS_PATH = os.path.join(DATA_DIR, "characters.json")
CHARACTERS_LOCK = threading.Lock()


def load_characters():
    if not os.path.exists(CHARACTERS_PATH):
        return []
    try:
        with open(CHARACTERS_PATH, "r") as f:
            return json.load(f)
    except Exception:
        return []


def save_characters(characters):
    os.makedirs(DATA_DIR, exist_ok=True)
    with open(CHARACTERS_PATH, "w") as f:
        json.dump(characters, f, indent=2)


def kie_headers():
    return {
        "Authorization": f"Bearer {KIE_API_KEY}",
        "Content-Type": "application/json",
    }


def require_api_key():
    if not KIE_API_KEY:
        return jsonify({"error": "Server is missing KIE_API_KEY. Set it as an environment variable."}), 500
    return None


# ---------- Static frontend ----------

@app.route("/")
def index():
    return send_from_directory(app.static_folder, "index.html")


@app.route("/api/credits", methods=["GET"])
def get_credits():
    err = require_api_key()
    if err:
        return err
    try:
        resp = requests.get(
            f"{KIE_BASE}/chat/credit",
            headers=kie_headers(),
            timeout=15,
        )
        if resp.status_code != 200:
            return jsonify({"error": f"kie.ai request failed: {resp.text}"}), 502
        data = resp.json()
        if data.get("code") != 200:
            return jsonify({"error": data.get("msg") or "Could not fetch credits"}), 502
        return jsonify({"credits": data.get("data")})
    except requests.RequestException as e:
        return jsonify({"error": str(e)}), 502


# ---------- File upload (for image-to-video source images / reference images) ----------

def upload_bytes_to_kie(file_bytes, mime, filename):
    b64 = base64.b64encode(file_bytes).decode("utf-8")
    data_url = f"data:{mime};base64,{b64}"
    resp = requests.post(
        f"{KIE_UPLOAD_BASE}/file-base64-upload",
        headers=kie_headers(),
        json={
            "base64Data": data_url,
            "uploadPath": "images/user-uploads",
            "fileName": filename or "upload.png",
        },
        timeout=60,
    )
    if resp.status_code != 200:
        raise RuntimeError(f"Upload failed: {resp.text}")
    data = resp.json()
    if not data.get("success"):
        raise RuntimeError(f"Upload failed: {data}")
    return data["data"]["downloadUrl"]


@app.route("/api/upload", methods=["POST"])
def upload_file():
    err = require_api_key()
    if err:
        return err

    if "file" not in request.files:
        return jsonify({"error": "No file provided"}), 400

    f = request.files["file"]
    try:
        url = upload_bytes_to_kie(f.read(), f.mimetype or "image/png", f.filename)
        return jsonify({"url": url})
    except RuntimeError as e:
        return jsonify({"error": str(e)}), 502


# ---------- Character library (Whisk-style Subject / Scene / Style references) ----------

VALID_CATEGORIES = {"subject", "scene", "style"}


@app.route("/api/characters", methods=["GET"])
def list_characters():
    err = require_api_key()
    if err:
        return err
    with CHARACTERS_LOCK:
        return jsonify({"characters": load_characters()})


@app.route("/api/characters", methods=["POST"])
def create_character():
    err = require_api_key()
    if err:
        return err

    if "file" not in request.files:
        return jsonify({"error": "No file provided"}), 400

    name = (request.form.get("name") or "").strip()
    if not name:
        return jsonify({"error": "A name is required"}), 400

    category = (request.form.get("category") or "subject").strip().lower()
    if category not in VALID_CATEGORIES:
        return jsonify({"error": f"category must be one of {sorted(VALID_CATEGORIES)}"}), 400

    f = request.files["file"]
    try:
        url = upload_bytes_to_kie(f.read(), f.mimetype or "image/png", f.filename)
    except RuntimeError as e:
        return jsonify({"error": str(e)}), 502

    character = {
        "id": uuid.uuid4().hex[:12],
        "name": name,
        "category": category,
        "image_url": url,
        "created": time.time(),
    }
    with CHARACTERS_LOCK:
        characters = load_characters()
        characters.append(character)
        save_characters(characters)

    return jsonify({"character": character})


@app.route("/api/characters/<char_id>", methods=["DELETE"])
def delete_character(char_id):
    err = require_api_key()
    if err:
        return err
    with CHARACTERS_LOCK:
        characters = load_characters()
        remaining = [c for c in characters if c["id"] != char_id]
        if len(remaining) == len(characters):
            return jsonify({"error": "Unknown character id"}), 404
        save_characters(remaining)
    return jsonify({"ok": True})


# ---------- Core kie.ai calls (shared by single + bulk endpoints) ----------

def create_image_task(prompt, aspect_ratio, image_urls):
    payload = {
        "model": IMAGE_MODEL,
        "input": {
            "prompt": prompt,
            "image_urls": image_urls or [],
            "aspect_ratio": aspect_ratio or "auto",
        },
    }
    resp = requests.post(f"{KIE_BASE}/jobs/createTask", headers=kie_headers(), json=payload, timeout=60)
    if resp.status_code != 200:
        raise RuntimeError(f"kie.ai request failed: {resp.text}")
    data = resp.json()
    if data.get("code") != 200:
        raise RuntimeError(f"kie.ai task creation failed: {data}")
    return data["data"]["taskId"]


def create_video_task(prompt, image_url, aspect_ratio, duration):
    duration = max(1, min(15, int(duration or 8)))
    payload = {
        "model": VIDEO_MODEL,
        "input": {
            "prompt": prompt,
            "image_urls": [image_url],
            "aspect_ratio": aspect_ratio or "16:9",
            "resolution": "480p",
            "duration": duration,
        },
    }
    resp = requests.post(f"{KIE_BASE}/jobs/createTask", headers=kie_headers(), json=payload, timeout=60)
    if resp.status_code != 200:
        raise RuntimeError(f"kie.ai request failed: {resp.text}")
    data = resp.json()
    if data.get("code") != 200:
        raise RuntimeError(f"kie.ai task creation failed: {data}")
    return data["data"]["taskId"]


def fetch_task_status(task_id):
    resp = requests.get(
        f"{KIE_BASE}/jobs/recordInfo",
        headers=kie_headers(),
        params={"taskId": task_id},
        timeout=30,
    )
    if resp.status_code != 200:
        raise RuntimeError(f"kie.ai status check failed: {resp.text}")
    data = resp.json().get("data", {})
    state = data.get("state")
    result = {"state": state}
    if state == "success":
        try:
            result_json = json.loads(data.get("resultJson") or "{}")
            result["urls"] = result_json.get("resultUrls", [])
        except Exception:
            result["urls"] = []
    elif state == "fail":
        result["error"] = data.get("failMsg") or "Generation failed"
    return result


def poll_until_done(task_id):
    for _ in range(POLL_MAX_ATTEMPTS):
        time.sleep(POLL_INTERVAL_SECS)
        status = fetch_task_status(task_id)
        if status["state"] == "success":
            return status.get("urls") or []
        if status["state"] == "fail":
            raise RuntimeError(status.get("error") or "Generation failed")
    raise RuntimeError("Timed out waiting for kie.ai")


# ---------- Single image / video generation ----------

@app.route("/api/image", methods=["POST"])
def generate_image():
    err = require_api_key()
    if err:
        return err
    body = request.get_json(force=True) or {}
    prompt = (body.get("prompt") or "").strip()
    if not prompt:
        return jsonify({"error": "Prompt is required"}), 400
    try:
        task_id = create_image_task(prompt, body.get("aspect_ratio"), body.get("image_urls"))
        return jsonify({"task_id": task_id})
    except RuntimeError as e:
        return jsonify({"error": str(e)}), 502


@app.route("/api/video", methods=["POST"])
def generate_video():
    err = require_api_key()
    if err:
        return err
    body = request.get_json(force=True) or {}
    prompt = (body.get("prompt") or "").strip()
    image_url = body.get("image_url")
    if not prompt:
        return jsonify({"error": "Prompt is required"}), 400
    if not image_url:
        return jsonify({"error": "An image_url is required (this model is image-to-video only)"}), 400
    try:
        task_id = create_video_task(prompt, image_url, body.get("aspect_ratio"), body.get("duration"))
        return jsonify({"task_id": task_id})
    except RuntimeError as e:
        return jsonify({"error": str(e)}), 502


@app.route("/api/status/<task_id>", methods=["GET"])
def task_status(task_id):
    err = require_api_key()
    if err:
        return err
    try:
        return jsonify(fetch_task_status(task_id))
    except RuntimeError as e:
        return jsonify({"error": str(e)}), 502


# ---------- Bulk generation ----------

def run_job(job, kind, aspect_ratio, duration, max_retries, batch):
    """Runs one job end-to-end: create task, poll to completion, retrying on
    failure up to max_retries times. Bails out early if the batch was cancelled."""
    attempt = 0
    while True:
        if batch.get("cancelled") and job["state"] not in ("generating", "creating"):
            job["state"] = "cancelled"
            return
        attempt += 1
        try:
            job["state"] = "creating"
            job["started_at"] = job.get("started_at") or time.time()
            if kind == "image":
                task_id = create_image_task(job["prompt"], aspect_ratio, job.get("image_urls"))
            else:
                task_id = create_video_task(job["prompt"], job.get("image_url"), aspect_ratio, duration)
            job["task_id"] = task_id
            job["state"] = "generating"
            urls = poll_until_done(task_id)
            job["url"] = urls[0] if urls else None
            if job["url"]:
                job["state"] = "success"
                job["finished_at"] = time.time()
                return
            raise RuntimeError("No output URL returned")
        except Exception as e:
            job["error"] = str(e)
            if attempt > max_retries or batch.get("cancelled"):
                job["state"] = "fail"
                job["finished_at"] = time.time()
                return
            job["state"] = "retrying"
            time.sleep(2)


def run_batch(batch_id):
    with BATCHES_LOCK:
        batch = BATCHES.get(batch_id)
    if not batch:
        return
    pending = [j for j in batch["jobs"] if j["state"] not in ("success", "fail")]
    with ThreadPoolExecutor(max_workers=batch["concurrency"]) as pool:
        futures = [
            pool.submit(run_job, job, batch["kind"], batch["aspect_ratio"],
                        batch.get("duration"), batch["max_retries"], batch)
            for job in pending
        ]
        for f in futures:
            f.result()
    with BATCHES_LOCK:
        batch["done"] = not batch.get("cancelled") or all(
            j["state"] in ("success", "fail", "cancelled") for j in batch["jobs"]
        )
        batch["running"] = False


def make_batch(kind, jobs, aspect_ratio, duration=None, concurrency=4, max_retries=1):
    batch_id = uuid.uuid4().hex[:12]
    for i, job in enumerate(jobs):
        job["index"] = i
        job["state"] = "queued"
        job["url"] = None
        job["error"] = None
        job["started_at"] = None
        job["finished_at"] = None
    concurrency = max(1, min(8, int(concurrency or 4)))
    max_retries = max(0, min(5, int(max_retries or 1)))
    with BATCHES_LOCK:
        BATCHES[batch_id] = {
            "kind": kind, "jobs": jobs, "done": False, "running": True,
            "cancelled": False, "created": time.time(),
            "aspect_ratio": aspect_ratio, "duration": duration,
            "concurrency": concurrency, "max_retries": max_retries,
        }
    thread = threading.Thread(target=run_batch, args=(batch_id,), daemon=True)
    thread.start()
    return batch_id


def resume_batch(batch_id):
    with BATCHES_LOCK:
        batch = BATCHES.get(batch_id)
        if not batch or batch.get("running"):
            return False
        batch["cancelled"] = False
        batch["done"] = False
        batch["running"] = True
        for j in batch["jobs"]:
            if j["state"] in ("cancelled", "retrying", "creating", "generating"):
                j["state"] = "queued"
    thread = threading.Thread(target=run_batch, args=(batch_id,), daemon=True)
    thread.start()
    return True


@app.route("/api/batch/image", methods=["POST"])
def batch_image():
    err = require_api_key()
    if err:
        return err
    body = request.get_json(force=True) or {}
    prompts = [p.strip() for p in (body.get("prompts") or []) if p and p.strip()]
    if not prompts:
        return jsonify({"error": "At least one prompt is required"}), 400
    if len(prompts) > MAX_BULK:
        return jsonify({"error": f"Maximum {MAX_BULK} prompts per batch"}), 400

    shared_refs = body.get("image_urls") or []
    aspect_ratio = body.get("aspect_ratio", "auto")
    concurrency = body.get("concurrency", 4)
    max_retries = body.get("max_retries", 1)

    jobs = [{"prompt": p, "image_urls": shared_refs} for p in prompts]
    batch_id = make_batch("image", jobs, aspect_ratio, concurrency=concurrency, max_retries=max_retries)
    return jsonify({"batch_id": batch_id, "total": len(jobs)})


@app.route("/api/batch/video", methods=["POST"])
def batch_video():
    err = require_api_key()
    if err:
        return err
    body = request.get_json(force=True) or {}
    prompts = [p.strip() for p in (body.get("prompts") or []) if p and p.strip()]
    image_urls = [u for u in (body.get("image_urls") or []) if u]

    if not prompts:
        return jsonify({"error": "At least one prompt is required"}), 400
    if len(prompts) > MAX_BULK:
        return jsonify({"error": f"Maximum {MAX_BULK} prompts per batch"}), 400
    if not image_urls:
        return jsonify({"error": "At least one source image is required"}), 400

    if len(image_urls) == 1:
        paired = [image_urls[0]] * len(prompts)
    elif len(image_urls) == len(prompts):
        paired = image_urls
    else:
        return jsonify({
            "error": f"Uploaded {len(image_urls)} images but {len(prompts)} prompts. "
                     f"Upload exactly 1 image (used for all) or exactly {len(prompts)} images (one per prompt)."
        }), 400

    aspect_ratio = body.get("aspect_ratio", "16:9")
    duration = body.get("duration", 8)
    concurrency = body.get("concurrency", 4)
    max_retries = body.get("max_retries", 1)

    jobs = [{"prompt": p, "image_url": img} for p, img in zip(prompts, paired)]
    batch_id = make_batch("video", jobs, aspect_ratio, duration=duration,
                           concurrency=concurrency, max_retries=max_retries)
    return jsonify({"batch_id": batch_id, "total": len(jobs)})


@app.route("/api/batch/<batch_id>", methods=["GET"])
def batch_status(batch_id):
    err = require_api_key()
    if err:
        return err
    with BATCHES_LOCK:
        batch = BATCHES.get(batch_id)
    if not batch:
        return jsonify({"error": "Unknown batch id"}), 404

    jobs = batch["jobs"]
    summary = {
        "total": len(jobs),
        "success": sum(1 for j in jobs if j["state"] == "success"),
        "fail": sum(1 for j in jobs if j["state"] == "fail"),
        "cancelled": sum(1 for j in jobs if j["state"] == "cancelled"),
        "pending": sum(1 for j in jobs if j["state"] not in ("success", "fail", "cancelled")),
    }
    return jsonify({
        "done": batch["done"],
        "running": batch.get("running", False),
        "cancelled": batch.get("cancelled", False),
        "created": batch["created"],
        "summary": summary,
        "jobs": [{"index": j["index"], "prompt": j["prompt"], "state": j["state"],
                  "url": j.get("url"), "error": j.get("error"),
                  "started_at": j.get("started_at"), "finished_at": j.get("finished_at")}
                 for j in jobs],
    })


@app.route("/api/batch/<batch_id>/cancel", methods=["POST"])
def batch_cancel(batch_id):
    err = require_api_key()
    if err:
        return err
    with BATCHES_LOCK:
        batch = BATCHES.get(batch_id)
        if not batch:
            return jsonify({"error": "Unknown batch id"}), 404
        batch["cancelled"] = True
        for j in batch["jobs"]:
            if j["state"] == "queued":
                j["state"] = "cancelled"
    return jsonify({"ok": True})


@app.route("/api/batch/<batch_id>/resume", methods=["POST"])
def batch_resume(batch_id):
    err = require_api_key()
    if err:
        return err
    with BATCHES_LOCK:
        exists = batch_id in BATCHES
    if not exists:
        return jsonify({"error": "Unknown batch id"}), 404
    started = resume_batch(batch_id)
    if not started:
        return jsonify({"error": "Batch is already running"}), 409
    return jsonify({"ok": True})


@app.route("/api/batch/<batch_id>/zip", methods=["GET"])
def batch_zip(batch_id):
    err = require_api_key()
    if err:
        return err
    with BATCHES_LOCK:
        batch = BATCHES.get(batch_id)
    if not batch:
        return jsonify({"error": "Unknown batch id"}), 404

    ext = "png" if batch["kind"] == "image" else "mp4"
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for job in batch["jobs"]:
            if job["state"] != "success" or not job.get("url"):
                continue
            try:
                r = requests.get(job["url"], timeout=120)
                if r.status_code == 200:
                    name = f"{job['index']+1:03d}.{ext}"
                    zf.writestr(name, r.content)
            except requests.RequestException:
                continue
    buf.seek(0)
    return send_file(buf, mimetype="application/zip", as_attachment=True,
                      download_name=f"batch-{batch_id}.zip")


if __name__ == "__main__":
    port = int(os.environ.get("PORT", 5000))
    app.run(host="0.0.0.0", port=port, debug=False)
