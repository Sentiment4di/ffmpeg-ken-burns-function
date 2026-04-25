const express = require('express');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const app = express();
app.use(express.json({ type: '*/*', limit: '500mb' }));

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const proto = url.startsWith('https') ? https : http;
    const file = fs.createWriteStream(dest);
    proto.get(url, res => {
      if ([301, 302].includes(res.statusCode)) {
        file.close();
        return downloadFile(res.headers.location, dest).then(resolve).catch(reject);
      }
      res.pipe(file);
      file.on('finish', () => {
        file.close();
        if (fs.statSync(dest).size < 5000) {
          reject(new Error(`صورة تالفة: ${url}`));
        } else {
          resolve();
        }
      });
    }).on('error', err => { fs.unlink(dest, () => {}); reject(err); });
  });
}

function writeBase64File(base64, dest) {
  fs.writeFileSync(dest, Buffer.from(base64, 'base64'));
}

function execSafe(cmd) {
  try {
    return execSync(cmd, { stdio: 'pipe', maxBuffer: 100 * 1024 * 1024, timeout: 180000 });
  } catch (err) {
    throw new Error(err.stderr ? err.stderr.toString().slice(-1000) : err.message);
  }
}

// 🔥 بسيط وسريع جداً - بدون zoompan
const FAST_FILTER = `scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080,format=yuv420p`;

// KenBurns خفيف - فقط لو المستخدم طلبه
function buildKenBurnsFilter(fps) {
  const f = Math.min(fps, 25);
  return `scale=4000:-1,zoompan=z='min(zoom+0.002,1.3)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${f}:s=1920x1080:fps=${f},format=yuv420p`;
}

app.post('/', async (req, res) => {
  const tmpDir = `/tmp/render_${Date.now()}`;
  fs.mkdirSync(tmpDir, { recursive: true });

  try {
    const { scenes, fps = 24, kenBurns = false } = req.body;

    if (!scenes || !Array.isArray(scenes)) {
      return res.status(400).json({ error: 'scenes array مطلوب' });
    }

    const sceneVideos = [];

    for (let i = 0; i < scenes.length; i++) {
      const scene = scenes[i];
      const sceneNum = i + 1;
      const duration = scene.duration || 3;

      console.log(`🎬 مشهد ${sceneNum}/${scenes.length}`);

      const imgPath = path.join(tmpDir, `img_${sceneNum}.jpg`);
      await downloadFile(scene.imageUrl, imgPath);

      const audioPath = path.join(tmpDir, `audio_${sceneNum}.mp3`);
      if (scene.audioBase64) {
        writeBase64File(scene.audioBase64, audioPath);
      } else {
        execSafe(`ffmpeg -f lavfi -i anullsrc=r=44100:cl=mono -t ${duration} -q:a 9 -acodec libmp3lame "${audioPath}" -y`);
      }

      const videoNoAudio = path.join(tmpDir, `scene_noaudio_${sceneNum}.mp4`);

      // 🔥 افتراضي: FAST_FILTER - اختياري: KenBurns
      let vf = FAST_FILTER;
      if (kenBurns) {
        try {
          const kbFilter = buildKenBurnsFilter(fps);
          execSafe(`ffmpeg -loop 1 -i "${imgPath}" -vf "${kbFilter}" -t ${duration} -r ${fps} -pix_fmt yuv420p -c:v libx264 -preset ultrafast -crf 28 "${videoNoAudio}" -y`);
          console.log(`✅ KenBurns نجح`);
          vf = null;
        } catch (err) {
          console.log(`⚠️ KenBurns فشل - fallback`);
          vf = FAST_FILTER;
        }
      }

      if (vf) {
        execSafe(`ffmpeg -loop 1 -i "${imgPath}" -vf "${vf}" -t ${duration} -r ${fps} -pix_fmt yuv420p -c:v libx264 -preset ultrafast -crf 26 "${videoNoAudio}" -y`);
      }

      const sceneFinal = path.join(tmpDir, `scene_${sceneNum}.mp4`);
      execSafe(
        `ffmpeg -i "${videoNoAudio}" -i "${audioPath}" ` +
        `-c:v libx264 -preset ultrafast -crf 26 ` +
        `-c:a aac -ar 44100 -ac 2 -b:a 128k ` +
        `-pix_fmt yuv420p -movflags +faststart ` +
        `-shortest "${sceneFinal}" -y`
      );

      sceneVideos.push(sceneFinal);
      fs.unlinkSync(imgPath);
      fs.unlinkSync(audioPath);
      fs.unlinkSync(videoNoAudio);
    }

    const concatFile = path.join(tmpDir, 'concat.txt');
    fs.writeFileSync(concatFile, sceneVideos.map(v => `file '${v}'`).join('\n'));

    const finalVideo = path.join(tmpDir, 'final_video.mp4');
    execSafe(
      `ffmpeg -f concat -safe 0 -i "${concatFile}" ` +
      `-c:v libx264 -preset fast -crf 22 ` +
      `-c:a aac -ar 44100 -ac 2 -b:a 128k ` +
      `-pix_fmt yuv420p -movflags +faststart ` +
      `"${finalVideo}" -y`
    );

    const videoBuffer = fs.readFileSync(finalVideo);
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Disposition', 'attachment; filename="story.mp4"');
    res.send(videoBuffer);

    fs.rmSync(tmpDir, { recursive: true, force: true });

  } catch (err) {
    console.error('❌ خطأ:', err.message);
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
    res.status(500).json({ error: err.message });
  }
});

const port = process.env.PORT || 8080;
app.listen(port, () => console.log(`🚀 Server running on port ${port}`));
