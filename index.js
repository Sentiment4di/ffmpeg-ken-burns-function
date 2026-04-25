const functions = require('@google-cloud/functions-framework');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

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
                  file.on('finish', () => file.close(resolve));
          }).on('error', err => {
                  fs.unlink(dest, () => {});
                  reject(err);
          });
    });
}

functions.http('render', async (req, res) => {
    res.set('Access-Control-Allow-Origin', '*');
    if (req.method === 'OPTIONS') { res.status(204).send(''); return; }

                 const tmpDir = `/tmp/render_${Date.now()}`;
    fs.mkdirSync(tmpDir, { recursive: true });

                 try {
                       const { scenes, fps = 30 } = req.body;
                       const sceneVideos = [];

      for (let i = 0; i < scenes.length; i++) {
              const scene = scenes[i];
              const imgPath = path.join(tmpDir, `img_${i}.jpg`);
              await downloadFile(scene.imageUrl, imgPath);

                         const audioPath = path.join(tmpDir, `audio_${i}.mp3`);
              if (scene.audioBase64) {
                        fs.writeFileSync(audioPath, Buffer.from(scene.audioBase64, 'base64'));
              } else {
                        execSync(`ffmpeg -f lavfi -i anullsrc=r=44100:cl=mono -t ${scene.duration || 3} -q:a 9 -acodec libmp3lame ${audioPath} -y`);
              }

                         const videoFinal = path.join(tmpDir, `scene_${i}.mp4`);
              // FFmpeg command applying Ken Burns
                         execSync(`ffmpeg -loop 1 -i "${imgPath}" -i "${audioPath}" -vf "scale=8000:-1,zoompan=z='min(zoom+0.0008,1.2)':d=90:s=1920x1080" -t ${scene.duration || 3} -c:v libx264 -pix_fmt yuv420p -c:a aac -shortest "${videoFinal}" -y`);

                         sceneVideos.push(videoFinal);
      }

      const concatFile = path.join(tmpDir, 'concat.txt');
                       fs.writeFileSync(concatFile, sceneVideos.map(v => `file '${v}'`).join('\n'));

      const finalVideo = path.join(tmpDir, 'final.mp4');
                       execSync(`ffmpeg -f concat -safe 0 -i "${concatFile}" -c copy "${finalVideo}" -y`);

      const videoBase64 = fs.readFileSync(finalVideo).toString('base64');
                       fs.rmSync(tmpDir, { recursive: true, force: true });

      res.json({ success: true, videoBase64 });
                 } catch (err) {
                       res.status(500).json({ error: err.message });
                 }
});
