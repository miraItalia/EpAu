from fastapi import FastAPI, File, UploadFile
from fastapi.responses import JSONResponse
import os
import uuid
import subprocess
import boto3
from botocore.client import Config

app = FastAPI()

# Config Cloudflare R2
R2_ENDPOINT = "https://<your-account-id>.r2.cloudflarestorage.com"
R2_ACCESS_KEY = "<your-access-key>"
R2_SECRET_KEY = "<your-secret-key>"
R2_BUCKET = "<your-bucket-name>"

session = boto3.session.Session()
s3 = session.client(
    "s3",
    region_name="auto",
    endpoint_url=R2_ENDPOINT,
    aws_access_key_id=R2_ACCESS_KEY,
    aws_secret_access_key=R2_SECRET_KEY,
    config=Config(signature_version="s3v4"),
)

TMP_DIR = "/tmp/uploads"

os.makedirs(TMP_DIR, exist_ok=True)

def convert_to_hls(input_path, output_dir):
    os.makedirs(output_dir, exist_ok=True)
    cmd = [
        "ffmpeg",
        "-i", input_path,
        "-codec:", "copy",
        "-start_number", "0",
        "-hls_time", "10",
        "-hls_list_size", "0",
        "-f", "hls",
        os.path.join(output_dir, "index.m3u8"),
    ]
    subprocess.run(cmd, check=True)

def upload_folder_to_r2(folder_path, r2_folder):
    for root, _, files in os.walk(folder_path):
        for file in files:
            full_path = os.path.join(root, file)
            key = os.path.join(r2_folder, file)
            s3.upload_file(full_path, R2_BUCKET, key)

@app.post("/upload/")
async def upload(files: list[UploadFile] = File(...)):
    results = []
    for file in files:
        # salva file temporaneo
        uid = str(uuid.uuid4())
        video_path = os.path.join(TMP_DIR, f"{uid}_{file.filename}")
        with open(video_path, "wb") as f:
            content = await file.read()
            f.write(content)

        # crea cartella output HLS
        hls_output = os.path.join(TMP_DIR, f"hls_{uid}")
        convert_to_hls(video_path, hls_output)

        # upload su R2
        r2_folder = f"episodes/{uid}"
        upload_folder_to_r2(hls_output, r2_folder)

        # pulizia
        os.remove(video_path)
        for root, _, files in os.walk(hls_output):
            for f_name in files:
                os.remove(os.path.join(root, f_name))
        os.rmdir(hls_output)

        results.append({"filename": file.filename, "r2_path": r2_folder})

    return JSONResponse({"uploaded": results})
