import os
import json
import uuid
import time
import threading
from datetime import datetime
from pathlib import Path

from flask import Flask, request, jsonify, send_from_directory, render_template, session, redirect
from google import genai
from google.genai import types
from PIL import Image
import io

app = Flask(__name__)
app.secret_key = uuid.uuid4().hex
APP_PASSWORD = os.environ.get("APP_PASSWORD", "1234")

BASE_DIR = Path(__file__).parent
# On Vercel, /var/task is read-only — use /tmp for writable dirs, fall back to local in dev
if os.environ.get("VERCEL"):
    PROJECTS_DIR = Path("/tmp/projects")
    OUTPUTS_DIR = Path("/tmp/outputs")
else:
    PROJECTS_DIR = BASE_DIR / "projects"
    OUTPUTS_DIR = BASE_DIR / "outputs"
PROJECTS_DIR.mkdir(exist_ok=True)
OUTPUTS_DIR.mkdir(exist_ok=True)

client = genai.Client(api_key=os.environ.get("GEMINI_API_KEY", ""))

# ---------------------------------------------------------------------------
# Styles & room types
# ---------------------------------------------------------------------------

STYLES = {
    "scandinavian": {
        "name": "Skandinavisk",
        "description": "Lyst egetræ, rene linjer, hyggelige tekstiler i uld, dæmpede jordfarver og varmt pendellys.",
        "prompt": "Scandinavian style furniture: light oak wood, clean lines, cozy wool textiles, muted earth tones, simple ceramic decor, pendant lamps with warm light.",
    },
    "modern": {
        "name": "Moderne",
        "description": "Stramme geometriske former, neutrale farver med én markant accent, krom- eller sortmetal-ben og arkitektoniske lamper.",
        "prompt": "Modern contemporary furniture: sleek geometric shapes, neutral upholstery with one bold accent color, chrome or matte black metal legs, minimal decorative objects, architectural floor lamp.",
    },
    "minimalist": {
        "name": "Minimalistisk",
        "description": "Meget få møbler, sort/hvid/grå palette, ultrarent udtryk uden dekoration — kun det funktionelle.",
        "prompt": "Minimalist furniture: very few pieces, monochrome black/white/grey, ultra-clean lines, no decorative clutter, only essential functional items.",
    },
    "dark_luxury": {
        "name": "Mørk Luksus",
        "description": "Dyb velour i navy eller smaragd, guld- og messingaccenter, mørkt træ, stemningsfuld belysning og materialer som marmor og læder.",
        "prompt": "Dark luxury furniture: deep velvet upholstery in navy or emerald, gold or brass metal accents, rich dark wood, moody table lamps, premium textures like marble and leather.",
    },
}

ROOM_TYPES = {
    "living_room": "Stue",
    "bedroom": "Soveværelse",
    "kids_room": "Børneværelse",
    "office": "Kontor",
    "kitchen": "Køkken",
    "bathroom": "Badeværelse",
    "dining_room": "Spisestue",
    "hallway": "Entré",
    "guest_room": "Gæsteværelse",
    "laundry": "Bryggers",
    "basement": "Kælder",
    "attic": "Loftsrum",
    "garage": "Garage",
    "sunroom": "Udestue",
    "walk_in_closet": "Garderobe",
    "hobby_room": "Hobbyrum",
    "home_theater": "Hjemmebiograf",
    "gym": "Fitnessrum",
    "corridor": "Fordelingsgang",
}

# ---------------------------------------------------------------------------
# Job tracker  (in-memory, per-process)
# ---------------------------------------------------------------------------

jobs: dict[str, dict] = {}  # job_id -> {status, room_id, style, result, error}

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def project_path(project_id: str) -> Path:
    return PROJECTS_DIR / f"{project_id}.json"


def load_project(project_id: str) -> dict | None:
    p = project_path(project_id)
    if not p.exists():
        return None
    with open(p) as f:
        return json.load(f)


def save_project(project: dict):
    with open(project_path(project["id"]), "w") as f:
        json.dump(project, f, indent=2, ensure_ascii=False)


def generate_room_image(image_path: str, style_key: str, current_room: str, target_room: str | None = None) -> Image.Image:
    style = STYLES[style_key]

    converting = target_room and target_room != current_room

    if converting:
        current_name = ROOM_TYPES.get(current_room, current_room).lower()
        target_name = ROOM_TYPES.get(target_room, target_room).lower()
        prompt = (
            f"Transform this {current_name} into a {target_name}. "
            f"Remove ALL existing furniture, objects, decorations, and items associated with the {current_name} — "
            f"nothing from the original room's function should remain. "
            f"Replace with appropriate {target_name} furniture and items "
            f"in the style: {style['prompt']} "
            f"Place new furniture in the same locations as the originals where possible. "
            f"Do not change walls, floors, ceiling, windows, doors, or any fixed elements. "
            f"Output 16:9 at 2560x1440. Photorealistic real estate photography."
        )
    else:
        prompt = (
            f"Replace all furniture and decorative items in this photo with {style['prompt']} "
            f"Keep every piece in the exact same position and size. "
            f"Do not change walls, floors, ceiling, windows, doors, or any fixed elements. "
            f"Output 16:9 at 2560x1440. Photorealistic real estate photography."
        )

    source_image = Image.open(image_path)

    response = client.models.generate_content(
        model="gemini-3.1-flash-image-preview",
        contents=[prompt, source_image],
        config=types.GenerateContentConfig(
            response_modalities=["TEXT", "IMAGE"],
        ),
    )

    for part in response.candidates[0].content.parts:
        if part.inline_data is not None:
            img = Image.open(io.BytesIO(part.inline_data.data))
            return img

    raise Exception("No image returned from API")


