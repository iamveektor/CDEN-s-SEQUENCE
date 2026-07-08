import os
import time

import requests
from mcp.server.fastmcp import FastMCP

# Base URL of your already-deployed C-DEN'S SEQUENCE web service, e.g.
# https://web-production-3bfee.up.railway.app
# Set this as an environment variable on THIS service (the MCP server),
# not on the main web app.
APP_BASE_URL = os.environ.get("APP_BASE_URL", "").rstrip("/")

mcp = FastMCP(
    "cdens-sequence",
    host="0.0.0.0",
    port=int(os.environ.get("PORT", 8000)),
)


def _check_configured():
    if not APP_BASE_URL:
        raise RuntimeError(
            "APP_BASE_URL is not set on this MCP server. Set it to your "
            "deployed C-DEN'S SEQUENCE URL, e.g. "
            "https://web-production-3bfee.up.railway.app"
        )


def _get(path, **params):
    _check_configured()
    r = requests.get(f"{APP_BASE_URL}{path}", params=params, timeout=30)
    try:
        data = r.json()
    except ValueError:
        r.raise_for_status()
        raise RuntimeError(f"Unexpected non-JSON response from {path}")
    return data


def _post(path, payload=None):
    _check_configured()
    r = requests.post(f"{APP_BASE_URL}{path}", json=payload or {}, timeout=60)
    try:
        data = r.json()
    except ValueError:
        r.raise_for_status()
        raise RuntimeError(f"Unexpected non-JSON response from {path}")
    return data


def _find_character_urls(names):
    """Look up saved character/scene/style image URLs by name (case-insensitive)."""
    if not names:
        return []
    data = _get("/api/characters")
    chars = data.get("characters", [])
    urls = []
    for name in names:
        match = next((c for c in chars if c["name"].lower() == name.lower()), None)
        if match:
            urls.append(match["image_url"])
    return urls


# ---------- Account ----------

@mcp.tool()
def get_credits() -> str:
    """Check the current kie.ai credit balance for this account."""
    data = _get("/api/credits")
    if "error" in data:
        return f"Could not fetch credits: {data['error']}"
    return f"{data.get('credits')} credits remaining."


# ---------- Reference library ----------

@mcp.tool()
def list_characters(category: str = "") -> str:
    """List saved reference images from the Subject/Scene/Style library.
    Optionally filter by category: 'subject', 'scene', or 'style'. Use this
    before generating so you know what names are available to reference."""
    data = _get("/api/characters")
    chars = data.get("characters", [])
    if category:
        chars = [c for c in chars if c.get("category") == category]
    if not chars:
        return "No saved references" + (f" in category '{category}'" if category else "") + "."
    return "\n".join(f"- {c['name']} ({c.get('category', 'subject')})" for c in chars)


# ---------- Single generation ----------

@mcp.tool()
def generate_image(prompt: str, character_names: list[str] = [], aspect_ratio: str = "16:9") -> str:
    """Start generating a single image with nano-banana-2-lite. Optionally pass
    character_names (exact names from list_characters) to use as reference
    images for visual consistency. Returns a task_id immediately — call
    check_task to see the result once it's ready (usually 10-30 seconds)."""
    image_urls = _find_character_urls(character_names)
    result = _post("/api/image", {"prompt": prompt, "aspect_ratio": aspect_ratio, "image_urls": image_urls})
    if "error" in result:
        return f"Error: {result['error']}"
    return f"Started. task_id = {result['task_id']}. Call check_task with this id to get the result."


@mcp.tool()
def generate_video(
    prompt: str,
    source_image_url: str = "",
    character_name: str = "",
    aspect_ratio: str = "16:9",
    duration: int = 8,
) -> str:
    """Start generating a single video. If source_image_url or character_name is
    given, animates that image with grok-imagine-video-1.5 (image-to-video, 480p).
    If NEITHER is given, generates straight from the text prompt instead using
    grok-imagine text-to-video (480p) — no image needed. Returns a task_id
    immediately — call check_task to get the result once it's ready (usually
    1-3 minutes)."""
    image_url = source_image_url
    if not image_url and character_name:
        found = _find_character_urls([character_name])
        image_url = found[0] if found else ""

    if image_url:
        payload = {
            "prompt": prompt, "image_url": image_url,
            "aspect_ratio": aspect_ratio, "duration": duration,
            "mode": "image_to_video",
        }
    else:
        payload = {
            "prompt": prompt, "aspect_ratio": aspect_ratio,
            "duration": duration, "mode": "text_to_video",
        }

    result = _post("/api/video", payload)
    if "error" in result:
        return f"Error: {result['error']}"
    return f"Started ({payload['mode']}). task_id = {result['task_id']}. Call check_task with this id to get the result."


