import os
import subprocess
import threading
import time
import glob
from pyftpdlib.handlers import FTPHandler
from pyftpdlib.servers import FTPServer
from pyftpdlib.authorizers import DummyAuthorizer
from watchdog.observers import Observer
from watchdog.events import FileSystemEventHandler
import boto3
from botocore.client import Config

# Configurazione tramite variabili ambiente
FTP_USER = os.getenv("FTP_USER", "user")
FTP_PASS = os.getenv("FTP_PASS", "password")
FTP_PORT = int(os.getenv("FTP_PORT", "21"))

R2_ACCESS_KEY = os.getenv("R2_ACCESS_KEY")
R2_SECRET_KEY = os.getenv("R2_SECRET_KEY")
R2_ENDPOINT = os.getenv("R2_ENDPOINT")  # es: https://<account_id>.r2.cloudflarestorage.com
R2_BUCKET = os.getenv("R2_BUCKET", "episodi")

UPLOAD_DIR = "/app/upload"
OUTPUT_DIR = "/app/episodi"

if not all([R2_ACCESS_KEY, R2_SECRET_KEY, R2_ENDPOINT]):
    raise Exception("Variabili ambiente R2_ACCESS_KEY, R2_SECRET_KEY e R2_ENDPOINT devono essere impostate!")

os.makedirs(UPLOAD_DIR, exist_ok=True)
os.makedirs(OUTPUT_DIR, exist_ok=True)

# Setup client boto3 per R2
s3_client = boto3.client(
    "s3",
    endpoint_url=R2_ENDPOINT,
    aws_access_key_id=R2_ACCESS_KEY,
    aws_secret_access_key=R2_SECRET_KEY,
    config=Config(signature_version="s3v4"),
    region_name="auto",
)

def upload_file_to_r2(local_path, remote_path):
    print(f"Uploading {local_path} to R2 at {remote_path}...")
    try:
        s3_client.upload_file(local_path, R2_BUCKET, remote_path)
        print(f"Uploaded {remote_path} successfully.")
    except Exception as e:
        print(f"Upload error: {e}")

def convert_to_hls(filepath):
    filename = os.path.basename(filepath)
    episode_name = os.path.splitext(filename)[0]
    episode_folder = os.path.join(OUTPUT_DIR, episode_name)
    os.makedirs(episode_folder, exist_ok=True)

    hls_output = os.path.join(episode_folder, f"{episode_name}.m3u8")

    cmd = [
        "ffmpeg", "-i", filepath,
        "-profile:v", "baseline", "-level", "3.0",
        "-start_number", "0",
        "-hls_time", "10",
        "-hls_list_size", "0",
        "-f", "hls",
        hls_output
    ]

    print(f"Converting {filename} to HLS...")
    result = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if result.returncode == 0:
        print(f"Conversion completed: {episode_name}")
        # Upload all files in episode folder
        files_to_upload = glob.glob(os.path.join(episode_folder, "*"))
        for f in files_to_upload:
            remote_path = f"{episode_name}/{os.path.basename(f)}"
            upload_file_to_r2(f, remote_path)
        # Optionally remove original video to save space
        os.remove(filepath)
    else:
        print(f"Conversion error: {result.stderr.decode()}")

class UploadHandler(FileSystemEventHandler):
    def on_created(self, event):
        if not event.is_directory and event.src_path.endswith(('.mp4', '.mov', '.mkv')):
            print(f"New video detected: {event.src_path}")
            # Run conversion in a separate thread to not block FTP
            threading.Thread(target=convert_to_hls, args=(event.src_path,)).start()

def start_ftp_server():
    authorizer = DummyAuthorizer()
    authorizer.add_user(FTP_USER, FTP_PASS, UPLOAD_DIR, perm="elradfmw")  # full permissions
    handler = FTPHandler
    handler.authorizer = authorizer

    server = FTPServer(("0.0.0.0", FTP_PORT), handler)
    print(f"Starting FTP server on port {FTP_PORT} with user {FTP_USER}")
    server.serve_forever()

def start_watcher():
    event_handler = UploadHandler()
    observer = Observer()
    observer.schedule(event_handler, UPLOAD_DIR, recursive=False)
    observer.start()
    print(f"Watching upload folder {UPLOAD_DIR} for new files...")
    try:
        while True:
            time.sleep(1)
    except KeyboardInterrupt:
        observer.stop()
    observer.join()

if __name__ == "__main__":
    # Avvia FTP e watcher in thread separati
    ftp_thread = threading.Thread(target=start_ftp_server, daemon=True)
    ftp_thread.start()

    start_watcher()
