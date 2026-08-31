#!/usr/bin/env python3
"""
Create the AI-mentor ElevenLabs agent from your own machine.

Run it, paste a NEW ElevenLabs API key when prompted (it's hidden and never
leaves your computer — not stored, not committed, not sent anywhere but
ElevenLabs). It creates a Conversational-AI agent with the mentor prompt and a
warm voice, and prints the AGENT ID.

    python3 scripts/create-eleven-agent.py

Then: (1) in the ElevenLabs dashboard, open the agent → Security → make it
PUBLIC (turn off "require authentication"); (2) paste the printed agent id into
the platform under Settings → "AI voice mentor (ElevenLabs)".

The key needs Conversational-AI permission. If your key is a restricted one and
this fails with 401/permission, make the agent in the dashboard instead (same
prompt + voice) — it's a couple of clicks and you can test the voice right there.
"""
import getpass
import json
import sys
import urllib.request
import urllib.error

API = "https://api.elevenlabs.io/v1"

# A warm, conversational mentor. Uses {{first_name}}/{{period}}/{{modules}} so the
# app can inject the real student. Keep in step with AI_MENTOR_PROMPT in the app.
PROMPT = """You are a warm, encouraging academic mentor for a university sport programme, running a one-on-one academic development check-in with a student-athlete by voice. You are NOT a human — if asked, say you're the programme's AI mentor and that a real person reviews every plan.

The student is {{first_name}}, in {{period}}. Their registered modules are: {{modules}}.

This is a spoken chat, so sound like a real, relaxed person, not a form. ONE question at a time — ask, then stop and listen. Always react first, then ask: reflect what you heard in a few words ("ah, on and off — that's really common in season") before the next question, with little affirmations ("got it", "no stress", "love that"). Draw them out with open questions and gentle follow-ups; vary your phrasing. Numbers are for you, not them — instead of "rate 1 to 5", ask how it's going and gauge it yourself.

Run it in this order: 1) warmly welcome them, say it's about ten minutes and helps line up support; 2) for each module, quickly get a feel for attendance, whether the content clicks, and how they're going with assessments; 3) walk through the four areas — understanding the content, assessments, work-life balance, careers — drawing them out on each; 4) where something's a struggle, suggest one or two small, doable actions and check they're happy; 5) agree a next catch-in; 6) warmly summarise and thank them.

If the student sounds distressed, overwhelmed, unsafe, or mentions self-harm, money or housing crisis, warmly tell them you're making sure a person from the office reaches out today, and continue gently only if they're comfortable. Give no medical, legal or financial advice — route to the relevant university service."""

FIRST_MESSAGE = "Hey {{first_name}}! Good to actually talk to you. Ready when you are?"


def req(method, path, key, body=None):
    data = json.dumps(body).encode() if body is not None else None
    r = urllib.request.Request(
        API + path, data=data, method=method,
        headers={"xi-api-key": key, "content-type": "application/json"},
    )
    try:
        with urllib.request.urlopen(r, timeout=30) as resp:
            return resp.status, json.loads(resp.read() or "{}")
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read() or "{}")
        except Exception:
            return e.code, {"detail": str(e)}


def main():
    key = getpass.getpass("Paste your ElevenLabs API key (hidden), then Enter: ").strip()
    if not key:
        sys.exit("No key entered.")

    # Pick a warm English voice (falls back to a well-known default).
    voice_id = "EXAVITQu4vr4xnSDxMaL"  # "Sarah" — a friendly default
    status, voices = req("GET", "/voices", key)
    if status == 200 and voices.get("voices"):
        picked = next(
            (v for v in voices["voices"] if "sarah" in (v.get("name", "").lower())),
            voices["voices"][0],
        )
        voice_id = picked["voice_id"]
        print(f"Using voice: {picked.get('name')} ({voice_id})")

    body = {
        "name": "UCT Academic Mentor",
        "conversation_config": {
            "agent": {
                "prompt": {"prompt": PROMPT},
                "first_message": FIRST_MESSAGE,
                "language": "en",
            },
            "tts": {"voice_id": voice_id},
        },
    }
    status, out = req("POST", "/convai/agents/create", key, body)
    if status not in (200, 201):
        print(f"\n✗ Create failed (HTTP {status}):")
        print(json.dumps(out, indent=2))
        print(
            "\nIf this is a permissions error, your key can't manage agents — "
            "create the agent in the ElevenLabs dashboard instead (paste the same "
            "prompt + pick a voice), then just copy its agent id."
        )
        sys.exit(1)

    agent_id = out.get("agent_id") or out.get("agent", {}).get("agent_id")
    print("\n✓ Agent created.")
    print(f"\n  AGENT ID:  {agent_id}\n")
    print("Next, two quick things:")
    print("  1. ElevenLabs dashboard → open this agent → Security → make it PUBLIC")
    print("     (turn OFF 'require authentication').")
    print("  2. In the platform: Settings → 'AI voice mentor (ElevenLabs)' →")
    print(f"     paste  {agent_id}  → Save.")
    print("\nThen open any AI-mentor link — it'll use the real ElevenLabs voice.")
    print("(Remember to rotate any key you've shared elsewhere.)")


if __name__ == "__main__":
    main()
