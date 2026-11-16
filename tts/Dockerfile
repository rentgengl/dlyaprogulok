# Озвучка на Piper. Голоса denis и dmitri: датасеты под CC0.
# Piper (piper1-gpl) распространяется по GPL-3.0; сервер Node обращается к нему по сети.
FROM python:3.12-slim-bookworm

RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg \
 && rm -rf /var/lib/apt/lists/*

RUN pip install --no-cache-dir piper-tts==1.8.0

# Голоса скачиваются при сборке: контейнеру не нужен интернет во время работы.
RUN mkdir /voices \
 && python -m piper.download_voices --data-dir /voices ru_RU-denis-medium ru_RU-dmitri-medium

COPY server.py /app/server.py

USER nobody
EXPOSE 8880
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8880/health', timeout=4)"
CMD ["python", "/app/server.py"]
