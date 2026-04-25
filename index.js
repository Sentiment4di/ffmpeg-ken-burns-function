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
      if (res.statusCode === 301 || res.statusCode === 302) {
        file.close();
        return downloadFile(res.headers.location, dest).then(resolve).catch(reject);
      }
      res.pipe(file);
      file.on('finish', () => {
        file.close();
        const stats = fs.statSync(dest);
        if (stats.size < 1000) {
          reject(new Error(`الصورة المحملة تالفة أو صغيرة جداً من الرابط: ${url}`));
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

function buildKenBurnsFilter(type, duration, fps) {
  const frames = duration * fps;
  return `scale=1920:-2,zoompan=z='min(zoom+0.0008,1.2)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${frames}:s=1920x1080:fps=${fps}`;
}

app.post('/', async (req, res) => {
  const tmpDir = `/tmp/render_${Date.now()}`;
  fs.mkdirSync(tmpDir, { recursive: true });

  try {
    const { scenes, fps = 25 } = req.body;
    if (!scenes || !Array.isArray(scenes)) {
      return res.status(400).json({ error: 'scenes array مطلوب' });
    }

    const sceneVideos = [];

    for (let i = 0; i < scenes.length; i++) {
      const scene = scenes[i];
      const sceneNum = scene.scene_num || (i + 1);
      const duration = scene.duration || 3;
      const kenType = scene.kenBurnsType || scene.ken_burns || 'zoom_in';

      const imgPath = path.join(tmpDir, `img_${sceneNum}.jpg`);
      await downloadFile(scene.imageUrl, imgPath);

      const audioPath = path.join(tmpDir, `audio_${sceneNum}.mp3`);
      if (scene.audioBase64) {
        writeBase64File(scene.audioBase64, audioPath);
      } else {
        execSync(`ffmpeg -f lavfi -i anullsrc=r=44100:cl=mono -t ${duration} -q:a 9 -acodec libmp3lame ${audioPath} -y`);
      }

      const videoNoAudio = path.join(tmpDir, `scene_noaudio_${sceneNum}.mp4`);
      const kbFilter = buildKenBurnsFilter(kenType, duration, fps);

      try {
        execSync(
          `ffmpeg -loop 1 -i "${imgPath}" -vf "${kbFilter},format=yuv420p" -t ${duration} -r ${fps} -c:v libx264 -preset fast -crf 23 "${videoNoAudio}" -y`,
          { stdio: 'pipe' }
        );
      } catch (ffmpegErr) {
        throw new Error(`خطأ في معالجة صورة المشهد ${sceneNum}: ` + ffmpegErr.stderr.toString());
      }

      const sceneFinal = path.join(tmpDir, `scene_${sceneNum}.mp4`);
      try {
        execSync(
          `ffmpeg -i "${videoNoAudio}" -i "${audioPath}" -c:v copy -c:a aac -shortest "${sceneFinal}" -y`,
          { stdio: 'pipe' }
        );
      } catch (ffmpegErr) {
         throw new Error(`خطأ في دمج صوت المشهد ${sceneNum}: ` + ffmpegErr.stderr.toString());
      }

      sceneVideos.push(sceneFinal);
    }

    const concatFile = path.join(tmpDir, 'concat.txt');
    const concatContent = sceneVideos.map(v => `file '${v}'`).join('\n');
    fs.writeFileSync(concatFile, concatContent);

    const finalVideo = path.join(tmpDir, 'final_video.mp4');
    execSync(
      `ffmpeg -f concat -safe 0 -i "${concatFile}" -c:v libx264 -preset fast -crf 22 -c:a aac -b:a 128k "${finalVideo}" -y`,
      { stdio: 'inherit' }
    );

    const videoBuffer = fs.readFileSync(finalVideo);
    
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Disposition', 'attachment; filename="story.mp4"');
    res.send(videoBuffer);

    fs.rmSync(tmpDir, { recursive: true, force: true });

  } catch (err) {
    console.error('خطأ:', err.message);
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch(e) {}
    res.status(500).json({ error: err.message });
  }
});

const port = process.env.PORT || 8080;
app.listen(port, () => {
  console.log(`Server listening on port ${port}`);
});

