const express = require("express");
const AWS = require("aws-sdk");
const { exec } = require("child_process");
const fs = require("fs");
const path = require("path");
const axios = require("axios");
const { MongoClient } = require("mongodb");
const { v4: uuidv4 } = require("uuid");

const app = express();
app.use(express.json());

// Serve i file statici da public/ (dove metterai index.html)
app.use(express.static(path.join(__dirname, "public")));

const s3 = new AWS.S3({
  endpoint: process.env.R2_ENDPOINT,
  accessKeyId: process.env.R2_ACCESS_KEY,
  secretAccessKey: process.env.R2_SECRET_KEY,
  region: "auto",
  s3ForcePathStyle: true,
});

const mongoClient = new MongoClient(process.env.MONGO_URI);
const R2_BUCKET = process.env.R2_BUCKET;

// GET / ora serve index.html dalla cartella public automaticamente

// POST per generare presigned URL per upload diretto su Cloudflare R2
app.post("/generate-presigned-url", (req, res) => {
  const { filename, contentType } = req.body;
  if (!filename || !contentType) {
    return res.status(400).json({ error: "filename e contentType richiesti" });
  }

  const key = `uploads/${uuidv4()}-${filename}`;

  const params = {
    Bucket: R2_BUCKET,
    Key: key,
    Expires: 3600, // 1 ora validità
    ContentType: contentType,
  };

  s3.getSignedUrl("putObject", params, (err, url) => {
    if (err) {
      console.error("Errore generazione presigned URL", err);
      return res.status(500).json({ error: "Errore generazione URL" });
    }
    res.json({ uploadUrl: url, key });
  });
});

// POST per notifica upload completato, processing e aggiornamento MongoDB
app.post("/notify-upload", async (req, res) => {
  const { key, season, episodeNumber } = req.body;
  if (!key || !season || !episodeNumber) {
    return res.status(400).json({ error: "key, season e episodeNumber richiesti" });
  }

  const tempFilePath = path.join("/tmp", `${uuidv4()}.mp4`);
  const processedFilePath = path.join("/tmp", `${uuidv4()}-processed.mp4`);

  try {
    // Scarica il file da R2
    const fileUrl = `https://${R2_BUCKET}.${process.env.R2_ENDPOINT.replace("https://", "")}/${key}`;
    const response = await axios({
      method: "GET",
      url: fileUrl,
      responseType: "stream",
    });

    const writer = fs.createWriteStream(tempFilePath);
    response.data.pipe(writer);

    await new Promise((resolve, reject) => {
      writer.on("finish", resolve);
      writer.on("error", reject);
    });

    // Applica flag moov atom con ffmpeg
    await new Promise((resolve, reject) => {
      exec(`ffmpeg -i ${tempFilePath} -movflags faststart -c copy ${processedFilePath}`, (err) => {
        if (err) return reject(err);
        resolve();
      });
    });

    // Carica file processato su R2 (stesso key per sovrascrivere)
    const fileStream = fs.createReadStream(processedFilePath);
    await s3
      .putObject({
        Bucket: R2_BUCKET,
        Key: key,
        Body: fileStream,
        ContentType: "video/mp4",
      })
      .promise();

    // Aggiorna MongoDB
    await mongoClient.connect();
    const db = mongoClient.db();
    const episodi = db.collection("supervideo_episodes");

    const filter = {
      season: parseInt(season),
      episodeNumber: parseInt(episodeNumber),
    };
    const update = {
      $set: { videoUrl: fileUrl },
    };

    const result = await episodi.updateOne(filter, update);
    if (result.modifiedCount !== 1) {
      console.warn("Nessun episodio aggiornato, controlla season/episodeNumber");
    }

    res.json({ message: "Upload processato e DB aggiornato", videoUrl: fileUrl });
  } catch (error) {
    console.error("Errore processing upload:", error);
    res.status(500).json({ error: "Errore durante processing" });
  } finally {
    try {
      fs.unlinkSync(tempFilePath);
      fs.unlinkSync(processedFilePath);
      await mongoClient.close();
    } catch {}
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Server avviato su porta ${port}`));