@mcp.tool()
def check_task(task_id: str) -> str:
    """Check the status of a single image or video generation started with
    generate_image or generate_video. Returns the result URL once ready."""
    data = _get(f"/api/status/{task_id}")
    if "error" in data:
        return f"Error: {data['error']}"
    state = data.get("state")
    if state == "success":
        urls = data.get("urls") or []
        return urls[0] if urls else "Finished, but no output URL was returned."
    if state == "fail":
        return f"Failed: {data.get('error', 'unknown error')}"
    return f"Still {state}. Check again shortly."


# ---------- Bulk generation ----------

@mcp.tool()
def bulk_generate_images(
    prompts: list[str],
    character_names: list[str] = [],
    aspect_ratio: str = "16:9",
    concurrency: int = 4,
    max_retries: int = 1,
) -> str:
    """Start a bulk image batch (up to 150 prompts) in the background. Optionally
    pass character_names to use the same reference image(s) for every prompt.
    Returns a batch_id immediately — call check_batch to monitor progress."""
    image_urls = _find_character_urls(character_names)
    result = _post("/api/batch/image", {
        "prompts": prompts, "image_urls": image_urls, "aspect_ratio": aspect_ratio,
        "concurrency": concurrency, "max_retries": max_retries,
    })
    if "error" in result:
        return f"Error: {result['error']}"
    return f"Batch started: {result['total']} images queued. batch_id = {result['batch_id']}."


@mcp.tool()
def bulk_generate_videos(
    prompts: list[str],
    source_image_urls: list[str] = [],
    character_name: str = "",
    aspect_ratio: str = "16:9",
    duration: int = 8,
    concurrency: int = 3,
    max_retries: int = 1,
) -> str:
    """Start a bulk video batch (up to 150 prompts) in the background. If
    source_image_urls (exactly 1 to use for every prompt, or exactly one per
    prompt matched in order) or character_name is given, animates image(s) with
    grok-imagine-video-1.5 (image-to-video). If NONE of those are given,
    generates every prompt straight from text instead using grok-imagine
    text-to-video — no images needed. Returns a batch_id immediately — call
    check_batch to monitor progress."""
    urls = source_image_urls or _find_character_urls([character_name] if character_name else [])

    payload = {
        "prompts": prompts, "aspect_ratio": aspect_ratio, "duration": duration,
        "concurrency": concurrency, "max_retries": max_retries,
    }
    if urls:
        payload["mode"] = "image_to_video"
        payload["image_urls"] = urls
    else:
        payload["mode"] = "text_to_video"

    result = _post("/api/batch/video", payload)
    if "error" in result:
        return f"Error: {result['error']}"
    return f"Batch started ({payload['mode']}): {result['total']} videos queued. batch_id = {result['batch_id']}."


@mcp.tool()
def check_batch(batch_id: str) -> str:
    """Check progress of a bulk image/video batch started with
    bulk_generate_images or bulk_generate_videos."""
    data = _get(f"/api/batch/{batch_id}")
    if "error" in data:
        return f"Error: {data['error']}"
    s = data["summary"]
    lines = [
        f"{s['success']}/{s['total']} succeeded, {s['fail']} failed, "
        f"{s['pending']} still pending. Done: {data['done']}."
    ]
    fails = [j for j in data["jobs"] if j["state"] == "fail"]
    if fails:
        lines.append("Failed prompts:")
        for f in fails[:10]:
            lines.append(f"  - {f['prompt'][:60]}: {f.get('error', 'unknown error')}")
        if len(fails) > 10:
            lines.append(f"  ...and {len(fails) - 10} more.")
    return "\n".join(lines)


if __name__ == "__main__":
    mcp.run(transport="streamable-http")
