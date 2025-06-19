const express = require("express");
const multer = require("multer");
const { exec } = require("child_process");
const fs = require("fs");
const AWS = require("aws-sdk");
const { v4: uuidv4 } = require("uuid");

const upload = multer({ dest: "/tmp" });
const app = express();
const port = process.env.PORT || 3000;

// Cloudflare R2 config
const s3 = new AWS.S3({
  endpoint: process.env.R2_ENDPOINT,
  accessKeyId: process.env.R2_ACCESS_KEY,
  secretAccessKey: process.env.R2_SECRET_KEY,
  region: "auto",
  s3ForcePathStyle: true,
});

app.post("/upload", upload.single("video"), async (req, res) => {
  const inputPath = req.file.path;
  const outputPath = `/tmp/${uuidv4()}.mp4`;
  const filename = `${uuidv4()}.mp4`;

  res.json({ message: "Upload ricevuto, elaborazione in corso." });

  exec(`ffmpeg -i ${inputPath} -movflags faststart -c copy ${outputPath}`, (err) => {
    if (err) return console.error("Errore durante il processing:", err);

    const fileStream = fs.createReadStream(outputPath);

    s3.upload(
      {
        Bucket: process.env.R2_BUCKET,
        Key: filename,
        Body: fileStream,
        ContentType: "video/mp4",
      },
      (err, data) => {
        if (err) return console.error("Errore upload su R2:", err);
        console.log("✅ Upload riuscito:", data.Location);
      }
    );
  });
});

app.listen(port, () => console.log(`🚀 Server avviato su porta ${port}`));
