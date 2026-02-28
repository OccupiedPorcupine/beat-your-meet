import logging
import os
import json
from pathlib import Path
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from livekit import api
from mistralai import Mistral
from dotenv import load_dotenv

# Resolve absolute path to .env so it works regardless of CWD or how Python
# was invoked (e.g. `python main.py` vs `uvicorn main:app` from project root).
_dotenv_path = Path(__file__).resolve().parent.parent / ".env"
load_dotenv(_dotenv_path)

logger = logging.getLogger("beat-your-meet-server")
logger.setLevel(logging.INFO)

app = FastAPI(title="Beat Your Meet API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

mistral_client = Mistral(api_key=os.environ.get("MISTRAL_API_KEY", ""))


# ── Models ────────────────────────────────────────────────────────────


class TokenRequest(BaseModel):
    room_name: str
    participant_name: str


class AgendaRequest(BaseModel):
    description: str
    duration_minutes: int


class CreateRoomRequest(BaseModel):
    agenda: dict
    style: str  # "gentle" | "moderate" | "chatting"


# ── Token Generation ─────────────────────────────────────────────────


@app.post("/api/token")
async def generate_token(req: TokenRequest):
    try:
        token = api.AccessToken(
            os.environ["LIVEKIT_API_KEY"],
            os.environ["LIVEKIT_API_SECRET"],
        )
        token.with_identity(req.participant_name)
        token.with_name(req.participant_name)
        token.with_grants(
            api.VideoGrants(
                room_join=True,
                room=req.room_name,
                can_publish=True,
                can_subscribe=True,
                can_publish_data=True,
            )
        )
        return {"token": token.to_jwt()}
    except KeyError as e:
        logger.error(f"Missing env var for token generation: {e}")
        raise HTTPException(status_code=500, detail=f"Server misconfigured: missing {e}")
    except Exception as e:
        logger.exception("Token generation failed")
        raise HTTPException(status_code=500, detail=str(e))


# ── Agenda Generation ────────────────────────────────────────────────


AGENDA_GENERATION_PROMPT = """Based on the meeting description below, generate a structured agenda.

Meeting Description:
{description}

Total meeting duration: {duration_minutes} minutes

Generate a JSON object with this exact structure:
{{
  "title": "Meeting title",
  "items": [
    {{
      "id": 1,
      "topic": "Topic name",
      "description": "Brief description of what to cover",
      "duration_minutes": 10
    }}
  ],
  "total_minutes": {duration_minutes}
}}

Rules:
- Keep the total duration of all items within {duration_minutes} minutes
- Each item should have a clear, concise topic name
- Order items by priority (most important first)
- Be realistic about time — discussion takes longer than you think
- Aim for 3-6 items depending on the total duration
"""


@app.post("/api/agenda")
async def generate_agenda(req: AgendaRequest):
    if not os.environ.get("MISTRAL_API_KEY"):
        raise HTTPException(status_code=500, detail="MISTRAL_API_KEY not configured")

    try:
        response = await mistral_client.chat.complete_async(
            model="mistral-large-latest",
            messages=[
                {
                    "role": "system",
                    "content": "You are a meeting planning assistant. Generate structured agendas in JSON format. Only output valid JSON.",
                },
                {
                    "role": "user",
                    "content": AGENDA_GENERATION_PROMPT.format(
                        description=req.description,
                        duration_minutes=req.duration_minutes,
                    ),
                },
            ],
            response_format={"type": "json_object"},
            temperature=0.3,
            max_tokens=1024,
        )

        agenda = json.loads(response.choices[0].message.content)
        return agenda
    except json.JSONDecodeError as e:
        logger.error(f"Mistral returned invalid JSON for agenda: {e}")
        raise HTTPException(status_code=502, detail="LLM returned invalid JSON")
    except Exception as e:
        logger.exception("Agenda generation failed")
        raise HTTPException(status_code=502, detail=f"Agenda generation failed: {e}")


# ── Room Creation ────────────────────────────────────────────────────


@app.post("/api/room")
async def create_room(req: CreateRoomRequest):
    import uuid

    room_name = f"meet-{uuid.uuid4().hex[:8]}"

    # Store room metadata (agenda + style) in LiveKit room metadata
    room_metadata = json.dumps(
        {
            "agenda": req.agenda,
            "style": req.style,
        }
    )

    try:
        lk_api = api.LiveKitAPI(
            os.environ["LIVEKIT_URL"],
            os.environ["LIVEKIT_API_KEY"],
            os.environ["LIVEKIT_API_SECRET"],
        )
        try:
            await lk_api.room.create_room(
                api.CreateRoomRequest(
                    name=room_name,
                    metadata=room_metadata,
                )
            )
        finally:
            await lk_api.aclose()
    except KeyError as e:
        logger.error(f"Missing env var for room creation: {e}")
        raise HTTPException(status_code=500, detail=f"Server misconfigured: missing {e}")
    except Exception as e:
        logger.exception("Room creation failed")
        raise HTTPException(status_code=502, detail=f"Failed to create LiveKit room: {e}")

    logger.info(f"Created room: {room_name}")
    return {"room_name": room_name}


# ── Health Check ─────────────────────────────────────────────────────


@app.get("/api/health")
async def health():
    return {"status": "ok"}


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=8000)
