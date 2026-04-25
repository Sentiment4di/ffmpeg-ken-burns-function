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
        const stats = fs.statSync(dest);
        if (stats.size < 5000) {
          reject(new Error(`الصورة تالفة أو صغيرة: ${url}`));
        } else {
          resolve();
        }
      });
    }).on('error', err => {
      fs.unlink(dest, () => {});
      reject(err);
    });
  });
}

function writeBase64File(base64, dest) {
  const buffer = Buffer.from(base64, 'base64');
  fs.writeFileSync(dest, buffer);
}

const SCALE_FILTER = `scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080,format=yuv420p`;

function buildKenBurnsFilter(fps) {
  const internalFps = Math.min(fps, 25);
  return (
    `scale=8000:-1,` +
    `zoompan=z='min(zoom+0.0015,1.5)':` +
    `x='iw/2-(iw/zoom/2)':` +
    `y='ih/2-(ih/zoom/2)':` +
    `d=${internalFps * 2}:` +
    `s=1920x1080:fps=${internalFps},` +
    `format=yuv420p`
  );
}

function execSafe(cmd, opts = {}) {
  try {
    return execSync(cmd, {
      stdio: 'pipe',
      maxBuffer: 100 * 1024 * 1024,
      timeout: 180000,
      ...opts
    });
  } catch (err) {
    const msg = err.stderr ? err.stderr.toString() : err.message;
    throw new Error(msg);
  }
}

app.post('/', async (req, res) => {
  const tmpDir = `/tmp/render_${Date.now()}`;
  fs.mkdirSync(tmpDir, { recursive: true });

  try {
    const { scenes, fps = 30 } = req.body;

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
        execSafe(
          `ffmpeg -f lavfi -i anullsrc=r=44100:cl=mono -t ${duration} -q:a 9 -acodec libmp3lame "${audioPath}" -y`
        );
      }

      const videoNoAudio = path.join(tmpDir, `scene_noaudio_${sceneNum}.mp4`);

      try {
        execSafe(
          `ffmpeg -loop 1 -i "${imgPath}" -vf "${buildKenBurnsFilter(fps)}" -t ${duration} -r ${fps} -pix_fmt yuv420p -c:v libx264 -preset ultrafast -crf 26 "${videoNoAudio}" -y`
        );
        console.log(`✅ KenBurns نجح`);
      } catch (err) {
        console.log(`⚠️ KenBurns فشل - fallback\n${err.message}`);
        execSafe(
          `ffmpeg -loop 1 -i "${imgPath}" -vf "${SCALE_FILTER}" -t ${duration} -r ${fps} -pix_fmt yuv420p -c:v libx264 -preset ultrafast -crf 26 "${videoNoAudio}" -y`
        );
      }

      // 🔥 دمج الفيديو والصوت مع إعادة encoding كامل لضمان التوافق
      const sceneFinal = path.join(tmpDir, `scene_${sceneNum}.mp4`);
      execSafe(
        `ffmpeg -i "${videoNoAudio}" -i "${audioPath}" ` +
        `-c:v libx264 -preset ultrafast -crf 26 ` +
        `-c:a aac -ar 44100 -ac 2 -b:a 128k ` +
        `-pix_fmt yuv420p ` +
        `-movflags +faststart ` +
        `-shortest "${sceneFinal}" -y`
      );

      sceneVideos.push(sceneFinal);

      fs.unlinkSync(imgPath);
      fs.unlinkSync(audioPath);
      fs.unlinkSync(videoNoAudio);
    }

    const concatFile = path.join(tmpDir, 'concat.txt');
    fs.writeFileSync(
      concatFile,
      sceneVideos.map(v => `file '${v}'`).join('\n')
    );

    const finalVideo = path.join(tmpDir, 'final_video.mp4');

    // 🔥 concat مع re-encode كامل لضمان عدم تعارض الـ streams
    execSafe(
      `ffmpeg -f concat -safe 0 -i "${concatFile}" ` +
      `-c:v libx264 -preset fast -crf 22 ` +
      `-c:a aac -ar 44100 -ac 2 -b:a 128k ` +
      `-pix_fmt yuv420p ` +
      `-movflags +faststart ` +
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
app.listen(port, () => {
  console.log(`🚀 Server running on port ${port}`);
});
