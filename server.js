const express = require("express");
const multer = require("multer");
const { exec } = require("child_process");
const fs = require("fs");
const path = require("path");
const AWS = require("aws-sdk");
const { v4: uuidv4 } = require("uuid");
const { MongoClient } = require("mongodb");

const upload = multer({ dest: "/tmp" });
const app = express();
const port = process.env.PORT || 3000;

app.use(express.urlencoded({ extended: true }));

// Serve index.html nella root
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// Config R2 (Cloudflare)
const s3 = new AWS.S3({
  endpoint: process.env.R2_ENDPOINT,
  accessKeyId: process.env.R2_ACCESS_KEY,
  secretAccessKey: process.env.R2_SECRET_KEY,
  region: "auto",
  s3ForcePathStyle: true,
});

// Config MongoDB
const mongoClient = new MongoClient(process.env.MONGO_URI);

app.post("/upload", upload.single("video"), async (req, res) => {
  const inputPath = req.file.path;
  const fileSizeBytes = req.file.size;
  const maxTotalBytes = 10 * 1024 * 1024 * 1024; // 10 GB limit
  const { season, episodeNumber } = req.body;

  // Funzione ricorsiva per calcolare spazio usato nel bucket
  let totalUsedBytes = 0;
  const listAllObjects = async (ContinuationToken = null) => {
    const params = {
      Bucket: process.env.R2_BUCKET,
      ContinuationToken,
    };
    const data = await s3.listObjectsV2(params).promise();
    data.Contents.forEach(obj => totalUsedBytes += obj.Size);
    if (data.IsTruncated) {
      await listAllObjects(data.NextContinuationToken);
    }
  };

  try {
    await listAllObjects();

    if (totalUsedBytes + fileSizeBytes > maxTotalBytes) {
      // Rimuovi file temporaneo e blocca
      fs.unlinkSync(inputPath);
      return res.status(413).send("❌ Spazio esaurito: superi i 10 GB disponibili.");
    }
  } catch (err) {
    console.error("❌ Errore nel controllo spazio R2:", err);
    return res.status(500).send("Errore nel controllo spazio R2");
  }

  // Rispondi subito al client
  res.send("✅ Upload ricevuto. File in elaborazione...");

  // Prepara output path e nome file R2
  const outputPath = `/tmp/${uuidv4()}.mp4`;
  const filename = `${uuidv4()}.mp4`;
  const r2Key = `video/${filename}`;

  // Esegui ffmpeg con flag faststart
  exec(`ffmpeg -i ${inputPath} -movflags faststart -c copy ${outputPath}`, async (err) => {
    if (err) {
      console.error("❌ Errore FFMPEG:", err);
      return;
    }

    const fileStream = fs.createReadStream(outputPath);

    s3.upload({
      Bucket: process.env.R2_BUCKET,
      Key: r2Key,
      Body: fileStream,
      ContentType: "video/mp4",
    }, async (err, data) => {
      if (err) {
        console.error("❌ Errore upload R2:", err);
        return;
      }

      console.log("✅ Upload R2 riuscito:", data.Location);

      // Aggiorna MongoDB
      try {
        await mongoClient.connect();
        const db = mongoClient.db(); // usa DB default
        const episodi = db.collection("supervideo_episodes");

        const filter = {
          season: parseInt(season),
          episodeNumber: parseInt(episodeNumber),
        };
        const update = {
          $set: {
            videoUrl: data.Location,
          },
        };

        const result = await episodi.updateOne(filter, update);

        if (result.modifiedCount === 1) {
          console.log("✅ Episodio aggiornato in MongoDB");
        } else {
          console.warn("⚠️ Nessun episodio aggiornato. Controlla i dati di stagione e episodio.");
        }
      } catch (mongoErr) {
        console.error("❌ Errore MongoDB:", mongoErr);
      } finally {
        await mongoClient.close();
      }
    });
  });
});

app.listen(port, () => console.log(`🚀 Server avviato su porta ${port}`));