def _run_generation(job_id: str, project_id: str, room_id: str, style_key: str):
    """Background worker for a single room+style generation."""
    try:
        project = load_project(project_id)
        if not project:
            jobs[job_id] = {**jobs[job_id], "status": "error", "error": "Project not found"}
            return

        room = next((r for r in project["rooms"] if r["id"] == room_id), None)
        if not room:
            jobs[job_id] = {**jobs[job_id], "status": "error", "error": "Room not found"}
            return

        image_path = str(PROJECTS_DIR / room["stored_filename"])
        current_room = room.get("room_type", "living_room")
        target_room = room.get("target_room_type")

        img = generate_room_image(image_path, style_key, current_room, target_room)

        output_filename = f"{project_id}_{room_id}_{style_key}_{uuid.uuid4().hex[:8]}.png"
        img.save(str(OUTPUTS_DIR / output_filename))

        # Update project JSON
        project = load_project(project_id)  # reload in case of concurrent writes
        room = next((r for r in project["rooms"] if r["id"] == room_id), None)
        if room:
            room.setdefault("generated", {})[style_key] = output_filename
            save_project(project)

        jobs[job_id] = {**jobs[job_id], "status": "done", "result": output_filename}

    except Exception as e:
        jobs[job_id] = {**jobs[job_id], "status": "error", "error": str(e)}


# ---------------------------------------------------------------------------
# Auth
# ---------------------------------------------------------------------------


@app.before_request
def require_login():
    allowed = ["/login", "/static/"]
    if any(request.path.startswith(p) for p in allowed):
        return
    if not session.get("authenticated"):
        return redirect("/login")


@app.route("/login", methods=["GET", "POST"])
def login():
    error = ""
    if request.method == "POST":
        if request.form.get("password") == APP_PASSWORD:
            session["authenticated"] = True
            return redirect("/")
        error = "Forkert kodeord"
    return render_template("login.html", error=error)


# ---------------------------------------------------------------------------
# Routes — pages
# ---------------------------------------------------------------------------


@app.route("/")
def index():
    return render_template("index.html")


# ---------------------------------------------------------------------------
# Routes — static files (uploads & generated)
# ---------------------------------------------------------------------------


@app.route("/uploads/<filename>")
def serve_upload(filename):
    return send_from_directory(PROJECTS_DIR, filename)


@app.route("/generated/<filename>")
def serve_generated(filename):
    return send_from_directory(OUTPUTS_DIR, filename)


# ---------------------------------------------------------------------------
# Routes — API
# ---------------------------------------------------------------------------


@app.get("/api/styles")
def get_styles():
    return jsonify(STYLES)


@app.get("/api/room-types")
def get_room_types():
    return jsonify(ROOM_TYPES)


# --- Projects CRUD ---


@app.get("/api/projects")
def list_projects():
    projects = []
    for f in sorted(PROJECTS_DIR.glob("*.json")):
        with open(f) as fp:
            projects.append(json.load(fp))
    return jsonify(projects)


@app.post("/api/projects")
def create_project():
    data = request.json or {}
    project = {
        "id": uuid.uuid4().hex[:12],
        "name": data.get("name", "Unavngivet"),
        "address": data.get("address", ""),
        "created": datetime.now().strftime("%Y-%m-%d %H:%M"),
        "rooms": [],
    }
    save_project(project)
    return jsonify(project), 201


@app.get("/api/projects/<project_id>")
def get_project(project_id):
    project = load_project(project_id)
    if not project:
        return jsonify({"error": "Not found"}), 404
    return jsonify(project)


@app.delete("/api/projects/<project_id>")
def delete_project(project_id):
    p = project_path(project_id)
    if not p.exists():
        return jsonify({"error": "Not found"}), 404
    # Delete project images
    project = load_project(project_id)
    if project:
        for room in project.get("rooms", []):
            img_path = PROJECTS_DIR / room["stored_filename"]
            if img_path.exists():
                img_path.unlink()
            for gen_file in room.get("generated", {}).values():
                gen_path = OUTPUTS_DIR / gen_file
                if gen_path.exists():
                    gen_path.unlink()
    p.unlink()
    return jsonify({"ok": True})


# --- Rooms ---


