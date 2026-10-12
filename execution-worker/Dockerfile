# Workday-execution engine — one container execution processes one scenario
# (see runner.py's module docstring). Base image already ships a matching
# Chromium build + all its OS-level dependencies, avoiding the usual
# apt-get dance for headless-browser containers.
FROM mcr.microsoft.com/playwright/python:v1.47.0-jammy

# Python fully block-buffers stdout when it isn't attached to a TTY (true of
# every container) — without this, log.info() output sits in an internal
# buffer and never reaches `az containerapp job logs show`/Log Analytics
# until the process exits, making a genuinely-hung process look identical to
# one that's silently working. Confirmed live: zero log lines appeared from
# 6 real executions that ran for 5+ minutes before this was added.
ENV PYTHONUNBUFFERED=1

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY runner.py .

# Run-to-completion job, not a long-lived server — no EXPOSE/CMD server loop.
CMD ["python", "runner.py"]
