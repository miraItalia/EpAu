const fs = require('fs').promises;
const path = require('path');
const { execSync } = require('child_process');
const { MongoClient } = require('mongodb');
const axios = require('axios');

// Configurazioni
const config = {
  UPLOAD_DIR: '/data/uploads',
  TEMP_DIR: '/data/temp',
  STATE_FILE: '/data/state.json',
  MAX_REPO_SIZE: 4.5 * 1024 * 1024 * 1024, // 4.5 GB
  REPO_PREFIX: 'miraEp',
  GITHUB_OWNER: 'miraItalia',
  TELEGRAM_TOKEN: process.env.TELEGRAM_TOKEN,
  TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID,
  GITHUB_TOKEN: process.env.GITHUB_TOKEN,
  MONGODB_URI: process.env.MONGODB_URI
};

// Stato iniziale
const initialState = {
  currentRepo: 'miraEp1',
  repos: {
    'miraEp1': { size: 0, files: 0 }
  },
  nextRepoIndex: 2
};

// Funzione principale
async function main() {
  try {
    // Carica stato
    const state = await loadState();
    
    // Processa file
    const files = await fs.readdir(config.UPLOAD_DIR);
    const mp4Files = files.filter(f => f.endsWith('.mp4'));
    
    for (const file of mp4Files) {
      try {
        const filePath = path.join(config.UPLOAD_DIR, file);
        await processVideo(filePath, state);
      } catch (err) {
        await sendTelegram(`❌ Errore elaborazione ${file}: ${err.message}`);
      }
    }
  } catch (err) {
    console.error('Errore critico:', err);
    await sendTelegram(`🔥 ERRORE CRITICO: ${err.message}`);
  }
}

async function processVideo(filePath, state) {
  const filename = path.basename(filePath);
  
  // Estrazione metadata
  const [, seasonChar, epChar1, epChar2] = filename;
  const season = parseInt(seasonChar);
  const episode = parseInt(epChar1 + epChar2);
  
  if (isNaN(season) || isNaN(episode)) {
    throw new Error('Formato nome file non valido');
  }

  await sendTelegram(`⏳ Inizio elaborazione: Stagione ${season} Episodio ${episode}`);
  
  // Preparazione cartelle
  const tempDir = path.join(config.TEMP_DIR, filename.replace('.mp4', ''));
  await fs.mkdir(tempDir, { recursive: true });
  
  // Conversione HLS (CPU-optimized)
  await sendTelegram(`🔧 Conversione HLS in corso...`);
  execSync(
    `ffmpeg -i "${filePath}" -c:v libx264 -preset ultrafast -crf 23 -c:a aac -b:a 128k ` +
    `-hls_time 6 -hls_list_size 0 -threads 0 -f hls "${path.join(tempDir, 'video.m3u8')}"`,
    { stdio: 'inherit' }
  );
  
  // Calcolo dimensione
  const stats = await fs.stat(filePath);
  const videoSize = stats.size;
  
  // Selezione/crazione repo
  let targetRepo = state.currentRepo;
  if (state.repos[targetRepo].size + videoSize > config.MAX_REPO_SIZE) {
    targetRepo = await createNewRepo(state);
  }
  
  // Caricamento GitHub
  await sendTelegram(`⬆️ Caricamento su GitHub: ${targetRepo}`);
  await uploadToGitHub(tempDir, filename.replace('.mp4', ''), targetRepo);
  
  // Aggiornamento stato repo
  state.repos[targetRepo].size += videoSize;
  state.repos[targetRepo].files++;
  
  // Aggiornamento MongoDB
  const videoUrl = `https://cdn.jsdelivr.net/gh/${config.GITHUB_OWNER}/${targetRepo}@master/${filename.replace('.mp4', '')}/video.m3u8`;
  await updateMongoDB(season, episode, videoUrl);
  
  // Pulizia
  await fs.unlink(filePath);
  await fs.rm(tempDir, { recursive: true });
  
  await sendTelegram(`✅ Episodio completato! Stagione ${season} Episodio ${episode}\n🔗 ${videoUrl}`);
  await saveState(state);
}

async function createNewRepo(state) {
  const newRepoName = `${config.REPO_PREFIX}${state.nextRepoIndex}`;
  
  // Creazione repo via API GitHub
  await axios.post(
    'https://api.github.com/user/repos',
    { name: newRepoName, auto_init: true, private: false },
    { headers: { Authorization: `token ${config.GITHUB_TOKEN}` } }
  );
  
  // Aggiornamento stato
  state.currentRepo = newRepoName;
  state.repos[newRepoName] = { size: 0, files: 0 };
  state.nextRepoIndex++;
  
  await sendTelegram(`🆕 Creato nuovo repository: ${newRepoName}`);
  return newRepoName;
}

async function uploadToGitHub(localDir, folderName, repoName) {
  const repoDir = path.join(config.TEMP_DIR, repoName);
  
  // Clona repo
  execSync(`git clone https://${config.GITHUB_TOKEN}@github.com/${config.GITHUB_OWNER}/${repoName}.git ${repoDir}`, {
    stdio: 'ignore'
  });
  
  // Copia file
  const targetDir = path.join(repoDir, folderName);
  await fs.mkdir(targetDir, { recursive: true });
  const files = await fs.readdir(localDir);
  
  for (const file of files) {
    await fs.copyFile(
      path.join(localDir, file),
      path.join(targetDir, file)
    );
  }
  
  // Push
  execSync(`cd ${repoDir} && git add . && git commit -m "Aggiunto ${folderName}" && git push`, {
    stdio: 'ignore'
  });
  
  // Pulizia
  await fs.rm(repoDir, { recursive: true });
}

async function updateMongoDB(season, episode, videoUrl) {
  const client = new MongoClient(config.MONGODB_URI);
  
  try {
    await client.connect();
    const db = client.db();
    await db.collection('episodes').updateOne(
      { season: season, episodeNumber: episode },
      { $set: { videoUrl: videoUrl } }
    );
  } finally {
    await client.close();
  }
}

// Funzioni di supporto
async function loadState() {
  try {
    const data = await fs.readFile(config.STATE_FILE);
    return JSON.parse(data);
  } catch {
    return JSON.parse(JSON.stringify(initialState));
  }
}

async function saveState(state) {
  await fs.writeFile(config.STATE_FILE, JSON.stringify(state, null, 2));
}

async function sendTelegram(message) {
  if (!config.TELEGRAM_TOKEN) return;
  
  await axios.post(
    `https://api.telegram.org/bot${config.TELEGRAM_TOKEN}/sendMessage`,
    {
      chat_id: config.TELEGRAM_CHAT_ID,
      text: message,
      parse_mode: 'HTML'
    }
  );
}

// Esecuzione ogni 5 minuti
setInterval(main, 300000);
main(); // Esecuzione iniziale
