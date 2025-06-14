#!/bin/bash

# Avvia worker Python in background
python3 /app/worker.py &

# Avvia il server SFTP (entrypoint originale di atmoz/sftp)
/entrypoint "$@"