@app.post("/api/projects/<project_id>/upload")
def upload_images(project_id):
    project = load_project(project_id)
    if not project:
        return jsonify({"error": "Not found"}), 404

    files = request.files.getlist("images")
    if not files:
        return jsonify({"error": "No files"}), 400

    new_rooms = []
    for f in files:
        room_id = f"room_{uuid.uuid4().hex[:8]}"
        ext = Path(f.filename).suffix or ".jpg"
        stored = f"{project_id}_{room_id}{ext}"
        f.save(str(PROJECTS_DIR / stored))

        room = {
            "id": room_id,
            "original_filename": f.filename,
            "stored_filename": stored,
            "room_type": "living_room",
            "target_room_type": None,
            "selected_styles": [],
            "generated": {},
        }
        project["rooms"].append(room)
        new_rooms.append(room)

    save_project(project)
    return jsonify(new_rooms), 201


@app.patch("/api/projects/<project_id>/rooms/<room_id>")
def update_room(project_id, room_id):
    project = load_project(project_id)
    if not project:
        return jsonify({"error": "Not found"}), 404

    room = next((r for r in project["rooms"] if r["id"] == room_id), None)
    if not room:
        return jsonify({"error": "Room not found"}), 404

    data = request.json or {}
    for key in ("room_type", "target_room_type", "selected_styles"):
        if key in data:
            room[key] = data[key]

    save_project(project)
    return jsonify(room)


@app.delete("/api/projects/<project_id>/rooms/<room_id>")
def delete_room(project_id, room_id):
    project = load_project(project_id)
    if not project:
        return jsonify({"error": "Not found"}), 404

    room = next((r for r in project["rooms"] if r["id"] == room_id), None)
    if not room:
        return jsonify({"error": "Room not found"}), 404

    # Clean up files
    img_path = PROJECTS_DIR / room["stored_filename"]
    if img_path.exists():
        img_path.unlink()
    for gen_file in room.get("generated", {}).values():
        gen_path = OUTPUTS_DIR / gen_file
        if gen_path.exists():
            gen_path.unlink()

    project["rooms"] = [r for r in project["rooms"] if r["id"] != room_id]
    save_project(project)
    return jsonify({"ok": True})


# --- Delete generated image ---


@app.delete("/api/projects/<project_id>/rooms/<room_id>/generated/<style_key>")
def delete_generated(project_id, room_id, style_key):
    project = load_project(project_id)
    if not project:
        return jsonify({"error": "Not found"}), 404

    room = next((r for r in project["rooms"] if r["id"] == room_id), None)
    if not room:
        return jsonify({"error": "Room not found"}), 404

    gen_file = room.get("generated", {}).pop(style_key, None)
    if gen_file:
        gen_path = OUTPUTS_DIR / gen_file
        if gen_path.exists():
            gen_path.unlink()

    save_project(project)
    return jsonify({"ok": True})


# --- Generation (async via threads) ---


@app.post("/api/projects/<project_id>/rooms/<room_id>/generate")
def generate_room(project_id, room_id):
    project = load_project(project_id)
    if not project:
        return jsonify({"error": "Not found"}), 404

    room = next((r for r in project["rooms"] if r["id"] == room_id), None)
    if not room:
        return jsonify({"error": "Room not found"}), 404

    data = request.json or {}
    styles = data.get("styles", room.get("selected_styles", []))
    if not styles:
        return jsonify({"error": "No styles selected"}), 400

    launched = []
    for style_key in styles:
        if style_key not in STYLES:
            continue
        job_id = uuid.uuid4().hex[:12]
        jobs[job_id] = {"status": "generating", "room_id": room_id, "style": style_key, "result": None, "error": None}
        t = threading.Thread(target=_run_generation, args=(job_id, project_id, room_id, style_key), daemon=True)
        t.start()
        launched.append({"job_id": job_id, "style": style_key})

    return jsonify(launched)


@app.post("/api/projects/<project_id>/generate-all")
def generate_all(project_id):
    project = load_project(project_id)
    if not project:
        return jsonify({"error": "Not found"}), 404

    launched = []
    for room in project["rooms"]:
        styles = room.get("selected_styles", [])
        for style_key in styles:
            if style_key not in STYLES:
                continue
            # Skip already generated
            if style_key in room.get("generated", {}):
                continue
            job_id = uuid.uuid4().hex[:12]
            jobs[job_id] = {"status": "generating", "room_id": room["id"], "style": style_key, "result": None, "error": None}
            t = threading.Thread(target=_run_generation, args=(job_id, project_id, room["id"], style_key), daemon=True)
            t.start()
            launched.append({"job_id": job_id, "room_id": room["id"], "style": style_key})

    return jsonify(launched)


@app.get("/api/jobs/<job_id>")
def get_job(job_id):
    job = jobs.get(job_id)
    if not job:
        return jsonify({"error": "Job not found"}), 404
    return jsonify({"job_id": job_id, **job})


@app.get("/api/jobs")
def list_jobs():
    """Return all active (non-done) jobs, useful for polling."""
    active = {jid: j for jid, j in jobs.items() if j["status"] == "generating"}
    return jsonify(active)


# ---------------------------------------------------------------------------
# Run
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    app.run(debug=True, port=5050, threaded=True)
