import os
import time
import boto3
from watchdog.observers import Observer
from watchdog.events import FileSystemEventHandler
from pymongo import MongoClient
from dotenv import load_dotenv

load_dotenv()

# Variabili d'ambiente
R2_ENDPOINT = os.getenv("R2_ENDPOINT")
R2_ACCESS_KEY = os.getenv("R2_ACCESS_KEY")
R2_SECRET_KEY = os.getenv("R2_SECRET_KEY")
R2_BUCKET = os.getenv("R2_BUCKET")
MONGO_URI = os.getenv("MONGO_URI")

# Configura boto3 per R2
s3 = boto3.client('s3',
                  endpoint_url=R2_ENDPOINT,
                  aws_access_key_id=R2_ACCESS_KEY,
                  aws_secret_access_key=R2_SECRET_KEY)

# Configura MongoDB
mongo_client = MongoClient(MONGO_URI)
db = mongo_client['MiraculousItalia']
episodi = db['episodi']

UPLOAD_FOLDER = "/home/sftpuser/upload"

def process_file(path):
    print(f"Processo file: {path}")
    filename = os.path.basename(path)

    # Upload diretto su R2
    with open(path, 'rb') as f:
        s3.upload_fileobj(f, R2_BUCKET, filename)
    print(f"Caricato {filename} su R2")

    # Aggiorna MongoDB usando nome file per stagione e episodio
    # Esempio nome file: IT101_xyz123.mp4
    # Prendiamo i 3 numeri: 101 -> stagione 1 episodio 01
    stagione = int(filename[2])
    episodio = int(filename[3:5])

    url_file = f"https://{R2_BUCKET}.r2.cloudflarestorage.com/{filename}"

    # Aggiorna documento episodio
    filter_query = {'season': stagione, 'episodeNumber': episodio}
    update_data = {'$set': {'videoUrl': url_file}}

    result = episodi.update_one(filter_query, update_data)
    if result.matched_count == 0:
        print(f"Nessun episodio trovato per S{stagione}E{episodio}, creazione nuovo.")
        episodi.insert_one({
            'season': stagione,
            'episodeNumber': episodio,
            'videoUrl': url_file,
            'title': 'Unknown',
            'slug': f'{stagione}x{episodio:02d}-unknown'
        })

class UploadHandler(FileSystemEventHandler):
    def on_created(self, event):
        if not event.is_directory and event.src_path.endswith('.mp4'):
            # Aspetta un attimo per sicurezza
            time.sleep(2)
            process_file(event.src_path)

if __name__ == "__main__":
    event_handler = UploadHandler()
    observer = Observer()
    observer.schedule(event_handler, UPLOAD_FOLDER, recursive=False)
    observer.start()
    print("Watcher avviato, in attesa di nuovi file...")
    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        observer.stop()
    observer.join()
