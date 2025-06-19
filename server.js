const express = require("express");
const multer = require("multer");
const { exec } = require("child_process");
const fs = require("fs");
const path = require("path");
const AWS = require("aws-sdk");
const { v4: uuidv4 } = require("uuid");

const upload = multer({ dest: "/tmp" });
const app = express();
const port = process.env.PORT || 3000;

// Serve index.html nella root
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// R2 config
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

  // Rispondi subito al client
  res.json({ message: "✅ Upload ricevuto. Il file sarà elaborato e caricato." });

  // In background: processa con ffmpeg
  exec(`ffmpeg -i ${inputPath} -movflags faststart -c copy ${outputPath}`, (err) => {
    if (err) {
      console.error("❌ Errore durante il processing ffmpeg:", err);
      return;
    }

    const fileStream = fs.createReadStream(outputPath);

    // Carica su R2
    s3.upload(
      {
        Bucket: process.env.R2_BUCKET,
        Key: filename,
        Body: fileStream,
        ContentType: "video/mp4",
      },
      (err, data) => {
        if (err) {
          console.error("❌ Errore durante l'upload su R2:", err);
        } else {
          console.log("✅ Upload su R2 riuscito:", data.Location);
        }
      }
    );
  });
});

app.listen(port, () => console.log(`🚀 Server avviato su porta ${port}`));
